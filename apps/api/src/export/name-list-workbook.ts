import {
  CLASSROOM_LIST_COLUMNS,
  CLUB_LIST_COLUMNS,
  NOT_REGISTERED_LABEL,
} from '@club-registration/shared';
import type ExcelJS from 'exceljs';
import type {
  ClassroomList,
  ClubList,
  ClubListStudent,
  ExportRound,
} from '../services/name-lists.js';
import { escapeCellText, escapeCellValue } from './escape-cell.js';
import type { ExportCellValue } from './escape-cell.js';
import { a4PageSetup, createExportWorkbook, createSheetNamer, workbookBuffer } from './sheet.js';

// Layout of every sheet: a few heading lines (one text cell each, wide enough to spill across
// the row), a blank line, then the table. The table header repeats on every printed page.

type ColumnSpec = { width: number; text: boolean };

const CLUB_COLUMN_SPECS: Readonly<Record<keyof typeof CLUB_LIST_COLUMNS, ColumnSpec>> =
  Object.freeze({
    order: { width: 8, text: false },
    loginId: { width: 16, text: true },
    fullName: { width: 36, text: true },
    classroom: { width: 12, text: true },
    seatNo: { width: 8, text: false },
  });

const CLASSROOM_COLUMN_SPECS: Readonly<Record<keyof typeof CLASSROOM_LIST_COLUMNS, ColumnSpec>> =
  Object.freeze({
    seatNo: { width: 8, text: false },
    loginId: { width: 16, text: true },
    fullName: { width: 36, text: true },
    club: { width: 40, text: true },
  });

const exportTimeFormat = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const classroomLabel = (grade: number, classroom: string): string =>
  `ม.${grade}/${classroom}`;

const roundLine = (round: ExportRound, exportedAt: Date): string =>
  `รอบ ${round.term} ม.${round.grade} · ข้อมูล ณ ${exportTimeFormat.format(exportedAt)}`;

type SheetContent = {
  name: string;
  headings: readonly string[];
  columns: readonly (readonly [header: string, spec: ColumnSpec])[];
  rows: readonly ExportCellValue[][];
};

const addListSheet = (
  workbook: ExcelJS.Workbook,
  { name, headings, columns, rows }: SheetContent,
): void => {
  // Headings, one blank line, then the table header.
  const headerRow = headings.length + 2;
  const worksheet = workbook.addWorksheet(name, {
    pageSetup: a4PageSetup(headerRow),
    headerFooter: { oddFooter: '&Cหน้า &P / &N' },
    views: [{ state: 'frozen', ySplit: headerRow }],
  });
  // Text format so Excel keeps an ID's leading zeros and never turns a value into a date or number
  // if the admin edits a cell.
  worksheet.columns = columns.map(([, { width, text }]) => ({
    width,
    ...(text ? { style: { numFmt: '@' } } : {}),
  }));
  headings.forEach((heading, index) => {
    const row = worksheet.addRow([escapeCellText(heading)]);
    if (index === 0) row.font = { bold: true, size: 14 };
  });
  worksheet.addRow([]);
  worksheet.addRow(columns.map(([header]) => escapeCellText(header))).font = { bold: true };
  rows.forEach((row) => worksheet.addRow(row.map(escapeCellValue)));
};

const clubStudentRow = (student: ClubListStudent, index: number): ExportCellValue[] => [
  index + 1,
  student.loginId,
  student.fullName,
  classroomLabel(student.grade, student.classroom),
  student.seatNo,
];

// One sheet per club, named by club code: advisors take attendance from it.
export const buildClubListWorkbook = async (
  round: ExportRound,
  clubs: readonly ClubList[],
  exportedAt: Date,
): Promise<Buffer> => {
  const workbook = createExportWorkbook();
  const sheetName = createSheetNamer();
  const columns = Object.entries(CLUB_LIST_COLUMNS).map(
    ([key, header]) => [header, CLUB_COLUMN_SPECS[key as keyof typeof CLUB_LIST_COLUMNS]] as const,
  );
  clubs.forEach((club) => {
    addListSheet(workbook, {
      name: sheetName(club.clubCode),
      headings: [
        `ชุมนุม ${club.clubCode} ${club.name}`,
        // Names only: advisors' phone, email and LINE never leave the system in an export.
        `ครูที่ปรึกษา: ${club.advisorNames.length === 0 ? '-' : club.advisorNames.join(', ')}`,
        // Counted from the rows below, in the same snapshot, so the sheet always adds up.
        `จำนวนลง/จำนวนรับ: ${club.students.length}/${club.capacity}`,
        roundLine(round, exportedAt),
      ],
      columns,
      rows: club.students.map(clubStudentRow),
    });
  });
  return await workbookBuffer(workbook);
};

// One sheet per classroom: homeroom teachers chase the students marked as not registered.
export const buildClassroomListWorkbook = async (
  round: ExportRound,
  classrooms: readonly ClassroomList[],
  exportedAt: Date,
): Promise<Buffer> => {
  const workbook = createExportWorkbook();
  const sheetName = createSheetNamer();
  const columns = Object.entries(CLASSROOM_LIST_COLUMNS).map(
    ([key, header]) =>
      [header, CLASSROOM_COLUMN_SPECS[key as keyof typeof CLASSROOM_LIST_COLUMNS]] as const,
  );
  classrooms.forEach(({ grade, classroom, students }) => {
    const registered = students.filter(({ club }) => club !== null).length;
    addListSheet(workbook, {
      name: sheetName(`ม.${grade}-${classroom}`),
      headings: [
        `ชั้น/ห้อง ${classroomLabel(grade, classroom)}`,
        `ลงแล้ว/ทั้งห้อง: ${registered}/${students.length}`,
        roundLine(round, exportedAt),
      ],
      columns,
      rows: students.map(({ seatNo, loginId, fullName, club }) => [
        seatNo,
        loginId,
        fullName,
        club === null ? NOT_REGISTERED_LABEL : `${club.clubCode} ${club.name}`,
      ]),
    });
  });
  return await workbookBuffer(workbook);
};
