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
