import { z } from 'zod';
import { loginIdSchema } from './auth.js';
import { idempotencyKeySchema } from './idempotency.js';
import { dbIdSchema } from './rounds.js';

// An admin's view of who holds a seat in a club, and an admin seating or removing a student in
// their place (README Phase 2, PR 3a). Admin routes only: these carry students' names.

// How the student got the seat they hold now: the latest event that moved one of their seats in
// the round. 'student' = their own register or change, 'waitlist' = promoted off a waitlist,
// 'admin' = seated by an admin. null only for a seat with no such event, which no writer of the
// api leaves (every seat write logs one); kept nullable so a hand-made row cannot break the list.
export const CLUB_MEMBER_SOURCES = Object.freeze(['student', 'waitlist', 'admin'] as const);
export const clubMemberSourceSchema = z.enum(CLUB_MEMBER_SOURCES);
export type ClubMemberSource = z.infer<typeof clubMemberSourceSchema>;

export const clubMemberSchema = z.object({
  studentId: z.number().int().positive(),
  loginId: z.string(),
  fullName: z.string(),
  classroom: z.string(),
  seatNo: z.number().int().positive(),
  // When the student got this club (a move resets it, as a student's change does).
  registeredAt: z.iso.datetime(),
  source: clubMemberSourceSchema.nullable(),
});
export type ClubMember = z.infer<typeof clubMemberSchema>;

// The club's seats as they stand with the members listed beside them (one snapshot, or after the
// write and its promotions). No advisors: the page that edits members already has them.
export const clubSeatsSchema = z.object({
  id: z.number().int().positive(),
  roundId: z.number().int().positive(),
  clubCode: z.string(),
  name: z.string(),
  capacity: z.number().int().nonnegative(),
  registered: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export type ClubSeats = z.infer<typeof clubSeatsSchema>;

// Members in the order the exports list them: classroom (numeric-aware), then seat number.
export const clubMembersResponseSchema = z.object({
  club: clubSeatsSchema,
  members: z.array(clubMemberSchema),
});
export type ClubMembersResponse = z.infer<typeof clubMembersResponseSchema>;

// The student is named by login ID (the student code an admin reads off a list), never by a
// database id. Strict: the round comes from the club, the club left from the DB, so a body that
// tries to name either (roundId, fromClubId) or anything else is refused with 400.
export const clubMemberRequestSchema = z.strictObject({
  loginId: loginIdSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ClubMemberRequest = z.infer<typeof clubMemberRequestSchema>;

// Both writes answer with the student's seat in this club after the request and every promotion
// it caused (null = not in this club: after a remove, or when a promotion cascade moved the
// student on to the club they waited for), and the club's seats at that moment. A replayed key
// answers with the state now, like the students' writes.
export const clubMemberWriteResponseSchema = z.object({
  club: clubSeatsSchema,
  member: clubMemberSchema.nullable(),
});
export type ClubMemberWriteResponse = z.infer<typeof clubMemberWriteResponseSchema>;

// A club named in an admin answer beside a student: the club a waiter holds in the round, or the
// club an event is about.
export const clubRefSchema = z.object({
  id: z.number().int().positive(),
  clubCode: z.string(),
  name: z.string(),
});
export type ClubRef = z.infer<typeof clubRefSchema>;

// An admin's view of a club's waitlist, and an admin removing a student from it (README Phase 2,
// PR 3b). position 1 = next in line, in queue order (created_at, id) as the promote engine reads
// it. heldClub: the club the waiter holds in the round, if any (a promotion moves them from it).
export const clubWaitlistEntrySchema = z.object({
  position: z.number().int().positive(),
  studentId: z.number().int().positive(),
  loginId: z.string(),
  fullName: z.string(),
  classroom: z.string(),
  seatNo: z.number().int().positive(),
  joinedAt: z.iso.datetime(),
  heldClub: clubRefSchema.nullable(),
});
export type ClubWaitlistEntry = z.infer<typeof clubWaitlistEntrySchema>;

// The list and the removal answer alike: the club's seats and its whole queue at one moment (one
// snapshot, or right after the removal under the round lock).
export const clubWaitlistResponseSchema = z.object({
  club: clubSeatsSchema,
  entries: z.array(clubWaitlistEntrySchema),
});
export type ClubWaitlistResponse = z.infer<typeof clubWaitlistResponseSchema>;

// Same body as seating or removing a member, strict for the same reasons: the student by login
// ID, the round from the club.
export const clubWaitlistRemoveRequestSchema = clubMemberRequestSchema;
export type ClubWaitlistRemoveRequest = z.infer<typeof clubWaitlistRemoveRequestSchema>;

// Every student of a round's grade and where each stands in the round, for an admin who knows a
// student's name or classroom but not their code: the members panel searches it client-side and
// fills the login ID the assign takes. The grade is the student's current one (an import may have
// moved members of a closed round on). No query parameters, strict like the students' reads, so
// a filter the endpoint does not have is refused instead of silently ignored.
export const roundStudentsParamsSchema = z.object({ roundId: dbIdSchema });
export type RoundStudentsParams = z.infer<typeof roundStudentsParamsSchema>;

export const roundStudentsQuerySchema = z.strictObject({});
export type RoundStudentsQuery = z.infer<typeof roundStudentsQuerySchema>;

// club: the seat the student holds in this round; waitingFor: the club whose waitlist they are on
// in it. Both can be set at once (a waiter may hold another club meanwhile).
export const roundStudentSchema = z.object({
  loginId: z.string(),
  fullName: z.string(),
  classroom: z.string(),
  seatNo: z.number().int().positive(),
  club: clubRefSchema.nullable(),
  waitingFor: clubRefSchema.nullable(),
});
export type RoundStudent = z.infer<typeof roundStudentSchema>;

// In the export order: classroom (numeric-aware), seat number, then login ID.
export const roundStudentsResponseSchema = z.object({
  students: z.array(roundStudentSchema),
});
export type RoundStudentsResponse = z.infer<typeof roundStudentsResponseSchema>;
