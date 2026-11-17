import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IMPORT_COLUMNS, IMPORT_SHEETS } from '@club-registration/shared';
import ExcelJS from 'exceljs';

export const IMPORT_TEMPLATE_FILENAME = 'import-template.xlsx';

// Same depth from src/import and dist/import, so dev, tests and the built server find one file.
export const IMPORT_TEMPLATE_PATH = fileURLToPath(
  new URL(`../../../../templates/${IMPORT_TEMPLATE_FILENAME}`, import.meta.url),
);

// Text format keeps the leading zero of a phone number and stops Excel from turning a code
// such as "1/2" into a date while the admin types.
export const TEXT_COLUMNS: ReadonlySet<string> = new Set([
  'loginId',
  'classroom',
  'clubCode',
  'phone',
  'lineId',
]);
const COLUMN_WIDTH = 22;
// Fixed so regenerating the template does not stamp the file with who made it or when.
const TEMPLATE_DATE = new Date('2026-01-01T00:00:00Z');

// Headers only, never data: templates/ is committed to a public repo.
export const buildImportTemplate = async (): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'club-registration';
  workbook.lastModifiedBy = 'club-registration';
  workbook.created = TEMPLATE_DATE;
  workbook.modified = TEMPLATE_DATE;
  IMPORT_SHEETS.forEach((sheet) => {
    const worksheet = workbook.addWorksheet(sheet);
    const columns = Object.entries(IMPORT_COLUMNS[sheet]);
    worksheet.columns = columns.map(([key, header]) => ({
      key,
      header,
      width: COLUMN_WIDTH,
      ...(TEXT_COLUMNS.has(key) ? { style: { numFmt: '@' } } : {}),
    }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const readImportTemplate = async (): Promise<Buffer> => await readFile(IMPORT_TEMPLATE_PATH);
