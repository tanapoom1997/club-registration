import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSameOrigin, isSameOriginRequest } from '../src/http/same-origin.js';
import { AppError } from '../src/errors.js';

const APP_HOST = 'club-registration.example.test';

// No database: a bare Fastify instance is enough to see what the check decides per header set.
const buildProbe = (trustProxy = false) => {
  const app = Fastify({ trustProxy });
  app.post('/probe', (request) => ({ allowed: isSameOriginRequest(request) }));
  return app;
};

describe('same-origin check', () => {
  let app: ReturnType<typeof buildProbe> | undefined;

  const probe = async (headers: Record<string, string>, trustProxy = false) => {
    app = buildProbe(trustProxy);
    const response = await app.inject({ method: 'POST', url: '/probe', headers });
    return response.json<{ allowed: boolean }>().allowed;
  };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    ['same-origin', true],
    ['none', true],
    ['SAME-ORIGIN', true],
    ['same-site', false],
    ['cross-site', false],
  ])('decides Sec-Fetch-Site: %s → %s', async (value, allowed) => {
    expect(await probe({ host: APP_HOST, 'sec-fetch-site': value })).toBe(allowed);
  });

  it('trusts Sec-Fetch-Site over Origin when both are sent', async () => {
    expect(
      await probe({
        host: APP_HOST,
        'sec-fetch-site': 'cross-site',
        origin: `https://${APP_HOST}`,
      }),
    ).toBe(false);
  });

  it.each([
    ['the same host', `https://${APP_HOST}`, true],
    ['the same host in other case', `https://${APP_HOST.toUpperCase()}`, true],
    ['another host', 'https://attacker.example.test', false],
    ['the same host on another port', `https://${APP_HOST}:8443`, false],
    ['a subdomain', `https://evil.${APP_HOST}`, false],
    ['"null"', 'null', false],
    ['garbage', 'not a url', false],
  ])('without Sec-Fetch-Site, decides an Origin of %s', async (_label, origin, allowed) => {
    expect(await probe({ host: APP_HOST, origin })).toBe(allowed);
  });

  it('allows a request with neither header (not a browser form)', async () => {
    expect(await probe({ host: APP_HOST })).toBe(true);
  });

  it('compares with X-Forwarded-Host only when the proxy is trusted', async () => {
    const headers = {
      host: 'api:3000',
      'x-forwarded-host': APP_HOST,
      origin: `https://${APP_HOST}`,
    };

    expect(await probe(headers, true)).toBe(true);
    expect(await probe(headers, false)).toBe(false);
  });

  it('throws 403 forbidden from assertSameOrigin for a cross-site request', async () => {
    app = Fastify();
    app.post('/guarded', (request) => {
      assertSameOrigin(request);
      return { ok: true };
    });
    let thrown: unknown;
    app.setErrorHandler(async (error, _request, reply) => {
      thrown = error;
      return await reply.status(403).send({});
    });

    await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'forbidden', statusCode: 403 });
  });
});
