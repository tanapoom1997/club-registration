import { ERROR_CODES, IMPORT_COLUMNS, IMPORT_SHEETS } from '@club-registration/shared';
import type { ImportError, ImportSheet } from '@club-registration/shared';
import ExcelJS from 'exceljs';
import { AppError } from '../errors.js';

// Worksheet parts the importer never reads; skipping them saves work on heavily formatted files.
// Hyperlinks are skipped too, so a linked e-mail cell reads as its plain text.
const IGNORED_WORKSHEET_NODES = [
  'dataValidations',
  'conditionalFormatting',
  'hyperlinks',
  'pageMargins',
  'pageSetup',
  'headerFooter',
  'printOptions',
  'picture',
  'drawing',
  'tableParts',
  'rowBreaks',
  'colBreaks',
  'extLst',
];

export type CellText = { value: string | undefined } | { error: string };
export type SheetRow = { row: number; cells: ReadonlyMap<string, CellText> };
export type SheetRows = { sheet: ImportSheet; rows: SheetRow[] };
export type WorkbookRows = { sheets: SheetRows[]; errors: ImportError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const richTextOf = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value.map((run) => (isRecord(run) && typeof run.text === 'string' ? run.text : '')).join('')
    : undefined;

const DATE_MESSAGE = 'Excel แปลงค่านี้เป็นวันที่ ให้จัดรูปแบบเซลล์เป็นข้อความ (Text) แล้วพิมพ์ใหม่';
const UNSUPPORTED_MESSAGE = 'อ่านค่าในเซลล์นี้ไม่ได้ ให้พิมพ์เป็นข้อความหรือตัวเลข';

// Turns any Excel cell value into trimmed text. Formulas are never evaluated: the value Excel
// cached when the file was saved is used, and a formula without one is an error.
const cellText = (value: unknown, allowFormula = true): CellText => {
  if (value === null || value === undefined) return { value: undefined };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return { value: trimmed === '' ? undefined : trimmed };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value: String(value) } : { error: UNSUPPORTED_MESSAGE };
  }
  if (value instanceof Date) return { error: DATE_MESSAGE };
  if (!isRecord(value)) return { error: UNSUPPORTED_MESSAGE };
  if ('error' in value) return { error: `เซลล์มีค่าผิดพลาด (${String(value.error)})` };
  if ('formula' in value || 'sharedFormula' in value) {
    if (!allowFormula) return { error: UNSUPPORTED_MESSAGE };
    return value.result === undefined
      ? { error: 'เซลล์เป็นสูตรที่ไม่มีค่าที่คำนวณไว้ ให้วางเป็นค่า (Paste Values)' }
      : cellText(value.result, false);
  }
  const rich = richTextOf(value.richText);
  if (rich !== undefined) return cellText(rich);
  if ('text' in value) return cellText(value.text, false);
  return { error: UNSUPPORTED_MESSAGE };
};

// Excel stores 01234 typed into a cell formatted as 00000 (Custom or Special > Zip Code) as the
// number 1234 and only shows the zeros. Reading the number alone would import the student ID
// 1234, which differs from the ID the school prints, so a whole number in such a format is read
// as Excel shows it. A number in any other format is read as stored: Excel shows it that way too.
const ZERO_PADDED_FORMAT = /^0+$/;

const zeroPadded = (value: unknown, numFmt: string | undefined): unknown => {
  if (numFmt === undefined || !ZERO_PADDED_FORMAT.test(numFmt)) return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0
      ? String(value).padStart(numFmt.length, '0')
      : value;
  }
  if (isRecord(value) && ('formula' in value || 'sharedFormula' in value)) {
    return { ...value, result: zeroPadded(value.result, numFmt) };
  }
  return value;
};

const hasNumber = (value: unknown): boolean =>
  typeof value === 'number' || (isRecord(value) && typeof value.result === 'number');

// Headers match ignoring spaces and case, so "ชื่อ - สกุล" or "Line ID" still map.
const headerKey = (text: string): string => text.replace(/\s+/g, '').toLowerCase();

type ColumnMap = { columns: Map<string, number>; errors: ImportError[] };

