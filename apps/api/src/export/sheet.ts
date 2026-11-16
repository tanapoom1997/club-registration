import ExcelJS from 'exceljs';

// What every exported workbook shares: anonymous file properties, sheet names Excel accepts, and
// a print layout teachers can use as-is.

const SHEET_NAME_MAX = 31;
// Room for a " (n)" suffix when two names clean up to the same one.
const SHEET_BASE_MAX = SHEET_NAME_MAX - 4;
const ILLEGAL_SHEET_CHARS = /[*?:/\\[\]]/g;

const sheetBaseName = (text: string): string =>
  text
    .replace(ILLEGAL_SHEET_CHARS, '-')
    .replace(/^'+|'+$/g, '')
    .slice(0, SHEET_BASE_MAX);

// Returns a function that turns a label into a sheet name no other sheet of the workbook has yet.
// Excel compares sheet names case-insensitively.
export const createSheetNamer = (): ((label: string) => string) => {
  const used = new Set<string>();
  return (label) => {
    const base = sheetBaseName(label);
    const candidates = [base, ...Array.from({ length: used.size }, (_, i) => `${base} (${i + 2})`)];
    const name = candidates.find((candidate) => !used.has(candidate.toLowerCase())) ?? base;
    used.add(name.toLowerCase());
    return name;
  };
};

// Neither who exported the file nor anything about a student goes into its properties.
export const createExportWorkbook = (): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'club-registration';
  workbook.lastModifiedBy = 'club-registration';
  return workbook;
};

// A4 portrait, one page wide, with the table header repeated on every printed page.
export const a4PageSetup = (headerRow: number): Partial<ExcelJS.PageSetup> => ({
  paperSize: 9, // A4
  orientation: 'portrait',
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 0,
  printTitlesRow: `${headerRow}:${headerRow}`,
});

export const workbookBuffer = async (workbook: ExcelJS.Workbook): Promise<Buffer> =>
  Buffer.from(await workbook.xlsx.writeBuffer());
