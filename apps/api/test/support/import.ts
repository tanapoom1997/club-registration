import { crc32, deflateRawSync } from 'node:zlib';
import { IMPORT_COLUMNS } from '@club-registration/shared';
import type { ImportSheet } from '@club-registration/shared';
import ExcelJS from 'exceljs';

// Workbooks are built in code at test time: no .xlsx fixture is ever committed, and every value
// in them is made up.
export type SheetSpec = { header: readonly string[]; rows: readonly ExcelJS.CellValue[][] };

export const buildWorkbook = async (sheets: Record<string, SheetSpec>): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  Object.entries(sheets).forEach(([name, { header, rows }]) => {
    const worksheet = workbook.addWorksheet(name);
    worksheet.addRow([...header]);
    rows.forEach((row) => worksheet.addRow([...row]));
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const templateHeader = (sheet: ImportSheet): string[] =>
  Object.values(IMPORT_COLUMNS[sheet]);

// Sheets with the template headers; only the sheets given are included in the file.
export const buildImportWorkbook = async (
  rows: Partial<Record<ImportSheet, readonly ExcelJS.CellValue[][]>>,
): Promise<Buffer> =>
  await buildWorkbook(
    Object.fromEntries(
      Object.entries(rows).map(([sheet, sheetRows]) => [
        sheet,
        { header: templateHeader(sheet as ImportSheet), rows: sheetRows },
      ]),
    ),
  );

export const studentRow = ({
  loginId,
  fullName = 'นักเรียน สมมติ',
  grade = 1,
  classroom = '1',
  seatNo = 1,
}: {
  loginId: ExcelJS.CellValue;
  fullName?: ExcelJS.CellValue;
  grade?: ExcelJS.CellValue;
  classroom?: ExcelJS.CellValue;
  seatNo?: ExcelJS.CellValue;
}): ExcelJS.CellValue[] => [loginId, fullName, grade, classroom, seatNo];

export const clubRow = ({
  clubCode,
  name = 'ชุมนุมสมมติ',
  grade = 1,
  capacity = 30,
  description = '',
}: {
  clubCode: ExcelJS.CellValue;
  name?: ExcelJS.CellValue;
  grade?: ExcelJS.CellValue;
  capacity?: ExcelJS.CellValue;
  description?: ExcelJS.CellValue;
}): ExcelJS.CellValue[] => [clubCode, name, grade, capacity, description];

export const advisorRow = ({
  clubCode,
  fullName = 'ครูสมมติ',
  phone = null,
  email = null,
  lineId = null,
}: {
  clubCode: ExcelJS.CellValue;
  fullName?: ExcelJS.CellValue;
  phone?: ExcelJS.CellValue;
  email?: ExcelJS.CellValue;
  lineId?: ExcelJS.CellValue;
}): ExcelJS.CellValue[] => [clubCode, fullName, phone, email, lineId];

export type MultipartFile = { name: string; bytes: Buffer };

// Lets the platform encode the form, the way a browser would.
export const multipartBody = async (fields: Record<string, string>, files: MultipartFile[]) => {
  const form = new FormData();
  Object.entries(fields).forEach(([name, value]) => form.append(name, value));
  files.forEach(({ name, bytes }) => form.append('file', new Blob([new Uint8Array(bytes)]), name));
  const request = new Request('http://localhost/', { method: 'POST', body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
  };
};

type ZipEntrySpec = {
  name: string;
  // Raw bytes stored in the zip as they are; compress them first for a deflated entry.
  stored: Buffer;
  method: 'store' | 'deflate';
  crc: number;
  declaredSize: number;
};

export const zipEntry = (
  name: string,
  content: Buffer,
  { declaredSize = content.length }: { declaredSize?: number } = {},
): ZipEntrySpec => ({
  name,
  stored: deflateRawSync(content),
  method: 'deflate',
  crc: crc32(content),
  declaredSize,
});

// For an entry whose compressed bytes are not a valid deflate stream.
export const rawZipEntry = (name: string, stored: Buffer): ZipEntrySpec => ({
  name,
  stored,
  method: 'deflate',
  crc: 0,
  declaredSize: stored.length,
});

// A minimal zip writer, so tests can build archives exceljs never would (bombs, broken streams).
export const buildZip = (entries: readonly ZipEntrySpec[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  entries.forEach(({ name, stored, method, crc, declaredSize }) => {
    const nameBytes = Buffer.from(name);
    const methodCode = method === 'deflate' ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(methodCode, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(methodCode, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};
