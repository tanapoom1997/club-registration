import { eventLogQuerySchema, eventLogResponseSchema } from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { AuthGuard } from '../auth/session.js';
import { listEvents } from '../services/event-log.js';

// The admin event log (README Phase 2, decision 3 and PR 3b). Read-only: one SELECT, no
// idempotency_key, no row written, and no log line of its own beyond Fastify's request line,
// which holds the path and the query's parameter names, never their values (log.ts): the loginId
// filter is a student's code. The answer names students and the accounts that acted, so it is
// never logged.
export const adminEventRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for the other admin routes: non-admins learn nothing from a 400.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    app.get(
      '/admin/events',
      { schema: { querystring: eventLogQuerySchema, response: { 200: eventLogResponseSchema } } },
      async (request) => await listEvents(pool, request.query),
    );
  };
