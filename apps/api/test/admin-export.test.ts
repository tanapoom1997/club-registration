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
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UNKNOWN_ID = 2_000_000_000;

// Tests that list a whole grade own one: every other test works in classrooms or clubs of its
// own, so no test sees another's students.
const SHARED_GRADE = 1;
const WHOLE_GRADE_TEST_GRADE = 4;
const CLASSROOM_COUNT_TEST_GRADE = 5;
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
    pool = createPool(container.getConnectionUri());
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
      expect(sheet!.headings.slice(0, 2)).toEqual([
        `ชั้น/ห้อง ม.1/${classroom}`,
        'ลงแล้ว/ทั้งห้อง: 1/3',
      ]);
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

    it('gives every classroom of the round grade a sheet, in classroom order', async () => {
      const roundId = await newRound(WHOLE_GRADE_TEST_GRADE);
      await Promise.all(
        ['10', '2', '3/1'].map(
          async (classroom) =>
            await createStudent(pool, { grade: WHOLE_GRADE_TEST_GRADE, classroom }),
        ),
      );
      await createStudent(pool, { grade: OTHER_GRADE, classroom: '1' });

      const response = await exportOk(roundId, { view: 'classroom', format: 'xlsx' });

      const sheets = await readClassroomSheets(response.rawPayload);
      expect(sheets.map(({ name }) => name)).toEqual(['ม.4-2', 'ม.4-3-1', 'ม.4-10']);
      expect(sheets.map(({ rows }) => rows.length)).toEqual([1, 1, 1]);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="classroom-list-round-${roundId}-grade-4.xlsx"`,
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

  describe('request validation and access', () => {
    it.each([
      ['no view', { format: 'xlsx' }],
      ['an unknown view', { view: 'teacher', format: 'xlsx' }],
      ['no format', { view: 'club' }],
      ['a format that is not offered yet', { view: 'club', format: 'pdf' }],
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
