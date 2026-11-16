import { ERROR_CODES, roleSchema } from '@club-registration/shared';
import type { Role } from '@club-registration/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { findUserById } from './users.js';
import type { AuthenticatedUser } from './users.js';

export const SESSION_COOKIE = 'session';
// Short on purpose: a registration visit takes minutes, and a leaked token should die quickly.
export const SESSION_TTL_SECONDS = 2 * 60 * 60;
export const JWT_ALGORITHM = 'HS256';

// SameSite=Strict plus JSON-only write endpoints is the CSRF defence: a cross-site form cannot
// send the cookie, and it cannot send application/json without a CORS preflight we never grant.
const COOKIE_OPTIONS: CookieSerializeOptions = Object.freeze({
  path: '/api',
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
});

const tokenPayloadSchema = z.object({
  sub: z.string().regex(/^[1-9]\d*$/),
  role: roleSchema,
  sv: z.number().int().nonnegative(),
});

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
  }
}

export const issueSessionCookie = (reply: FastifyReply, user: AuthenticatedUser): void => {
  const token = reply.server.jwt.sign({
    sub: String(user.id),
    role: user.role,
    sv: user.sessionVersion,
  });
  void reply.setCookie(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL_SECONDS });
};

export const clearSessionCookie = (reply: FastifyReply): void => {
  void reply.clearCookie(SESSION_COOKIE, COOKIE_OPTIONS);
};

const verifiedPayload = (request: FastifyRequest) => {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined) return undefined;
  try {
    return tokenPayloadSchema.parse(request.server.jwt.verify(token));
  } catch (error) {
    // Expired or tampered tokens are routine; debug level keeps them out of production logs.
    request.log.debug({ err: error }, 'rejected session token');
    return undefined;
  }
};

// Role and identity come only from the server-signed token; the DB lookup then confirms the token
// has not been revoked (session_version) and the role has not changed since it was issued.
export const readSession = async (
  pool: pg.Pool,
  request: FastifyRequest,
): Promise<AuthenticatedUser | undefined> => {
  const payload = verifiedPayload(request);
  if (!payload) return undefined;
  const user = await findUserById(pool, Number(payload.sub));
  if (user?.sessionVersion !== payload.sv || user.role !== payload.role) return undefined;
  return user;
};

export type GuardOptions = {
  roles?: readonly Role[];
  // Only the endpoints a user needs to get past the forced password change set this.
  allowPendingPasswordChange?: boolean;
};

export const createAuthGuard =
  (pool: pg.Pool) =>
  ({ roles, allowPendingPasswordChange = false }: GuardOptions = {}): preHandlerAsyncHookHandler =>
  async (request) => {
    const user = await readSession(pool, request);
    if (!user) throw new AppError(ERROR_CODES.unauthorized);
    if (user.mustChangePassword && !allowPendingPasswordChange) {
      throw new AppError(ERROR_CODES.passwordChangeRequired);
    }
    if (roles && !roles.includes(user.role)) throw new AppError(ERROR_CODES.forbidden);
    request.authUser = user;
  };

export type AuthGuard = ReturnType<typeof createAuthGuard>;

// For handlers behind the guard; reaching this without a user is a wiring bug, not a client error.
export const requireAuthUser = (request: FastifyRequest): AuthenticatedUser => {
  if (!request.authUser) throw new Error('Route is missing the auth guard');
  return request.authUser;
};
