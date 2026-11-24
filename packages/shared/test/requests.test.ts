import { describe, expect, it } from 'vitest';
import { CAPACITY_MAX } from '../src/import.js';
import { clubMemberRequestSchema, clubWaitlistRemoveRequestSchema } from '../src/club-members.js';
import { updateClubRequestSchema } from '../src/clubs.js';
import {
  EVENT_LOG_DEFAULT_LIMIT,
  EVENT_LOG_MAX_LIMIT,
  eventLogQuerySchema,
} from '../src/event-log.js';
import { exportQuerySchema } from '../src/export.js';
import { idempotencyKeySchema } from '../src/idempotency.js';
import {
  issueInitialPasswordsRequestSchema,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
} from '../src/initial-passwords.js';
import {
  cancelRegistrationRequestSchema,
  changeRegistrationRequestSchema,
  joinWaitlistRequestSchema,
  leaveWaitlistRequestSchema,
  registerRequestSchema,
  studentAdminChangeSchema,
  studentClubSchema,
  studentClubsResponseSchema,
  studentQuerySchema,
  studentRegistrationResponseSchema,
  studentRoundResponseSchema,
  studentWaitlistResponseSchema,
  studentWaitlistSchema,
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

describe('waitlist requests', () => {
  it('accepts a join of a club with a key', () => {
    expect(joinWaitlistRequestSchema.safeParse({ clubId: 3, idempotencyKey: KEY })).toEqual({
      success: true,
      data: { clubId: 3, idempotencyKey: KEY },
    });
  });

  // The student comes from the session; the entry given up is the one held in the DB.
  it.each([
    ['naming a student', { clubId: 3, idempotencyKey: KEY, studentId: 7 }],
    ['naming a round', { clubId: 3, idempotencyKey: KEY, roundId: 1 }],
    ['naming the waitlist left', { clubId: 3, idempotencyKey: KEY, fromClubId: 2 }],
    ['choosing a place', { clubId: 3, idempotencyKey: KEY, position: 1 }],
    ['without a key', { clubId: 3 }],
    ['without a club', { idempotencyKey: KEY }],
    ['with the club id as text', { clubId: '3', idempotencyKey: KEY }],
  ])('refuses a join %s', (_case, body) => {
    expect(joinWaitlistRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a leave with a key alone and refuses one that names a club or a student', () => {
    expect(leaveWaitlistRequestSchema.safeParse({ idempotencyKey: KEY }).success).toBe(true);
    expect(leaveWaitlistRequestSchema.safeParse({ idempotencyKey: KEY, clubId: 3 }).success).toBe(
      false,
    );
    expect(
      leaveWaitlistRequestSchema.safeParse({ idempotencyKey: KEY, studentId: 7 }).success,
    ).toBe(false);
    expect(leaveWaitlistRequestSchema.safeParse({}).success).toBe(false);
  });
});

// What the web app parses every poll with: an answer from an api without the waitlist fields must
// fail loudly rather than show "not waiting" or "not promoted" by default.
describe('student read responses', () => {
  const CLUB = { id: 3, clubCode: 'SMK03', name: 'ชุมนุมสมมติ' };
  const WAITLIST = { club: CLUB, position: 1, joinedAt: '2026-12-01T01:05:00.000Z' };

  it.each([0, -1, 1.5])('refuses a waitlist position of %j', (position) => {
    expect(studentWaitlistSchema.safeParse({ ...WAITLIST, position }).success).toBe(false);
  });

  it('accepts the first place in a queue', () => {
    expect(studentWaitlistSchema.safeParse(WAITLIST).success).toBe(true);
  });

  it('requires the waitlist, even as null', () => {
    expect(
      studentRoundResponseSchema.safeParse({ round: null, registration: null, adminChange: null })
        .success,
    ).toBe(false);
    expect(
      studentRoundResponseSchema.safeParse({
        round: null,
        registration: null,
        waitlist: null,
        adminChange: null,
      }).success,
    ).toBe(true);
  });

  it('requires a registration to say whether it came from the waitlist', () => {
    const registration = { club: CLUB, registeredAt: '2026-12-01T01:05:00.000Z' };
    const response = { round: null, waitlist: WAITLIST, adminChange: null };

    expect(studentRoundResponseSchema.safeParse({ ...response, registration }).success).toBe(false);
    expect(
      studentRoundResponseSchema.safeParse({
        ...response,
        registration: { ...registration, promotedFromWaitlist: true },
      }).success,
    ).toBe(true);
  });

  it.each([undefined, -1])('refuses a club with a waitlist count of %j', (waitlistCount) => {
    const club = {
      ...CLUB,
      description: '',
      capacity: 30,
      registered: 30,
      remaining: 0,
      advisorNames: [],
      waitlistCount,
    };

    expect(studentClubSchema.safeParse(club).success).toBe(false);
    expect(studentClubSchema.safeParse({ ...club, waitlistCount: 4 }).success).toBe(true);
  });
});

// The notice of what an admin did (README Phase 4, P3). An api that does not send it must fail the
// web app's parse rather than read as "no admin change".
describe('studentAdminChangeSchema', () => {
  const CLUB = { id: 3, clubCode: 'SMK03', name: 'ชุมนุมสมมติ' };
  const FROM_CLUB = { id: 4, clubCode: 'SMK04', name: 'ชุมนุมสมมติ เดิม' };
  const AT = '2026-12-01T02:15:00.000Z';
  const EMPTY_ROUND = { round: null, registration: null, waitlist: null };

  it.each(['assigned', 'removed', 'waitlist_removed'])('accepts %s with a club', (kind) => {
    expect(studentAdminChangeSchema.safeParse({ kind, club: CLUB, at: AT }).success).toBe(true);
  });

  it('accepts a move with the club left', () => {
    expect(
      studentAdminChangeSchema.safeParse({ kind: 'moved', club: CLUB, fromClub: FROM_CLUB, at: AT })
        .success,
    ).toBe(true);
  });

  it('refuses a move that does not say which club was left', () => {
    expect(studentAdminChangeSchema.safeParse({ kind: 'moved', club: CLUB, at: AT }).success).toBe(
      false,
    );
  });

  it('drops a club left from every other kind', () => {
    const parsed = studentAdminChangeSchema.parse({
      kind: 'assigned',
      club: CLUB,
      fromClub: FROM_CLUB,
      at: AT,
    });

    expect(parsed).toEqual({ kind: 'assigned', club: CLUB, at: AT });
  });

  it.each([
    ['an unknown kind', { kind: 'promoted', club: CLUB, at: AT }],
    ['no club', { kind: 'removed', at: AT }],
    ['no time', { kind: 'removed', club: CLUB }],
    ['a time that is not ISO', { kind: 'removed', club: CLUB, at: '1 ธ.ค. 2569' }],
  ])('refuses %s', (_case, change) => {
    expect(studentAdminChangeSchema.safeParse(change).success).toBe(false);
  });

  // Whatever the admin record carries, a student never learns who made the change.
  it('keeps no admin identity in what it parses', () => {
    const parsed = studentAdminChangeSchema.parse({
      kind: 'removed',
      club: CLUB,
      at: AT,
      actorId: 9,
      actor: { loginId: 'admin-fictional', fullName: 'ผู้ดูแลสมมติ' },
    });

    expect(Object.keys(parsed).sort()).toEqual(['at', 'club', 'kind']);
  });

  it('is required, even as null, by every student answer', () => {
    const change = { kind: 'removed', club: CLUB, at: AT };

    expect(studentRoundResponseSchema.safeParse(EMPTY_ROUND).success).toBe(false);
    expect(
      studentRoundResponseSchema.safeParse({ ...EMPTY_ROUND, adminChange: change }).success,
    ).toBe(true);
    expect(
      studentClubsResponseSchema.safeParse({ ...EMPTY_ROUND, adminChange: null, clubs: [] })
        .success,
    ).toBe(true);
    expect(studentClubsResponseSchema.safeParse({ ...EMPTY_ROUND, clubs: [] }).success).toBe(false);
    expect(studentRegistrationResponseSchema.safeParse({ registration: null }).success).toBe(false);
    expect(
      studentRegistrationResponseSchema.safeParse({ registration: null, adminChange: null })
        .success,
    ).toBe(true);
    expect(studentWaitlistResponseSchema.safeParse({ waitlist: null }).success).toBe(false);
    expect(
      studentWaitlistResponseSchema.safeParse({ waitlist: null, adminChange: change }).success,
    ).toBe(true);
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

// The admin names the student by login ID; the round comes from the club and the club left from
// the DB, so a body naming either is refused, never ignored.
describe('clubMemberRequestSchema', () => {
  it('accepts a login ID and a key, lower-casing the login ID as login does', () => {
    expect(
      clubMemberRequestSchema.safeParse({ loginId: ' Fictional01 ', idempotencyKey: KEY }),
    ).toEqual({ success: true, data: { loginId: 'fictional01', idempotencyKey: KEY } });
  });

  it.each([
    ['naming a student id', { loginId: 'fictional01', idempotencyKey: KEY, studentId: 7 }],
    ['naming a round', { loginId: 'fictional01', idempotencyKey: KEY, roundId: 1 }],
    ['naming the club left', { loginId: 'fictional01', idempotencyKey: KEY, fromClubId: 2 }],
    ['without a key', { loginId: 'fictional01' }],
    ['without a login ID', { idempotencyKey: KEY }],
    ['with a login ID of other characters', { loginId: 'นักเรียน', idempotencyKey: KEY }],
    ['with a numeric login ID', { loginId: 1001, idempotencyKey: KEY }],
  ])('refuses a body %s', (_case, body) => {
    expect(clubMemberRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('clubWaitlistRemoveRequestSchema', () => {
  it('accepts a login ID and a key', () => {
    expect(
      clubWaitlistRemoveRequestSchema.safeParse({ loginId: 'Fictional01', idempotencyKey: KEY }),
    ).toEqual({ success: true, data: { loginId: 'fictional01', idempotencyKey: KEY } });
  });

  it.each([
    ['naming a club', { loginId: 'fictional01', idempotencyKey: KEY, clubId: 3 }],
    ['naming a round', { loginId: 'fictional01', idempotencyKey: KEY, roundId: 1 }],
    ['without a key', { loginId: 'fictional01' }],
  ])('refuses a body %s', (_case, body) => {
    expect(clubWaitlistRemoveRequestSchema.safeParse(body).success).toBe(false);
  });
});

// Query strings arrive as text, so the ids and the limit are coerced from it.
describe('eventLogQuerySchema', () => {
  it('defaults the limit and needs no filter', () => {
    expect(eventLogQuerySchema.safeParse({})).toEqual({
      success: true,
      data: { limit: EVENT_LOG_DEFAULT_LIMIT },
    });
  });

  it('reads every filter, the cursor and the limit from text', () => {
    expect(
      eventLogQuerySchema.safeParse({
        roundId: '1',
        studentId: '2',
        clubId: '3',
        loginId: 'fictional01',
        before: '40',
        limit: String(EVENT_LOG_MAX_LIMIT),
      }),
    ).toEqual({
      success: true,
      data: {
        roundId: 1,
        studentId: 2,
        clubId: 3,
        loginId: 'fictional01',
        before: 40,
        limit: EVENT_LOG_MAX_LIMIT,
      },
    });
  });

  it('normalises a login ID as an admin types it, like every other login ID', () => {
    expect(eventLogQuerySchema.safeParse({ loginId: '  Fictional.01 ' })).toEqual({
      success: true,
      data: { loginId: 'fictional.01', limit: EVENT_LOG_DEFAULT_LIMIT },
    });
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['a limit above the most', { limit: String(EVENT_LOG_MAX_LIMIT + 1) }],
    ['a cursor of 0', { before: '0' }],
    ['an id that is no number', { roundId: 'x' }],
    ['an id past the integer range', { clubId: '2147483648' }],
    ['an unknown parameter', { eventType: 'register' }],
    ['a filter given twice', { studentId: ['1', '2'] }],
    ['an empty login ID', { loginId: '' }],
    ['a login ID of spaces only', { loginId: '   ' }],
    ['a login ID with a space inside', { loginId: 'fictional 01' }],
    ['a login ID with a character no login has', { loginId: 'fictional!' }],
    ['a login ID over 64 characters', { loginId: 'a'.repeat(65) }],
    ['a login ID given twice', { loginId: ['fictional01', 'fictional02'] }],
  ])('refuses %s', (_case, query) => {
    expect(eventLogQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('passwordResetRequestSchema', () => {
  it('accepts a login ID and a key, lower-casing and trimming the login ID as login does', () => {
    expect(
      passwordResetRequestSchema.safeParse({ loginId: ' Fictional01 ', idempotencyKey: KEY }),
    ).toEqual({ success: true, data: { loginId: 'fictional01', idempotencyKey: KEY } });
  });

  it.each([
    ['naming a student id', { loginId: 'fictional01', idempotencyKey: KEY, studentId: 7 }],
    ['choosing the password', { loginId: 'fictional01', idempotencyKey: KEY, password: 'x' }],
    ['without a key', { loginId: 'fictional01' }],
    ['with a malformed key', { loginId: 'fictional01', idempotencyKey: 'short' }],
    ['without a login ID', { idempotencyKey: KEY }],
    ['with an empty login ID', { loginId: '  ', idempotencyKey: KEY }],
    ['with a login ID of other characters', { loginId: 'นักเรียน', idempotencyKey: KEY }],
    ['with a numeric login ID', { loginId: 1001, idempotencyKey: KEY }],
  ])('refuses a body %s', (_case, body) => {
    expect(passwordResetRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('passwordResetResponseSchema', () => {
  const answer = {
    student: {
      loginId: 'fictional01',
      fullName: 'นักเรียนสมมติ ทดสอบ',
      grade: 1,
      classroom: '2',
      seatNo: 5,
    },
    password: 'abcde23456',
  };

  it('accepts the student and the new password', () => {
    expect(passwordResetResponseSchema.safeParse(answer)).toEqual({ success: true, data: answer });
  });

  it('refuses an answer without a password', () => {
    expect(passwordResetResponseSchema.safeParse({ ...answer, password: '' }).success).toBe(false);
  });
});
