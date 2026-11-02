import type { ErrorResponse } from '@club-registration/shared';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import { healthRoutes } from './routes/health.js';

type AppOptions = {
  pool: pg.Pool;
  logger?: boolean | { level: string };
  trustProxy?: boolean;
};

const clientErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
};

export const buildApp = async ({ pool, logger = false, trustProxy = false }: AppOptions) => {
  const app = Fastify({ logger, trustProxy }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setNotFoundHandler(async (_request, reply) => {
    const body: ErrorResponse = { code: 'not_found', message: 'Route not found' };
    return await reply.status(404).send(body);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status = clientErrorStatus(error);
    if (status !== undefined) {
      const body: ErrorResponse = { code: 'bad_request', message: 'Invalid request' };
      return await reply.status(status).send(body);
    }
    request.log.error({ err: error }, 'unhandled error');
    const body: ErrorResponse = { code: 'internal_error', message: 'Internal server error' };
    return await reply.status(500).send(body);
  });

  await app.register(healthRoutes(pool), { prefix: '/api' });

  return app;
};
