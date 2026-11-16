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
import type { AuthGuard } from '../auth/session.js';
import {
  createRound,
  createRoundBatch,
  deleteRound,
  listRounds,
  updateRound,
} from '../services/rounds.js';

// These admin writes are not registration writes, so they take no idempotency_key: a retried
// create or batch hits the (term, grade) unique constraint and answers 409 round_exists, a
// retried PATCH sets the same values again, and a retried DELETE answers 404.
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
      async (request) => ({
        round: await updateRound(pool, request.params.id, request.body, new Date()),
      }),
    );

    app.delete(
      '/admin/rounds/:id',
      { schema: { params: roundIdParamsSchema } },
      async (request, reply) => {
        await deleteRound(pool, request.params.id);
        return await reply.status(204).send();
      },
    );
  };
