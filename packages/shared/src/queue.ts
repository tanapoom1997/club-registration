import { z } from 'zod';
import { studentRoundSchema } from './student.js';

// The queue in front of a round (README Phase 3): it limits how many students of the round are
// choosing clubs at once (rounds.max_active). The student and their round come from the session
// alone, as for every student endpoint.

// Join, heartbeat and done take no input, but still require the JSON body `{}`: strict, so a body
// that tries to name a student, round or place (e.g. {"position": 1}) is refused with 400 instead
// of being ignored, and JSON-only, like every other write, so a cross-site form cannot send one
// (docs/security.md).
export const queueWriteRequestSchema = z.strictObject({});
export type QueueWriteRequest = z.infer<typeof queueWriteRequestSchema>;

// The student's latest ticket in the round, as it stands by the DB clock: a ticket past its idle
// timeout or its admission TTL is reported as expired even before any write has marked it so.
//
// - waiting: position 1 = next to be admitted (the live waiting tickets ahead + 1). The page shows
//   it; no other student's data, and not max_active or the admitted count, which are the school's
//   settings and load, not something a student needs to wait.
// - admitted: may choose clubs until admittedUntil (the admission TTL), provided the page keeps
//   sending heartbeats; a ticket idle past the timeout expires earlier. secondsLeft is the time to
//   admittedUntil by the DB clock when the answer was made (whole seconds, rounded down): the page
//   counts down from when the answer arrived, so a device clock that is minutes off still shows
//   the right minutes. admittedUntil stays the admission's identity (the same for its whole turn)
//   and the clock time shown beside them.
// - expired / done: the ticket ended (timed out, or the student released it); joining again
//   queues at the back. Kept apart so the page can say why.
export const queueTicketSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('waiting'), position: z.number().int().positive() }),
  z.object({
    status: z.literal('admitted'),
    admittedUntil: z.iso.datetime(),
    secondsLeft: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('done') }),
]);
export type QueueTicket = z.infer<typeof queueTicketSchema>;

// One shape for join, heartbeat, done and the read. round is the same round GET
// /api/student/round shows (nothing new to the student), so a waiting page can show which round
// it queues for and when it closes from this one poll. round null = the grade has no round, and
// ticket is then null too; ticket null = the student never queued in this round.
export const studentQueueResponseSchema = z.object({
  round: studentRoundSchema.nullable(),
  ticket: queueTicketSchema.nullable(),
});
export type StudentQueueResponse = z.infer<typeof studentQueueResponseSchema>;
