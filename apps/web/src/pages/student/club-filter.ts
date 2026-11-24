import type { StudentClub } from '@club-registration/shared';
import { normalizeSearchText } from '@/lib/search-text';
import { isSeatFree } from './student-ui';

// What the student narrows the club list to (README Phase 4, P4b, U3). Client-side over the list
// the page already has: no request, and it lives in the page's state only (not the URL).
export type SeatFilter = 'all' | 'free';
export type ClubFilter = { query: string; seats: SeatFilter };

export const NO_FILTER: ClubFilter = Object.freeze({ query: '', seats: 'all' });

export const isFiltering = ({ query, seats }: ClubFilter): boolean =>
  normalizeSearchText(query) !== '' || seats !== 'all';

// "ยังรับ" is a seat the student can take now: the same rule as the card's register button, so a
// club with seats but people already waiting (whose seats are theirs first) is not in it.
const matches = (club: StudentClub, seats: SeatFilter, query: string): boolean =>
  (seats === 'all' || isSeatFree(club)) &&
  (query === '' ||
    [club.clubCode, club.name, `${club.clubCode}${club.name}`].some((text) =>
      normalizeSearchText(text).includes(query),
    ));

// keepId: the club whose confirmation is open stays in the list whatever the filter says, so a
// poll that fills it under "ยังรับ" cannot take the confirmation (and its answer) off the screen.
export const filterClubs = (
  clubs: readonly StudentClub[],
  { query, seats }: ClubFilter,
  keepId?: number,
): StudentClub[] => {
  const normalized = normalizeSearchText(query);
  return clubs.filter((club) => club.id === keepId || matches(club, seats, normalized));
};

export const CLUB_FILTER_MESSAGES = Object.freeze({
  searchLabel: 'ค้นหาชุมนุม',
  searchPlaceholder: 'ชื่อหรือรหัสชุมนุม',
  seatsLegend: 'แสดงชุมนุม',
  seats: Object.freeze({ all: 'ทั้งหมด', free: 'ยังรับ' } satisfies Record<SeatFilter, string>),
  clear: 'ล้างตัวกรอง',
  shown: (shown: number, total: number) => `แสดง ${shown} จาก ${total} ชุมนุม`,
  all: (total: number) => `แสดงทั้งหมด ${total} ชุมนุม`,
  none: ({ query, seats }: ClubFilter) => {
    const trimmed = query.trim();
    const free = seats === 'free' ? 'ที่ยังรับ' : '';
    return trimmed === '' ? `ไม่พบชุมนุม${free}` : `ไม่พบชุมนุม${free}ที่ตรงกับ "${trimmed}"`;
  },
});

// The line a screen reader hears after the student changes the filter, and the visible one under
// the filter: how many clubs are shown, or that none are.
export const filterSummary = (filter: ClubFilter, shown: number, total: number): string => {
  if (!isFiltering(filter)) return CLUB_FILTER_MESSAGES.all(total);
  return shown === 0 ? CLUB_FILTER_MESSAGES.none(filter) : CLUB_FILTER_MESSAGES.shown(shown, total);
};
