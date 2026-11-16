import { INITIAL_PASSWORD_COLUMNS } from '@club-registration/shared';
import ExcelJS from 'exceljs';
import type { IssuedStudent } from '../services/initial-passwords.js';
import { escapeCellText, escapeCellValue } from './escape-cell.js';
import type { ExportCellValue } from './escape-cell.js';

type ColumnKey = keyof typeof INITIAL_PASSWORD_COLUMNS;

const COLUMN_WIDTHS: Readonly<Record<ColumnKey, number>> = Object.freeze({
  loginId: 16,
  fullName: 36,
  grade: 8,
  classroom: 8,
  seatNo: 8,
  password: 16,
});

// Text format so Excel keeps an ID's leading zeros and never turns a value into a date or number
// if the admin edits a cell.
const TEXT_COLUMNS: ReadonlySet<ColumnKey> = new Set([
  'loginId',
  'fullName',
  'classroom',
  'password',
]);

const SHEET_NAME_MAX = 31;
// Room for a " (n)" suffix when two classrooms clean up to the same name.
const SHEET_BASE_MAX = SHEET_NAME_MAX - 4;
const ILLEGAL_SHEET_CHARS = /[*?:/\\[\]]/g;

const sheetBaseName = (grade: number, classroom: string): string =>
  `ม.${grade}-${classroom}`
    .replace(ILLEGAL_SHEET_CHARS, '-')
    .replace(/^'+|'+$/g, '')
    .slice(0, SHEET_BASE_MAX);

// Excel compares sheet names case-insensitively.
const uniqueSheetName = (base: string, used: ReadonlySet<string>): string => {
  const candidates = [base, ...Array.from({ length: used.size }, (_, i) => `${base} (${i + 2})`)];
  return candidates.find((name) => !used.has(name.toLowerCase())) ?? base;
};

type ClassroomGroup = { grade: number; classroom: string; students: IssuedStudent[] };

// Keeps the order students arrive in (already sorted for printing): a Map keeps insertion order.
const groupByClassroom = (students: readonly IssuedStudent[]): ClassroomGroup[] => {
  const groups = new Map<string, ClassroomGroup>();
  students.forEach((student) => {
    const key = `${student.grade}\u0000${student.classroom}`;
    const group = groups.get(key);
    if (group) {
      group.students.push(student);
      return;
    }
    groups.set(key, { grade: student.grade, classroom: student.classroom, students: [student] });
  });
  return [...groups.values()];
};

const rowOf = (student: IssuedStudent): ExportCellValue[] =>
  (Object.keys(INITIAL_PASSWORD_COLUMNS) as ColumnKey[]).map((key) =>
    escapeCellValue(student[key]),
  );

// One sheet per classroom so each prints on its own pages for that classroom's teacher.
export const buildInitialPasswordWorkbook = async (
  students: readonly IssuedStudent[],
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  // Neither who exported the file nor anything about a student goes into its properties.
  workbook.creator = 'club-registration';
  workbook.lastModifiedBy = 'club-registration';

  const usedNames = new Set<string>();
  groupByClassroom(students).forEach(({ grade, classroom, students: rows }) => {
    const name = uniqueSheetName(sheetBaseName(grade, classroom), usedNames);
    usedNames.add(name.toLowerCase());
    const worksheet = workbook.addWorksheet(name, {
      pageSetup: {
        paperSize: 9, // A4
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: '1:1',
      },
    });
    worksheet.columns = (Object.entries(INITIAL_PASSWORD_COLUMNS) as [ColumnKey, string][]).map(
      ([key, header]) => ({
        key,
        header: escapeCellText(header),
        width: COLUMN_WIDTHS[key],
        ...(TEXT_COLUMNS.has(key) ? { style: { numFmt: '@' } } : {}),
      }),
    );
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    rows.forEach((student) => worksheet.addRow(rowOf(student)));
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
};
