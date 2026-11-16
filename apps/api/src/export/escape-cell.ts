// Spreadsheet apps treat text starting with one of these as a formula once the sheet is saved as
// CSV or a cell is edited, so "=HYPERLINK(...)" typed into a name could run on an admin's machine
// (CSV/formula injection, CLAUDE.md rule 8). Tab and CR are included because some apps skip them
// and read the formula character that follows.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

// A leading apostrophe makes Excel, LibreOffice and Google Sheets show the value as plain text.
// Every text cell an export writes goes through this; numbers need no escaping.
export const escapeCellText = (text: string): string =>
  FORMULA_TRIGGER.test(text) ? `'${text}` : text;

export type ExportCellValue = string | number | null;

export const escapeCellValue = (value: ExportCellValue): ExportCellValue =>
  typeof value === 'string' ? escapeCellText(value) : value;
