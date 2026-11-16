import { NOT_REGISTERED_LABEL } from '@club-registration/shared';
import type { ClassroomList, ClubList, ExportRound } from '../services/name-lists.js';

// What a name list says, whatever the file format: the heading lines above the table and the rows
// (the table header comes from the column definitions in packages/shared). The Excel and PDF
// builders only lay it out, so both formats always carry the same headings, columns and values.

export type ListCell = string | number;

export type ListSection = {
  // Heading lines above the table, the first one being the title.
  headings: string[];
  rows: ListCell[][];
};

const exportTimeFormat = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  dateStyle: 'medium',
  timeStyle: 'short',
});

// Thai time, whatever time zone the server runs in.
export const formatExportTime = (date: Date): string => exportTimeFormat.format(date);

export const classroomLabel = (grade: number, classroom: string): string =>
  `ม.${grade}/${classroom}`;

const roundLine = (round: ExportRound, exportedAt: Date): string =>
  `รอบ ${round.term} ม.${round.grade} · ข้อมูล ณ ${formatExportTime(exportedAt)}`;

// Advisors take attendance from it, in grade → classroom → seat order.
export const clubListSection = (
  round: ExportRound,
  club: ClubList,
  exportedAt: Date,
): ListSection => ({
  headings: [
    `ชุมนุม ${club.clubCode} ${club.name}`,
    // Names only: advisors' phone, email and LINE never leave the system in an export.
    `ครูที่ปรึกษา: ${club.advisorNames.length === 0 ? '-' : club.advisorNames.join(', ')}`,
    // Counted from the rows below, in the same snapshot, so the list always adds up.
    `จำนวนลง/จำนวนรับ: ${club.students.length}/${club.capacity}`,
    roundLine(round, exportedAt),
  ],
  rows: club.students.map((student, index) => [
    index + 1,
    student.loginId,
    student.fullName,
    classroomLabel(student.grade, student.classroom),
    student.seatNo,
  ]),
});

// Homeroom teachers chase the students marked as not registered.
export const classroomListSection = (
  round: ExportRound,
  { grade, classroom, students }: ClassroomList,
  exportedAt: Date,
): ListSection => ({
  headings: [
    `ชั้น/ห้อง ${classroomLabel(grade, classroom)}`,
    `ลงแล้ว/ทั้งห้อง: ${students.filter(({ club }) => club !== null).length}/${students.length}`,
    roundLine(round, exportedAt),
  ],
  rows: students.map(({ seatNo, loginId, fullName, club }) => [
    seatNo,
    loginId,
    fullName,
    club === null ? NOT_REGISTERED_LABEL : `${club.clubCode} ${club.name}`,
  ]),
});
