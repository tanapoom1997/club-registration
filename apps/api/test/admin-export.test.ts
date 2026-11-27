import { randomBytes } from 'node:crypto';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  CLASSROOM_LIST_COLUMNS,
  CLUB_LIST_COLUMNS,
  NOT_REGISTERED_LABEL,
  errorResponseSchema,
  roundClassroomsResponseSchema,
} from '@club-registration/shared';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { TEST_JWT_SECRET, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import {
  createClub,
  createRound,
  createStudent,
  register,
  snapshotDatabase,
  uniqueCode,
  uniqueTerm,
} from './support/import-db.js';
import { readPdf } from './support/pdf.js';
import type { PdfPage } from './support/pdf.js';
import { appConnectionUri, startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';
const UNKNOWN_ID = 2_000_000_000;

// Tests that list a whole grade own one: every other test works in classrooms or clubs of its
// own, so no test sees another's students.
const SHARED_GRADE = 1;
const WHOLE_GRADE_TEST_GRADE = 4;
const CLASSROOM_COUNT_TEST_GRADE = 5;
const PDF_TIMING_TEST_GRADE = 2;
const EMPTY_GRADE = 6;
// Students of a grade no whole-grade test lists.
const OTHER_GRADE = 3;

// Every value below is made up. Thai names carry upper and lower vowels and tone marks.
const ADVISOR_CONTACT = Object.freeze({
  phone: '080-000-0001',
  email: 'fictional.teacher@example.com',
  lineId: 'fictional.line',
});

const uniqueClassroom = () => `r${randomBytes(3).toString('hex')}`;
const errorCodeOf = (response: InjectResponse) => errorResponseSchema.parse(response.json()).code;

type Sheet = {
  name: string;
  // Text lines above the table.
  headings: string[];
  header: ExcelJS.CellValue[];
  rows: ExcelJS.CellValue[][];
  headerRowNumber: number;
  worksheet: ExcelJS.Worksheet;
};

const textOf = (value: ExcelJS.CellValue): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '');

const valuesOf = (row: ExcelJS.Row): ExcelJS.CellValue[] =>
  (row.values as ExcelJS.CellValue[]).slice(1);

const readSheets = async (bytes: Buffer, firstHeader: string): Promise<Sheet[]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  return workbook.worksheets.map((worksheet) => {
    const rows: { number: number; values: ExcelJS.CellValue[] }[] = [];
    worksheet.eachRow((row, number) => rows.push({ number, values: valuesOf(row) }));
    const headerIndex = rows.findIndex(({ values }) => values[0] === firstHeader);
    if (headerIndex < 0) throw new Error(`No table header in sheet ${worksheet.name}`);
    return {
      name: worksheet.name,
      headings: rows.slice(0, headerIndex).map(({ values }) => textOf(values[0])),
      header: rows[headerIndex]!.values,
      rows: rows.slice(headerIndex + 1).map(({ values }) => values),
      headerRowNumber: rows[headerIndex]!.number,
      worksheet,
    };
  });
};

const readClubSheets = async (bytes: Buffer) => await readSheets(bytes, CLUB_LIST_COLUMNS.order);
const readClassroomSheets = async (bytes: Buffer) =>
  await readSheets(bytes, CLASSROOM_LIST_COLUMNS.seatNo);

// Every text cell of every sheet, to prove what a file does not contain.
const allTextOf = async (bytes: Buffer): Promise<string> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  const texts: string[] = [];
  workbook.eachSheet((worksheet) => {
    texts.push(worksheet.name);
    worksheet.eachRow((row) => {
      valuesOf(row).forEach((value) => texts.push(textOf(value)));
    });
  });
  return texts.join('\n');
};

// The PDF's pages as the text lines drawn on them, after checking it is a PDF at all.
const readPdfPages = (bytes: Buffer): PdfPage[] => {
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  return readPdf(bytes);
};

const FOOTER_TIME = /^ส่งออกเมื่อ \d{1,2} \S+ \d{4} \d{2}:\d{2} น\.$/;

// The page labels of one club or classroom that runs over `count` pages: numbered within it.
const sectionPages = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `หน้า ${index + 1}/${count}`);

// Every page ends with the export time and its page label, in page order.
const expectFooters = (pages: readonly PdfPage[], pageLabels: readonly string[]) => {
  expect(pages.map(({ lines }) => lines.at(-1))).toEqual(pageLabels);
  pages.forEach(({ lines }) => {
    expect(lines.at(-2)).toMatch(FOOTER_TIME);
  });
};

// The rows of a table: the lines between the table header and the footer, cell by cell.
const tableRows = (lines: readonly string[], header: readonly string[]): string[][] => {
  const start = lines.findIndex((line, index) =>
    header.every((cell, offset) => lines[index + offset] === cell),
  );
  if (start < 0) throw new Error('No table header on the page');
  const cells = lines.slice(start + header.length, -2);
  return Array.from({ length: cells.length / header.length }, (_, row) =>
    cells.slice(row * header.length, (row + 1) * header.length),
  );
};

