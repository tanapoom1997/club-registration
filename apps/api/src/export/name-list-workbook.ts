import { CLASSROOM_LIST_COLUMNS, CLUB_LIST_COLUMNS } from '@club-registration/shared';
import type ExcelJS from 'exceljs';
import type { ClassroomList, ClubList, ExportRound } from '../services/name-lists.js';
import { escapeCellText, escapeCellValue } from './escape-cell.js';
import { classroomListSection, clubListSection } from './name-list-content.js';
import type { ListSection } from './name-list-content.js';
import { a4PageSetup, createExportWorkbook, createSheetNamer, workbookBuffer } from './sheet.js';

// Layout of every sheet: a few heading lines (one text cell each, wide enough to spill across
// the row), a blank line, then the table. The table header repeats on every printed page.

type ColumnSpec = { width: number; text: boolean };
type Column = readonly [header: string, spec: ColumnSpec];

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

const columnsOf = <K extends string>(
  headers: Readonly<Record<K, string>>,
  specs: Readonly<Record<K, ColumnSpec>>,
): Column[] => (Object.keys(headers) as K[]).map((key) => [headers[key], specs[key]] as const);

const CLUB_COLUMNS = columnsOf(CLUB_LIST_COLUMNS, CLUB_COLUMN_SPECS);
const CLASSROOM_COLUMNS = columnsOf(CLASSROOM_LIST_COLUMNS, CLASSROOM_COLUMN_SPECS);

const addListSheet = (
  workbook: ExcelJS.Workbook,
  name: string,
  columns: readonly Column[],
  { headings, rows }: ListSection,
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

// One sheet per club, named by club code.
export const buildClubListWorkbook = async (
  round: ExportRound,
  clubs: readonly ClubList[],
  exportedAt: Date,
): Promise<Buffer> => {
  const workbook = createExportWorkbook();
  const sheetName = createSheetNamer();
  clubs.forEach((club) => {
    addListSheet(
      workbook,
      sheetName(club.clubCode),
      CLUB_COLUMNS,
      clubListSection(round, club, exportedAt),
    );
  });
  return await workbookBuffer(workbook);
};

// One sheet per classroom.
export const buildClassroomListWorkbook = async (
  round: ExportRound,
  classrooms: readonly ClassroomList[],
  exportedAt: Date,
): Promise<Buffer> => {
  const workbook = createExportWorkbook();
  const sheetName = createSheetNamer();
  classrooms.forEach((classroom) => {
    addListSheet(
      workbook,
      sheetName(`ม.${classroom.grade}-${classroom.classroom}`),
      CLASSROOM_COLUMNS,
      classroomListSection(round, classroom, exportedAt),
    );
  });
  return await workbookBuffer(workbook);
};
