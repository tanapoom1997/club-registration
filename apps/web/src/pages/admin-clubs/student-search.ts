import type { RoundStudent } from '@club-registration/shared';
import { normalizeSearchText } from '@/lib/search-text';

// Finding a student of the round in the members panel: teachers
// know a student's name and classroom, rarely the code. Client-side over the round's students,
// in the panel's state only (never the URL or storage: names and codes are personal data).
//
// The rule, on text normalized like every list search (case, spaces and the two ways of typing
// sara am do not matter):
// - "<room> <seat>" (the last word a number, the words before it a classroom of the list): that
//   one seat. "2 12", "4/2 12" and "ม.4/2 12" all name room 2, seat 12, in a grade 4 round.
// - Otherwise a student matches when the whole query is part of their name or code, or names
//   their classroom exactly, or when every word does one of those (e.g. "สมชาย 4/2").
// Classrooms match exactly, not as a prefix: "4/1" must not list rooms 4/10 to 4/19 first. Seat
// numbers count only after a classroom, so a lone "12" searches codes, not every seat 12.

export const STUDENT_SEARCH_LIMIT = 8;

// Words people put before a classroom or seat number, which the data does not have.
const FILLER_PREFIXES = Object.freeze(['ห้อง', 'เลขที่']);

type IndexedStudent = {
  student: RoundStudent;
  name: string;
  loginId: string;
  // The classroom as stored, and as people say it with the round's grade in front.
  rooms: ReadonlySet<string>;
};

export type StudentIndex = readonly IndexedStudent[];

export const indexStudents = (students: readonly RoundStudent[], grade: number): StudentIndex =>
  students.map((student) => ({
    student,
    name: normalizeSearchText(student.fullName),
    loginId: normalizeSearchText(student.loginId),
    rooms: new Set(
      [student.classroom, `${grade}/${student.classroom}`, `ม.${grade}/${student.classroom}`].map(
        normalizeSearchText,
      ),
    ),
  }));

const withoutFiller = (word: string): string => {
  const prefix = FILLER_PREFIXES.find((filler) => word.startsWith(filler));
  return prefix === undefined ? word : word.slice(prefix.length);
};

const wordsOf = (query: string): string[] =>
  query
    .split(/\s+/u)
    .map((word) => withoutFiller(normalizeSearchText(word)))
    .filter((word) => word !== '');

const roomSeatOf = (index: StudentIndex, words: readonly string[]) => {
  const seatWord = words.at(-1);
  if (words.length < 2 || seatWord === undefined || !/^\d+$/u.test(seatWord)) return undefined;
  const room = words.slice(0, -1).join('');
  return index.some(({ rooms }) => rooms.has(room))
    ? { room, seatNo: Number(seatWord) }
    : undefined;
};

const matchesWord = ({ name, loginId, rooms }: IndexedStudent, word: string): boolean =>
  name.includes(word) || loginId.includes(word) || rooms.has(word);

export type StudentSearchResult = {
  // At most STUDENT_SEARCH_LIMIT, in the list's order (classroom, seat).
  shown: RoundStudent[];
  total: number;
};

// undefined = nothing to search for yet.
export const searchStudents = (
  index: StudentIndex,
  query: string,
): StudentSearchResult | undefined => {
  const words = wordsOf(query);
  if (words.length === 0) return undefined;
  const whole = words.join('');
  const roomSeat = roomSeatOf(index, words);
  const matches = index.filter((entry) =>
    roomSeat
      ? entry.rooms.has(roomSeat.room) && entry.student.seatNo === roomSeat.seatNo
      : matchesWord(entry, whole) ||
        (words.length > 1 && words.every((word) => matchesWord(entry, word))),
  );
  return {
    shown: matches.slice(0, STUDENT_SEARCH_LIMIT).map(({ student }) => student),
    total: matches.length,
  };
};

const clubLabel = ({ clubCode, name }: { clubCode: string; name: string }) => `${clubCode} ${name}`;

// Where the student stands in the round, as seen from the panel of club `clubId`.
export const studentPlacement = (student: RoundStudent, clubId: number): string => {
  const { club, waitingFor } = student;
  const parts = [
    club && (club.id === clubId ? 'อยู่ชุมนุมนี้แล้ว' : `อยู่ชุมนุม ${clubLabel(club)}`),
    waitingFor && (waitingFor.id === clubId ? 'รอชุมนุมนี้อยู่' : `รอชุมนุม ${clubLabel(waitingFor)}`),
  ].filter((part) => part !== null);
  return parts.length === 0 ? 'ยังไม่มีชุมนุม' : parts.join(' · ');
};

export const STUDENT_SEARCH_MESSAGES = Object.freeze({
  label: 'ค้นหานักเรียน',
  placeholder: 'ชื่อ รหัส หรือห้อง',
  help: (grade: number) =>
    `พิมพ์ชื่อ รหัสนักเรียน ห้อง หรือห้องตามด้วยเลขที่ (เช่น ${grade}/2 12) แล้วกด "เลือก" เพื่อใส่รหัสในช่องรหัสนักเรียน`,
  results: 'ผลการค้นหานักเรียน',
  found: (total: number) => `พบ ${total} คน`,
  more: (shown: number, total: number) => `แสดง ${shown} จาก ${total} คน พิมพ์เพิ่มเพื่อให้แคบลง`,
  none: (query: string) => `ไม่พบนักเรียนที่ตรงกับ "${query.trim()}"`,
  loading: 'กำลังโหลดรายชื่อนักเรียน…',
  loadFailed: 'โหลดรายชื่อนักเรียนไม่สำเร็จ ยังพิมพ์รหัสนักเรียนในช่องด้านล่างเองได้',
});
