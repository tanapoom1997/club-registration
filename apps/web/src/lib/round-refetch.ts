import type { RoundStatus } from '@club-registration/shared';

// What the timers need from a round; both the student and the admin round types have it.
type RoundWindow = { status: RoundStatus; opensAt: string; closesAt: string };

// The next status change is timed by the device's clock, which may be off. The cap bounds how late
// a slow clock notices it; the floor keeps a fast clock from refetching in a tight loop while the
// server still says "upcoming".
const STATUS_CHECK_MAX_MS = 30_000;
const STATUS_CHECK_MIN_MS = 2_000;
// Spreads the refetch of a whole grade waiting on the same opening time over a second.
const STATUS_CHECK_JITTER_MS = 1_000;

// How long until the round should next change status (opens, or closes), within the bounds above.
export const untilNextStatusChange = (round: RoundWindow, now = Date.now()): number => {
  const boundary = round.status === 'upcoming' ? round.opensAt : round.closesAt;
  const delay = Date.parse(boundary) - now + Math.random() * STATUS_CHECK_JITTER_MS;
  return Math.min(Math.max(delay, STATUS_CHECK_MIN_MS), STATUS_CHECK_MAX_MS);
};

// For a page whose numbers move only while the round is open: poll every `openIntervalMs` while
// open, ask again when an upcoming round should open (so the page switches without a reload), and
// stop once closed. The server decides the status on every answer; this only chooses when to ask.
export const refetchWhileOpen = (
  round: RoundWindow | null | undefined,
  openIntervalMs: number,
): number | false => {
  if (!round || round.status === 'closed') return false;
  return round.status === 'open' ? openIntervalMs : untilNextStatusChange(round);
};
