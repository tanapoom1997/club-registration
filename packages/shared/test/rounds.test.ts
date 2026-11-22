import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_LIMIT,
  TERM_MAX_LENGTH,
  createRoundBatchRequestSchema,
  createRoundRequestSchema,
  dbIdBodySchema,
  dbIdSchema,
  gradeSchema,
  termSchema,
  updateRoundRequestSchema,
} from '../src/rounds.js';

const PG_INT_MAX = 2_147_483_647;

const validRound = {
  term: '2/2569',
  grade: 4,
  opensAt: '2099-12-01T08:00:00+07:00',
  closesAt: '2099-12-01T16:00:00+07:00',
  maxActive: 150,
};

describe('termSchema', () => {
  it('trims the term', () => {
    expect(termSchema.parse('  2/2569 ')).toBe('2/2569');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['a control character', '2/2569\u0000'],
    ['a line break', '2/\n2569'],
    [`${TERM_MAX_LENGTH + 1} characters`, 'x'.repeat(TERM_MAX_LENGTH + 1)],
  ])('refuses %s', (_case, input) => {
    expect(termSchema.safeParse(input).success).toBe(false);
  });
});

describe('gradeSchema', () => {
  it.each([1, 6])('accepts %i', (grade) => {
    expect(gradeSchema.safeParse(grade).success).toBe(true);
  });

  it.each([0, 7, 1.5, '1'])('refuses %j', (grade) => {
    expect(gradeSchema.safeParse(grade).success).toBe(false);
  });
});

describe('row ids', () => {
  // Path parameters arrive as text; a JSON body has real numbers and must not have them coerced.
  it('coerces an id from the URL path but not from a JSON body', () => {
    expect(dbIdSchema.parse('42')).toBe(42);
    expect(dbIdBodySchema.safeParse('42').success).toBe(false);
  });

  // Larger than a Postgres integer would be a database error (500) instead of a 404.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['above the Postgres integer range', PG_INT_MAX + 1],
  ])('refuses %s', (_case, id) => {
    expect(dbIdSchema.safeParse(id).success).toBe(false);
    expect(dbIdBodySchema.safeParse(id).success).toBe(false);
  });

  it('accepts the largest Postgres integer', () => {
    expect(dbIdBodySchema.safeParse(PG_INT_MAX).success).toBe(true);
  });
});

describe('createRoundRequestSchema', () => {
  it('accepts a window given in Thai time', () => {
    expect(createRoundRequestSchema.safeParse(validRound).success).toBe(true);
  });

  // Without an offset the same text means different instants on the server and in the browser.
  it('refuses a time without a timezone', () => {
    const result = createRoundRequestSchema.safeParse({
      ...validRound,
      opensAt: '2099-12-01T08:00:00',
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['equal to the opening time', '2099-12-01T08:00:00+07:00'],
    ['before the opening time', '2099-12-01T07:59:00+07:00'],
    // 00:30 UTC is 07:30 Thai time: earlier, although its text sorts after "08:00".
    ['earlier once both are in UTC', '2099-12-01T00:30:00Z'],
  ])('refuses a closing time %s, on the closesAt field', (_case, closesAt) => {
    const result = createRoundRequestSchema.safeParse({ ...validRound, closesAt });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ path }) => path)).toEqual([['closesAt']]);
  });

  it('compares the window as instants, not as text', () => {
    // 01:30 UTC is 08:30 Thai time, so it closes after an 08:00 Thai opening.
    const result = createRoundRequestSchema.safeParse({
      ...validRound,
      closesAt: '2099-12-01T01:30:00Z',
    });

    expect(result.success).toBe(true);
  });

  it.each([0, MAX_ACTIVE_LIMIT + 1, 1.5, '150'])('refuses maxActive %j', (maxActive) => {
    expect(createRoundRequestSchema.safeParse({ ...validRound, maxActive }).success).toBe(false);
  });

  // README Phase 3 decision 6: null = a round without a queue.
  it('accepts maxActive null as a round without a queue', () => {
    const result = createRoundRequestSchema.safeParse({ ...validRound, maxActive: null });

    expect(result.data?.maxActive).toBeNull();
  });

  // Left out would silently give the round the column default; the admin must choose.
  it('refuses a round without maxActive', () => {
    const round: Partial<typeof validRound> = { ...validRound };
    delete round.maxActive;

    expect(createRoundRequestSchema.safeParse(round).success).toBe(false);
  });

  it('refuses a field the request does not define', () => {
    const result = createRoundRequestSchema.safeParse({ ...validRound, status: 'open' });

    expect(result.success).toBe(false);
  });
});

describe('createRoundBatchRequestSchema', () => {
  // One window for every grade: a grade sent here would be silently meaningless.
  it('refuses a grade', () => {
    expect(createRoundBatchRequestSchema.safeParse(validRound).success).toBe(false);
  });

  it('accepts the same window without a grade', () => {
    const batch = {
      term: validRound.term,
      opensAt: validRound.opensAt,
      closesAt: validRound.closesAt,
      maxActive: validRound.maxActive,
    };

    expect(createRoundBatchRequestSchema.safeParse(batch).success).toBe(true);
  });

  it('accepts maxActive null and refuses it left out', () => {
    const batch = {
      term: validRound.term,
      opensAt: validRound.opensAt,
      closesAt: validRound.closesAt,
    };

    expect(createRoundBatchRequestSchema.safeParse({ ...batch, maxActive: null }).data).toEqual({
      ...batch,
      maxActive: null,
    });
    expect(createRoundBatchRequestSchema.safeParse(batch).success).toBe(false);
  });
});

describe('updateRoundRequestSchema', () => {
  it('refuses an empty change', () => {
    expect(updateRoundRequestSchema.safeParse({}).success).toBe(false);
  });

  // Turning the queue off is a change on its own, and must stay apart from "not given".
  it('accepts maxActive null alone and keeps it null', () => {
    expect(updateRoundRequestSchema.safeParse({ maxActive: null }).data).toEqual({
      maxActive: null,
    });
  });

  it('leaves maxActive out when it is not given', () => {
    const result = updateRoundRequestSchema.safeParse({ closesAt: '2099-12-02T16:00:00+07:00' });

    expect(result.data).not.toHaveProperty('maxActive');
  });

  it.each([0, MAX_ACTIVE_LIMIT + 1, 1.5, '10'])('refuses maxActive %j', (maxActive) => {
    expect(updateRoundRequestSchema.safeParse({ maxActive }).success).toBe(false);
  });

  // Moving a round to another term or grade must fail, not half-succeed.
  it.each([{ term: '1/2570' }, { grade: 5 }])('refuses %j', (change) => {
    expect(updateRoundRequestSchema.safeParse({ maxActive: 10, ...change }).success).toBe(false);
  });

  // The stored half is checked by the database; the request alone cannot know it.
  it('accepts half a window', () => {
    const result = updateRoundRequestSchema.safeParse({ closesAt: '2099-12-02T16:00:00+07:00' });

    expect(result.success).toBe(true);
  });

  it('refuses a whole window that closes before it opens', () => {
    const result = updateRoundRequestSchema.safeParse({
      opensAt: '2099-12-02T08:00:00+07:00',
      closesAt: '2099-12-01T08:00:00+07:00',
    });

    expect(result.success).toBe(false);
  });
});
