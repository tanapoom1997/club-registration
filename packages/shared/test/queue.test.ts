import { describe, expect, it } from 'vitest';
import {
  queueTicketSchema,
  queueWriteRequestSchema,
  studentQueueResponseSchema,
} from '../src/queue.js';

const ROUND = {
  id: 4,
  term: '2569/2',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T05:00:00.000Z',
  status: 'open',
  hasQueue: true,
} as const;

// The student and their round come from the session (CLAUDE.md rule 5), and the place in the
// queue from the DB, so a body that tries to name any of them is refused, never ignored.
describe('queue write requests', () => {
  it('accepts the empty JSON object', () => {
    expect(queueWriteRequestSchema.safeParse({})).toEqual({ success: true, data: {} });
  });

  it.each([
    ['naming a student', { studentId: 7 }],
    ['naming a round', { roundId: 1 }],
    ['choosing a place', { position: 1 }],
    ['choosing a status', { status: 'admitted' }],
    ['as text, as a cross-site form would send it', '{}'],
    ['missing', undefined],
  ])('refuses a body %s', (_case, body) => {
    expect(queueWriteRequestSchema.safeParse(body).success).toBe(false);
  });
});

// What the web app will parse every poll with: a ticket that lacks what its status needs must fail
// loudly rather than show a place or an admission that is not there.
describe('queue responses', () => {
  it.each([
    { status: 'waiting', position: 1 },
    { status: 'admitted', admittedUntil: '2026-12-01T01:15:00.000Z' },
    { status: 'expired' },
    { status: 'done' },
  ])('accepts the ticket %j', (ticket) => {
    expect(queueTicketSchema.safeParse(ticket).success).toBe(true);
  });

  it.each([
    ['a waiting ticket without a position', { status: 'waiting' }],
    ['position 0', { status: 'waiting', position: 0 }],
    ['a fractional position', { status: 'waiting', position: 1.5 }],
    ['an admitted ticket without its end', { status: 'admitted' }],
    ['an end without a timezone', { status: 'admitted', admittedUntil: '2026-12-01 01:15' }],
    ['an unknown status', { status: 'paused' }],
  ])('refuses %s', (_case, ticket) => {
    expect(queueTicketSchema.safeParse(ticket).success).toBe(false);
  });

  it('accepts a grade with no round and a student who never queued', () => {
    expect(studentQueueResponseSchema.safeParse({ round: null, ticket: null }).success).toBe(true);
    expect(studentQueueResponseSchema.safeParse({ round: ROUND, ticket: null }).success).toBe(true);
  });

  it('refuses an answer without the ticket field', () => {
    expect(studentQueueResponseSchema.safeParse({ round: ROUND }).success).toBe(false);
  });

  it('carries no admin-only round field such as maxActive or the queue counts', () => {
    const parsed = studentQueueResponseSchema.parse({
      round: { ...ROUND, maxActive: 150, queueWaiting: 40, queueAdmitted: 150 },
      ticket: { status: 'waiting', position: 3 },
    });

    expect(parsed.round).toEqual(ROUND);
  });

  // The one thing a student learns of the setting: whether the round queues at all.
  it('refuses a round without hasQueue', () => {
    const round = Object.fromEntries(Object.entries(ROUND).filter(([key]) => key !== 'hasQueue'));

    expect(studentQueueResponseSchema.safeParse({ round, ticket: null }).success).toBe(false);
  });
});
