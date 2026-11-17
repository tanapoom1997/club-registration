import { z } from 'zod';
import { roundSchema } from './rounds.js';

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
// would see, so they stay on admin routes (README "Security").
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
