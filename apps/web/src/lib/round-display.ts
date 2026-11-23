import type { Round, RoundStatus } from '@club-registration/shared';

// How a round is shown on both the student and the admin pages, kept in one place so the two
// always describe a round the same way.

export const gradeLabel = (grade: number): string => `ม.${grade}`;

export const STATUS_DISPLAY: Readonly<
  Record<RoundStatus, { label: string; variant: 'success' | 'warning' | 'neutral' }>
> = Object.freeze({
  upcoming: { label: 'ยังไม่เปิด', variant: 'warning' },
  open: { label: 'เปิดอยู่', variant: 'success' },
  closed: { label: 'ปิดแล้ว', variant: 'neutral' },
});

// How a round is named in the round pickers of the admin pages.
export const roundOptionLabel = ({ term, grade, status }: Round): string =>
  `${term} ${gradeLabel(grade)} (${STATUS_DISPLAY[status].label})`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Coarse on purpose (no minutes): it runs on the viewer's own clock, which can be minutes off the
// server's that decides when a round opens and closes.
export const timeLeftLabel = (ms: number): string => {
  if (ms < HOUR_MS) return 'ไม่ถึง 1 ชั่วโมง';
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  if (days === 0) return `${hours} ชั่วโมง`;
  return hours === 0 ? `${days} วัน` : `${days} วัน ${hours} ชั่วโมง`;
};

type RoundWindow = { status: RoundStatus; opensAt: string; closesAt: string };
export type RoundCountdown = { text: string; withinHour: boolean };

// How long until the round opens or closes, beside its exact times. Nothing once that moment has
// passed on this clock: the status from the server catches up on the next poll.
export const roundCountdown = (round: RoundWindow, now: number): RoundCountdown | undefined => {
  if (round.status === 'closed') return undefined;
  const open = round.status === 'open';
  const left = Date.parse(open ? round.closesAt : round.opensAt) - now;
  if (left <= 0) return undefined;
  return {
    text: `${open ? 'ปิดรับในอีก' : 'เปิดในอีก'} ${timeLeftLabel(left)}`,
    withinHour: left < HOUR_MS,
  };
};
