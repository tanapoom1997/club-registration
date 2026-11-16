import { ERROR_CODES } from '@club-registration/shared';
import type { ErrorResponse } from '@club-registration/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type pg from 'pg';
import { createAuthGuard, JWT_ALGORITHM, SESSION_TTL_SECONDS } from './auth/session.js';
import { AppError } from './errors.js';
import { adminRoundRoutes } from './routes/admin-rounds.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';

// JSON bodies in this API are tiny; routes that take uploads raise this for themselves.
const BODY_LIMIT_BYTES = 64 * 1024;

type AppOptions = {
  pool: pg.Pool;
  jwtSecret: string;
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

const isValidationError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'validation' in error;

export const buildApp = async ({
  pool,
  jwtSecret,
  logger = false,
  trustProxy = false,
}: AppOptions) => {
  const app = Fastify({
    logger,
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('authUser', null);

  await app.register(fastifyHelmet);
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: jwtSecret,
    sign: { algorithm: JWT_ALGORITHM, expiresIn: SESSION_TTL_SECONDS },
    // Pinning the algorithm stops a token from choosing its own (e.g. "none").
    verify: { algorithms: [JWT_ALGORITHM] },
  });
  // Limits are opted into per route with app.createRateLimit().
  await app.register(fastifyRateLimit, { global: false });

  app.setNotFoundHandler(async (_request, reply) => {
    const body: ErrorResponse = { code: ERROR_CODES.notFound, message: 'Route not found' };
    return await reply.status(404).send(body);
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      const body: ErrorResponse = { code: error.code, message: error.message };
      return await reply.status(error.statusCode).send(body);
    }
    if (isValidationError(error)) {
      const body: ErrorResponse = {
        code: ERROR_CODES.validationError,
        message: 'Request failed validation',
      };
      return await reply.status(400).send(body);
    }
    const status = clientErrorStatus(error);
    if (status !== undefined) {
      const body: ErrorResponse = { code: ERROR_CODES.badRequest, message: 'Invalid request' };
      return await reply.status(status).send(body);
    }
    request.log.error({ err: error }, 'unhandled error');
    const body: ErrorResponse = {
      code: ERROR_CODES.internalError,
      message: 'Internal server error',
    };
    return await reply.status(500).send(body);
  });

  const guard = createAuthGuard(pool);
  await app.register(healthRoutes(pool), { prefix: '/api' });
  await app.register(authRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(adminRoundRoutes({ pool, guard }), { prefix: '/api' });

  return app;
};
