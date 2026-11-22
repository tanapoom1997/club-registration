import type { FastifyRequest } from 'fastify';
import { requireAuthUser } from '../auth/session.js';

// Admin writes that keep no row of their own say who did what here instead. Registrations have
// registration_events, password issuance has password_issuances and the import logs its own line
// (routes/admin-import.ts); round and club edits take no idempotency_key (README Phase 1) and
// have no table, so without this line nothing would show which admin changed a window or a
// capacity. An admin seating or removing a student, or taking one off a waitlist
// (routes/admin-club-members.ts), does write registration_events; it logs here too so every admin
// change, and the promotions it caused, is found with one grep. Logged only after the change commits: a refused request changed nothing.
//
// A log line, not a table: it lasts only as long as the container's log rotation keeps it
// (compose.prod.yml), which covers investigating a registration day, not a long-term record.
export const ADMIN_ACTIONS = Object.freeze({
  roundCreate: 'round.create',
  roundCreateBatch: 'round.create_batch',
  roundUpdate: 'round.update',
  roundDelete: 'round.delete',
  clubUpdate: 'club.update',
  clubMemberAssign: 'club.member_assign',
  clubMemberRemove: 'club.member_remove',
  clubWaitlistRemove: 'club.waitlist_remove',
} as const);

export type AdminAction = (typeof ADMIN_ACTIONS)[keyof typeof ADMIN_ACTIONS];

// Ids, numbers, timestamps and field names only. No free text: a club's name and description
// are written by admins and may name people, so a change to them is logged as the field name.
// null is a value of its own (a round's maxActive null = no queue), logged as null, not dropped.
type AuditValue = string | number | null | readonly string[] | readonly number[];

export const logAdminChange = (
  request: FastifyRequest,
  action: AdminAction,
  details: Readonly<Record<string, AuditValue>>,
): void => {
  request.log.info(
    { audit: action, adminId: requireAuthUser(request).id, ...details },
    'admin change',
  );
};

// The fields a PATCH body actually sent, for the "changed" entry. Sorted, so the line does not
// depend on the order of keys in the Zod schema.
export const sentFields = (body: object): string[] =>
  Object.entries(body)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field)
    .sort();
