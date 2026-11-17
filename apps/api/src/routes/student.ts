import {
  studentClubsResponseSchema,
  studentQuerySchema,
  studentRoundResponseSchema,
} from '@club-registration/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { listStudentClubs, readStudentRound } from '../services/student-round.js';

// Read-only views for a logged-in student. The student, and through their profile the grade and
// round, come from the session alone: no path or query parameter can choose them. Responses carry
// club and advisor names, so nothing here logs a club, advisor or student.
export const studentRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // preValidation, as for admin routes: other roles learn nothing about the schema from a 400.
    app.addHook('preValidation', guard({ roles: ['student'] }));

    app.get(
      '/student/round',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentRoundResponseSchema } },
      },
      async (request) => await readStudentRound(pool, requireAuthUser(request).id, new Date()),
    );

    app.get(
      '/student/clubs',
      {
        schema: { querystring: studentQuerySchema, response: { 200: studentClubsResponseSchema } },
      },
      async (request) => await listStudentClubs(pool, requireAuthUser(request).id, new Date()),
    );
  };
