import {
  ERROR_CODES,
  ISSUED_COUNT_HEADER,
  issueInitialPasswordsRequestSchema,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  passwordStatusResponseSchema,
} from '@club-registration/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { requireAuthUser } from '../auth/session.js';
import type { AuthGuard } from '../auth/session.js';
import { createConcurrencyLimit } from '../concurrency-limit.js';
import { AppError } from '../errors.js';
import { buildInitialPasswordWorkbook } from '../export/initial-passwords-workbook.js';
import { ADMIN_ACTIONS, logAdminChange } from '../http/audit-log.js';
import { assertSameOrigin } from '../http/same-origin.js';
import {
  assertIdempotencyKeyUnused,
  commitPasswords,
  getPasswordStatus,
  preparePasswords,
} from '../services/initial-passwords.js';
import type { IssueScope } from '../services/initial-passwords.js';
import { assertResetKeyUnused, commitReset, prepareReset } from '../services/password-reset.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Half of libuv's default 4 threads: logins (one Argon2 verify each) keep the other half while a
// whole grade is being hashed, however many admins issue at once.
const HASH_CONCURRENCY = 2;
// Each request can mean hundreds of Argon2 hashes. Generous enough to go classroom by classroom
// through a grade, small enough that a stuck button cannot keep the CPU busy.
const ISSUES_PER_ADMIN = 20;
const ISSUE_WINDOW_MS = 10 * 60_000;
// One hash each, typed in by hand one student at a time: one every ten seconds is more than any
// admin at a desk needs, and a budget of its own keeps resets from using up the issuance's.
const RESETS_PER_ADMIN = 60;
const RESET_WINDOW_MS = 10 * 60_000;

// Scope only: the file name must never carry a name or ID. Classrooms are free text, so only
// ASCII letters and digits of it are kept.
const attachmentName = ({ grade, classroom }: IssueScope): string => {
  const room = classroom?.replace(/[^A-Za-z0-9]/g, '') ?? '';
  return `initial-passwords-grade-${grade}${room === '' ? '' : `-room-${room}`}.xlsx`;
};

