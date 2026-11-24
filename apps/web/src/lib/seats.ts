// How full a club is, for the seat bar's colour and its "almost full" label. "Low" starts at a
// fifth of the seats left, but never above 2 seats in a tiny club, where every seat is one click.
// "Closed" is a club with capacity 0: it takes no one and has no waitlist (README waitlist rule 9),
// so it must never read as "full".
export type SeatLevel = 'open' | 'low' | 'full' | 'closed';

const LOW_SHARE = 0.2;
const LOW_MIN_SEATS = 2;

export const seatLevel = (capacity: number, remaining: number): SeatLevel => {
  if (capacity <= 0) return 'closed';
  if (remaining <= 0) return 'full';
  return remaining <= Math.max(LOW_MIN_SEATS, Math.ceil(capacity * LOW_SHARE)) ? 'low' : 'open';
};

// The taken share as a whole percent for the bar. A club that takes no one has nothing taken.
export const takenPercent = (capacity: number, remaining: number): number => {
  if (capacity <= 0) return 0;
  const taken = capacity - Math.max(0, Math.min(remaining, capacity));
  return Math.round((taken / capacity) * 100);
};
