import {
  ERROR_CODES,
  queueWriteRequestSchema,
  studentQueueResponseSchema,
  studentQuerySchema,
} from '@club-registration/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withReadOnlySnapshot, withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { heartbeatQueue, joinQueue, readQueue, releaseQueue } from '../services/queue.js';
import type { QueueInput, QueueResult, QueueSettings } from '../services/queue.js';

// The page polls the heartbeat every 3–5 s (12–20 a minute); 60 a minute, shared with the read,
// leaves room for a second tab and retries and still stops a script hammering the queue lock.
// Join and done are clicks (plus retries), so they get a smaller budget of their own. Both are
// apart from the registration writes' 30 a minute, so polling never eats into choosing a club.
// The stores are in memory, which is right for the single instance we run.
const POLLS_PER_STUDENT = 60;
const QUEUE_WRITES_PER_STUDENT = 20;
const WINDOW_MS = 60_000;

// The queue in front of the student's own round (README Phase 3). The student, and through their
// profile the grade and round, come from the session alone; the bodies are the empty JSON object,
// strict, so nothing a client sends can name them. Logs carry ids, counts and outcomes only.
export const studentQueueRoutes =
  ({
    pool,
    guard,
    settings,
  }: {
    pool: pg.Pool;
    guard: AuthGuard;
    settings: QueueSettings;
  }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for the other student routes: other roles learn nothing from a 400.
    app.addHook('preValidation', guard({ roles: ['student'] }));

    const limiterGate = (max: number) => {
      const limiter = app.createRateLimit({
        max,
        timeWindow: WINDOW_MS,
        keyGenerator: (request) => String(request.authUser?.id),
      });
      // Runs after the guard and validation, so only well-formed requests use up the budget.
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const limit = await limiter(request);
        if (!limit.isAllowed && limit.isExceeded) {
          void reply.header('retry-after', String(limit.ttlInSeconds));
          throw new AppError(ERROR_CODES.rateLimited);
        }
      };
    };
    const pollGate = limiterGate(POLLS_PER_STUDENT);
    const writeGate = limiterGate(QUEUE_WRITES_PER_STUDENT);

    const runLogged = async (
      request: FastifyRequest,
      action: 'join' | 'heartbeat' | 'done',
      work: (client: pg.PoolClient, input: QueueInput) => Promise<QueueResult>,
    ) => {
      const studentId = requireAuthUser(request).id;
      let result: QueueResult;
      try {
        result = await withTransaction(
          pool,
          async (client) => await work(client, { studentId, settings }),
        );
      } catch (error) {
        if (error instanceof AppError) {
          request.log.info({ studentId, outcome: error.code }, `student queue ${action} refused`);
        }
        throw error;
      }
      const { outcome, roundId, expired, admitted, response } = result;
      request.log.info(
        { studentId, roundId, outcome, ticket: response.ticket?.status ?? null, expired, admitted },
        `student queue ${action}`,
      );
      return response;
    };

    const writeSchema = {
      body: queueWriteRequestSchema,
      response: { 200: studentQueueResponseSchema },
    };

    // A read only: no expiry, no admission, no heartbeat. The page shows what it says between
    // heartbeats; it is not counted as being present.
    app.get(
      '/student/queue',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentQueueResponseSchema } },
        preHandler: pollGate,
      },
      async (request) => {
        const studentId = requireAuthUser(request).id;
        return await withReadOnlySnapshot(
          pool,
          async (client) => await readQueue(client, { studentId, settings }),
        );
      },
    );

    // JSON bodies only (Fastify refuses other content types and the schema refuses a text body),
    // which with the SameSite=Strict cookie is the CSRF defence (docs/security.md).
    app.post(
      '/student/queue/join',
      { schema: writeSchema, preHandler: writeGate },
      async (request) => await runLogged(request, 'join', joinQueue),
    );

    // A POST although the page polls it: it writes (last_seen_at, expiry, admission), and reads
    // must have no side effects.
    app.post(
      '/student/queue/heartbeat',
      { schema: writeSchema, preHandler: pollGate },
      async (request) => await runLogged(request, 'heartbeat', heartbeatQueue),
    );

    app.post(
      '/student/queue/done',
      { schema: writeSchema, preHandler: writeGate },
      async (request) => await runLogged(request, 'done', releaseQueue),
    );
  };
