import { INITIAL_PASSWORD_COLUMNS } from '@club-registration/shared';
import type { IssuedStudent } from '../services/initial-passwords.js';
import { escapeCellText, escapeCellValue } from './escape-cell.js';
import type { ExportCellValue } from './escape-cell.js';
import { a4PageSetup, createExportWorkbook, createSheetNamer, workbookBuffer } from './sheet.js';

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
  const workbook = createExportWorkbook();
  const sheetName = createSheetNamer();
  groupByClassroom(students).forEach(({ grade, classroom, students: rows }) => {
    const worksheet = workbook.addWorksheet(sheetName(`ม.${grade}-${classroom}`), {
      pageSetup: a4PageSetup(1),
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
  return await workbookBuffer(workbook);
};
