import { IMPORT_COLUMNS } from '@club-registration/shared';
import type {
  AdvisorImportRow,
  ClubImportRow,
  ImportSheet,
  StudentImportRow,
} from '@club-registration/shared';
import ExcelJS from 'exceljs';
import { TEXT_COLUMNS } from '../import/template.js';
import { DEMO_ACCOUNTS } from './demo-accounts.js';

// Fictional import workbooks for trying the import by hand. The repo is public, so these are
// generated into the gitignored samples/ folder instead of being committed, and every name, phone,
// e-mail and LINE id here is made up: phones use the 000- prefix, which is nobody's number, and
// e-mails use example.com. The data is fixed (no randomness, no clock), so every run writes the
// same rows.

const FIRST_NAMES = [
  'สมใจ',
  'มานะ',
  'ปิติ',
  'ชูใจ',
  'วีระ',
  'สุดา',
  'กานดา',
  'ธนา',
  'พิมพ์ใจ',
  'ภูมิ',
  'นภา',
  'ศักดิ์ชัย',
  'ปิ่นมณี',
  'ฟ้าใส',
  'ญาณิน',
  'ฐิติ',
  'น้ำฝน',
  'กิตติ',
  'อรุณี',
  'เอกชัย',
] as const;

// Every surname ends in "สมมติ" (fictional), so no row can pass for a real student.
const LAST_NAMES = [
  'ใจดีสมมติ',
  'รักเรียนสมมติ',
  'ตั้งใจสมมติ',
  'มีสุขสมมติ',
  'ศักดิ์สิทธิ์สมมติ',
  'ปั้นเปี่ยมสมมติ',
  'ฟื้นฟูสุขสมมติ',
  'ฤทธิ์ณรงค์สมมติ',
] as const;

const ROOMS = [
  { grade: 1, classroom: '1' },
  { grade: 1, classroom: '2' },
  { grade: 2, classroom: '1' },
  { grade: 2, classroom: '2' },
] as const;
const SEATS_PER_ROOM = 20;

const seatKey = (grade: number, classroom: string, seatNo: number) =>
  `${grade}/${classroom}/${seatNo}`;

// The demo students exactly as seed-dev creates them, so importing a sample never changes a demo
// account (same name, grade, room and seat).
const DEMO_STUDENTS: ReadonlyMap<string, StudentImportRow> = new Map(
  DEMO_ACCOUNTS.flatMap(({ loginId, fullName, profile }) =>
    profile
      ? [
          [
            seatKey(profile.grade, profile.classroom, profile.seatNo),
            { loginId, fullName, ...profile },
          ] as const,
        ]
      : [],
  ),
);

// Generated IDs are all digits (9 + grade + room + seat), so they can never equal a demo ID,
// which all start with "demo".
const generatedStudent = (
  index: number,
  grade: number,
  classroom: string,
  seatNo: number,
): StudentImportRow => {
  const first = FIRST_NAMES[index % FIRST_NAMES.length] ?? '';
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length] ?? '';
  return {
    loginId: `9${grade}${classroom}${String(seatNo).padStart(2, '0')}`,
    fullName: `${first} ${last}`,
    grade,
    classroom,
    seatNo,
  };
};

const SEATS = ROOMS.flatMap(({ grade, classroom }) =>
  Array.from({ length: SEATS_PER_ROOM }, (_, seat) => ({ grade, classroom, seatNo: seat + 1 })),
);

// Every room is full: a demo student keeps their seat, a generated one takes each other seat.
export const SAMPLE_STUDENTS: readonly StudentImportRow[] = Object.freeze(
  SEATS.reduce<{ rows: StudentImportRow[]; generated: number }>(
    ({ rows, generated }, { grade, classroom, seatNo }) => {
      const demo = DEMO_STUDENTS.get(seatKey(grade, classroom, seatNo));
      return demo
        ? { rows: [...rows, demo], generated }
        : {
            rows: [...rows, generatedStudent(generated, grade, classroom, seatNo)],
            generated: generated + 1,
          };
    },
    { rows: [], generated: 0 },
  ).rows,
);

const FULL_TEST_NOTE = 'รับน้อย ไว้ลองกรณีชุมนุมเต็ม';
const TWO_GRADES_NOTE = 'เปิดรับทั้ง ม.1 และ ม.2 (ที่นั่งแยกกันต่อชั้น)';

// Small capacities (C102, C202) let one person try "full"; C300 is one club open to two grades
// (one row per grade, separate seats); C104 has no advisor, so the pages show none named.
export const SAMPLE_CLUBS: readonly ClubImportRow[] = Object.freeze([
  {
    clubCode: 'C101',
    name: 'ชุมนุมหมากรุกสมมติ',
    grade: 1,
    capacity: 10,
    description: 'ฝึกหมากรุกไทยและหมากรุกสากล\nพบกันทุกวันศุกร์ คาบ 7',
  },
  {
    clubCode: 'C102',
    name: 'ชุมนุมดนตรีไทยสมมติ',
    grade: 1,
    capacity: 2,
    description: FULL_TEST_NOTE,
  },
  {
    clubCode: 'C103',
    name: 'ชุมนุมวาดภาพสีน้ำสมมติ',
    grade: 1,
    capacity: 15,
    description: 'นำอุปกรณ์มาเอง',
  },
  { clubCode: 'C104', name: 'ชุมนุมหุ่นยนต์สมมติ', grade: 1, capacity: 8, description: '' },
  {
    clubCode: 'C201',
    name: 'ชุมนุมถ่ายภาพสมมติ',
    grade: 2,
    capacity: 10,
    description: 'ใช้มือถือถ่ายได้',
  },
  {
    clubCode: 'C202',
    name: 'ชุมนุมทำอาหารสมมติ',
    grade: 2,
    capacity: 3,
    description: FULL_TEST_NOTE,
  },
  { clubCode: 'C203', name: 'ชุมนุมนาฏศิลป์สมมติ', grade: 2, capacity: 12, description: '' },
  {
    clubCode: 'C300',
    name: 'ชุมนุมภาษาอังกฤษสมมติ',
    grade: 1,
    capacity: 6,
    description: TWO_GRADES_NOTE,
  },
  {
    clubCode: 'C300',
    name: 'ชุมนุมภาษาอังกฤษสมมติ',
    grade: 2,
    capacity: 6,
    description: TWO_GRADES_NOTE,
  },
]);

