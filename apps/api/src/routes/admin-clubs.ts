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
import { listRoundClubs, updateClub } from '../services/clubs.js';

// Same convention as the round routes: a club edit is not a registration write, so it takes no
// idempotency_key and writes no registration_events row (which needs a student). A retried PATCH
// sets the same values again. Responses carry advisors' contact details, so nothing here logs a
// club or advisor.
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
      async (request) => ({ club: await updateClub(pool, request.params.id, request.body) }),
    );
  };
