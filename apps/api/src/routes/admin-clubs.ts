import {
  adminClubResponseSchema,
  clubIdParamsSchema,
  roundClubsParamsSchema,
  roundClubsResponseSchema,
  updateClubRequestSchema,
} from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { withTransaction } from '../db.js';
import { ADMIN_ACTIONS, logAdminChange, sentFields } from '../http/audit-log.js';
import { listRoundClubs, updateClub } from '../services/clubs.js';
import type { QueueSettings } from '../services/queue.js';

// Same convention as the round routes: a club edit takes no idempotency_key and writes no event of
// its own (registration_events rows need a student). A retried PATCH sets the same values again.
// It is an in-round write, though, so it runs in a transaction that takes the round's advisory
// lock first (updateClub), and an edit that raises capacity promotes waiters in that same
// transaction: those are waitlist_promote events with this admin as actor and no key, as every
// promotion has. A retry still has the same effect, since the seats it freed are already taken
// and nothing is left to promote. Responses carry advisors' contact details, so the only log line
// is logAdminChange's, with ids, field names, the capacity and the promotions (count and student
// ids): never a club's text, an advisor or a student's name.
// `settings` (the queue's) is for the round in the list's answer, whose queue counts use the
// queue's own idea of a live ticket.
export const adminClubRoutes =
  ({
    pool,
    guard,
    settings,
  }: {
    pool: pg.Pool;
    guard: AuthGuard;
    settings: QueueSettings;
  }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for rounds: non-admins learn nothing about the schema from a 400.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    app.get(
      '/admin/rounds/:roundId/clubs',
      {
        schema: { params: roundClubsParamsSchema, response: { 200: roundClubsResponseSchema } },
      },
      async (request) =>
        await listRoundClubs(pool, request.params.roundId, { now: new Date(), settings }),
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
        const actorId = requireAuthUser(request).id;
        const { club, promotions } = await withTransaction(
          pool,
          async (client) =>
            await updateClub(client, { clubId: request.params.id, changes: request.body, actorId }),
        );
        logAdminChange(request, ADMIN_ACTIONS.clubUpdate, {
          clubId: club.id,
          roundId: club.roundId,
          changed: sentFields(request.body),
          capacity: club.capacity,
          promoted: promotions.length,
          ...(promotions.length > 0
            ? { promotedStudentIds: promotions.map(({ studentId }) => studentId) }
            : {}),
        });
        return { club };
      },
    );
  };
