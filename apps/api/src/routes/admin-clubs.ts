import {
  adminClubResponseSchema,
  clubIdParamsSchema,
  roundClubsParamsSchema,
  roundClubsResponseSchema,
  updateClubRequestSchema,
} from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { AuthGuard } from '../auth/session.js';
import { withTransaction } from '../db.js';
import { ADMIN_ACTIONS, logAdminChange, sentFields } from '../http/audit-log.js';
import { listRoundClubs, updateClub } from '../services/clubs.js';

// Same convention as the round routes: a club edit is not a registration write, so it takes no
// idempotency_key and writes no registration_events row (which needs a student). A retried PATCH
// sets the same values again. It is an in-round write, though, so it runs in a transaction that
// takes the round's advisory lock first (updateClub). Responses carry advisors' contact details, so
// the only log line is logAdminChange's, with ids, field names and the capacity: never a club's
// text or an advisor.
export const adminClubRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for rounds: non-admins learn nothing about the schema from a 400.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    app.get(
      '/admin/rounds/:roundId/clubs',
      {
        schema: { params: roundClubsParamsSchema, response: { 200: roundClubsResponseSchema } },
      },
      async (request) => await listRoundClubs(pool, request.params.roundId, new Date()),
    );

    app.patch(
      '/admin/clubs/:id',
      {
        schema: {
          params: clubIdParamsSchema,
          body: updateClubRequestSchema,
          response: { 200: adminClubResponseSchema },
        },
      },
      async (request) => {
        const club = await withTransaction(
          pool,
          async (client) => await updateClub(client, request.params.id, request.body),
        );
        logAdminChange(request, ADMIN_ACTIONS.clubUpdate, {
          clubId: club.id,
          roundId: club.roundId,
          changed: sentFields(request.body),
          capacity: club.capacity,
        });
        return { club };
      },
    );
  };
