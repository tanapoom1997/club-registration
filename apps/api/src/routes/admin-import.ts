import { createHash } from 'node:crypto';
import {
  ERROR_CODES,
  IMPORT_MAX_ERRORS_LISTED,
  IMPORT_MAX_FILE_BYTES,
  importCommitFieldsSchema,
  importCommitResponseSchema,
  importInvalidResponseSchema,
  importPreviewFieldsSchema,
  importPreviewResponseSchema,
} from '@club-registration/shared';
import type { ImportInvalidResponse, ImportPreviewResponse } from '@club-registration/shared';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { z } from 'zod';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withReadOnlySnapshot } from '../db.js';
import { AppError } from '../errors.js';
import { assertSameOrigin } from '../http/same-origin.js';
import type { ParsedImport } from '../import/parse.js';
import { parseImportWorkbook } from '../import/parse.js';
import { IMPORT_TEMPLATE_FILENAME, readImportTemplate } from '../import/template.js';
import { assertXlsxUpload } from '../import/xlsx-file.js';
import { commitImport } from '../services/import-commit.js';
import type { ImportPromotion } from '../services/import-commit.js';
import { planImport, summarizeImportPlan } from '../services/import-plan.js';
import type { ImportPlan } from '../services/import-plan.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Room for the multipart boundaries and the form fields around a file at the limit.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 1024;
// The commit form's term, fileSha256 and idempotencyKey; the preview sends only term.
const MAX_FIELDS = 3;
// Parsing a workbook is the heaviest thing an admin can trigger, so repeated uploads (previews
// and commits together) are capped.
const UPLOADS_PER_USER = 30;
const UPLOAD_WINDOW_MS = 60_000;

type Upload = { fields: Record<string, string>; filename: string; bytes: Buffer };

const fileTooLarge = () => new AppError(ERROR_CODES.fileTooLarge);

// Reads the whole form into memory (never to disk). The limits are set on this plugin only, so
// every other route keeps the global 64 KiB body limit and does not accept multipart at all.
const readUpload = async (request: FastifyRequest): Promise<Upload> => {
  if (!request.isMultipart()) {
    throw new AppError(ERROR_CODES.badRequest, 'Expected multipart/form-data');
  }
  const { RequestFileTooLargeError, FilesLimitError, FieldsLimitError, PartsLimitError } =
    request.server.multipartErrors;
  const fields: Record<string, string> = {};
  let file: { filename: string; bytes: Buffer } | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        file = { filename: part.filename, bytes: await part.toBuffer() };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (error instanceof RequestFileTooLargeError) throw fileTooLarge();
    if (
      error instanceof FilesLimitError ||
      error instanceof FieldsLimitError ||
      error instanceof PartsLimitError
    ) {
      throw new AppError(ERROR_CODES.validationError, 'Too many form fields or files');
    }
    throw error;
  }
  if (!file) throw new AppError(ERROR_CODES.validationError, 'A file is required');
  return { fields, ...file };
};

const parseFields = <S extends z.ZodType>(
  schema: S,
  fields: Record<string, string>,
): z.output<S> => {
  const result = schema.safeParse(fields);
  if (!result.success) throw new AppError(ERROR_CODES.validationError);
  return result.data;
};

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const rowCounts = (parsed: ParsedImport) => ({
  students: parsed.students?.length ?? null,
  clubs: parsed.clubs?.length ?? null,
  advisors: parsed.advisors?.length ?? null,
});

const summarize = (plan: ImportPlan, fileSha256: string, term: string) =>
  summarizeImportPlan(plan, { fileSha256, term, maxErrors: IMPORT_MAX_ERRORS_LISTED });

const promotionCounts = (promotions: readonly ImportPromotion[]) => {
  const byRound = promotions.reduce(
    (counts, { roundId }) => counts.set(roundId, (counts.get(roundId) ?? 0) + 1),
    new Map<number, number>(),
  );
  return {
    promoted: promotions.length,
    ...(byRound.size > 0
      ? { promotedByRound: [...byRound].map(([roundId, count]) => ({ roundId, count })) }
      : {}),
  };
};

// Counts and the hash only: cell values and the file name can hold personal data. A commit also
// logs how many waiters it moved up (promoted), and how many per round when there were any.
const logImport = (
  request: FastifyRequest,
  message: string,
  details: {
    adminId: number;
    fileSha256: string;
    parsed: ParsedImport;
    summary: ImportPreviewResponse;
    promotions?: readonly ImportPromotion[];
  },
) => {
  const { adminId, fileSha256, parsed, summary, promotions } = details;
  request.log.info(
    {
      adminId,
      fileSha256,
      rows: rowCounts(parsed),
      changes: { students: summary.students, clubs: summary.clubs, advisors: summary.advisors },
      errorCount: summary.errorCount,
      ...(promotions === undefined ? {} : promotionCounts(promotions)),
    },
    message,
  );
};

