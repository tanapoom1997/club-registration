import { z } from 'zod';
import { loginIdSchema } from './auth.js';
import { errorResponseSchema } from './error.js';
import { idempotencyKeySchema } from './idempotency.js';
import { termSchema } from './rounds.js';

export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS_PER_SHEET = 5_000;
// The preview lists at most this many errors (errorCount still says how many there were), so a
// file that is wrong everywhere cannot produce a response too big for the browser to render.
export const IMPORT_MAX_ERRORS_LISTED = 1_000;
export const IMPORT_FILE_EXTENSION = '.xlsx';

export const IMPORT_SHEETS = Object.freeze(['students', 'clubs', 'advisors'] as const);
export const importSheetSchema = z.enum(IMPORT_SHEETS);
export type ImportSheet = z.infer<typeof importSheetSchema>;

// Key order is the template's column order. Only these columns are ever read (PDPA): anything
// else in the file is ignored, never stored and never logged.
export const STUDENT_COLUMNS = Object.freeze({
  loginId: 'รหัสนักเรียน',
  fullName: 'ชื่อ-สกุล',
  grade: 'ชั้น',
  classroom: 'ห้อง',
  seatNo: 'เลขที่',
} as const);

export const CLUB_COLUMNS = Object.freeze({
  clubCode: 'รหัสชุมนุม',
  name: 'ชื่อชุมนุม',
  grade: 'ชั้นที่เปิดรับ',
  capacity: 'จำนวนรับ',
  description: 'รายละเอียด',
} as const);

export const ADVISOR_COLUMNS = Object.freeze({
  clubCode: 'รหัสชุมนุม',
  fullName: 'ชื่อครู',
  phone: 'เบอร์โทร',
  email: 'อีเมล',
  lineId: 'LINE ID',
} as const);

export const IMPORT_COLUMNS = Object.freeze({
  students: STUDENT_COLUMNS,
  clubs: CLUB_COLUMNS,
  advisors: ADVISOR_COLUMNS,
} as const);

const NAME_MAX_LENGTH = 200;
const CLASSROOM_MAX_LENGTH = 16;
const CLUB_CODE_MAX_LENGTH = 32;
const DESCRIPTION_MAX_LENGTH = 2_000;
const PHONE_MAX_LENGTH = 32;
const EMAIL_MAX_LENGTH = 254;
const LINE_ID_MAX_LENGTH = 50;
export const SEAT_NO_MAX = 999;
export const CAPACITY_MAX = 10_000;

// Line breaks are allowed only where the admin may write paragraphs (club descriptions).
const CONTROL_CHARS = /\p{Cc}/u;
const CONTROL_CHARS_EXCEPT_LINE_BREAKS = /[^\P{Cc}\t\n\r]/u;

const requiredText = (label: string, max: number) =>
  z
    .string({ error: `กรุณากรอก${label}` })
    .trim()
    .min(1, `กรุณากรอก${label}`)
    .max(max, `${label}ยาวได้ไม่เกิน ${max} ตัวอักษร`)
    .refine((value) => !CONTROL_CHARS.test(value), `${label}มีอักขระที่ใช้ไม่ได้`);

// Cells arrive as text: a numeric cell is passed in as its decimal string, so "30" and 30 are
// read the same way, and 30.5 or -1 fail the pattern instead of being rounded.
const wholeNumber = (label: string, min: number, max: number) => {
  const message = `${label}ต้องเป็นจำนวนเต็ม ${min}–${max}`;
  return z
    .string({ error: `กรุณากรอก${label}` })
    .trim()
    .regex(/^\d{1,9}$/, message)
    .transform(Number)
    .pipe(z.number().int().min(min, message).max(max, message));
};

// Admins write grades either as a digit or the Thai way ("ม.1").
const gradeCell = (label: string) =>
  z
    .string({ error: `กรุณากรอก${label}` })
    .trim()
    .regex(/^(?:ม\.?\s*)?[1-6]$/u, `${label}ต้องเป็น 1–6 (หรือ ม.1–ม.6)`)
    .transform((value) => Number(value.slice(-1)));

// Codes key the upsert, so they are upper-cased once here; Thai letters (e.g. "ก30901") are kept.
export const clubCodeSchema = z
  .string({ error: 'กรุณากรอกรหัสชุมนุม' })
  .trim()
  .toUpperCase()
  .min(1, 'กรุณากรอกรหัสชุมนุม')
  .max(CLUB_CODE_MAX_LENGTH, `รหัสชุมนุมยาวได้ไม่เกิน ${CLUB_CODE_MAX_LENGTH} ตัวอักษร`)
  .regex(
    /^[\p{L}\p{M}\p{N}._/-]+$/u,
    'รหัสชุมนุมใช้ได้เฉพาะตัวอักษร ตัวเลข . _ / - (ไม่มีช่องว่าง)',
  );

// Shared with the admin screens that pick a classroom, so a value accepted there matches what the
// import stored.
export const classroomSchema = requiredText('ห้อง', CLASSROOM_MAX_LENGTH);

// Same normalisation as login, so the student signs in with exactly the key that was imported.
const studentIdCell = z.string({ error: 'กรุณากรอกรหัสนักเรียน' }).pipe(loginIdSchema);

const PHONE_MESSAGE = 'เบอร์โทรไม่ถูกต้อง (ขึ้นต้นด้วย 0 หรือ + เช่น 081-234-5678)';
const MIN_PHONE_DIGITS = 9;
const MAX_PHONE_DIGITS = 15;

