import type { Round } from '@club-registration/shared';
import { describe, expect, it } from 'vitest';
import { ROUNDS_POLL_INTERVAL_MS } from '@/pages/admin-rounds/round-ui';
import { liveRounds, overviewRefetchInterval, queueSummary } from './rounds-overview';

const round = (overrides: Partial<Round>): Round => ({
  id: 1,
  term: '2569/1',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  maxActive: 150,
  status: 'upcoming',
  clubCount: 0,
  totalCapacity: 0,
  totalRegistered: 0,
  queueWaiting: 0,
  queueAdmitted: 0,
  studentCount: 0,
  studentsWithoutClub: 0,
  ...overrides,
});

const NOW = Date.parse('2026-11-30T00:00:00.000Z');

describe('liveRounds', () => {
  it('lists open rounds closing soonest first, then upcoming ones opening soonest, without closed ones', () => {
    const rounds = [
      round({ id: 1, status: 'upcoming', opensAt: '2026-12-03T01:00:00.000Z' }),
      round({ id: 2, status: 'closed' }),
      round({ id: 3, status: 'open', closesAt: '2026-12-02T09:00:00.000Z' }),
      round({ id: 4, status: 'upcoming', opensAt: '2026-12-02T01:00:00.000Z' }),
      round({ id: 5, status: 'open', closesAt: '2026-12-01T09:00:00.000Z' }),
    ];

    expect(liveRounds(rounds).map(({ id }) => id)).toEqual([5, 3, 4, 1]);
  });

  it('orders rounds with the same time by grade', () => {
    const rounds = [round({ id: 1, grade: 3 }), round({ id: 2, grade: 1 })];

    expect(liveRounds(rounds).map(({ grade }) => grade)).toEqual([1, 3]);
  });
});

describe('overviewRefetchInterval', () => {
  it('polls like the rounds page while a round is open', () => {
    const rounds = [round({ status: 'upcoming' }), round({ id: 2, status: 'open' })];

    expect(overviewRefetchInterval(rounds, NOW)).toBe(ROUNDS_POLL_INTERVAL_MS);
  });

  it('asks again around when the next round should open', () => {
    const opensAt = new Date(NOW + 5_000).toISOString();

    const interval = overviewRefetchInterval([round({ status: 'upcoming', opensAt })], NOW);

    expect(interval).toBeGreaterThanOrEqual(5_000);
    expect(interval).toBeLessThanOrEqual(6_000);
  });

  it('does not poll when nothing is open or upcoming', () => {
    expect(overviewRefetchInterval([round({ status: 'closed' })], NOW)).toBe(false);
    expect(overviewRefetchInterval(undefined, NOW)).toBe(false);
  });
});

describe('queueSummary', () => {
  it('says a round without a queue has none', () => {
    expect(queueSummary(round({ status: 'open', maxActive: null }))).toBe('ไม่มีคิว');
  });

  it('gives the live queue of an open round', () => {
    const open = round({ status: 'open', queueWaiting: 40, queueAdmitted: 150 });

    expect(queueSummary(open)).toBe('รอคิว 40 คน · ได้คิวแล้ว 150 / 150 คน');
  });

  it('gives only the setting for a round not open yet', () => {
    expect(queueSummary(round({ status: 'upcoming', maxActive: 120 }))).toBe(
      'คิว: เข้าเลือกพร้อมกันได้ 120 คน',
    );
  });
});
