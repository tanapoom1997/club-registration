import type { Round } from '@club-registration/shared';
import { untilNextStatusChange } from '@/lib/round-refetch';
import { ROUNDS_POLL_INTERVAL_MS } from '@/pages/admin-rounds/round-ui';

// The rounds worth a look from the admin's home: open ones first, the one closing soonest on top,
// then the upcoming ones, the one opening soonest on top. Closed rounds are on the rounds page.
export const liveRounds = (rounds: readonly Round[]): Round[] => {
  const by = (key: 'opensAt' | 'closesAt') => (a: Round, b: Round) =>
    Date.parse(a[key]) - Date.parse(b[key]) || a.grade - b.grade;
  return [
    ...rounds.filter(({ status }) => status === 'open').sort(by('closesAt')),
    ...rounds.filter(({ status }) => status === 'upcoming').sort(by('opensAt')),
  ];
};

// Poll like the rounds page while a round is open (the seat and queue counts move), and while
// none is, ask again when the next one should open, so the home switches it to open without a
// reload. Nothing open or upcoming: nothing changes until an admin does something.
export const overviewRefetchInterval = (
  rounds: readonly Round[] | undefined,
  now = Date.now(),
): number | false => {
  const live = liveRounds(rounds ?? []);
  if (live.some(({ status }) => status === 'open')) return ROUNDS_POLL_INTERVAL_MS;
  const next = live[0];
  return next === undefined ? false : untilNextStatusChange(next, now);
};

// The queue as one line: what the admin set, and while open, where it stands now.
export const queueSummary = ({ status, maxActive, queueWaiting, queueAdmitted }: Round): string => {
  if (maxActive === null) return 'ไม่มีคิว';
  if (status !== 'open') return `คิว: เข้าเลือกพร้อมกันได้ ${maxActive} คน`;
  return `รอคิว ${queueWaiting} คน · ได้คิวแล้ว ${queueAdmitted} / ${maxActive} คน`;
};
