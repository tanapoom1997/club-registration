import {
  ERROR_CODES,
  clubIdParamsSchema,
  clubMemberRequestSchema,
  clubMembersResponseSchema,
  clubMemberWriteResponseSchema,
  clubWaitlistRemoveRequestSchema,
  clubWaitlistResponseSchema,
  roundStudentsParamsSchema,
  roundStudentsQuerySchema,
  roundStudentsResponseSchema,
} from '@club-registration/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { ADMIN_ACTIONS, logAdminChange } from '../http/audit-log.js';
import type { AdminAction } from '../http/audit-log.js';
import { assignMember, listClubMembers, removeMember } from '../services/club-members.js';
import type { MemberWriteInput, MemberWriteResult } from '../services/club-members.js';
import { listClubWaitlist, removeWaitlistEntry } from '../services/club-waitlist.js';
import { listRoundStudents } from '../services/round-students.js';

// Seating, removing and taking a student off a waitlist is one request per student, so a busy
// admin fixing a list clicks a few times a minute. 120 a minute (two a second, shared by the
// three: one admin cleaning up a club's lists is one budget, whichever list a click edits) is far
// above any person and still stops a stuck button or a script from queueing hundreds of writes on
// the round lock that students register through.
const SEAT_WRITES_PER_ADMIN = 120;
const SEAT_WRITE_WINDOW_MS = 60_000;

// An admin's view and edit of who holds a seat in a club (README Phase 2, PR 3a) and who waits for
// one (PR 3b). Writes take an idempotency_key and write registration_events (CLAUDE.md rule 7)
// with the admin as actor: one admin_assign, admin_remove or waitlist_leave per request, plus a
// waitlist_promote per student a freed seat promoted. Responses carry students' names, so the only
// log line is logAdminChange's, with ids and the outcome: never a name or a login ID (a student
// code, like the issuance log keeps out).
export const adminClubMemberRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for the other admin routes: non-admins learn nothing from a 400.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    const writeLimiter = app.createRateLimit({
      max: SEAT_WRITES_PER_ADMIN,
      timeWindow: SEAT_WRITE_WINDOW_MS,
      keyGenerator: (request) => String(request.authUser?.id),
    });

    // Runs after the guard and body validation, so only well-formed requests use up the budget.
    const writeGate = async (request: FastifyRequest, reply: FastifyReply) => {
      const limit = await writeLimiter(request);
      if (!limit.isAllowed && limit.isExceeded) {
        void reply.header('retry-after', String(limit.ttlInSeconds));
        throw new AppError(ERROR_CODES.rateLimited);
      }
    };

    const runLogged = async (
      request: FastifyRequest,
      action: AdminAction,
      work: (client: pg.PoolClient, input: MemberWriteInput) => Promise<MemberWriteResult>,
      input: MemberWriteInput,
    ) => {
      const result = await withTransaction(pool, async (client) => await work(client, input));
      const { clubId, roundId, studentId, outcome, fromClubId, promotions } = result;
      logAdminChange(request, action, {
        clubId,
        roundId,
        studentId,
        outcome,
        ...(fromClubId === undefined ? {} : { fromClubId }),
        promoted: promotions.length,
        ...(promotions.length > 0
          ? { promotedStudentIds: promotions.map((promotion) => promotion.studentId) }
          : {}),
      });
      return { club: result.club, member: result.member };
    };

    // The students the panel can seat, to find one by name or classroom (services/round-students.ts).
    // A read, so outside the write budget. No query string: a student's name or code typed into
    // the search never leaves the browser.
    app.get(
      '/admin/rounds/:roundId/students',
      {
        schema: {
          params: roundStudentsParamsSchema,
          querystring: roundStudentsQuerySchema,
          response: { 200: roundStudentsResponseSchema },
        },
      },
      async (request) => await listRoundStudents(pool, request.params.roundId),
    );

    app.get(
      '/admin/clubs/:id/members',
      { schema: { params: clubIdParamsSchema, response: { 200: clubMembersResponseSchema } } },
      async (request) => await listClubMembers(pool, request.params.id),
    );

    // JSON bodies only (Fastify refuses other content types), which with the SameSite=Strict
    // cookie is the CSRF defence (docs/security.md), as for every other admin JSON write.
    app.post(
      '/admin/clubs/:id/members',
      {
        schema: {
          params: clubIdParamsSchema,
          body: clubMemberRequestSchema,
          response: { 200: clubMemberWriteResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) =>
        await runLogged(request, ADMIN_ACTIONS.clubMemberAssign, assignMember, {
          adminId: requireAuthUser(request).id,
          clubId: request.params.id,
          ...request.body,
        }),
    );

    // POST, not DELETE: the body carries the student and the idempotency key, like a student's
    // /cancel.
    app.post(
      '/admin/clubs/:id/members/remove',
      {
        schema: {
          params: clubIdParamsSchema,
          body: clubMemberRequestSchema,
          response: { 200: clubMemberWriteResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) =>
        await runLogged(request, ADMIN_ACTIONS.clubMemberRemove, removeMember, {
          adminId: requireAuthUser(request).id,
          clubId: request.params.id,
          ...request.body,
        }),
    );

    app.get(
      '/admin/clubs/:id/waitlist',
      { schema: { params: clubIdParamsSchema, response: { 200: clubWaitlistResponseSchema } } },
      async (request) => await listClubWaitlist(pool, request.params.id),
    );

    // Answers with the whole queue after the removal (the same shape as the GET): the others'
    // positions shift, so the page needs the list again anyway, read under the same round lock.
    app.post(
      '/admin/clubs/:id/waitlist/remove',
      {
        schema: {
          params: clubIdParamsSchema,
          body: clubWaitlistRemoveRequestSchema,
          response: { 200: clubWaitlistResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) => {
        const result = await withTransaction(
          pool,
          async (client) =>
            await removeWaitlistEntry(client, {
              adminId: requireAuthUser(request).id,
              clubId: request.params.id,
              ...request.body,
            }),
        );
        const { clubId, roundId, studentId, outcome } = result;
        logAdminChange(request, ADMIN_ACTIONS.clubWaitlistRemove, {
          clubId,
          roundId,
          studentId,
          outcome,
        });
        return { club: result.club, entries: result.entries };
      },
    );
  };