describe('admin name list export', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: FastifyInstance;
  let logLines: string[];
  let admin: TestUser;
  let adminToken: string;

  const loginAs = async (user: TestUser): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { loginId: user.loginId, password: user.password },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.find(({ name }) => name === SESSION_COOKIE)!.value;
  };

  const exportList = async (
    roundId: number | string,
    query: Record<string, string | number>,
    // null = no session cookie at all.
    token: string | null = adminToken,
  ) =>
    await app.inject({
      method: 'GET',
      url: `/api/admin/rounds/${roundId}/export`,
      query: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
      ...(token === null ? {} : { cookies: { [SESSION_COOKIE]: token } }),
    });

  const exportOk = async (roundId: number, query: Record<string, string | number>) => {
    const response = await exportList(roundId, query);
    expect(response.statusCode).toBe(200);
    return response;
  };

  const addAdvisor = async (clubId: number, fullName: string) => {
    await pool.query(
      `INSERT INTO club_advisors (club_id, full_name, phone, email, line_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [clubId, fullName, ADVISOR_CONTACT.phone, ADVISOR_CONTACT.email, ADVISOR_CONTACT.lineId],
    );
  };

  const newRound = async (grade = SHARED_GRADE) => await createRound(pool, uniqueTerm(), grade);

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(appConnectionUri(container));
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    logLines = [];
    app = await buildApp({
      pool,
      jwtSecret: TEST_JWT_SECRET,
      logger: { level: 'info', stream: { write: (line) => logLines.push(line) } },
    });
    admin = await createTestUser(pool, { role: 'admin' });
    adminToken = await loginAs(admin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('per-club list', () => {
    it('lists a club in grade, classroom and seat order under its code, advisors and counts', async () => {
      const roundId = await newRound();
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, {
        name: 'ชุมนุมหมากรุกสมมติ',
        capacity: 20,
      });
      await addAdvisor(clubId, 'ครูสมมติ ใจดี');
      await addAdvisor(clubId, 'ครูสมมติ คนที่สอง');
      // Numeric-aware order: "2…" before "10…".
      const room2 = `2${uniqueClassroom()}`;
      const room10 = `10${uniqueClassroom()}`;
      const late = await createStudent(pool, {
        fullName: 'เด็กหญิงสมมติ น้ำใส',
        classroom: room10,
        seatNo: 1,
      });
      const second = await createStudent(pool, {
        fullName: 'เด็กชายสมมติ ทุ่งกว้าง',
        classroom: room2,
        seatNo: 12,
      });
      const first = await createStudent(pool, {
        fullName: 'เด็กหญิงสมมติ ฟ้าใส',
        classroom: room2,
        seatNo: 3,
      });
      await Promise.all(
        [late, second, first].map(async ({ id }) => await register(pool, roundId, id, clubId)),
      );
      const otherClub = await createClub(pool, roundId, uniqueCode());
      const elsewhere = await createStudent(pool, { classroom: room2, seatNo: 4 });
      await register(pool, roundId, elsewhere.id, otherClub);

      const response = await exportOk(roundId, { view: 'club', clubId, format: 'xlsx' });

      const [sheet, ...others] = await readClubSheets(response.rawPayload);
      expect(others).toEqual([]);
      expect(sheet!.name).toBe(code);
      expect(sheet!.headings[0]).toBe(`ชุมนุม ${code} ชุมนุมหมากรุกสมมติ`);
      expect(sheet!.headings[1]).toBe('ครูที่ปรึกษา: ครูสมมติ ใจดี, ครูสมมติ คนที่สอง');
      expect(sheet!.headings[2]).toBe('จำนวนลง/จำนวนรับ: 3/20');
      expect(sheet!.headings[3]).toMatch(/^รอบ t-[0-9a-f]+ ม\.1 · ข้อมูล ณ /);
      expect(sheet!.header).toEqual(Object.values(CLUB_LIST_COLUMNS));
      expect(sheet!.rows).toEqual([
        [1, first.loginId, 'เด็กหญิงสมมติ ฟ้าใส', `ม.1/${room2}`, 3],
        [2, second.loginId, 'เด็กชายสมมติ ทุ่งกว้าง', `ม.1/${room2}`, 12],
        [3, late.loginId, 'เด็กหญิงสมมติ น้ำใส', `ม.1/${room10}`, 1],
      ]);
    });

    it('prints on A4 with the table header repeated on every page', async () => {
      const roundId = await newRound();
      const clubId = await createClub(pool, roundId, uniqueCode());

      const response = await exportOk(roundId, { view: 'club', clubId, format: 'xlsx' });

      const [sheet] = await readClubSheets(response.rawPayload);
      const { pageSetup } = sheet!.worksheet;
      expect(pageSetup.paperSize).toBe(9);
      expect(pageSetup.orientation).toBe('portrait');
      expect(pageSetup.printTitlesRow).toBe(`${sheet!.headerRowNumber}:${sheet!.headerRowNumber}`);
    });

    it('never writes an advisor phone, email or LINE ID into any export', async () => {
      const roundId = await newRound();
      const clubId = await createClub(pool, roundId, uniqueCode());
      await addAdvisor(clubId, 'ครูสมมติ ติดต่อได้');
      const classroom = uniqueClassroom();
      const student = await createStudent(pool, { classroom });
      await register(pool, roundId, student.id, clubId);

      const files = await Promise.all([
        exportOk(roundId, { view: 'club', clubId, format: 'xlsx' }),
        exportOk(roundId, { view: 'club', format: 'xlsx' }),
        exportOk(roundId, { view: 'classroom', classroom, format: 'xlsx' }),
      ]);

      const texts = await Promise.all(files.map(async ({ rawPayload }) => allTextOf(rawPayload)));
      expect(texts[0]).toContain('ครูสมมติ ติดต่อได้');
      texts.forEach((text) => {
        Object.values(ADVISOR_CONTACT).forEach((contact) => {
          expect(text).not.toContain(contact);
        });
      });
      // The homeroom list carries no advisor data at all, not even names.
      expect(texts[2]).not.toContain('ครูสมมติ ติดต่อได้');
    });

    it('exports a club nobody has joined as its header and an empty table', async () => {
      const roundId = await newRound();
      const clubId = await createClub(pool, roundId, uniqueCode(), { capacity: 30 });

      const response = await exportOk(roundId, { view: 'club', clubId, format: 'xlsx' });

      const [sheet] = await readClubSheets(response.rawPayload);
      expect(sheet!.headings[1]).toBe('ครูที่ปรึกษา: -');
      expect(sheet!.headings[2]).toBe('จำนวนลง/จำนวนรับ: 0/30');
      expect(sheet!.rows).toEqual([]);
    });

    it('gives every club of the round a sheet of its own, by club code', async () => {
      const roundId = await newRound();
      const [codeA, codeB, codeC] = ['A', 'B', 'C'].map((prefix) => `${prefix}${uniqueCode()}`);
      const clubB = await createClub(pool, roundId, codeB!);
      const clubA = await createClub(pool, roundId, codeA!);
      await createClub(pool, roundId, codeC!);
      await createClub(pool, await newRound(), uniqueCode());
      const [one, two] = await Promise.all([
        createStudent(pool, { classroom: uniqueClassroom() }),
        createStudent(pool, { classroom: uniqueClassroom() }),
      ]);
      await register(pool, roundId, one.id, clubA);
      await register(pool, roundId, two.id, clubB);

      const response = await exportOk(roundId, { view: 'club', format: 'xlsx' });

      const sheets = await readClubSheets(response.rawPayload);
      expect(sheets.map(({ name }) => name)).toEqual([codeA, codeB, codeC]);
      expect(sheets.map(({ rows }) => rows.map((row) => row[1]))).toEqual([
        [one.loginId],
        [two.loginId],
        [],
      ]);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="club-list-round-${roundId}-grade-1.xlsx"`,
      );
    });

    it('answers 404 not_found for a club of another round or no club at all', async () => {
      const roundId = await newRound();
      await createClub(pool, roundId, uniqueCode());
      const foreignClub = await createClub(pool, await newRound(), uniqueCode());

      const responses = await Promise.all(
        [foreignClub, UNKNOWN_ID].map(
          async (clubId) => await exportList(roundId, { view: 'club', clubId, format: 'xlsx' }),
        ),
      );

      responses.forEach((response) => {
        expect(response.statusCode).toBe(404);
        expect(errorCodeOf(response)).toBe('not_found');
      });
    });

    it('answers 404 nothing_to_export for the whole of a round without clubs', async () => {
      const roundId = await newRound();

      const response = await exportList(roundId, { view: 'club', format: 'xlsx' });

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('nothing_to_export');
    });
  });

  describe('per-classroom list', () => {
    it('lists every student of the classroom by seat, marking who has not registered', async () => {
      const roundId = await newRound();
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, { name: 'ชุมนุมดนตรีสมมติ' });
      await addAdvisor(clubId, 'ครูสมมติ ดนตรี');
      const classroom = uniqueClassroom();
      const third = await createStudent(pool, {
        classroom,
        seatNo: 30,
        fullName: 'เด็กชายสมมติ ไม่ลง',
      });
      const first = await createStudent(pool, {
        classroom,
        seatNo: 1,
        fullName: 'เด็กหญิงสมมติ ลงแล้ว',
      });
      const second = await createStudent(pool, {
        classroom,
        seatNo: 2,
        fullName: 'เด็กชายสมมติ ยังไม่เลือก',
      });
      await register(pool, roundId, first.id, clubId);
      // A club in another round of the same grade does not count for this one.
      const otherRound = await newRound();
      await register(pool, otherRound, second.id, await createClub(pool, otherRound, uniqueCode()));
      // Same classroom name, other grade: another classroom.
      await createStudent(pool, { grade: OTHER_GRADE, classroom, seatNo: 5 });

      const response = await exportOk(roundId, { view: 'classroom', classroom, format: 'xlsx' });

      const [sheet, ...others] = await readClassroomSheets(response.rawPayload);
      expect(others).toEqual([]);
      expect(sheet!.name).toBe(`ม.1-${classroom}`);
      expect(sheet!.headings.slice(0, 2)).toEqual([`ชั้น/ห้อง ม.1/${classroom}`, 'ลงแล้ว/ทั้งห้อง: 1/3']);
      expect(sheet!.header).toEqual(Object.values(CLASSROOM_LIST_COLUMNS));
      expect(sheet!.rows).toEqual([
        [1, first.loginId, 'เด็กหญิงสมมติ ลงแล้ว', `${code} ชุมนุมดนตรีสมมติ`],
        [2, second.loginId, 'เด็กชายสมมติ ยังไม่เลือก', NOT_REGISTERED_LABEL],
        [30, third.loginId, 'เด็กชายสมมติ ไม่ลง', NOT_REGISTERED_LABEL],
      ]);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="classroom-list-round-${roundId}-grade-1-room-${classroom}.xlsx"`,
      );
    });

    // One test for both formats: it owns the grade, so no other test may add classrooms to it.
    it('gives every classroom of the round grade a sheet or a PDF page, in classroom order', async () => {
      const roundId = await newRound(WHOLE_GRADE_TEST_GRADE);
      await Promise.all(
        ['10', '2', '3/1'].map(
          async (classroom) =>
            await createStudent(pool, { grade: WHOLE_GRADE_TEST_GRADE, classroom }),
        ),
      );
      await createStudent(pool, { grade: OTHER_GRADE, classroom: '1' });

      const [xlsx, pdf] = await Promise.all([
        exportOk(roundId, { view: 'classroom', format: 'xlsx' }),
        exportOk(roundId, { view: 'classroom', format: 'pdf' }),
      ]);

      const sheets = await readClassroomSheets(xlsx.rawPayload);
      expect(sheets.map(({ name }) => name)).toEqual(['ม.4-2', 'ม.4-3-1', 'ม.4-10']);
      expect(sheets.map(({ rows }) => rows.length)).toEqual([1, 1, 1]);
      expect(xlsx.headers['content-disposition']).toBe(
        `attachment; filename="classroom-list-round-${roundId}-grade-4.xlsx"`,
      );
      // A small classroom fits on one page, and every classroom starts a page of its own.
      const pages = readPdfPages(pdf.rawPayload);
      expect(pages.map(({ lines }) => lines[0])).toEqual([
        'ชั้น/ห้อง ม.4/2',
        'ชั้น/ห้อง ม.4/3/1',
        'ชั้น/ห้อง ม.4/10',
      ]);
      expect(
        pages.map(({ lines }) => tableRows(lines, Object.values(CLASSROOM_LIST_COLUMNS)).length),
      ).toEqual([1, 1, 1]);
      // Numbered per classroom: each one's printout starts at page 1.
      expectFooters(pages, [...sectionPages(1), ...sectionPages(1), ...sectionPages(1)]);
      expect(pdf.headers['content-disposition']).toBe(
        `attachment; filename="classroom-list-round-${roundId}-grade-4.pdf"`,
      );
    });

    it('answers 404 not_found for a classroom with no student in the round grade', async () => {
      const roundId = await newRound();
      const classroom = uniqueClassroom();
      await createStudent(pool, { grade: OTHER_GRADE, classroom });

      const response = await exportList(roundId, { view: 'classroom', classroom, format: 'xlsx' });

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
    });

    it('answers 404 nothing_to_export for the whole of a grade without students', async () => {
      const roundId = await newRound(EMPTY_GRADE);

      const response = await exportList(roundId, { view: 'classroom', format: 'xlsx' });

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('nothing_to_export');
    });
  });

  // A later term's import may move a student who registered in a closed round of an earlier term
  // up a grade (import-plan.ts). Both lists read the current profiles, so they would no longer
  // describe the round: the classroom list would show this year's grade as "not registered".
  describe('a round whose registered students moved to another grade', () => {
    const roundWithMovedStudent = async () => {
      const roundId = await createRound(pool, uniqueTerm(), SHARED_GRADE, { closedDaysAgo: 30 });
      const clubId = await createClub(pool, roundId, uniqueCode());
      const classroom = uniqueClassroom();
      const [moved, stayed] = await Promise.all([
        createStudent(pool, { grade: SHARED_GRADE, classroom, seatNo: 1 }),
        createStudent(pool, { grade: SHARED_GRADE, classroom, seatNo: 2 }),
      ]);
      await register(pool, roundId, moved.id, clubId);
      await register(pool, roundId, stayed.id, clubId);
      // What the next year's import does: the student moves up out of the round's grade.
      await pool.query('UPDATE student_profiles SET grade = $2 WHERE user_id = $1', [
        moved.id,
        OTHER_GRADE,
      ]);
      return { roundId, clubId, classroom };
    };

    it.each([
      ['the per-club list', { view: 'club', format: 'xlsx' }],
      ['the per-classroom list', { view: 'classroom', format: 'xlsx' }],
      ['the per-classroom PDF', { view: 'classroom', format: 'pdf' }],
    ])('answers 409 export_outdated for %s', async (_label, query) => {
      const { roundId } = await roundWithMovedStudent();

      const response = await exportList(roundId, query);

      expect(response.statusCode).toBe(409);
      expect(errorCodeOf(response)).toBe('export_outdated');
    });

    it('answers 409 export_outdated for one club or one classroom of it too', async () => {
      const { roundId, clubId, classroom } = await roundWithMovedStudent();

      const responses = await Promise.all([
        exportList(roundId, { view: 'club', format: 'xlsx', clubId }),
        exportList(roundId, { view: 'classroom', format: 'xlsx', classroom }),
      ]);

      expect(responses.map((response) => [response.statusCode, errorCodeOf(response)])).toEqual([
        [409, 'export_outdated'],
        [409, 'export_outdated'],
      ]);
    });

    it('answers 409 export_outdated for its classroom choices', async () => {
      const { roundId } = await roundWithMovedStudent();

      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/rounds/${roundId}/classrooms`,
        cookies: { [SESSION_COOKIE]: adminToken },
      });

      expect(response.statusCode).toBe(409);
      expect(errorCodeOf(response)).toBe('export_outdated');
    });

    it('still exports a closed round whose registered students are all in its grade', async () => {
      const roundId = await createRound(pool, uniqueTerm(), SHARED_GRADE, { closedDaysAgo: 30 });
      const clubId = await createClub(pool, roundId, uniqueCode());
      const classroom = uniqueClassroom();
      const student = await createStudent(pool, { grade: SHARED_GRADE, classroom });
      await register(pool, roundId, student.id, clubId);

      const responses = await Promise.all([
        exportList(roundId, { view: 'club', format: 'xlsx' }),
        exportList(roundId, { view: 'classroom', format: 'xlsx', classroom }),
        app.inject({
          method: 'GET',
          url: `/api/admin/rounds/${roundId}/classrooms`,
          cookies: { [SESSION_COOKIE]: adminToken },
        }),
      ]);

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200, 200]);
    });
  });

  describe('file safety', () => {
    it('escapes text cells that a spreadsheet would read as a formula', async () => {
      const roundId = await newRound();
      const code = `-${uniqueCode()}`;
      const clubId = await createClub(pool, roundId, code, { name: '+ชุมนุมสมมติ' });
      const classroom = uniqueClassroom();
      const student = await createStudent(pool, {
        classroom,
        fullName: '=HYPERLINK("http://example.test","x")',
      });
      await register(pool, roundId, student.id, clubId);

      const [clubFile, classroomFile] = await Promise.all([
        exportOk(roundId, { view: 'club', clubId, format: 'xlsx' }),
        exportOk(roundId, { view: 'classroom', classroom, format: 'xlsx' }),
      ]);

      const [clubSheet] = await readClubSheets(clubFile.rawPayload);
      expect(clubSheet!.rows[0]![2]).toBe(`'=HYPERLINK("http://example.test","x")`);
      const [classroomSheet] = await readClassroomSheets(classroomFile.rawPayload);
      expect(classroomSheet!.rows[0]![2]).toBe(`'=HYPERLINK("http://example.test","x")`);
      expect(classroomSheet!.rows[0]![3]).toBe(`'${code} +ชุมนุมสมมติ`);
    });

    it('is an uncacheable .xlsx attachment named by identifiers only', async () => {
      const roundId = await newRound();
      const asciiClub = await createClub(pool, roundId, 'SCI/1.A');
      const thaiClub = await createClub(pool, roundId, 'ก30901');
      await createStudent(pool, { classroom: '3/1' });

      const [ascii, thai, room] = await Promise.all([
        exportOk(roundId, { view: 'club', clubId: asciiClub, format: 'xlsx' }),
        exportOk(roundId, { view: 'club', clubId: thaiClub, format: 'xlsx' }),
        exportOk(roundId, { view: 'classroom', classroom: '3/1', format: 'xlsx' }),
      ]);

      [ascii, thai, room].forEach((response) => {
        expect(response.headers['content-type']).toBe(XLSX_MIME);
        expect(response.headers['cache-control']).toBe('no-store');
      });
      const prefix = `attachment; filename="club-list-round-${roundId}-grade-1`;
      expect(ascii.headers['content-disposition']).toBe(`${prefix}-SCI-1.A.xlsx"`);
      expect(thai.headers['content-disposition']).toBe(
        `${prefix}-${Buffer.from('ก30901').toString('hex')}.xlsx"`,
      );
      expect(room.headers['content-disposition']).toBe(
        `attachment; filename="classroom-list-round-${roundId}-grade-1-room-3-1.xlsx"`,
      );
    });

    it('changes nothing in the database', async () => {
      const roundId = await newRound();
      const clubId = await createClub(pool, roundId, uniqueCode());
      const classroom = uniqueClassroom();
      const student = await createStudent(pool, { classroom });
      await register(pool, roundId, student.id, clubId);
      const before = await snapshotDatabase(pool);

      await exportOk(roundId, { view: 'club', format: 'xlsx' });
      await exportOk(roundId, { view: 'classroom', classroom, format: 'xlsx' });
      await exportOk(roundId, { view: 'club', format: 'pdf' });
      await exportOk(roundId, { view: 'classroom', classroom, format: 'pdf' });

      expect(await snapshotDatabase(pool)).toEqual(before);
    });

    it('logs the admin, scope and counts, and never a name, student ID or contact', async () => {
      const roundId = await newRound();
      const clubId = await createClub(pool, roundId, uniqueCode());
      await addAdvisor(clubId, 'ครูสมมติ ห้ามลงบันทึก');
      const classroom = uniqueClassroom();
      const students = await Promise.all(
        ['เด็กชายสมมติ บันทึก', 'เด็กหญิงสมมติ บันทึก'].map(
          async (fullName, index) =>
            await createStudent(pool, { classroom, fullName, seatNo: index + 1 }),
        ),
      );
      await register(pool, roundId, students[0]!.id, clubId);

      await exportOk(roundId, { view: 'club', clubId, format: 'xlsx' });
      await exportOk(roundId, { view: 'classroom', classroom, format: 'xlsx' });

      const log = logLines.join('');
      [
        'ครูสมมติ ห้ามลงบันทึก',
        ...Object.values(ADVISOR_CONTACT),
        ...students.map(({ loginId }) => loginId),
        'เด็กชายสมมติ บันทึก',
        'เด็กหญิงสมมติ บันทึก',
      ].forEach((personal) => {
        expect(log).not.toContain(personal);
      });
      const entries = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(({ msg }) => msg === 'name list exported');
      expect(entries).toEqual([
        expect.objectContaining({
          adminId: admin.id,
          roundId,
          view: 'club',
          format: 'xlsx',
          clubId,
          classroom: null,
          sheetCount: 1,
          studentCount: 1,
        }),
        expect.objectContaining({
          adminId: admin.id,
          roundId,
          view: 'classroom',
          format: 'xlsx',
          clubId: null,
          classroom,
          sheetCount: 1,
          studentCount: 2,
        }),
      ]);
    });
  });

  describe('PDF', () => {
    it('lays out one club as an A4 page with the same headings and columns as the Excel list', async () => {
      const roundId = await newRound();
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, {
        name: 'ชุมนุมดนตรีไทยสมมติ',
        capacity: 20,
      });
      await addAdvisor(clubId, 'ครูสมมติ ปิ่นแก้ว');
      await addAdvisor(clubId, 'ครูสมมติ น้ำใจ');
      const classroom = uniqueClassroom();
      // Upper and lower vowels, stacked tone marks, ascender and descender consonants.
      const [second, first] = await Promise.all([
        createStudent(pool, { classroom, seatNo: 9, fullName: 'เด็กชายปุ๊ก ฐิติปัญญ์สมมติ' }),
        createStudent(pool, { classroom, seatNo: 2, fullName: 'เด็กหญิงฝ้าย ญุ่นฟื้นฟูสมมติ' }),
      ]);
      await register(pool, roundId, second.id, clubId);
      await register(pool, roundId, first.id, clubId);

      const response = await exportOk(roundId, { view: 'club', clubId, format: 'pdf' });

      expect(response.headers['content-type']).toBe(PDF_MIME);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="club-list-round-${roundId}-grade-1-${code}.pdf"`,
      );
      const [page, ...others] = readPdfPages(response.rawPayload);
      expect(others).toEqual([]);
      expect(page!.lines.slice(0, 4)).toEqual([
        `ชุมนุม ${code} ชุมนุมดนตรีไทยสมมติ`,
        'ครูที่ปรึกษา: ครูสมมติ ปิ่นแก้ว, ครูสมมติ น้ำใจ',
        'จำนวนลง/จำนวนรับ: 2/20',
        expect.stringMatching(/^รอบ t-[0-9a-f]+ ม\.1 · ข้อมูล ณ /),
      ]);
      expect(tableRows(page!.lines, Object.values(CLUB_LIST_COLUMNS))).toEqual([
        ['1', first.loginId, 'เด็กหญิงฝ้าย ญุ่นฟื้นฟูสมมติ', `ม.1/${classroom}`, '2'],
        ['2', second.loginId, 'เด็กชายปุ๊ก ฐิติปัญญ์สมมติ', `ม.1/${classroom}`, '9'],
      ]);
      expectFooters([page!], sectionPages(1));
      // The glyphs drawn say the same as the text a viewer copies, wherever the glyph map can tell
      // (it cannot for sara am).
      expect(page!.glyphLines).toHaveLength(page!.lines.length);
      page!.lines
        .map((line, index) => [line, page!.glyphLines[index]] as const)
        .filter(([line]) => !line.includes('ำ'))
        .forEach(([line, drawn]) => {
          expect(drawn).toBe(line);
        });
      // Advisor names only, as in the Excel list.
      const text = page!.lines.join('\n');
      Object.values(ADVISOR_CONTACT).forEach((contact) => {
        expect(text).not.toContain(contact);
      });
    });

    it('starts a new page for every club of the round, an empty club showing its header', async () => {
      const roundId = await newRound();
      const [codeA, codeB] = ['A', 'B'].map((prefix) => `${prefix}${uniqueCode()}`);
      const clubB = await createClub(pool, roundId, codeB!, { capacity: 25 });
      await createClub(pool, roundId, codeA!, { capacity: 15 });
      const student = await createStudent(pool, { classroom: uniqueClassroom() });
      await register(pool, roundId, student.id, clubB);

      const response = await exportOk(roundId, { view: 'club', format: 'pdf' });

      const pages = readPdfPages(response.rawPayload);
      expect(pages.map(({ lines }) => lines.slice(0, 3))).toEqual([
        [`ชุมนุม ${codeA} ชุมนุมสมมติ`, 'ครูที่ปรึกษา: -', 'จำนวนลง/จำนวนรับ: 0/15'],
        [`ชุมนุม ${codeB} ชุมนุมสมมติ`, 'ครูที่ปรึกษา: -', 'จำนวนลง/จำนวนรับ: 1/25'],
      ]);
      expect(
        pages.map(({ lines }) =>
          tableRows(lines, Object.values(CLUB_LIST_COLUMNS)).map((row) => row[1]),
        ),
      ).toEqual([[], [student.loginId]]);
      expectFooters(pages, [...sectionPages(1), ...sectionPages(1)]);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="club-list-round-${roundId}-grade-1.pdf"`,
      );
    });

    it('numbers the pages of each club from 1 in a whole-round export', async () => {
      const roundId = await newRound();
      const [codeA, codeB, codeC] = ['A', 'B', 'C'].map((prefix) => `${prefix}${uniqueCode()}`);
      const clubA = await createClub(pool, roundId, codeA!, { capacity: 100 });
      const clubB = await createClub(pool, roundId, codeB!, { capacity: 10 });
      await createClub(pool, roundId, codeC!, { capacity: 10 });
      const classroom = uniqueClassroom();
      const students = await Promise.all(
        Array.from(
          { length: 91 },
          async (_, index) => await createStudent(pool, { classroom, seatNo: index + 1 }),
        ),
      );
      await Promise.all(
        students.map(
          async ({ id }, index) => await register(pool, roundId, id, index < 90 ? clubA : clubB),
        ),
      );

      const response = await exportOk(roundId, { view: 'club', format: 'pdf' });

      // 90 students run over three pages, the other clubs fit on one each.
      const pages = readPdfPages(response.rawPayload);
      const titleA = `ชุมนุม ${codeA} ชุมนุมสมมติ`;
      expect(pages.map(({ lines }) => lines[0])).toEqual([
        titleA,
        `${titleA} (ต่อ)`,
        `${titleA} (ต่อ)`,
        `ชุมนุม ${codeB} ชุมนุมสมมติ`,
        `ชุมนุม ${codeC} ชุมนุมสมมติ`,
      ]);
      expectFooters(pages, ['หน้า 1/3', 'หน้า 2/3', 'หน้า 3/3', 'หน้า 1/1', 'หน้า 1/1']);
    });

    it('lists every student of a classroom, marking who has not registered', async () => {
      const roundId = await newRound();
      const code = uniqueCode();
      const clubId = await createClub(pool, roundId, code, { name: 'ชุมนุมน้ำใสสมมติ' });
      const classroom = `3/${uniqueClassroom()}`;
      const [registered, missing] = await Promise.all([
        createStudent(pool, { classroom, seatNo: 1, fullName: 'เด็กหญิงสมมติ ลงแล้ว' }),
        createStudent(pool, { classroom, seatNo: 2, fullName: 'เด็กชายสมมติ ยังไม่เลือก' }),
      ]);
      await register(pool, roundId, registered.id, clubId);

      const response = await exportOk(roundId, { view: 'classroom', classroom, format: 'pdf' });

      const [page, ...others] = readPdfPages(response.rawPayload);
      expect(others).toEqual([]);
      expect(page!.lines.slice(0, 2)).toEqual([`ชั้น/ห้อง ม.1/${classroom}`, 'ลงแล้ว/ทั้งห้อง: 1/2']);
      expect(tableRows(page!.lines, Object.values(CLASSROOM_LIST_COLUMNS))).toEqual([
        ['1', registered.loginId, 'เด็กหญิงสมมติ ลงแล้ว', `${code} ชุมนุมน้ำใสสมมติ`],
        ['2', missing.loginId, 'เด็กชายสมมติ ยังไม่เลือก', NOT_REGISTERED_LABEL],
      ]);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="classroom-list-round-${roundId}-grade-1-room-${classroom.replace('/', '-')}.pdf"`,
      );
    });

    it('continues a long list onto more pages, repeating the table header on each', async () => {
      const roundId = await newRound();
      const classroom = uniqueClassroom();
      const students = await Promise.all(
        Array.from(
          { length: 90 },
          async (_, index) =>
            await createStudent(pool, {
              classroom,
              seatNo: index + 1,
              fullName: `นักเรียนสมมติ ลำดับ${index + 1}`,
            }),
        ),
      );

      const response = await exportOk(roundId, { view: 'classroom', classroom, format: 'pdf' });

      const pages = readPdfPages(response.rawPayload);
      expect(pages.length).toBeGreaterThanOrEqual(3);
      const rows = pages.map(({ lines }) =>
        tableRows(lines, Object.values(CLASSROOM_LIST_COLUMNS)),
      );
      // Every student exactly once, in seat order, across the pages.
      expect(rows.flat().map((row) => row[1])).toEqual(students.map(({ loginId }) => loginId));
      expect(rows.every((pageRows) => pageRows.length > 0)).toBe(true);
      pages.slice(1).forEach(({ lines }) => {
        expect(lines[0]).toBe(`ชั้น/ห้อง ม.1/${classroom} (ต่อ)`);
      });
      expectFooters(pages, sectionPages(pages.length));
    });

    it('cuts text too wide for its cell with an ellipsis and keeps every value as plain text', async () => {
      const roundId = await newRound();
      const code = `-${uniqueCode()}`;
      const longName = 'ชุมนุมสมมติ'.repeat(12);
      const clubId = await createClub(pool, roundId, code, { name: longName });
      const classroom = uniqueClassroom();
      const markup = '=1+2 <b>สมมติ</b>';
      const student = await createStudent(pool, { classroom, fullName: markup });
      await register(pool, roundId, student.id, clubId);

      const response = await exportOk(roundId, { view: 'classroom', classroom, format: 'pdf' });

      const [page] = readPdfPages(response.rawPayload);
      const [row] = tableRows(page!.lines, Object.values(CLASSROOM_LIST_COLUMNS));
      // Nothing to escape in a PDF: no formula runs and no markup is read.
      expect(row![2]).toBe(markup);
      const club = row![3]!;
      expect(club.endsWith('…')).toBe(true);
      expect(`${code} ${longName}`.startsWith(club.slice(0, -1))).toBe(true);
      expect(club.length).toBeLessThan(code.length + longName.length);
    });

    it('logs the format with the scope and counts, and never a name or student ID', async () => {
      const roundId = await newRound();
      const clubId = await createClub(pool, roundId, uniqueCode());
      await addAdvisor(clubId, 'ครูสมมติ ห้ามลงบันทึก');
      const classroom = uniqueClassroom();
      const student = await createStudent(pool, { classroom, fullName: 'เด็กชายสมมติ บันทึก' });
      await register(pool, roundId, student.id, clubId);

      await exportOk(roundId, { view: 'club', clubId, format: 'pdf' });
      await exportOk(roundId, { view: 'classroom', classroom, format: 'pdf' });

      const log = logLines.join('');
      [
        'ครูสมมติ ห้ามลงบันทึก',
        ...Object.values(ADVISOR_CONTACT),
        student.loginId,
        'เด็กชายสมมติ บันทึก',
      ].forEach((personal) => {
        expect(log).not.toContain(personal);
      });
      const entries = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(({ msg }) => msg === 'name list exported');
      expect(entries).toEqual([
        expect.objectContaining({ view: 'club', format: 'pdf', clubId, studentCount: 1 }),
        expect.objectContaining({ view: 'classroom', format: 'pdf', classroom, studentCount: 1 }),
      ]);
    });

    it('answers 404 like the Excel export for an unknown club or an empty round', async () => {
      const roundId = await newRound();

      const [club, whole] = await Promise.all([
        exportList(roundId, { view: 'club', clubId: UNKNOWN_ID, format: 'pdf' }),
        exportList(roundId, { view: 'club', format: 'pdf' }),
      ]);

      expect([club.statusCode, errorCodeOf(club)]).toEqual([404, 'not_found']);
      expect([whole.statusCode, errorCodeOf(whole)]).toEqual([404, 'nothing_to_export']);
    });

    it('exports a realistic round of 450 students in 12 classrooms and reports time and size', async () => {
      const grade = PDF_TIMING_TEST_GRADE;
      const roundId = await newRound(grade);
      const clubIds = await Promise.all(
        Array.from(
          { length: 15 },
          async () => await createClub(pool, roundId, uniqueCode(), { capacity: 30 }),
        ),
      );
      const perRoom = [38, 38, 38, 38, 38, 38, 37, 37, 37, 37, 37, 37];
      const students = (
        await Promise.all(
          perRoom.map(
            async (count, room) =>
              await Promise.all(
                Array.from(
                  { length: count },
                  async (_, seat) =>
                    await createStudent(pool, {
                      grade,
                      classroom: String(room + 1),
                      seatNo: seat + 1,
                      fullName: `เด็กหญิงปิ่นมณี ศักดิ์สิทธิ์สมมติ${room}-${seat}`,
                    }),
                ),
              ),
          ),
        )
      ).flat();
      // Two of every three students have a club.
      await Promise.all(
        students
          .filter((_, index) => index % 3 !== 0)
          .map(
            async ({ id }, index) =>
              await register(pool, roundId, id, clubIds[index % clubIds.length]!),
          ),
      );

      const startedAt = performance.now();
      const response = await exportOk(roundId, { view: 'classroom', format: 'pdf' });
      const elapsedMs = performance.now() - startedAt;

      const pages = readPdfPages(response.rawPayload);
      // Each classroom of up to 38 fits on one page.
      expect(pages).toHaveLength(12);
      expect(
        pages.flatMap(({ lines }) => tableRows(lines, Object.values(CLASSROOM_LIST_COLUMNS))),
      ).toHaveLength(450);
      // Printed so the number in the README/PR comes from a real run, not an estimate.
      console.info(
        `exported 450 students in 12 classrooms as PDF: request ${Math.round(elapsedMs)} ms, ` +
          `${response.rawPayload.length} bytes, ${pages.length} pages`,
      );
    }, 180_000);
  });

  describe('request validation and access', () => {
    it.each([
      ['no view', { format: 'xlsx' }],
      ['an unknown view', { view: 'teacher', format: 'xlsx' }],
      ['no format', { view: 'club' }],
      ['an unknown format', { view: 'club', format: 'docx' }],
      ['a clubId with the classroom view', { view: 'classroom', clubId: 1, format: 'xlsx' }],
      ['a classroom with the club view', { view: 'club', classroom: '1', format: 'xlsx' }],
      ['a clubId that is not a number', { view: 'club', clubId: 'abc', format: 'xlsx' }],
      ['a clubId of 0', { view: 'club', clubId: 0, format: 'xlsx' }],
      ['an empty classroom', { view: 'classroom', classroom: ' ', format: 'xlsx' }],
      ['an over-long classroom', { view: 'classroom', classroom: 'x'.repeat(17), format: 'xlsx' }],
      ['an unknown parameter', { view: 'club', format: 'xlsx', grade: 1 }],
    ])('answers 400 for %s', async (_label, query) => {
      const roundId = await newRound();
      await createClub(pool, roundId, uniqueCode());

      const response = await exportList(roundId, query);

      expect(response.statusCode).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_error');
    });

    it('answers 400 for a round id that is not a number', async () => {
      const response = await exportList('abc', { view: 'club', format: 'xlsx' });

      expect(response.statusCode).toBe(400);
    });

    it('answers 404 for an unknown round', async () => {
      const response = await exportList(UNKNOWN_ID, { view: 'club', format: 'xlsx' });

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
    });

    it('answers 401 without a session', async () => {
      const roundId = await newRound();

      const response = await exportList(roundId, { view: 'club', format: 'xlsx' }, null);

      expect(response.statusCode).toBe(401);
    });

    it('refuses a student with 403 before validating anything', async () => {
      const roundId = await newRound();
      await createClub(pool, roundId, uniqueCode());
      const token = await loginAs(await createTestUser(pool));

      const [valid, invalid, classrooms] = await Promise.all([
        exportList(roundId, { view: 'club', format: 'xlsx' }, token),
        exportList(roundId, { view: 'nope' }, token),
        app.inject({
          method: 'GET',
          url: `/api/admin/rounds/${roundId}/classrooms`,
          cookies: { [SESSION_COOKIE]: token },
        }),
      ]);

      [valid, invalid, classrooms].forEach((response) => {
        expect(response.statusCode).toBe(403);
        expect(errorCodeOf(response)).toBe('forbidden');
      });
    });
  });

  describe('GET /api/admin/rounds/:roundId/classrooms', () => {
    const getClassrooms = async (roundId: number | string) =>
      await app.inject({
        method: 'GET',
        url: `/api/admin/rounds/${roundId}/classrooms`,
        cookies: { [SESSION_COOKIE]: adminToken },
      });

    it('counts the students and registrations of each classroom of the round grade', async () => {
      const grade = CLASSROOM_COUNT_TEST_GRADE;
      const roundId = await newRound(grade);
      const clubId = await createClub(pool, roundId, uniqueCode());
      const [a, b] = await Promise.all([
        createStudent(pool, { grade, classroom: '10', seatNo: 1 }),
        createStudent(pool, { grade, classroom: '10', seatNo: 2 }),
        createStudent(pool, { grade, classroom: '9', seatNo: 1 }),
      ]);
      await register(pool, roundId, a.id, clubId);
      await register(pool, roundId, b.id, clubId);
      await createStudent(pool, { grade: OTHER_GRADE, classroom: '1' });

      const response = await getClassrooms(roundId);

      expect(response.statusCode).toBe(200);
      const { round, classrooms } = roundClassroomsResponseSchema.parse(response.json());
      expect(round).toMatchObject({ id: roundId, grade, totalRegistered: 2 });
      expect(classrooms).toEqual([
        { classroom: '9', studentCount: 1, registeredCount: 0 },
        { classroom: '10', studentCount: 2, registeredCount: 2 },
      ]);
    });

    it('answers 404 for an unknown round', async () => {
      const response = await getClassrooms(UNKNOWN_ID);

      expect(response.statusCode).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
    });
  });
});
