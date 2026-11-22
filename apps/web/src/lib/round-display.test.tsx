import { describe, expect, it } from 'vitest';
import { roundCountdown, timeLeftLabel } from './round-display';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-12-01T01:00:00.000Z');
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();

describe('timeLeftLabel', () => {
  it.each([
    [0.5 * HOUR, 'ไม่ถึง 1 ชั่วโมง'],
    [5.9 * HOUR, '5 ชั่วโมง'],
    [24 * HOUR, '1 วัน'],
    [74 * HOUR, '3 วัน 2 ชั่วโมง'],
  ])('%i ms reads "%s"', (ms, label) => {
    expect(timeLeftLabel(ms)).toBe(label);
  });
});

describe('roundCountdown', () => {
  it('counts down to the close of an open round', () => {
    const countdown = roundCountdown({ status: 'open', opensAt: at(-1), closesAt: at(26) }, NOW);

    expect(countdown).toEqual({ text: 'ปิดรับในอีก 1 วัน 2 ชั่วโมง', withinHour: false });
  });

  it('counts down to the opening of an upcoming round', () => {
    const countdown = roundCountdown({ status: 'upcoming', opensAt: at(3), closesAt: at(9) }, NOW);

    expect(countdown?.text).toBe('เปิดในอีก 3 ชั่วโมง');
  });

  it('flags the last hour', () => {
    const countdown = roundCountdown({ status: 'open', opensAt: at(-1), closesAt: at(0.2) }, NOW);

    expect(countdown).toEqual({ text: 'ปิดรับในอีก ไม่ถึง 1 ชั่วโมง', withinHour: true });
  });

  it('says nothing once this clock has passed the moment, or for a closed round', () => {
    expect(roundCountdown({ status: 'open', opensAt: at(-2), closesAt: at(-1) }, NOW)).toBe(
      undefined,
    );
    expect(roundCountdown({ status: 'closed', opensAt: at(-2), closesAt: at(-1) }, NOW)).toBe(
      undefined,
    );
  });
});
