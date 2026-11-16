import { ERROR_CODES } from '@club-registration/shared';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';

// Fetch metadata values a browser sends for a request this app's own pages make (same-origin) or
// one the user started directly, e.g. by typing a URL (none).
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

const hostOfOrigin = (origin: string): string | undefined => {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    // "null" (sandboxed or file pages) and anything else unparsable.
    return undefined;
  }
};

// CSRF guard for routes a cross-site HTML form can reach. A form may POST multipart/form-data
// with no CORS preflight, so the JSON-only defence does not cover uploads and SameSite=Strict
// would be the only barrier. Browsers send Sec-Fetch-Site (modern) or Origin (older ones) on
// such a POST; a request with neither is not from a browser form and carries no ambient cookie
// risk. request.host follows trustProxy, so behind Caddy it is the host the browser used.
export const isSameOriginRequest = (request: FastifyRequest): boolean => {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined) {
    return typeof fetchSite === 'string' && ALLOWED_FETCH_SITES.has(fetchSite.toLowerCase());
  }
  const { origin } = request.headers;
  if (origin === undefined) return true;
  const originHost = hostOfOrigin(origin);
  return originHost !== undefined && originHost === request.host.toLowerCase();
};

// Call first in the preHandler of every route that accepts writes a cross-site form could send.
export const assertSameOrigin = (request: FastifyRequest): void => {
  if (!isSameOriginRequest(request)) throw new AppError(ERROR_CODES.forbidden);
};
