import { ERROR_CODES } from '@club-registration/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { assertXlsxUpload } from '../src/import/xlsx-file.js';
import {
  buildImportWorkbook,
  buildZip,
  endOfCentralDirectory,
  zipEntry,
  zipParts,
} from './support/import.js';

// Unpacks to 40 MB, over MAX_UNCOMPRESSED_BYTES, from about 40 KB of deflate.
const bombEntry = (name: string) => zipEntry(name, Buffer.alloc(40 * 1024 * 1024));
const benignEntry = (name: string) => zipEntry(name, Buffer.from('fictional content'));

const rejectionOf = async (bytes: Buffer): Promise<unknown> => {
  try {
    await assertXlsxUpload('students.xlsx', bytes);
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectRejected = async (bytes: Buffer, code: string): Promise<void> => {
  const error = await rejectionOf(bytes);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
};

// The guard must measure exactly the entries the parser (JSZip inside exceljs) unpacks. Each zip
// below shows the guard one harmless entry while JSZip, reading the same bytes its own way, finds
// a zip bomb.
describe('assertXlsxUpload', () => {
  it('accepts a workbook written by exceljs', async () => {
    const bytes = await buildImportWorkbook({ students: [] });

    await expect(assertXlsxUpload('students.xlsx', bytes)).resolves.toBeUndefined();
  });

  it('rejects a zip whose end record counts fewer entries than its directory holds', async () => {
    // JSZip keeps reading central headers while the signature matches, whatever the count says.
    const bytes = buildZip([benignEntry('xl/a.xml'), bombEntry('xl/b.xml')], {
      declaredCount: 1,
    });

    await expectRejected(bytes, ERROR_CODES.invalidWorkbook);
  });

  it('rejects a zip whose directory does not end where the end record starts', async () => {
    // JSZip treats the gap as bytes prepended to the archive and shifts every offset by it, so it
    // reads the second directory (the bomb's) while the guard reads the first.
    const bomb = zipParts([bombEntry('xl/b.xml')]);
    const benign = zipParts([benignEntry('xl/a.xml')]);
    const directoryOffset = bomb.body.length;
    const shift = directoryOffset + benign.directory.length;
    const bytes = Buffer.concat([
      benign.body,
      Buffer.alloc(directoryOffset - benign.body.length),
      benign.directory,
      bomb.body,
      bomb.directory,
      endOfCentralDirectory({
        entryCount: 1,
        directorySize: benign.directory.length,
        directoryOffset,
      }),
    ]);
    expect(bomb.directory.length).toBe(benign.directory.length);
    expect(shift).toBe(bytes.length - 22 - bomb.directory.length - bomb.body.length);

    await expectRejected(bytes, ERROR_CODES.invalidWorkbook);
  });

  it.each([
    ['ZIP64 marker as its disk number', 0xffff],
    ['disk number other than the first', 1],
  ])('rejects an end record with a %s', async (_label, diskNumber) => {
    // 0xFFFF in any end record field sends JSZip to a ZIP64 directory the guard never reads.
    const bytes = buildZip([benignEntry('xl/a.xml')], { diskNumber });

    await expectRejected(bytes, ERROR_CODES.invalidWorkbook);
  });

  it('still answers file_too_large for a plain zip bomb', async () => {
    const bytes = buildZip([bombEntry('xl/b.xml')]);

    await expectRejected(bytes, ERROR_CODES.fileTooLarge);
  });
});
