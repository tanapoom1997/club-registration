import {
  IMPORT_COLUMNS,
  IMPORT_MAX_ROWS_PER_SHEET,
  IMPORT_ROW_SCHEMAS,
} from '@club-registration/shared';
import type {
  AdvisorImportRow,
  ClubImportRow,
  ImportError,
  ImportSheet,
  StudentImportRow,
} from '@club-registration/shared';
import type { z } from 'zod';
import { readImportWorkbook } from './workbook.js';
import type { SheetRow } from './workbook.js';

// row is the Excel row number, kept so later checks can point the admin at the right line.
export type Located<T> = T & { row: number };

export type ParsedImport = {
  // null when the sheet is not in the file: that kind of data is left alone.
  students: Located<StudentImportRow>[] | null;
  clubs: Located<ClubImportRow>[] | null;
  advisors: Located<AdvisorImportRow>[] | null;
  // Every club code written in the clubs sheet, valid row or not, so an advisor row for a club
  // whose own row has a typo is not reported a second time.
  clubCodesInFile: ReadonlySet<string>;
  errors: ImportError[];
};

const columnLabel = (sheet: ImportSheet, key: string): string =>
  (IMPORT_COLUMNS[sheet] as Readonly<Record<string, string>>)[key] ?? key;

type RowResult<T> = { data: T | undefined; errors: ImportError[] };

// One error per bad cell, all cells checked: the admin fixes a whole row in one go.
const validateRow = <S extends z.ZodType>(
  sheet: ImportSheet,
  schema: S,
  { row, cells }: SheetRow,
): RowResult<z.output<S>> => {
  const cellErrors = [...cells].flatMap(([key, cell]) =>
    'error' in cell ? [{ sheet, row, column: columnLabel(sheet, key), message: cell.error }] : [],
  );
  const input = Object.fromEntries(
    [...cells].map(([key, cell]) => [key, 'value' in cell ? cell.value : undefined]),
  );
  const result = schema.safeParse(input);
  // A cell that could not be read already has its error; "required" on top would be noise.
  const reported = new Set(cellErrors.map(({ column }) => column));
  const schemaErrors = (result.success ? [] : result.error.issues).flatMap((issue) => {
    const column = columnLabel(sheet, String(issue.path[0] ?? ''));
    if (reported.has(column)) return [];
    reported.add(column);
    return [{ sheet, row, column, message: issue.message }];
  });
  const errors = [...cellErrors, ...schemaErrors];
  return { data: result.success && errors.length === 0 ? result.data : undefined, errors };
};

type KeyedRow<T> = { row: number; key: string | undefined; data: T | undefined };

// The first row with a key wins; each later one is reported, naming the row it repeats.
const duplicateErrors = <T>(
  sheet: ImportSheet,
  rows: readonly KeyedRow<T>[],
  column: string,
  describe: (key: string) => string,
): ImportError[] => {
  const firstRow = new Map<string, number>();
  return rows.flatMap(({ row, key }) => {
    if (key === undefined) return [];
    const first = firstRow.get(key);
    if (first === undefined) {
      firstRow.set(key, row);
      return [];
    }
    return [{ sheet, row, column, message: `${describe(key)} ซ้ำกับแถว ${first}` }];
  });
};

const keyOf = <T>(schema: z.ZodType<T>, value: string | undefined): T | undefined => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

const cellValue = ({ cells }: SheetRow, key: string): string | undefined => {
  const cell = cells.get(key);
  return cell && 'value' in cell ? cell.value : undefined;
};

type SheetResult<T> = { rows: Located<T>[]; errors: ImportError[] };

const validateSheet = <S extends z.ZodType>(
  sheet: ImportSheet,
  schema: S,
  rows: readonly SheetRow[],
  duplicates: (keyed: KeyedRow<z.output<S>>[]) => ImportError[],
  keyFor: (row: SheetRow) => string | undefined,
): SheetResult<z.output<S>> => {
  const keyed = rows.map((sheetRow) => {
    const { data, errors } = validateRow(sheet, schema, sheetRow);
    return { row: sheetRow.row, key: keyFor(sheetRow), data, errors };
  });
  const duplicateRows = duplicates(keyed);
  const rejected = new Set(duplicateRows.map(({ row }) => row));
  return {
    rows: keyed.flatMap(({ row, data }) =>
      data === undefined || rejected.has(row) ? [] : [{ ...data, row }],
    ),
    errors: [...keyed.flatMap(({ errors }) => errors), ...duplicateRows],
  };
};

const studentSheet = (rows: readonly SheetRow[]) => {
  const { students: schema } = IMPORT_ROW_SCHEMAS;
  return validateSheet(
    'students',
    schema,
    rows,
    (keyed) =>
      duplicateErrors(
        'students',
        keyed,
        IMPORT_COLUMNS.students.loginId,
        (id) => `รหัสนักเรียน ${id}`,
      ),
    (row) => keyOf(schema.shape.loginId, cellValue(row, 'loginId')),
  );
};

const clubSheet = (rows: readonly SheetRow[]) => {
  const { clubs: schema } = IMPORT_ROW_SCHEMAS;
  // A club taking several grades has one row per grade, so the key is code + grade.
  const keyFor = (row: SheetRow) => {
    const code = keyOf(schema.shape.clubCode, cellValue(row, 'clubCode'));
    const grade = keyOf(schema.shape.grade, cellValue(row, 'grade'));
    return code === undefined || grade === undefined ? undefined : `${code} ม.${grade}`;
  };
  return validateSheet(
    'clubs',
    schema,
    rows,
    (keyed) =>
      duplicateErrors(
        'clubs',
        keyed,
        IMPORT_COLUMNS.clubs.clubCode,
        (key) => `รหัสชุมนุมและชั้น ${key}`,
      ),
    keyFor,
  );
};

const advisorSheet = (rows: readonly SheetRow[]) =>
  validateSheet(
    'advisors',
    IMPORT_ROW_SCHEMAS.advisors,
    rows,
    () => [],
    () => undefined,
  );

// Pure: reads and validates the file without touching the database, so the commit step can run
// the same parse and then diff inside its own transaction.
export const parseImportWorkbook = async (
  bytes: Buffer,
  maxRows = IMPORT_MAX_ROWS_PER_SHEET,
): Promise<ParsedImport> => {
  const workbook = await readImportWorkbook(bytes, maxRows);
  const rowsOf = (sheet: ImportSheet) =>
    workbook.sheets.find((found) => found.sheet === sheet)?.rows;

  const studentRows = rowsOf('students');
  const clubRows = rowsOf('clubs');
  const advisorRows = rowsOf('advisors');
  const students = studentRows && studentSheet(studentRows);
  const clubs = clubRows && clubSheet(clubRows);
  const advisors = advisorRows && advisorSheet(advisorRows);

  const clubCodesInFile = new Set(
    (clubRows ?? []).flatMap((row) => {
      const code = keyOf(IMPORT_ROW_SCHEMAS.clubs.shape.clubCode, cellValue(row, 'clubCode'));
      return code === undefined ? [] : [code];
    }),
  );

  return {
    students: students?.rows ?? null,
    clubs: clubs?.rows ?? null,
    advisors: advisors?.rows ?? null,
    clubCodesInFile,
    errors: [
      ...workbook.errors,
      ...(students?.errors ?? []),
      ...(clubs?.errors ?? []),
      ...(advisors?.errors ?? []),
    ],
  };
};