const advisor = (
  clubCode: string,
  fullName: string,
  {
    phone = null,
    email = null,
    lineId = null,
  }: { phone?: string | null; email?: string | null; lineId?: string | null } = {},
): AdvisorImportRow => ({ clubCode, fullName, phone, email, lineId });

// Contact fields are optional, so some teachers leave them empty. No value starts with "@" (a LINE
// id may), because a cell starting with = + - @ is read as a formula when the file is edited.
export const SAMPLE_ADVISORS: readonly AdvisorImportRow[] = Object.freeze([
  advisor('C101', 'ครูสมมติ ใจดี', {
    phone: '000-000-0001',
    email: 'teacher.chess@example.com',
    lineId: 'fictional.chess',
  }),
  advisor('C101', 'ครูสมมติ ใจเย็น'),
  advisor('C102', 'ครูสมมติ ไพเราะ', { phone: '000-000-0002' }),
  advisor('C103', 'ครูสมมติ ศิลป์ดี', { email: 'teacher.art@example.com' }),
  advisor('C201', 'ครูสมมติ ชัดเจน', { phone: '000-000-0003', lineId: 'fictional.photo' }),
  advisor('C202', 'ครูสมมติ อร่อยดี'),
  advisor('C203', 'ครูสมมติ อ่อนช้อย', { email: 'teacher.dance@example.com' }),
  advisor('C300', 'Teacher Fictional', { email: 'teacher.english@example.com' }),
]);

type ColumnKey<S extends ImportSheet> = keyof (typeof IMPORT_COLUMNS)[S] & string;
// One value per template column, so a column added in packages/shared fails to compile here.
type SheetRow<S extends ImportSheet> = Readonly<Record<ColumnKey<S>, string | number | null>>;
type SheetSpec = { [S in ImportSheet]: { sheet: S; rows: readonly SheetRow<S>[] } }[ImportSheet];

const STUDENTS_SHEET: SheetSpec = { sheet: 'students', rows: SAMPLE_STUDENTS };
const CLUBS_SHEET: SheetSpec = { sheet: 'clubs', rows: SAMPLE_CLUBS };
const ADVISORS_SHEET: SheetSpec = { sheet: 'advisors', rows: SAMPLE_ADVISORS };

export const SAMPLE_IMPORT_FILES = Object.freeze([
  { filename: 'import-all-fictional.xlsx', sheets: [STUDENTS_SHEET, CLUBS_SHEET, ADVISORS_SHEET] },
  { filename: 'import-students-only-fictional.xlsx', sheets: [STUDENTS_SHEET] },
  { filename: 'import-clubs-advisors-fictional.xlsx', sheets: [CLUBS_SHEET, ADVISORS_SHEET] },
] as const);

const WIDE_COLUMNS: ReadonlySet<string> = new Set(['fullName', 'name', 'description', 'email']);
const NARROW_WIDTH = 14;
const WIDE_WIDTH = 32;
// Fixed, like the template's, so the file carries no date of when it was generated.
const SAMPLE_DATE = new Date('2026-01-01T00:00:00Z');

// Headers come from the column definitions in packages/shared, the same ones the import reads.
const addSheet = (workbook: ExcelJS.Workbook, { sheet, rows }: SheetSpec) => {
  const worksheet = workbook.addWorksheet(sheet);
  worksheet.columns = Object.entries(IMPORT_COLUMNS[sheet]).map(([key, header]) => ({
    key,
    header,
    width: WIDE_COLUMNS.has(key) ? WIDE_WIDTH : NARROW_WIDTH,
    ...(TEXT_COLUMNS.has(key) ? { style: { numFmt: '@' } } : {}),
  }));
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  rows.forEach((row) => {
    // An empty string is left as an empty cell, as an admin would leave it.
    const values = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value === '' ? null : value]),
    );
    worksheet.addRow(values);
  });
};

export type SampleWorkbook = { filename: string; bytes: Buffer };

// Pure: builds every sample file in memory; the caller decides where they go.
export const buildSampleImportWorkbooks = async (): Promise<SampleWorkbook[]> =>
  await Promise.all(
    SAMPLE_IMPORT_FILES.map(async ({ filename, sheets }) => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'club-registration';
      workbook.lastModifiedBy = 'club-registration';
      workbook.created = SAMPLE_DATE;
      workbook.modified = SAMPLE_DATE;
      sheets.forEach((spec) => addSheet(workbook, spec));
      return { filename, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
    }),
  );
