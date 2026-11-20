import {
  ERROR_CODES,
  cancelRegistrationRequestSchema,
  registerRequestSchema,
  studentClubsResponseSchema,
  studentQuerySchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
} from '@club-registration/shared';
import type { StudentRegistrationResponse } from '@club-registration/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { cancelRegistration, registerForClub } from '../services/registrations.js';
import type { RegistrationResult } from '../services/registrations.js';
import { listStudentClubs, readStudentRound } from '../services/student-round.js';

// Register and cancel share one budget per student. A real visit is a handful of clicks plus
// automatic retries; 30 a minute leaves room for that and still stops a script hammering the
// round lock. The store is in memory, which is right for the single instance we run.
const WRITES_PER_STUDENT = 30;
const WRITE_WINDOW_MS = 60_000;

// What a logged-in student reads and writes in their own grade's round. The student, and through
// their profile the grade and round, come from the session alone: no path, query or body field
// can choose them. Responses carry club and advisor names, so logs carry ids and outcomes only.
export const studentRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
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

    // Ids and the outcome only: never a student, club or advisor name.
    const runLogged = async (
      request: FastifyRequest,
      action: 'register' | 'cancel',
      requestedClubId: number | null,
      work: (client: pg.PoolClient) => Promise<RegistrationResult>,
    ): Promise<StudentRegistrationResponse> => {
      const studentId = requireAuthUser(request).id;
      let result: RegistrationResult;
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
      const { roundId, clubId, outcome, registration } = result;
      request.log.info({ studentId, roundId, clubId, outcome }, `student ${action}`);
      return { registration };
    };

    app.get(
      '/student/round',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentRoundResponseSchema } },
      },
      async (request) => await readStudentRound(pool, requireAuthUser(request).id, new Date()),
    );

    app.get(
      '/student/clubs',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentClubsResponseSchema } },
      },
      async (request) => await listStudentClubs(pool, requireAuthUser(request).id, new Date()),
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
        return await runLogged(
          request,
          'register',
          clubId,
          async (client) => await registerForClub(client, { studentId, clubId, idempotencyKey }),
        );
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
        return await runLogged(
          request,
          'cancel',
          null,
          async (client) => await cancelRegistration(client, { studentId, idempotencyKey }),
        );
      },
    );
  };
