import {
  createRoundBatchRequestSchema,
  createRoundRequestSchema,
  listRoundsQuerySchema,
  roundIdParamsSchema,
  roundListResponseSchema,
  roundResponseSchema,
  updateRoundRequestSchema,
} from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withTransaction } from '../db.js';
import { ADMIN_ACTIONS, logAdminChange, sentFields } from '../http/audit-log.js';
import {
  createRound,
  createRoundBatch,
  deleteRound,
  listRounds,
  updateRound,
} from '../services/rounds.js';

// These admin writes are not registration writes, so they take no idempotency_key: a retried
// create or batch hits the (term, grade) unique constraint and answers 409 round_exists, a
// retried PATCH sets the same values again, and a retried DELETE answers 404. Who made each
// change is recorded by logAdminChange (http/audit-log.ts). A PATCH that reopens a closed round
// (open or upcoming) also promotes waiters into its free seats in the same transaction
// (updateRound): those are waitlist_promote events with this admin as actor and no key, and a
// retry promotes nobody more, since the seats are already taken. Its log line names the
// promotions by count and student id.
export const adminRoundRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // A hook on this encapsulated plugin covers every route below, so none can be left open.
    // preValidation rather than preHandler: callers who are not admins learn nothing about the
    // request schema from validation errors.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    app.get(
      '/admin/rounds',
      {
        schema: { querystring: listRoundsQuerySchema, response: { 200: roundListResponseSchema } },
      },
      async (request) => ({ rounds: await listRounds(pool, request.query, new Date()) }),
    );

    app.post(
      '/admin/rounds',
      { schema: { body: createRoundRequestSchema, response: { 201: roundResponseSchema } } },
      async (request, reply) => {
        const round = await createRound(pool, request.body, new Date());
        const { id: roundId, term, grade, opensAt, closesAt, maxActive } = round;
        logAdminChange(request, ADMIN_ACTIONS.roundCreate, {
          roundId,
          term,
          grade,
          opensAt,
          closesAt,
          maxActive,
        });
        return await reply.status(201).send({ round });
      },
    );

    app.post(
      '/admin/rounds/batch',
      {
        schema: { body: createRoundBatchRequestSchema, response: { 201: roundListResponseSchema } },
      },
      async (request, reply) => {
        const rounds = await createRoundBatch(pool, request.body, new Date());
        const { term, opensAt, closesAt, maxActive } = request.body;
        // The body may carry any offset (+07:00); the other round lines log the stored UTC form,
        // so one search finds a window whichever route set it.
        logAdminChange(request, ADMIN_ACTIONS.roundCreateBatch, {
          term,
          roundIds: rounds.map(({ id }) => id),
          opensAt: new Date(opensAt).toISOString(),
          closesAt: new Date(closesAt).toISOString(),
          maxActive,
        });
        return await reply.status(201).send({ rounds });
      },
    );

    app.patch(
      '/admin/rounds/:id',
      {
        schema: {
          params: roundIdParamsSchema,
          body: updateRoundRequestSchema,
          response: { 200: roundResponseSchema },
        },
      },
      async (request) => {
        const actorId = requireAuthUser(request).id;
        const { round, promotions } = await withTransaction(
          pool,
          async (client) =>
            await updateRound(client, {
              id: request.params.id,
              changes: request.body,
              actorId,
              now: new Date(),
            }),
        );
        const { id: roundId, opensAt, closesAt, maxActive } = round;
        logAdminChange(request, ADMIN_ACTIONS.roundUpdate, {
          roundId,
          changed: sentFields(request.body),
          opensAt,
          closesAt,
          maxActive,
          promoted: promotions.length,
          ...(promotions.length > 0
            ? { promotedStudentIds: promotions.map(({ studentId }) => studentId) }
            : {}),
        });
        return { round };
      },
    );

    app.delete(
      '/admin/rounds/:id',
      { schema: { params: roundIdParamsSchema } },
      async (request, reply) => {
        await deleteRound(pool, request.params.id);
        logAdminChange(request, ADMIN_ACTIONS.roundDelete, { roundId: request.params.id });
        return await reply.status(204).send();
      },
    );
  };
