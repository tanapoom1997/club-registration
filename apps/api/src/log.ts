import type { FastifyRequest } from 'fastify';
import pg from 'pg';

// Replace Fastify's defaults (pino's): every logger the app creates writes through these, so
// personal data stays out of the log however a line is produced (CLAUDE.md rule 10).

type SerializedError = { type: string; message: string; stack: string; [key: string]: unknown };

// Identifiers that say which statement and constraint failed. Left out on purpose: detail and
// where quote row values ("Key (login_id)=(...) already exists"), and hint, position and
// internalQuery can quote the statement's input.
const PG_ERROR_FIELDS = Object.freeze([
  'code',
  'severity',
  'constraint',
  'table',
  'column',
  'schema',
  'routine',
] as const);

// From Fastify errors, our AppError and Node system errors (e.g. ECONNREFUSED to the database).
// An allowlist rather than every enumerable property, which is what pino copies: a library error
// may carry the input it choked on.
const SAFE_ERROR_FIELDS = Object.freeze([
  'code',
  'statusCode',
  'errno',
  'syscall',
  'address',
  'port',
] as const);

// Class 22 (data exception) messages quote the offending value itself, e.g.
// invalid input syntax for type integer: "...". Other classes name only identifiers.
const DATA_EXCEPTION_CLASS = '22';
const MAX_NESTED_DEPTH = 3;

// Every field listed is an own enumerable property (set in the error's constructor or by pg's
// parser), so a spread reaches them all without a cast.
const pickFields = (error: Error, fields: readonly string[]): Record<string, unknown> => {
  const own: Record<string, unknown> = { ...error };
  return Object.fromEntries(
    fields
      .map((field): [string, unknown] => [field, own[field]])
      .filter(([, value]) => value !== undefined),
  );
};

const safeMessage = (error: Error): string =>
  error instanceof pg.DatabaseError && error.code?.startsWith(DATA_EXCEPTION_CLASS)
    ? `data exception ${error.code} (message withheld: it quotes input values)`
    : error.message;

const serializeAt = (value: unknown, depth: number): SerializedError => {
  if (!(value instanceof Error)) {
    // Never String(value): a thrown object could be anything, including a whole row.
    return { type: typeof value, message: 'non-Error value thrown', stack: '' };
  }
  const message = safeMessage(value);
  // The stack starts with the message, so a withheld message must go from there too. A function
  // replacer: a string one would expand $' and $& in the message.
  const stack =
    message === value.message
      ? (value.stack ?? '')
      : (value.stack ?? '').replace(value.message, () => message);
  const fields = value instanceof pg.DatabaseError ? PG_ERROR_FIELDS : SAFE_ERROR_FIELDS;
  const nested =
    depth < MAX_NESTED_DEPTH
      ? {
          ...(value.cause === undefined ? {} : { cause: serializeAt(value.cause, depth + 1) }),
          // Node reports a refused connection to every address of a host as an AggregateError.
          ...(value instanceof AggregateError
            ? { errors: value.errors.map((inner) => serializeAt(inner, depth + 1)) }
            : {}),
        }
      : {};
  return {
    type: value.constructor.name,
    message,
    stack,
    ...pickFields(value, fields),
    ...nested,
  };
};

export const serializeError = (error: unknown): SerializedError => serializeAt(error, 0);

// No remoteAddress or remotePort: next to the request id, which ties a request's lines to the
// student id the routes log, an IP points at a student's device or home. Caddy keeps no access
// log for the same reason (Caddyfile). Abuse is handled by the in-memory rate limits instead.
export const serializeRequest = (request: FastifyRequest) => ({
  method: request.method,
  url: request.url,
  host: request.host,
});

export const LOG_SERIALIZERS = Object.freeze({ req: serializeRequest, err: serializeError });
