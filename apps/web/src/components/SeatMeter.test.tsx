import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { seatLevel, takenPercent } from '@/lib/seats';
import { SeatMeter } from './SeatMeter';

describe('seatLevel', () => {
  it.each([
    [30, 18, 'open'],
    [30, 6, 'low'],
    [30, 7, 'open'],
    [3, 2, 'low'],
    [3, 3, 'open'],
    [12, 0, 'full'],
    [0, 0, 'closed'],
  ] as const)('a club of %i with %i left is %s', (capacity, remaining, level) => {
    expect(seatLevel(capacity, remaining)).toBe(level);
  });
});

describe('takenPercent', () => {
  it.each([
    [20, 15, 25],
    [3, 0, 100],
    [0, 0, 0],
    [10, 10, 0],
  ])('a club of %i with %i left is %i%% taken', (capacity, remaining, percent) => {
    expect(takenPercent(capacity, remaining)).toBe(percent);
  });
});

describe('SeatMeter', () => {
  afterEach(cleanup);

  it('says how many seats are left out of how many', () => {
    const { container } = render(<SeatMeter capacity={20} remaining={15} waitlistCount={0} />);

    expect(container.textContent).toContain('เหลือ 15 ที่');
    expect(container.textContent).toContain('รับ 20 คน');
    expect(container.textContent).not.toContain('ใกล้เต็ม');
  });

  it('says a club is almost full in words, not only by colour', () => {
    render(<SeatMeter capacity={12} remaining={2} waitlistCount={0} />);

    expect(screen.getByText('ใกล้เต็ม')).toBeTruthy();
  });

  it('says a club is full and how many wait for it', () => {
    const { container } = render(<SeatMeter capacity={3} remaining={0} waitlistCount={1} />);

    expect(screen.getByText('เต็ม')).toBeTruthy();
    expect(container.textContent).not.toContain('เหลือ');
    expect(container.textContent).toContain('มีคนรอ 1 คน');
  });

  // README waitlist rule 9: capacity 0 takes no one; "full" would suggest a waitlist.
  it('says a club with capacity 0 takes no one, not that it is full', () => {
    const { container } = render(<SeatMeter capacity={0} remaining={0} waitlistCount={0} />);

    expect(screen.getByText('ไม่เปิดรับ')).toBeTruthy();
    expect(container.textContent).not.toContain('เต็ม');
    expect(container.textContent).not.toContain('รับ 0 คน');
  });
});