export const adminImportRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  async (app) => {
    // Same reason as admin rounds: non-admins are refused before anything is read or validated.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    await app.register(fastifyMultipart, {
      limits: {
        fileSize: IMPORT_MAX_FILE_BYTES,
        files: 1,
        fields: MAX_FIELDS,
        parts: MAX_FIELDS + 1,
        fieldSize: MAX_FIELD_BYTES,
      },
    });

    const uploadLimiter = app.createRateLimit({
      max: UPLOADS_PER_USER,
      timeWindow: UPLOAD_WINDOW_MS,
      keyGenerator: (request) => String(request.authUser?.id),
    });

    // Shared by every upload route: the CSRF check, then an obviously oversized upload is refused
    // before any of it is read, then the per-admin limit.
    const uploadGate = async (request: FastifyRequest, reply: FastifyReply) => {
      assertSameOrigin(request);
      const declared = Number(request.headers['content-length']);
      if (declared > IMPORT_MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) throw fileTooLarge();
      const limit = await uploadLimiter(request);
      if (!limit.isAllowed && limit.isExceeded) {
        void reply.header('retry-after', String(limit.ttlInSeconds));
        throw new AppError(ERROR_CODES.rateLimited);
      }
    };

    app.get('/admin/import/template', async (_request, reply) => {
      const template = await readImportTemplate();
      return await reply
        .header('content-type', XLSX_MIME)
        .header('content-disposition', `attachment; filename="${IMPORT_TEMPLATE_FILENAME}"`)
        .send(template);
    });

    // A dry run: it reads the DB in a READ ONLY transaction and writes nothing, so it takes no
    // idempotency_key.
    app.post(
      '/admin/import/preview',
      { schema: { response: { 200: importPreviewResponseSchema } }, preHandler: uploadGate },
      async (request) => {
        const admin = requireAuthUser(request);
        const upload = await readUpload(request);
        const { term } = parseFields(importPreviewFieldsSchema, upload.fields);
        await assertXlsxUpload(upload.filename, upload.bytes);
        const fileSha256 = sha256Hex(upload.bytes);

        const parsed = await parseImportWorkbook(upload.bytes);
        const plan = await withReadOnlySnapshot(
          pool,
          async (client) => await planImport(client, term, parsed),
        );
        const summary = summarize(plan, fileSha256, term);
        logImport(request, 'import preview', {
          adminId: admin.id,
          fileSha256,
          parsed,
          summary,
        });
        return summary;
      },
    );

    // Writes the previewed file in one transaction: all of it or, on any error, nothing.
    //
    // Idempotency: the result is a function of the file and the DB, never of the request, so a
    // retry (same or new idempotencyKey) leaves the same state and reports every row unchanged.
    // The key is still required, so this endpoint has the same contract as every other write
    // (CLAUDE.md rule 7), but it is not stored: registration_events needs a round and a student
    // per row and has no import event type, and an import table would only let a retry repeat the
    // first summary, which the unchanged counts already make clear. The waitlist_promote events of
    // the waiters a commit moves up carry no key either, like every promotion, and a retry moves
    // nobody: the seats it freed are taken. Nothing is kept between
    // preview and commit either (no state on disk): the file is sent again and fileSha256 ties it
    // to the preview the admin saw.
    app.post(
      '/admin/import/commit',
      {
        schema: {
          response: { 200: importCommitResponseSchema, 422: importInvalidResponseSchema },
        },
        preHandler: uploadGate,
      },
      async (request, reply) => {
        const admin = requireAuthUser(request);
        const upload = await readUpload(request);
        const { term, fileSha256 } = parseFields(importCommitFieldsSchema, upload.fields);
        // Checked before the file is even opened: a different file means the admin never saw
        // a summary of what this one would do.
        const actualSha256 = sha256Hex(upload.bytes);
        if (actualSha256 !== fileSha256) throw new AppError(ERROR_CODES.importFileMismatch);
        await assertXlsxUpload(upload.filename, upload.bytes);

        const parsed = await parseImportWorkbook(upload.bytes);
        const { status, plan, promotions } = await commitImport(pool, {
          term,
          parsed,
          actorId: admin.id,
        });
        const summary = summarize(plan, fileSha256, term);
        logImport(request, status === 'committed' ? 'import committed' : 'import rejected', {
          adminId: admin.id,
          fileSha256,
          parsed,
          summary,
          promotions,
        });
        if (status === 'invalid') {
          const body: ImportInvalidResponse = {
            code: ERROR_CODES.importInvalid,
            message: new AppError(ERROR_CODES.importInvalid).message,
            errors: summary.errors,
            errorCount: summary.errorCount,
          };
          return await reply.status(422).send(body);
        }
        return summary;
      },
    );
  };
