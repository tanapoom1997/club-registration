import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';
import { dbIdBodySchema, roundSchema } from './rounds.js';

// What a logged-in student reads about their own grade's round. The student and their grade come
// from the session only, so these endpoints take no parameters at all. Strict, so an attempt to
// pick a grade, student or round (e.g. ?studentId=) fails with 400 instead of being ignored.
export const studentQuerySchema = z.strictObject({});
export type StudentQuery = z.infer<typeof studentQuerySchema>;

// The admin round minus what only admins need: max_active is a queue setting, the queue counts are
// the school's load, and the totals are summed over every club, which the club list already gives
// per club. hasQueue is all a student learns of the queue setting: false = the round has no queue
// (max_active NULL), so the page shows the list without queueing, and the queue answers queue_off.
export const studentRoundSchema = roundSchema
  .pick({
    id: true,
    term: true,
    grade: true,
    opensAt: true,
    closesAt: true,
    status: true,
  })
  .extend({ hasQueue: z.boolean() });
export type StudentRound = z.infer<typeof studentRoundSchema>;

// A club as a student's seat or waitlist entry names it.
export const studentClubRefSchema = z.object({
  id: z.number().int().positive(),
  clubCode: z.string(),
  name: z.string(),
});
export type StudentClubRef = z.infer<typeof studentClubRefSchema>;

// The student's own seat in the round. promotedFromWaitlist: the last thing that moved the
// student's seat in this round was a promotion off a waitlist (not their own register or change),
// so the page can say "you got this club from the waitlist" even after a reload; there is no other
// notification (README Phase 2, decision 2).
export const studentRegistrationSchema = z.object({
  club: studentClubRefSchema,
  registeredAt: z.iso.datetime(),
  promotedFromWaitlist: z.boolean(),
});
export type StudentRegistration = z.infer<typeof studentRegistrationSchema>;

// The student's place on a club's waitlist in the round: at most one entry per round. position 1
// = next in line for that club. Joining another club's waitlist starts at the back of that queue.
export const studentWaitlistSchema = z.object({
  club: studentClubRefSchema,
  position: z.number().int().positive(),
  joinedAt: z.iso.datetime(),
});
export type StudentWaitlist = z.infer<typeof studentWaitlistSchema>;

// Advisors are names only. Their phone, email and LINE ID are personal data that ~2,500 students
// would see, so they stay on admin routes (docs/security.md).
export const studentClubSchema = z.object({
  id: z.number().int().positive(),
  clubCode: z.string(),
  name: z.string(),
  // Plain text written by an admin; the web app must render it as text, never as HTML.
  description: z.string(),
  capacity: z.number().int().nonnegative(),
  registered: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  advisorNames: z.array(z.string()),
  // How many students wait for a seat; a count only, never who.
  waitlistCount: z.number().int().nonnegative(),
});
export type StudentClub = z.infer<typeof studentClubSchema>;

// round null = the student's grade has no round at all; that is a normal state, not an error, and
// registration and waitlist are then null too.
export const studentRoundResponseSchema = z.object({
  round: studentRoundSchema.nullable(),
  registration: studentRegistrationSchema.nullable(),
  waitlist: studentWaitlistSchema.nullable(),
});
export type StudentRoundResponse = z.infer<typeof studentRoundResponseSchema>;

// Carries the round and the student's registration as well, so the club page can poll this one
// endpoint and still see the round open or close and which club is theirs.
export const studentClubsResponseSchema = studentRoundResponseSchema.extend({
  clubs: z.array(studentClubSchema),
});
export type StudentClubsResponse = z.infer<typeof studentClubsResponseSchema>;

// Writes. Strict like the reads: the student, grade and round come from the session, so a body
// that tries to name one (e.g. studentId) is refused with 400 rather than ignored. One key per
// click; a retry of the same click sends the same key (README "Idempotency").
export const registerRequestSchema = z.strictObject({
  clubId: dbIdBodySchema,
  idempotencyKey: idempotencyKeySchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

// Cancels the student's registration in their selected round; there is only one, so no club id.
export const cancelRegistrationRequestSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});
export type CancelRegistrationRequest = z.infer<typeof cancelRegistrationRequestSchema>;

// Moves the student's seat in their selected round to another club in one step: the new seat is
// taken before the old one is given back, so a full club leaves the student where they were.
// Same shape as register, but its own schema so the two can diverge without surprising either.
export const changeRegistrationRequestSchema = z.strictObject({
  clubId: dbIdBodySchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ChangeRegistrationRequest = z.infer<typeof changeRegistrationRequestSchema>;

// Joins the waitlist of a full club in the student's selected round. Waiting for another club
// already = that entry is given up (its place is lost) for one at the back of this club's queue.
export const joinWaitlistRequestSchema = z.strictObject({
  clubId: dbIdBodySchema,
  idempotencyKey: idempotencyKeySchema,
});
export type JoinWaitlistRequest = z.infer<typeof joinWaitlistRequestSchema>;

// Leaves the student's one waitlist entry in their selected round, so no club id.
export const leaveWaitlistRequestSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});
export type LeaveWaitlistRequest = z.infer<typeof leaveWaitlistRequestSchema>;

// Both waitlist writes answer with the student's entry as it stands after the request (null after
// leaving), and a replayed key with the entry now, like the registration writes.
export const studentWaitlistResponseSchema = z.object({
  waitlist: studentWaitlistSchema.nullable(),
});
export type StudentWaitlistResponse = z.infer<typeof studentWaitlistResponseSchema>;

// Every registration write answers with the student's registration in the round as it stands
// after the request, promotions off a waitlist in the same transaction included (null after a
// cancel, unless the cancel's cascade promoted the student into the club they waited for). A
// replayed key answers with the state now, not a copy of the first reply.
export const studentRegistrationResponseSchema = z.object({
  registration: studentRegistrationSchema.nullable(),
});
export type StudentRegistrationResponse = z.infer<typeof studentRegistrationResponseSchema>;
