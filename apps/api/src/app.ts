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
import { LOG_SERIALIZERS } from './log.js';
import { adminClubMemberRoutes } from './routes/admin-club-members.js';
import { adminClubRoutes } from './routes/admin-clubs.js';
import { adminEventRoutes } from './routes/admin-events.js';
import { adminExportRoutes } from './routes/admin-export.js';
import { adminImportRoutes } from './routes/admin-import.js';
import { adminRoundRoutes } from './routes/admin-rounds.js';
import { adminStudentRoutes } from './routes/admin-students.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { studentQueueRoutes } from './routes/student-queue.js';
import { studentRoutes } from './routes/student.js';
import { DEFAULT_QUEUE_SETTINGS } from './services/queue.js';
import type { QueueSettings } from './services/queue.js';

// JSON bodies in this API are tiny; routes that take uploads raise this for themselves.
const BODY_LIMIT_BYTES = 64 * 1024;

type AppLogger = boolean | { level: string; stream?: { write: (line: string) => void } };

type AppOptions = {
  pool: pg.Pool;
  jwtSecret: string;
  // stream lets tests capture log lines to prove no secret or personal data is written.
  logger?: AppLogger;
  trustProxy?: boolean;
  // From env in production (config.ts); tests may shorten them.
  queue?: QueueSettings;
};

// Tests' capturing loggers get the same serializers as production, so they test what ships.
const loggerOptions = (logger: AppLogger) =>
  logger === false ? false : { ...(logger === true ? {} : logger), serializers: LOG_SERIALIZERS };

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
  queue = DEFAULT_QUEUE_SETTINGS,
}: AppOptions) => {
  const app = Fastify({
    logger: loggerOptions(logger),
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
  await app.register(adminClubRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(adminClubMemberRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(adminEventRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(adminImportRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(adminStudentRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(adminExportRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(studentRoutes({ pool, guard }), { prefix: '/api' });
  await app.register(studentQueueRoutes({ pool, guard, settings: queue }), { prefix: '/api' });

  return app;
};
