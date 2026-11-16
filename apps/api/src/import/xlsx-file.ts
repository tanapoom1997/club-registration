import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';
import { ERROR_CODES, IMPORT_FILE_EXTENSION } from '@club-registration/shared';
import { AppError } from '../errors.js';

const inflateRawAsync = promisify(inflateRaw);

// A real school workbook under the row limits unpacks to a few MB; this bounds what a small but
// highly compressed upload (a zip bomb) can make the parser hold in memory.
export const MAX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
const MAX_ENTRIES = 1_000;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_ZIP_COMMENT = 0xffff;
// Marks a ZIP64 field; an .xlsx this small never needs ZIP64.
const ZIP64_MARKER = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 0x1;

type ZipEntry = {
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const corrupt = () => new AppError(ERROR_CODES.invalidWorkbook);
const tooLarge = () =>
  new AppError(ERROR_CODES.fileTooLarge, 'Workbook content is larger than the import limit');

const findEndOfCentralDirectory = (bytes: Buffer): number => {
  const last = bytes.length - END_OF_CENTRAL_DIRECTORY_SIZE;
  const first = Math.max(0, last - MAX_ZIP_COMMENT);
  for (let offset = last; offset >= first; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw corrupt();
};

const readCentralDirectory = (bytes: Buffer): ZipEntry[] => {
  if (bytes.length < END_OF_CENTRAL_DIRECTORY_SIZE) throw corrupt();
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) throw tooLarge();
  if (directoryOffset + directorySize > eocd) throw corrupt();

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + CENTRAL_HEADER_SIZE > eocd) throw corrupt();
    if (bytes.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) throw corrupt();
    const entry: ZipEntry = {
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      compressedSize: bytes.readUInt32LE(offset + 20),
      uncompressedSize: bytes.readUInt32LE(offset + 24),
      localHeaderOffset: bytes.readUInt32LE(offset + 42),
    };
    if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER) {
      throw tooLarge();
    }
    entries.push(entry);
    offset +=
      CENTRAL_HEADER_SIZE +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  return entries;
};

const entryData = (bytes: Buffer, entry: ZipEntry): Buffer => {
  const header = entry.localHeaderOffset;
  if (header + LOCAL_HEADER_SIZE > bytes.length) throw corrupt();
  if (bytes.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) throw corrupt();
  const start =
    header + LOCAL_HEADER_SIZE + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw corrupt();
  return bytes.subarray(start, end);
};

const isOutputLimitError = (error: unknown): boolean =>
  error instanceof RangeError ||
  (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE');

// Inflates every entry with a hard output cap instead of trusting the sizes the zip declares,
// which an attacker controls. The output is thrown away; this only measures it.
const measureUncompressedSize = async (bytes: Buffer, entries: readonly ZipEntry[]) => {
  let total = 0;
  for (const entry of entries) {
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) throw corrupt();
    const data = entryData(bytes, entry);
    const budget = MAX_UNCOMPRESSED_BYTES - total;
    if (entry.uncompressedSize > budget) throw tooLarge();
    if (entry.method === METHOD_STORED) {
      total += data.length;
    } else if (entry.method === METHOD_DEFLATED) {
      try {
        total += (await inflateRawAsync(data, { maxOutputLength: budget + 1 })).length;
      } catch (error) {
        throw isOutputLimitError(error) ? tooLarge() : corrupt();
      }
    } else {
      throw corrupt();
    }
    if (total > MAX_UNCOMPRESSED_BYTES) throw tooLarge();
  }
};

// The browser's MIME type is never trusted: the name must end in .xlsx and the bytes must be a
// zip. A legacy .xls or a password-protected workbook is an OLE file, not a zip, and fails here.
export const assertXlsxUpload = async (filename: string, bytes: Buffer): Promise<void> => {
  const hasZipMagic = bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER_SIGNATURE;
  if (!filename.toLowerCase().endsWith(IMPORT_FILE_EXTENSION) || !hasZipMagic) {
    throw new AppError(ERROR_CODES.unsupportedFile);
  }
  await measureUncompressedSize(bytes, readCentralDirectory(bytes));
};