// A leading 0 is required: a phone typed into a number cell has lost it, and storing the result
// would give teachers a wrong number.
const phoneCell = z
  .string()
  .trim()
  .max(PHONE_MAX_LENGTH, PHONE_MESSAGE)
  .regex(/^(?:\+|0)[\d -]+$/, PHONE_MESSAGE)
  .refine((value) => {
    const digits = value.replace(/\D/g, '').length;
    return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS;
  }, PHONE_MESSAGE);

const emailCell = z
  .string()
  .trim()
  .max(EMAIL_MAX_LENGTH, 'อีเมลยาวเกินไป')
  .pipe(z.email({ error: 'อีเมลไม่ถูกต้อง' }));

const lineIdCell = z
  .string()
  .trim()
  .max(LINE_ID_MAX_LENGTH, `LINE ID ยาวได้ไม่เกิน ${LINE_ID_MAX_LENGTH} ตัวอักษร`)
  .regex(/^@?[A-Za-z0-9._-]+$/, 'LINE ID ใช้ได้เฉพาะ a-z 0-9 . _ - (มี @ นำหน้าได้)');

// Club name and description are shared with the admin club editor, so a value accepted there
// matches what the import stores.
export const clubNameSchema = requiredText('ชื่อชุมนุม', NAME_MAX_LENGTH);

export const clubDescriptionSchema = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX_LENGTH, `รายละเอียดยาวได้ไม่เกิน ${DESCRIPTION_MAX_LENGTH} ตัวอักษร`)
  .refine(
    (value) => !CONTROL_CHARS_EXCEPT_LINE_BREAKS.test(value),
    'รายละเอียดมีอักขระที่ใช้ไม่ได้',
  );

// Row schemas take one string (or undefined for an empty cell) per template column; the API turns
// Excel cell values into that shape before parsing.
export const studentImportRowSchema = z.object({
  loginId: studentIdCell,
  fullName: requiredText('ชื่อ-สกุล', NAME_MAX_LENGTH),
  grade: gradeCell('ชั้น'),
  classroom: classroomSchema,
  seatNo: wholeNumber('เลขที่', 1, SEAT_NO_MAX),
});
export type StudentImportRow = z.infer<typeof studentImportRowSchema>;

export const clubImportRowSchema = z.object({
  clubCode: clubCodeSchema,
  name: clubNameSchema,
  grade: gradeCell('ชั้นที่เปิดรับ'),
  capacity: wholeNumber('จำนวนรับ', 0, CAPACITY_MAX),
  // An empty description clears it, matching the column default.
  description: clubDescriptionSchema.optional().transform((value) => value ?? ''),
});
export type ClubImportRow = z.infer<typeof clubImportRowSchema>;

// Every contact field is optional: teachers choose what students may see.
export const advisorImportRowSchema = z.object({
  clubCode: clubCodeSchema,
  fullName: requiredText('ชื่อครู', NAME_MAX_LENGTH),
  phone: phoneCell.optional().transform((value) => value ?? null),
  email: emailCell.optional().transform((value) => value ?? null),
  lineId: lineIdCell.optional().transform((value) => value ?? null),
});
export type AdvisorImportRow = z.infer<typeof advisorImportRowSchema>;

export const IMPORT_ROW_SCHEMAS = Object.freeze({
  students: studentImportRowSchema,
  clubs: clubImportRowSchema,
  advisors: advisorImportRowSchema,
} as const);

export const importPreviewFieldsSchema = z.strictObject({ term: termSchema });
export type ImportPreviewFields = z.infer<typeof importPreviewFieldsSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

// The commit re-sends the previewed file: the server keeps nothing between the two requests, and
// fileSha256 proves the bytes are the ones the admin looked at.
export const importCommitFieldsSchema = z.strictObject({
  term: termSchema,
  fileSha256: sha256HexSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ImportCommitFields = z.infer<typeof importCommitFieldsSchema>;

// row is the row number the admin sees in Excel (header = 1); sheet, row or column is null when
// the problem is not tied to one (e.g. no known sheet in the file, or too many rows).
export const importErrorSchema = z.object({
  sheet: importSheetSchema.nullable(),
  row: z.number().int().positive().nullable(),
  column: z.string().nullable(),
  message: z.string(),
});
export type ImportError = z.infer<typeof importErrorSchema>;

const countSchema = z.number().int().nonnegative();

// Counts cover rows that passed validation; "update" means at least one stored field changes.
export const importChangeCountsSchema = z.object({
  create: countSchema,
  update: countSchema,
  unchanged: countSchema,
});
export type ImportChangeCounts = z.infer<typeof importChangeCountsSchema>;

export const importPreviewResponseSchema = z.object({
  fileSha256: sha256HexSchema,
  term: z.string(),
  students: importChangeCountsSchema,
  clubs: importChangeCountsSchema,
  // Per club (one per round) named in the advisors sheet: clubsReplaced get the file's list,
  // clubsUnchanged already have exactly that list (same teachers, same order).
  advisors: z.object({
    clubsReplaced: countSchema,
    clubsUnchanged: countSchema,
    rows: countSchema,
  }),
  errors: z.array(importErrorSchema),
  errorCount: countSchema,
});
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

// The same shape as the preview, counting what was written; errors is always empty.
export const importCommitResponseSchema = importPreviewResponseSchema;
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;

// 422 import_invalid: the file has errors, so nothing was written. The list is capped like the
// preview's.
export const importInvalidResponseSchema = errorResponseSchema.extend({
  errors: z.array(importErrorSchema),
  errorCount: countSchema,
});
export type ImportInvalidResponse = z.infer<typeof importInvalidResponseSchema>;