export const adminStudentRoutes =
  ({ pool, guard }: { pool: pg.Pool; guard: AuthGuard }): FastifyPluginAsyncZod =>
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins must be async
  async (app) => {
    // Same reason as admin rounds: non-admins are refused before anything is read or validated.
    app.addHook('preValidation', guard({ roles: ['admin'] }));

    // One limit for the whole server, not per request, so two admins issuing at once still use
    // at most HASH_CONCURRENCY threads between them.
    const hashLimit = createConcurrencyLimit(HASH_CONCURRENCY);
    const issueLimiter = app.createRateLimit({
      max: ISSUES_PER_ADMIN,
      timeWindow: ISSUE_WINDOW_MS,
      keyGenerator: (request) => String(request.authUser?.id),
    });

    const resetLimiter = app.createRateLimit({
      max: RESETS_PER_ADMIN,
      timeWindow: RESET_WINDOW_MS,
      keyGenerator: (request) => String(request.authUser?.id),
    });

    // Both writes answer with live passwords: JSON alone already stops cross-site forms, and this
    // also refuses a cross-site fetch outright.
    const passwordWriteGate =
      (limiter: typeof issueLimiter) => async (request: FastifyRequest, reply: FastifyReply) => {
        assertSameOrigin(request);
        const limit = await limiter(request);
        if (!limit.isAllowed && limit.isExceeded) {
          void reply.header('retry-after', String(limit.ttlInSeconds));
          throw new AppError(ERROR_CODES.rateLimited);
        }
      };

    app.get(
      '/admin/students/password-status',
      { schema: { response: { 200: passwordStatusResponseSchema } } },
      async () => ({ classrooms: await getPasswordStatus(pool) }),
    );

    // Answers with the .xlsx of new passwords; nothing about them is kept but the Argon2 hashes.
    //
    // Idempotency: unlike the import, repeating this is not harmless. Every issuance replaces the
    // passwords of the previous one, so a replayed request (a client or proxy retry of a request
    // that did commit) would silently invalidate the file the admin may already have printed.
    // The key is therefore stored with the issuance (password_issuances, same transaction) and a
    // request reusing it gets 409 idempotency_key_reused instead of a second issuance. The first
    // response cannot be replayed, because the passwords were never stored; an admin who lost the
    // file issues again with a new key, which the web app generates per click. The audit row goes
    // to password_issuances, not registration_events (CLAUDE.md rule 7): an issuance belongs to no
    // round and is not a registration event.
    app.post(
      '/admin/students/initial-passwords',
      {
        schema: { body: issueInitialPasswordsRequestSchema },
        preHandler: passwordWriteGate(issueLimiter),
      },
      async (request, reply) => {
        const admin = requireAuthUser(request);
        const { grade, classroom, onlyUnissued, idempotencyKey } = request.body;
        const scope: IssueScope = { grade, classroom, onlyUnissued };
        const startedAt = performance.now();

        // Checked before hashing so a replay costs one query, not a grade's worth of Argon2.
        await assertIdempotencyKeyUnused(pool, admin.id, idempotencyKey);
        const prepared = await preparePasswords(pool, scope, hashLimit);
        const hashedAt = performance.now();
        const issued = await commitPasswords(pool, {
          adminId: admin.id,
          idempotencyKey,
          scope,
          prepared,
        });
        const file = await buildInitialPasswordWorkbook(issued);

        // Scope and counts only: never names, IDs or passwords.
        request.log.info(
          {
            adminId: admin.id,
            grade,
            classroom: classroom ?? null,
            onlyUnissued,
            issuedCount: issued.length,
            skippedCount: prepared.length - issued.length,
            hashMs: Math.round(hashedAt - startedAt),
            totalMs: Math.round(performance.now() - startedAt),
          },
          'initial passwords issued',
        );

        return await reply
          .header('content-type', XLSX_MIME)
          .header('content-disposition', `attachment; filename="${attachmentName(scope)}"`)
          // The body is a list of live passwords: no browser or proxy may keep a copy.
          .header('cache-control', 'no-store')
          .header(ISSUED_COUNT_HEADER, String(issued.length))
          .send(file);
      },
    );

    // One student's password, for a student who forgot it (services/password-reset.ts). Answers
    // with the new password itself, the one copy there is: only its hash is kept.
    //
    // Idempotency as for the issuance: a replay cannot be answered with the same password, which
    // was never stored, and acting again would silently kill the password the admin may already
    // have read out to the student. The key is stored in password_resets (same transaction) and a
    // request reusing it gets 409 idempotency_key_reused; the web app tells the admin the earlier
    // reset went through and a new one is needed. A reset belongs to no round, so its row is
    // there and not in registration_events (CLAUDE.md rule 7).
    app.post(
      '/admin/students/password-reset',
      {
        schema: {
          body: passwordResetRequestSchema,
          response: { 200: passwordResetResponseSchema },
        },
        preHandler: passwordWriteGate(resetLimiter),
      },
      async (request, reply) => {
        const admin = requireAuthUser(request);
        const { loginId, idempotencyKey } = request.body;

        // Before hashing, like the issuance: a replay or a typo costs one query.
        await assertResetKeyUnused(pool, admin.id, idempotencyKey);
        const prepared = await prepareReset(pool, loginId, hashLimit);
        const reset = await commitReset(pool, { adminId: admin.id, idempotencyKey, prepared });

        // Database ids only: never the password, the student's name or login ID (a student code).
        logAdminChange(request, ADMIN_ACTIONS.studentPasswordReset, {
          studentId: prepared.studentId,
        });

        // The body is a live password: no browser or proxy may keep a copy.
        void reply.header('cache-control', 'no-store');
        return reset;
      },
    );
  };