const mapHeaders = (sheet: ImportSheet, headerValues: readonly unknown[]): ColumnMap => {
  const wanted = new Map(
    Object.entries(IMPORT_COLUMNS[sheet]).map(([key, label]) => [headerKey(label), key]),
  );
  const labels: Readonly<Record<string, string>> = IMPORT_COLUMNS[sheet];
  const columns = new Map<string, number>();
  const errors: ImportError[] = [];
  headerValues.forEach((value, index) => {
    const text = cellText(value);
    if (!('value' in text) || text.value === undefined) return;
    // Columns outside the template are skipped without reading their contents (PDPA).
    const key = wanted.get(headerKey(text.value));
    if (key === undefined) return;
    if (columns.has(key)) {
      errors.push({ sheet, row: 1, column: labels[key] ?? key, message: 'มีคอลัมน์นี้ซ้ำ' });
      return;
    }
    columns.set(key, index);
  });
  Object.entries(labels)
    .filter(([key]) => !columns.has(key))
    .forEach(([, label]) => {
      errors.push({
        sheet,
        row: 1,
        column: label,
        message: `ไม่พบคอลัมน์ "${label}" ในแถวหัวตาราง`,
      });
    });
  return { columns, errors };
};

const readSheet = (
  sheet: ImportSheet,
  worksheet: ExcelJS.Worksheet,
  maxRows: number,
): { rows: SheetRow[]; errors: ImportError[] } => {
  // A sparse array indexed by row number, then by column number (both 1-based).
  const values: unknown[] = worksheet.getSheetValues();
  const headerValues = values[1];
  const { columns, errors } = mapHeaders(sheet, Array.isArray(headerValues) ? headerValues : []);
  if (errors.length > 0) return { rows: [], errors };

  const rows: SheetRow[] = [];
  values.forEach((rowValues, rowNumber) => {
    if (rowNumber <= 1 || !Array.isArray(rowValues)) return;
    const cells = new Map(
      [...columns].map(([key, column]): [string, CellText] => {
        const value: unknown = rowValues[column];
        // Only a number can be zero-padded, so text cells skip the per-cell lookup.
        const numFmt = hasNumber(value)
          ? worksheet.getRow(rowNumber).getCell(column).numFmt
          : undefined;
        return [key, cellText(zeroPadded(value, numFmt))];
      }),
    );
    // Rows with nothing in the template columns (blank or formatted-only rows) are not data.
    if ([...cells.values()].every((cell) => 'value' in cell && cell.value === undefined)) return;
    rows.push({ row: rowNumber, cells });
  });

  if (rows.length > maxRows) {
    return {
      rows: [],
      errors: [
        {
          sheet,
          row: null,
          column: null,
          message: `ชีตนี้มีข้อมูล ${rows.length.toLocaleString('en-US')} แถว เกินที่รับได้ ${maxRows.toLocaleString('en-US')} แถว`,
        },
      ],
    };
  }
  return { rows, errors: [] };
};

const loadWorkbook = async (bytes: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  try {
    // A copy as a plain ArrayBuffer: exceljs is typed for that, and reads it the same way.
    await workbook.xlsx.load(new Uint8Array(bytes).buffer, {
      ignoreNodes: IGNORED_WORKSHEET_NODES,
    });
  } catch {
    // The parser's message can quote file content, so it is neither logged nor returned.
    throw new AppError(ERROR_CODES.invalidWorkbook);
  }
  // Excel cannot save a workbook without a sheet, so this zip is something else (e.g. a .docx).
  if (workbook.worksheets.length === 0) throw new AppError(ERROR_CODES.invalidWorkbook);
  return workbook;
};

// Reads only the template sheets and columns. Cell problems are returned per cell, not thrown,
// so the admin sees every problem in one pass.
export const readImportWorkbook = async (bytes: Buffer, maxRows: number): Promise<WorkbookRows> => {
  const workbook = await loadWorkbook(bytes);
  const byName = new Map(
    workbook.worksheets.map((worksheet) => [worksheet.name.trim().toLowerCase(), worksheet]),
  );
  const found = IMPORT_SHEETS.flatMap((sheet) => {
    const worksheet = byName.get(sheet);
    return worksheet ? [{ sheet, worksheet }] : [];
  });
  if (found.length === 0) {
    return {
      sheets: [],
      errors: [
        {
          sheet: null,
          row: null,
          column: null,
          message: `ไม่พบชีต ${IMPORT_SHEETS.join(', ')} ในไฟล์ (ใช้ไฟล์ตัวอย่างเป็นต้นแบบ)`,
        },
      ],
    };
  }
  const read = found.map(({ sheet, worksheet }) => ({
    sheet,
    ...readSheet(sheet, worksheet, maxRows),
  }));
  return {
    sheets: read.map(({ sheet, rows }) => ({ sheet, rows })),
    errors: read.flatMap(({ errors }) => errors),
  };
};
