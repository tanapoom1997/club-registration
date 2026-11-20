import { z } from 'zod';
import { loginIdSchema } from './auth.js';
import { idempotencyKeySchema } from './idempotency.js';

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
