import {
  ERROR_CODES,
  cancelRegistrationRequestSchema,
  changeRegistrationRequestSchema,
  joinWaitlistRequestSchema,
  leaveWaitlistRequestSchema,
  registerRequestSchema,
  studentClubsResponseSchema,
  studentQuerySchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
  studentWaitlistResponseSchema,
} from '@club-registration/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import {
  cancelRegistration,
  changeRegistration,
  registerForClub,
} from '../services/registrations.js';
import type { RegistrationResult } from '../services/registrations.js';
import { requireAdmittedTicket } from '../services/queue.js';
import type { QueueSettings } from '../services/queue.js';
import { listStudentClubs, readStudentRound } from '../services/student-round.js';
import { joinWaitlist, leaveWaitlist } from '../services/waitlist.js';
import type { WaitlistResult } from '../services/waitlist.js';

// Register, change, cancel and the waitlist's join and leave share one budget per student. A real visit is a handful of clicks
// plus automatic retries; 30 a minute leaves room for that and still stops a script hammering the
// round lock. The store is in memory, which is right for the single instance we run.
const WRITES_PER_STUDENT = 30;
const WRITE_WINDOW_MS = 60_000;

// What a logged-in student reads and writes in their own grade's round. The student, and through
// their profile the grade and round, come from the session alone: no path, query or body field
// can choose them. Responses carry club and advisor names, so logs carry ids and outcomes only.
//
// The queue gate (README Phase 3, Q2) is always on here: the club list and the writes that take a
// seat or a place in line (register, change, waitlist join) need a live admitted queue ticket
// while the round is open. It runs inside each request's own transaction, after the round lock,
// the idempotency replay and the window check (registrations.ts says why), never in a preHandler:
// a replayed key must still get its stored answer once the ticket ended, and a closed round must
// still answer round_not_open. Cancel, leaving the waitlist and the student's own result are not
// gated: they take nobody's seat.
export const studentRoutes =
  ({
    pool,
    guard,
    queue,
  }: {
    pool: pg.Pool;
    guard: AuthGuard;
    queue: QueueSettings;
  }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for admin routes: other roles learn nothing about the schema from a 400.
    app.addHook('preValidation', guard({ roles: ['student'] }));

    const writeLimiter = app.createRateLimit({
      max: WRITES_PER_STUDENT,
      timeWindow: WRITE_WINDOW_MS,
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

    // Ids and the outcome only: never a student, club or advisor name. Promotions a freed seat
    // caused are logged as ids too (student, club, club left), and their count.
    const runLogged = async <T extends RegistrationResult | WaitlistResult>(
      request: FastifyRequest,
      action: 'register' | 'change' | 'cancel' | 'waitlist join' | 'waitlist leave',
      requestedClubId: number | null,
      work: (client: pg.PoolClient) => Promise<T>,
    ): Promise<T> => {
      const studentId = requireAuthUser(request).id;
      let result: T;
      try {
        result = await withTransaction(pool, work);
      } catch (error) {
        if (error instanceof AppError) {
          request.log.info(
            { studentId, clubId: requestedClubId, outcome: error.code },
            `student ${action} refused`,
          );
        }
        throw error;
      }
      const { roundId, clubId, fromClubId, outcome } = result;
      const promotions = 'promotions' in result ? result.promotions : [];
      request.log.info(
        {
          studentId,
          roundId,
          clubId,
          fromClubId,
          outcome,
          ...(promotions.length > 0 ? { promoted: promotions.length, promotions } : {}),
        },
        `student ${action}`,
      );
      return result;
    };

    app.get(
      '/student/round',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentRoundResponseSchema } },
      },
      async (request) => await readStudentRound(pool, requireAuthUser(request).id),
    );

    app.get(
      '/student/clubs',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentClubsResponseSchema } },
      },
      async (request) => {
        const studentId = requireAuthUser(request).id;
        try {
          return await listStudentClubs(pool, studentId, requireAdmittedTicket(studentId, queue));
        } catch (error) {
          // Ids and the code only, like the writes' refusals.
          if (error instanceof AppError && error.code === ERROR_CODES.queueRequired) {
            request.log.info({ studentId, outcome: error.code }, 'student clubs refused');
          }
          throw error;
        }
      },
    );

    // JSON bodies only (Fastify refuses other content types), which with the SameSite=Strict
    // cookie is the CSRF defence (docs/security.md): a cross-site form cannot send JSON.
    app.post(
      '/student/registration',
      {
        schema: {
          body: registerRequestSchema,
          response: { 200: studentRegistrationResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) => {
        const { clubId, idempotencyKey } = request.body;
        const studentId = requireAuthUser(request).id;
        const { registration } = await runLogged(
          request,
          'register',
          clubId,
          async (client) =>
            await registerForClub(
              client,
              { studentId, clubId, idempotencyKey },
              requireAdmittedTicket(studentId, queue),
            ),
        );
        return { registration };
      },
    );

    // PUT: it replaces which club the student's one registration is for. The club given back is
    // the one held in the DB, never named by the client.
    app.put(
      '/student/registration',
      {
        schema: {
          body: changeRegistrationRequestSchema,
          response: { 200: studentRegistrationResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) => {
        const { clubId, idempotencyKey } = request.body;
        const studentId = requireAuthUser(request).id;
        const { registration } = await runLogged(
          request,
          'change',
          clubId,
          async (client) =>
            await changeRegistration(
              client,
              { studentId, clubId, idempotencyKey },
              requireAdmittedTicket(studentId, queue),
            ),
        );
        return { registration };
      },
    );

    app.post(
      '/student/registration/cancel',
      {
        schema: {
          body: cancelRegistrationRequestSchema,
          response: { 200: studentRegistrationResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) => {
        const { idempotencyKey } = request.body;
        const studentId = requireAuthUser(request).id;
        const { registration } = await runLogged(
          request,
          'cancel',
          null,
          async (client) => await cancelRegistration(client, { studentId, idempotencyKey }),
        );
        return { registration };
      },
    );

    // POST, not PUT: joining another club's waitlist gives up the current entry and its place, and
    // the body carries an idempotency key like every other write.
    app.post(
      '/student/waitlist',
      {
        schema: {
          body: joinWaitlistRequestSchema,
          response: { 200: studentWaitlistResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) => {
        const { clubId, idempotencyKey } = request.body;
        const studentId = requireAuthUser(request).id;
        const { waitlist } = await runLogged(
          request,
          'waitlist join',
          clubId,
          async (client) =>
            await joinWaitlist(
              client,
              { studentId, clubId, idempotencyKey },
              requireAdmittedTicket(studentId, queue),
            ),
        );
        return { waitlist };
      },
    );

    app.post(
      '/student/waitlist/leave',
      {
        schema: {
          body: leaveWaitlistRequestSchema,
          response: { 200: studentWaitlistResponseSchema },
        },
        preHandler: writeGate,
      },
      async (request) => {
        const { idempotencyKey } = request.body;
        const studentId = requireAuthUser(request).id;
        const { waitlist } = await runLogged(
          request,
          'waitlist leave',
          null,
          async (client) => await leaveWaitlist(client, { studentId, idempotencyKey }),
        );
        return { waitlist };
      },
    );
  };
