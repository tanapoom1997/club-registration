import { createHash } from 'node:crypto';
import {
  ERROR_CODES,
  IMPORT_MAX_ERRORS_LISTED,
  IMPORT_MAX_FILE_BYTES,
  importPreviewFieldsSchema,
  importPreviewResponseSchema,
} from '@club-registration/shared';
import type { ImportPreviewFields } from '@club-registration/shared';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withReadOnlySnapshot } from '../db.js';
import { AppError } from '../errors.js';
import { parseImportWorkbook } from '../import/parse.js';
import { IMPORT_TEMPLATE_FILENAME, readImportTemplate } from '../import/template.js';
import { assertXlsxUpload } from '../import/xlsx-file.js';
import { planImport, summarizeImportPlan } from '../services/import-plan.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Room for the multipart boundaries and the term field around a file at the limit.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 1024;
// Parsing a workbook is the heaviest thing an admin can trigger, so repeated uploads are capped.
const PREVIEWS_PER_USER = 30;
const PREVIEW_WINDOW_MS = 60_000;

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
      throw new AppError(ERROR_CODES.validationError, 'Send one term field and one file');
    }
    throw error;
  }
  if (!file) throw new AppError(ERROR_CODES.validationError, 'A file is required');
  return { fields, ...file };
};

const parseFields = (fields: Record<string, string>): ImportPreviewFields => {
  const result = importPreviewFieldsSchema.safeParse(fields);
  if (!result.success) throw new AppError(ERROR_CODES.validationError);
  return result.data;
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
        fields: 2,
        parts: 3,
        fieldSize: MAX_FIELD_BYTES,
      },
    });

    const previewLimiter = app.createRateLimit({
      max: PREVIEWS_PER_USER,
      timeWindow: PREVIEW_WINDOW_MS,
      keyGenerator: (request) => String(request.authUser?.id),
    });

    app.get('/admin/import/template', async (_request, reply) => {
      const template = await readImportTemplate();
      return await reply
        .header('content-type', XLSX_MIME)
        .header('content-disposition', `attachment; filename="${IMPORT_TEMPLATE_FILENAME}"`)
        .send(template);
    });

    // A dry run: it reads the DB in a READ ONLY transaction and writes nothing, so it takes no
    // idempotency_key and writes no registration_events. The commit step (next task) will.
    app.post(
      '/admin/import/preview',
      {
        schema: { response: { 200: importPreviewResponseSchema } },
        preHandler: async (request, reply) => {
          const declared = Number(request.headers['content-length']);
          // Refuses an obviously oversized upload before reading any of it.
          if (declared > IMPORT_MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) throw fileTooLarge();
          const limit = await previewLimiter(request);
          if (!limit.isAllowed && limit.isExceeded) {
            void reply.header('retry-after', String(limit.ttlInSeconds));
            throw new AppError(ERROR_CODES.rateLimited);
          }
        },
      },
      async (request) => {
        const admin = requireAuthUser(request);
        const upload = await readUpload(request);
        const { term } = parseFields(upload.fields);
        await assertXlsxUpload(upload.filename, upload.bytes);
        const fileSha256 = createHash('sha256').update(upload.bytes).digest('hex');

        const parsed = await parseImportWorkbook(upload.bytes);
        const plan = await withReadOnlySnapshot(
          pool,
          async (client) => await planImport(client, term, parsed),
        );
        const summary = summarizeImportPlan(plan, {
          fileSha256,
          term,
          maxErrors: IMPORT_MAX_ERRORS_LISTED,
        });
        // Counts and the hash only: cell values and the file name can hold personal data.
        request.log.info(
          {
            adminId: admin.id,
            fileSha256,
            rows: {
              students: parsed.students?.length ?? null,
              clubs: parsed.clubs?.length ?? null,
              advisors: parsed.advisors?.length ?? null,
            },
            errorCount: summary.errorCount,
          },
          'import preview',
        );
        return summary;
      },
    );
  };
