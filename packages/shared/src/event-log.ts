import { z } from 'zod';
import { roleSchema } from './auth.js';
import { clubRefSchema } from './club-members.js';
import { dbIdSchema } from './rounds.js';

// The admin's view of registration_events (README Phase 2, decision 3 and PR 3b). Admin routes
// only: every row names a student and the account that acted.

// Mirrors the CHECK on registration_events.event_type in the initial migration exactly
// (apps/api/test/admin-events.test.ts compares the two): a type the DB allows but this list lacks
// would fail the response schema with a 500 instead of being shown.
export const EVENT_TYPES = Object.freeze([
  'register',
  'cancel',
  'change',
  'admin_assign',
  'admin_remove',
  'waitlist_join',
  'waitlist_leave',
  'waitlist_promote',
] as const);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const EVENT_LOG_DEFAULT_LIMIT = 50;
export const EVENT_LOG_MAX_LIMIT = 200;

// Strict: a misspelt filter (clubid, round) must be a 400, not an unfiltered page that looks like
// an answer. Every filter is optional and they combine with AND; clubId matches the club an event
// is about or the club it left (from_club_id). before is the cursor: the nextBefore of the page
// before, so a page holds the events with a smaller id, newest first.
export const eventLogQuerySchema = z.strictObject({
  roundId: dbIdSchema.optional(),
  studentId: dbIdSchema.optional(),
  clubId: dbIdSchema.optional(),
  before: dbIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(EVENT_LOG_MAX_LIMIT).default(EVENT_LOG_DEFAULT_LIMIT),
});
export type EventLogQuery = z.infer<typeof eventLogQuerySchema>;

export const eventRoundSchema = z.object({
  id: z.number().int().positive(),
  term: z.string(),
  grade: z.number().int().positive(),
});
export type EventRound = z.infer<typeof eventRoundSchema>;

// The student as they are now: classroom and seat number come from their profile today (an import
// may have moved them since the event), not from the moment of the event.
export const eventStudentSchema = z.object({
  id: z.number().int().positive(),
  loginId: z.string(),
  fullName: z.string(),
  classroom: z.string(),
  seatNo: z.number().int().positive(),
});
export type EventStudent = z.infer<typeof eventStudentSchema>;

// The student themself for their own requests, the admin for an admin's, and for a promotion
// whoever freed the seat (a student's cancel or change, or an admin's edit).
export const eventActorSchema = z.object({
  id: z.number().int().positive(),
  loginId: z.string(),
  fullName: z.string(),
  role: roleSchema,
});
export type EventActor = z.infer<typeof eventActorSchema>;

// No idempotency key: it is the client's own retry token, of no use to a reader of the log.
export const registrationEventSchema = z.object({
  id: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  eventType: eventTypeSchema,
  round: eventRoundSchema,
  student: eventStudentSchema,
  club: clubRefSchema.nullable(),
  fromClub: clubRefSchema.nullable(),
  actor: eventActorSchema,
});
export type RegistrationEvent = z.infer<typeof registrationEventSchema>;

// nextBefore: pass it as before for the next (older) page; null = this was the last page.
export const eventLogResponseSchema = z.object({
  events: z.array(registrationEventSchema),
  nextBefore: z.number().int().positive().nullable(),
});
export type EventLogResponse = z.infer<typeof eventLogResponseSchema>;
