import { describe, expect, it } from 'vitest';
import { CAPACITY_MAX } from '../src/import.js';
import { updateClubRequestSchema } from '../src/clubs.js';
import { exportQuerySchema } from '../src/export.js';
import { idempotencyKeySchema } from '../src/idempotency.js';
import { issueInitialPasswordsRequestSchema } from '../src/initial-passwords.js';
import {
  cancelRegistrationRequestSchema,
  changeRegistrationRequestSchema,
  registerRequestSchema,
  studentQuerySchema,
} from '../src/student.js';

const KEY = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('idempotencyKeySchema', () => {
  it('accepts what the web app sends (crypto.randomUUID)', () => {
    expect(idempotencyKeySchema.safeParse(KEY).success).toBe(true);
  });

  it.each([
    ['15 characters', 'a'.repeat(15)],
    ['129 characters', 'a'.repeat(129)],
    ['a space', 'fictional key 0001'],
    ['a quote', "fictional-key-0001'"],
  ])('refuses %s', (_case, key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

// The student, their grade and the round come from the session (CLAUDE.md rule 5), so a request
// that tries to name one is refused with 400, never silently ignored.
describe('student requests', () => {
  it.each([{ studentId: 7 }, { grade: 4 }, { roundId: 1 }])('refuses query %j', (query) => {
    expect(studentQuerySchema.safeParse(query).success).toBe(false);
  });

  it('accepts a registration of a club with a key', () => {
    expect(registerRequestSchema.safeParse({ clubId: 3, idempotencyKey: KEY }).success).toBe(true);
  });

  it.each([
    ['naming a student', { clubId: 3, idempotencyKey: KEY, studentId: 7 }],
    ['naming a round', { clubId: 3, idempotencyKey: KEY, roundId: 1 }],
    ['without a key', { clubId: 3 }],
    ['with the club id as text', { clubId: '3', idempotencyKey: KEY }],
  ])('refuses a registration %s', (_case, body) => {
    expect(registerRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a change to a club with a key', () => {
    expect(changeRegistrationRequestSchema.safeParse({ clubId: 3, idempotencyKey: KEY })).toEqual({
      success: true,
      data: { clubId: 3, idempotencyKey: KEY },
    });
  });

  // The club the student leaves is the one they hold, read from the DB, never named by the client.
  it.each([
    ['naming a student', { clubId: 3, idempotencyKey: KEY, studentId: 7 }],
    ['naming the club left', { clubId: 3, idempotencyKey: KEY, fromClubId: 2 }],
    ['naming a round', { clubId: 3, idempotencyKey: KEY, roundId: 1 }],
    ['without a key', { clubId: 3 }],
    ['without a club', { idempotencyKey: KEY }],
    ['with the club id as text', { clubId: '3', idempotencyKey: KEY }],
    ['with a zero club id', { clubId: 0, idempotencyKey: KEY }],
    ['with a short key', { clubId: 3, idempotencyKey: 'short' }],
  ])('refuses a change %s', (_case, body) => {
    expect(changeRegistrationRequestSchema.safeParse(body).success).toBe(false);
  });

  it('refuses a cancellation that names a club or a student', () => {
    expect(cancelRegistrationRequestSchema.safeParse({ idempotencyKey: KEY }).success).toBe(true);
    expect(
      cancelRegistrationRequestSchema.safeParse({ idempotencyKey: KEY, clubId: 3 }).success,
    ).toBe(false);
    expect(
      cancelRegistrationRequestSchema.safeParse({ idempotencyKey: KEY, studentId: 7 }).success,
    ).toBe(false);
  });
});

describe('updateClubRequestSchema', () => {
  it('refuses an empty change', () => {
    expect(updateClubRequestSchema.safeParse({}).success).toBe(false);
  });

  // The code keys the Excel upsert and registered belongs to registrations: neither is editable.
  it.each([{ clubCode: 'SMK02' }, { registered: 0 }, { roundId: 2 }])('refuses %j', (change) => {
    expect(updateClubRequestSchema.safeParse({ capacity: 20, ...change }).success).toBe(false);
  });

  it.each([0, CAPACITY_MAX])('accepts capacity %i', (capacity) => {
    expect(updateClubRequestSchema.safeParse({ capacity }).success).toBe(true);
  });

  it.each([-1, CAPACITY_MAX + 1, 1.5, '20'])('refuses capacity %j', (capacity) => {
    expect(updateClubRequestSchema.safeParse({ capacity }).success).toBe(false);
  });
});

describe('exportQuerySchema', () => {
  it('reads a club id from the query text', () => {
    expect(exportQuerySchema.parse({ view: 'club', clubId: '5', format: 'pdf' })).toEqual({
      view: 'club',
      clubId: 5,
      format: 'pdf',
    });
  });

  // A scope meant for the other view must fail, not widen the export to the whole round.
  it.each([
    ['a classroom with view=club', { view: 'club', classroom: '4/1', format: 'xlsx' }],
    ['a club id with view=classroom', { view: 'classroom', clubId: '5', format: 'xlsx' }],
    ['no format', { view: 'club' }],
    ['an unknown format', { view: 'club', format: 'csv' }],
    ['an unknown view', { view: 'student', format: 'xlsx' }],
  ])('refuses %s', (_case, query) => {
    expect(exportQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('issueInitialPasswordsRequestSchema', () => {
  const request = { grade: 4, onlyUnissued: true, idempotencyKey: KEY };

  it('accepts a whole grade or one classroom', () => {
    expect(issueInitialPasswordsRequestSchema.safeParse(request).success).toBe(true);
    expect(
      issueInitialPasswordsRequestSchema.safeParse({ ...request, classroom: '4/1' }).success,
    ).toBe(true);
  });

  // A misspelt scope field would otherwise issue passwords to the whole grade.
  it('refuses a misspelt classroom field', () => {
    expect(
      issueInitialPasswordsRequestSchema.safeParse({ ...request, classRoom: '4/1' }).success,
    ).toBe(false);
  });

  it('requires onlyUnissued to be said explicitly', () => {
    const withoutChoice = { grade: request.grade, idempotencyKey: request.idempotencyKey };

    expect(issueInitialPasswordsRequestSchema.safeParse(withoutChoice).success).toBe(false);
  });
});
