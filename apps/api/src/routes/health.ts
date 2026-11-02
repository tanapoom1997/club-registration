import { healthResponseSchema } from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { pingDatabase } from '../db.js';

export const healthRoutes =
  (pool: pg.Pool): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    app.get(
      '/health',
      { schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } } },
      async (request, reply) => {
        try {
          await pingDatabase(pool);
          return await reply.status(200).send({ status: 'ok', database: 'up' });
        } catch (error) {
          request.log.error({ err: error }, 'database health check failed');
          return await reply.status(503).send({ status: 'degraded', database: 'down' });
        }
      },
    );
  };
