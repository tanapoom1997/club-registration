import {
  ERROR_CODES,
  changePasswordRequestSchema,
  loginRequestSchema,
  sessionResponseSchema,
} from '@club-registration/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { changePassword, login, logout } from '../auth/service.js';
import {
  clearSessionCookie,
  issueSessionCookie,
  readSession,
  requireAuthUser,
} from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { toSessionUser } from '../auth/users.js';
import { AppError } from '../errors.js';

const MINUTE_MS = 60_000;

// Keyed by IP + login ID, not login ID alone, so someone elsewhere cannot lock a student out by
// spamming that student's ID.
const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
const LOGIN_ACCOUNT_WINDOW_MS = 15 * MINUTE_MS;
// Generous because a whole school can sit behind one NAT address when a round opens; this only
// caps how much Argon2 work a single source can force. Revisit after the load test.
const LOGIN_ATTEMPTS_PER_IP = 600;
const LOGIN_IP_WINDOW_MS = MINUTE_MS;
const PASSWORD_CHANGES_PER_USER = 10;
const PASSWORD_CHANGE_WINDOW_MS = 15 * MINUTE_MS;

type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

// The plugin runs at most one limiter per request, so routes needing two check them by hand.
const enforceLimits = async (
  limiters: readonly Limiter[],
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  for (const limiter of limiters) {
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) {
      void reply.header('retry-after', String(result.ttlInSeconds));
      throw new AppError(ERROR_CODES.rateLimited);
    }
  }
};

const loginIdOf = (request: FastifyRequest): string => {
  const parsed = loginRequestSchema.pick({ loginId: true }).safeParse(request.body);
  return parsed.success ? parsed.data.loginId : '';
};

export const authRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    const loginLimiters = [
      app.createRateLimit({ max: LOGIN_ATTEMPTS_PER_IP, timeWindow: LOGIN_IP_WINDOW_MS }),
      app.createRateLimit({
        max: LOGIN_ATTEMPTS_PER_ACCOUNT,
        timeWindow: LOGIN_ACCOUNT_WINDOW_MS,
        keyGenerator: (request) => `${request.ip}|${loginIdOf(request)}`,
      }),
    ];
    const passwordChangeLimiters = [
      app.createRateLimit({
        max: PASSWORD_CHANGES_PER_USER,
        timeWindow: PASSWORD_CHANGE_WINDOW_MS,
        keyGenerator: (request) => String(request.authUser?.id),
      }),
    ];

    app.post(
      '/auth/login',
      {
        schema: { body: loginRequestSchema, response: { 200: sessionResponseSchema } },
        preHandler: async (request, reply) => {
          await enforceLimits(loginLimiters, request, reply);
        },
      },
      async (request, reply) => {
        const user = await login(pool, request.body);
        issueSessionCookie(reply, user);
        return { user: toSessionUser(user) };
      },
    );

    app.get(
      '/auth/me',
      {
        schema: { response: { 200: sessionResponseSchema } },
        preHandler: guard({ allowPendingPasswordChange: true }),
      },
      (request) => ({ user: toSessionUser(requireAuthUser(request)) }),
    );

    app.post(
      '/auth/change-password',
      {
        schema: { body: changePasswordRequestSchema, response: { 200: sessionResponseSchema } },
        preHandler: [
          guard({ allowPendingPasswordChange: true }),
          async (request, reply) => {
            await enforceLimits(passwordChangeLimiters, request, reply);
          },
        ],
      },
      async (request, reply) => {
        const user = await changePassword(pool, requireAuthUser(request), request.body);
        // The change bumped session_version, so the old cookie is dead; hand out a fresh one.
        issueSessionCookie(reply, user);
        return { user: toSessionUser(user) };
      },
    );

    // Unguarded so an expired or revoked session can still clear its cookie.
    app.post('/auth/logout', async (request, reply) => {
      const user = await readSession(pool, request);
      if (user) await logout(pool, user);
      clearSessionCookie(reply);
      return await reply.status(204).send();
    });
  };
