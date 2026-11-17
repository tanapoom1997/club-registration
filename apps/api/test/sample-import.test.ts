import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS } from '../src/dev/demo-accounts.js';
import {
  SAMPLE_ADVISORS,
  SAMPLE_CLUBS,
  SAMPLE_STUDENTS,
  buildSampleImportWorkbooks,
} from '../src/dev/sample-import.js';
import type { SampleWorkbook } from '../src/dev/sample-import.js';
import { parseImportWorkbook } from '../src/import/parse.js';
import { assertXlsxUpload } from '../src/import/xlsx-file.js';

const ALL = 'import-all-fictional.xlsx';
const STUDENTS_ONLY = 'import-students-only-fictional.xlsx';
const CLUBS_ADVISORS = 'import-clubs-advisors-fictional.xlsx';

const workbookNamed = (workbooks: readonly SampleWorkbook[], filename: string): Buffer => {
  const found = workbooks.find((workbook) => workbook.filename === filename);
  if (!found) throw new Error(`No sample named ${filename}`);
  return found.bytes;
};

// The parser adds each row's Excel row number; data starts under the header in row 2.
const FIRST_DATA_ROW = 2;
const located = <T extends object>(rows: readonly T[]) =>
  rows.map((row, index) => ({ ...row, row: index + FIRST_DATA_ROW }));

const cellTexts = async (bytes: Buffer): Promise<string[]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  return workbook.worksheets.flatMap((worksheet) => {
    const texts: string[] = [];
    worksheet.eachRow((row) => row.eachCell((cell) => texts.push(cell.text)));
    return texts;
  });
};

describe('fictional sample import workbooks', () => {
  it('writes the three sample files', async () => {
    const workbooks = await buildSampleImportWorkbooks();

    expect(workbooks.map(({ filename }) => filename)).toEqual([ALL, STUDENTS_ONLY, CLUBS_ADVISORS]);
  });

  it('passes the upload checks the import route runs', async () => {
    const workbooks = await buildSampleImportWorkbooks();

    await Promise.all(
      workbooks.map(async ({ filename, bytes }) => {
        await expect(assertXlsxUpload(filename, bytes)).resolves.toBeUndefined();
      }),
    );
  });

  it('parses the all-sheets file with no errors and every row', async () => {
    const bytes = workbookNamed(await buildSampleImportWorkbooks(), ALL);

    const parsed = await parseImportWorkbook(bytes);

    expect(parsed.errors).toEqual([]);
    expect(parsed.students).toEqual(located(SAMPLE_STUDENTS));
    expect(parsed.clubs).toEqual(located(SAMPLE_CLUBS));
    expect(parsed.advisors).toEqual(located(SAMPLE_ADVISORS));
  });

  it('has the expected numbers of rows', async () => {
    const parsed = await parseImportWorkbook(
      workbookNamed(await buildSampleImportWorkbooks(), ALL),
    );

    expect(parsed.students).toHaveLength(80);
    expect(parsed.clubs).toHaveLength(9);
    expect(parsed.clubCodesInFile.size).toBe(8);
    expect(parsed.advisors).toHaveLength(8);
  });

  it('puts only the students sheet in the students-only file', async () => {
    const parsed = await parseImportWorkbook(
      workbookNamed(await buildSampleImportWorkbooks(), STUDENTS_ONLY),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.students).toHaveLength(SAMPLE_STUDENTS.length);
    expect(parsed.clubs).toBeNull();
    expect(parsed.advisors).toBeNull();
  });

  it('puts only the clubs and advisors sheets in the clubs-advisors file', async () => {
    const parsed = await parseImportWorkbook(
      workbookNamed(await buildSampleImportWorkbooks(), CLUBS_ADVISORS),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.students).toBeNull();
    expect(parsed.clubs).toHaveLength(SAMPLE_CLUBS.length);
    expect(parsed.advisors).toHaveLength(SAMPLE_ADVISORS.length);
  });

  it('contains every demo student exactly as seed-dev creates them', async () => {
    const parsed = await parseImportWorkbook(
      workbookNamed(await buildSampleImportWorkbooks(), ALL),
    );
    const demoIds = new Set(DEMO_ACCOUNTS.map(({ loginId }) => loginId));

    const demoInSample = (parsed.students ?? [])
      .filter(({ loginId }) => demoIds.has(loginId))
      .map(({ loginId, fullName, grade, classroom, seatNo }) => ({
        loginId,
        fullName,
        grade,
        classroom,
        seatNo,
      }));

    expect(demoInSample).toEqual(
      DEMO_ACCOUNTS.flatMap(({ loginId, fullName, profile }) =>
        profile ? [{ loginId, fullName, ...profile }] : [],
      ),
    );
  });

  it('gives generated students IDs unlike any demo account and no seat twice', () => {
    const generated = SAMPLE_STUDENTS.filter(({ loginId }) => !loginId.startsWith('demo'));
    const seats = SAMPLE_STUDENTS.map(
      ({ grade, classroom, seatNo }) => `${grade}/${classroom}/${seatNo}`,
    );

    expect(generated.every(({ loginId }) => /^\d+$/.test(loginId))).toBe(true);
    expect(new Set(SAMPLE_STUDENTS.map(({ loginId }) => loginId)).size).toBe(
      SAMPLE_STUDENTS.length,
    );
    expect(new Set(seats).size).toBe(seats.length);
  });

  it('has no cell a spreadsheet would read as a formula', async () => {
    const workbooks = await buildSampleImportWorkbooks();

    const texts = (await Promise.all(workbooks.map(async ({ bytes }) => await cellTexts(bytes))))
      .flat()
      .filter((text) => /^[=+\-@]/.test(text));

    expect(texts).toEqual([]);
  });

  it('uses only made-up contact details', () => {
    expect(
      SAMPLE_ADVISORS.every(
        ({ phone, email }) =>
          (phone === null || phone.startsWith('000-')) &&
          (email === null || email.endsWith('@example.com')),
      ),
    ).toBe(true);
  });

  it('builds the same rows on every run', async () => {
    const [first, second] = await Promise.all([
      buildSampleImportWorkbooks(),
      buildSampleImportWorkbooks(),
    ]);

    const parse = async (bytes: Buffer) => {
      const { students, clubs, advisors } = await parseImportWorkbook(bytes);
      return { students, clubs, advisors };
    };

    expect(await parse(workbookNamed(second, ALL))).toEqual(await parse(workbookNamed(first, ALL)));
  });
});
