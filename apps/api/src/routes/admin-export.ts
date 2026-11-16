import {
  exportQuerySchema,
  roundClassroomsResponseSchema,
  roundExportParamsSchema,
} from '@club-registration/shared';
import type { ExportView } from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { buildClassroomListWorkbook, buildClubListWorkbook } from '../export/name-list-workbook.js';
import { listRoundClassrooms, readClassroomLists, readClubLists } from '../services/name-lists.js';
import type { ExportRound } from '../services/name-lists.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Club codes and classrooms are mostly ASCII ("A100", "3/1"): those keep their letters, digits,
// '.', '_' and '-', with anything else as '-'. One with any other character (e.g. a Thai letter)
// becomes its UTF-8 hex instead, so two such scopes never share a file name.
const fileSafe = (text: string): string =>
  /^[\x20-\x7e]+$/.test(text)
    ? text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
    : Buffer.from(text).toString('hex');

// Identifiers only (round, grade, club code, classroom): never a student's or teacher's name.
const attachmentName = (view: ExportView, round: ExportRound, scope: string | undefined): string =>
  `${view}-list-round-${round.id}-grade-${round.grade}${scope === undefined ? '' : `-${scope}`}.xlsx`;

// Read-only: nothing here writes, so there is no idempotency_key and no registration_events row.
// The files and the classroom list carry students' names, so logs get counts and scope only.
export const adminExportRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for rounds: non-admins learn nothing about the schema from a 400.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    // What the export page offers as classroom scopes, with how many have registered.
    app.get(
      '/admin/rounds/:roundId/classrooms',
      {
        schema: {
          params: roundExportParamsSchema,
          response: { 200: roundClassroomsResponseSchema },
        },
      },
      async (request) => await listRoundClassrooms(pool, request.params.roundId, new Date()),
    );

    app.get(
      '/admin/rounds/:roundId/export',
      { schema: { params: roundExportParamsSchema, querystring: exportQuerySchema } },
      async (request, reply) => {
        const admin = requireAuthUser(request);
        const { roundId } = request.params;
        const query = request.query;
        const exportedAt = new Date();

        let file: Buffer;
        let filename: string;
        let sheetCount: number;
        let studentCount: number;
        if (query.view === 'club') {
          const { round, clubs } = await readClubLists(pool, roundId, query.clubId);
          file = await buildClubListWorkbook(round, clubs, exportedAt);
          filename = attachmentName(
            'club',
            round,
            query.clubId === undefined || !clubs[0] ? undefined : fileSafe(clubs[0].clubCode),
          );
          sheetCount = clubs.length;
          studentCount = clubs.reduce((total, { students }) => total + students.length, 0);
        } else {
          const { round, classrooms } = await readClassroomLists(pool, roundId, query.classroom);
          file = await buildClassroomListWorkbook(round, classrooms, exportedAt);
          filename = attachmentName(
            'classroom',
            round,
            query.classroom === undefined ? undefined : `room-${fileSafe(query.classroom)}`,
          );
          sheetCount = classrooms.length;
          studentCount = classrooms.reduce((total, { students }) => total + students.length, 0);
        }

        // Scope and counts only: never a name, student ID or contact.
        request.log.info(
          {
            adminId: admin.id,
            roundId,
            view: query.view,
            format: query.format,
            clubId: query.view === 'club' ? (query.clubId ?? null) : null,
            classroom: query.view === 'classroom' ? (query.classroom ?? null) : null,
            sheetCount,
            studentCount,
          },
          'name list exported',
        );

        return await reply
          .header('content-type', XLSX_MIME)
          .header('content-disposition', `attachment; filename="${filename}"`)
          // Students' names: no browser or proxy cache may keep a copy.
          .header('cache-control', 'no-store')
          .send(file);
      },
    );
  };
