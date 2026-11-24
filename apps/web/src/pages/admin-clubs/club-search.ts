import type { AdminClub } from '@club-registration/shared';
import { normalizeSearchText } from '@/lib/search-text';

// What the admin narrows the round's club table to: a round can have 40+ clubs. Client-side over
// the list the page already polls, and in the page's state only (not the URL), like the students'
// search (README Phase 4, U3). The advisors' names count too: "which club is ครูสมใจ's?" is a
// common question on registration day.
const searchableTexts = (club: AdminClub): string[] => [
  club.clubCode,
  club.name,
  `${club.clubCode}${club.name}`,
  ...club.advisors.map(({ fullName }) => fullName),
];

export const searchClubs = (clubs: readonly AdminClub[], query: string): AdminClub[] => {
  const normalized = normalizeSearchText(query);
  if (normalized === '') return [...clubs];
  return clubs.filter((club) =>
    searchableTexts(club).some((text) => normalizeSearchText(text).includes(normalized)),
  );
};

export const CLUB_SEARCH_MESSAGES = Object.freeze({
  label: 'ค้นหาชุมนุม',
  placeholder: 'ชื่อ รหัส หรือชื่อครู',
  shown: (shown: number, total: number) => `แสดง ${shown} จาก ${total} ชุมนุม`,
  none: (query: string) => `ไม่พบชุมนุมที่ตรงกับ "${query.trim()}"`,
});
