import { readFile } from 'node:fs/promises';
import { IMPORT_COLUMNS, IMPORT_SHEETS } from '@club-registration/shared';
import type { ImportSheet } from '@club-registration/shared';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { IMPORT_TEMPLATE_PATH, buildImportTemplate } from '../src/import/template.js';
import { templateHeader } from './support/import.js';

const COL = IMPORT_COLUMNS;
const TEXT_FORMAT = '@';

const loadWorkbook = async (bytes: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  return workbook;
};

// What an admin sees when opening the file, read back the way Excel would read it.
const layoutOf = async (bytes: Buffer) =>
  (await loadWorkbook(bytes)).worksheets.map((worksheet) => {
    const headerRow = worksheet.getRow(1);
    const header = (headerRow.values as ExcelJS.CellValue[]).slice(1);
    return {
      name: worksheet.name,
      header,
      rows: worksheet.actualRowCount,
      textColumns: header.filter(
        (_label, index) => worksheet.getColumn(index + 1).numFmt === TEXT_FORMAT,
      ),
      boldHeader: headerRow.font.bold === true,
      frozenRows: worksheet.views.map((view) => (view.state === 'frozen' ? view.ySplit : 0)),
    };
  });

describe('import template', () => {
  it('has one sheet per import sheet, each with only its header row', async () => {
    const layout = await layoutOf(await buildImportTemplate());

    expect(layout.map(({ name, header, rows }) => ({ name, header, rows }))).toEqual(
      IMPORT_SHEETS.map((sheet) => ({ name: sheet, header: templateHeader(sheet), rows: 1 })),
    );
  });

  it('formats code, classroom and contact columns as text', async () => {
    // Text keeps the leading zero of a phone number and stops Excel from turning "1/2" into a date.
    const expected: Record<ImportSheet, string[]> = {
      students: [COL.students.loginId, COL.students.classroom],
      clubs: [COL.clubs.clubCode],
      advisors: [COL.advisors.clubCode, COL.advisors.phone, COL.advisors.lineId],
    };

    const layout = await layoutOf(await buildImportTemplate());

    expect(Object.fromEntries(layout.map(({ name, textColumns }) => [name, textColumns]))).toEqual(
      expected,
    );
  });

  it('keeps the header row bold and frozen while the admin scrolls', async () => {
    const layout = await layoutOf(await buildImportTemplate());

    expect(layout.map(({ boldHeader, frozenRows }) => ({ boldHeader, frozenRows }))).toEqual(
      IMPORT_SHEETS.map(() => ({ boldHeader: true, frozenRows: [1] })),
    );
  });

  it('records a fixed author and date instead of who generated it and when', async () => {
    const workbook = await loadWorkbook(await buildImportTemplate());

    expect({
      creator: workbook.creator,
      lastModifiedBy: workbook.lastModifiedBy,
      created: workbook.created.toISOString(),
      modified: workbook.modified.toISOString(),
    }).toEqual({
      creator: 'club-registration',
      lastModifiedBy: 'club-registration',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    });
  });

  it('matches the committed template, so a column change cannot ship without regenerating it', async () => {
    const [built, committed] = await Promise.all([
      layoutOf(await buildImportTemplate()),
      layoutOf(await readFile(IMPORT_TEMPLATE_PATH)),
    ]);

    expect(committed, 'run: pnpm --filter api generate-template').toEqual(built);
  });
});
