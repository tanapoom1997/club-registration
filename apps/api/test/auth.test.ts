import { randomBytes } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { errorResponseSchema, sessionResponseSchema } from '@club-registration/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthGuard, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { buildTestApp, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const sessionCookieOf = (response: InjectResponse) =>
  response.cookies.find((cookie) => cookie.name === SESSION_COOKIE);

const errorCodeOf = (response: InjectResponse) => errorResponseSchema.parse(response.json()).code;

describe('auth', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  const postLogin = async (loginId: string, password: string) =>
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { loginId, password } });

  const loginAs = async (user: TestUser): Promise<string> => {
    const response = await postLogin(user.loginId, user.password);
    expect(response.statusCode).toBe(200);
    return sessionCookieOf(response)!.value;
  };

  const getMe = async (token: string) =>
    await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: token } });

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    app = await buildTestApp(pool);
    // Test-only routes exercise the guard the way upcoming business routes will use it.
    const guard = createAuthGuard(pool);
    app.get('/api/test/any-user', { preHandler: guard() }, () => ({ ok: true }));
    app.get('/api/test/admin-only', { preHandler: guard({ roles: ['admin'] }) }, () => ({
      ok: true,
    }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/auth/login', () => {
    it('sets an HttpOnly, Secure, SameSite=Strict session cookie and returns the user', async () => {
      const user = await createTestUser(pool);

      const response = await postLogin(user.loginId, user.password);

      expect(response.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(response.json()).user).toEqual({
        id: user.id,
        loginId: user.loginId,
        fullName: 'Fictional User',
        role: 'student',
        mustChangePassword: false,
      });
      expect(sessionCookieOf(response)).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/api',
        maxAge: SESSION_TTL_SECONDS,
      });
    });

    it('issues a token that expires after the session TTL', async () => {
      const token = await loginAs(await createTestUser(pool));

      const { iat, exp } = app.jwt.decode<{ iat: number; exp: number }>(token)!;

      expect(exp - iat).toBe(SESSION_TTL_SECONDS);
    });

    it('never returns the password hash', async () => {
      const user = await createTestUser(pool);

      const response = await postLogin(user.loginId, user.password);

      expect(response.body).not.toContain('argon2');
    });

    it('matches login IDs case-insensitively', async () => {
      const user = await createTestUser(pool);

      const response = await postLogin(user.loginId.toUpperCase(), user.password);

      expect(response.statusCode).toBe(200);
    });

    it('rejects a wrong password with invalid_credentials and no cookie', async () => {
      const user = await createTestUser(pool);

      const response = await postLogin(user.loginId, 'not-the-password');

      expect(response.statusCode).toBe(401);
      expect(errorCodeOf(response)).toBe('invalid_credentials');
      expect(sessionCookieOf(response)).toBeUndefined();
    });

    it('answers an unknown login ID exactly like a wrong password', async () => {
      const response = await postLogin('nobody-here', 'whatever-password');

      expect(response.statusCode).toBe(401);
      expect(errorCodeOf(response)).toBe('invalid_credentials');
    });

    it('rejects a malformed body with validation_error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { loginId: 'bad id with spaces', password: '' },
      });

      expect(response.statusCode).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_error');
    });

    it('rate limits repeated attempts on one account with 429 and Retry-After', async () => {
      const user = await createTestUser(pool);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await postLogin(user.loginId, 'wrong-password');
      }

      const response = await postLogin(user.loginId, user.password);

      expect(response.statusCode).toBe(429);
      expect(errorCodeOf(response)).toBe('rate_limited');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('keeps other accounts behind the same IP usable while one is rate limited', async () => {
      const [target, classmate] = [await createTestUser(pool), await createTestUser(pool)];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await postLogin(target.loginId, 'wrong-password');
      }

      const response = await postLogin(classmate.loginId, classmate.password);

      expect(response.statusCode).toBe(200);
    });
  });

  describe('session guard', () => {
    it('rejects requests without a session cookie', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

      expect(response.statusCode).toBe(401);
      expect(errorCodeOf(response)).toBe('unauthorized');
    });

    it('rejects a token signed with another secret', async () => {
      const user = await createTestUser(pool);
      const otherApp = await buildApp({ pool, jwtSecret: randomBytes(48).toString('base64url') });
      const forged = otherApp.jwt.sign({ sub: String(user.id), role: 'admin', sv: 0 });
      await otherApp.close();

      const response = await getMe(forged);

      expect(response.statusCode).toBe(401);
    });

    it('rejects an unsigned alg=none token', async () => {
      const user = await createTestUser(pool, { role: 'admin' });
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: String(user.id), role: 'admin', sv: 0 })}.`;

      const response = await getMe(unsigned);

      expect(response.statusCode).toBe(401);
    });

    it('forbids a student from an admin-only route', async () => {
      const token = await loginAs(await createTestUser(pool));

      const response = await app.inject({
        method: 'GET',
        url: '/api/test/admin-only',
        cookies: { [SESSION_COOKIE]: token },
        // Client-supplied role hints must be ignored.
        headers: { 'x-role': 'admin' },
        query: { role: 'admin' },
      });

      expect(response.statusCode).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
    });

    it('lets an admin through an admin-only route', async () => {
      const token = await loginAs(await createTestUser(pool, { role: 'admin' }));

      const response = await app.inject({
        method: 'GET',
        url: '/api/test/admin-only',
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(response.statusCode).toBe(200);
    });

    it('rejects a token whose role no longer matches the database', async () => {
      const user = await createTestUser(pool, { role: 'admin' });
      const token = await loginAs(user);
      await pool.query(`UPDATE users SET role = 'student' WHERE id = $1`, [user.id]);

      const response = await getMe(token);

      expect(response.statusCode).toBe(401);
    });

    it('blocks other routes with password_change_required until the password is changed', async () => {
      const token = await loginAs(await createTestUser(pool, { mustChangePassword: true }));

      const response = await app.inject({
        method: 'GET',
        url: '/api/test/any-user',
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(response.statusCode).toBe(403);
      expect(errorCodeOf(response)).toBe('password_change_required');
    });

    it('still lets a user with a pending password change read /api/auth/me', async () => {
      const token = await loginAs(await createTestUser(pool, { mustChangePassword: true }));

      const response = await getMe(token);

      expect(response.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(response.json()).user.mustChangePassword).toBe(true);
    });
  });

  describe('POST /api/auth/change-password', () => {
    const changePassword = async (token: string, currentPassword: string, newPassword: string) =>
      await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        cookies: { [SESSION_COOKIE]: token },
        payload: { currentPassword, newPassword },
      });

    it('clears must_change_password and issues a working new session', async () => {
      const user = await createTestUser(pool, { mustChangePassword: true });
      const token = await loginAs(user);

      const response = await changePassword(token, user.password, 'a-brand-new-password');

      expect(response.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(response.json()).user.mustChangePassword).toBe(false);
      const newToken = sessionCookieOf(response)!.value;
      expect((await getMe(newToken)).statusCode).toBe(200);
    });

    it('revokes sessions issued before the change', async () => {
      const user = await createTestUser(pool, { mustChangePassword: true });
      const oldToken = await loginAs(user);

      await changePassword(oldToken, user.password, 'a-brand-new-password');

      expect((await getMe(oldToken)).statusCode).toBe(401);
    });

    it('makes the new password the only one that logs in', async () => {
      const user = await createTestUser(pool);
      await changePassword(await loginAs(user), user.password, 'a-brand-new-password');

      const [oldLogin, newLogin] = [
        await postLogin(user.loginId, user.password),
        await postLogin(user.loginId, 'a-brand-new-password'),
      ];

      expect(oldLogin.statusCode).toBe(401);
      expect(newLogin.statusCode).toBe(200);
    });

    it('rejects a wrong current password with invalid_current_password', async () => {
      const user = await createTestUser(pool);
      const token = await loginAs(user);

      const response = await changePassword(token, 'not-the-password', 'a-brand-new-password');

      expect(response.statusCode).toBe(400);
      expect(errorCodeOf(response)).toBe('invalid_current_password');
    });

    it('rejects a new password shorter than the minimum', async () => {
      const user = await createTestUser(pool);
      const token = await loginAs(user);

      const response = await changePassword(token, user.password, 'short');

      expect(response.statusCode).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_error');
    });

    it('requires a session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: { currentPassword: 'whatever-1', newPassword: 'whatever-2' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the session server-side and clears the cookie', async () => {
      const token = await loginAs(await createTestUser(pool));

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(response.statusCode).toBe(204);
      expect(sessionCookieOf(response)).toMatchObject({ value: '', path: '/api' });
      expect((await getMe(token)).statusCode).toBe(401);
    });

    it('succeeds without a session so a stale cookie can always be cleared', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });

      expect(response.statusCode).toBe(204);
    });
  });
});
