import { z } from 'zod';
import { idempotencyKeySchema } from './idempotency.js';
import { dbIdBodySchema, roundSchema } from './rounds.js';

// What a logged-in student reads about their own grade's round. The student and their grade come
// from the session only, so these endpoints take no parameters at all. Strict, so an attempt to
// pick a grade, student or round (e.g. ?studentId=) fails with 400 instead of being ignored.
export const studentQuerySchema = z.strictObject({});
export type StudentQuery = z.infer<typeof studentQuerySchema>;

// The admin round minus what only admins need: max_active is a queue setting and the totals are
// summed over every club, which the club list already gives per club.
export const studentRoundSchema = roundSchema.pick({
  id: true,
  term: true,
  grade: true,
  opensAt: true,
  closesAt: true,
  status: true,
});
export type StudentRound = z.infer<typeof studentRoundSchema>;

// The student's own seat in the round.
export const studentRegistrationSchema = z.object({
  club: z.object({
    id: z.number().int().positive(),
    clubCode: z.string(),
    name: z.string(),
  }),
  registeredAt: z.iso.datetime(),
});
export type StudentRegistration = z.infer<typeof studentRegistrationSchema>;

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
});
export type StudentClub = z.infer<typeof studentClubSchema>;

// round null = the student's grade has no round at all; that is a normal state, not an error, and
// registration is then null too.
export const studentRoundResponseSchema = z.object({
  round: studentRoundSchema.nullable(),
  registration: studentRegistrationSchema.nullable(),
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

// Both writes answer with the student's registration in the round as it stands after the request
// (null after a cancel). A replayed key answers with the state now, not a copy of the first reply.
export const studentRegistrationResponseSchema = z.object({
  registration: studentRegistrationSchema.nullable(),
});
export type StudentRegistrationResponse = z.infer<typeof studentRegistrationResponseSchema>;
