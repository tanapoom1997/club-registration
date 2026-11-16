import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  IMPORT_COLUMNS,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_SHEETS,
  errorResponseSchema,
  importPreviewResponseSchema,
} from '@club-registration/shared';
import type { ImportPreviewResponse } from '@club-registration/shared';
import ExcelJS from 'exceljs';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { createPool } from '../src/db.js';
import { IMPORT_TEMPLATE_PATH } from '../src/import/template.js';
import { buildTestApp, createTestUser } from './support/app.js';
import type { TestUser } from './support/app.js';
import {
  advisorRow,
  buildImportWorkbook,
  buildWorkbook,
  buildZip,
  clubRow,
  multipartBody,
  rawZipEntry,
  studentRow,
  templateHeader,
  zipEntry,
} from './support/import.js';
import type { MultipartFile } from './support/import.js';
import {
  addAdvisor,
  createClub as createClubIn,
  createRound as createRoundIn,
  createStudent as createStudentIn,
  register as registerIn,
  snapshotDatabase as snapshotDatabaseOf,
  uniqueCode,
  uniqueStudentId,
  uniqueTerm,
} from './support/import-db.js';
import { startMigratedPostgres, stopPostgres } from './support/postgres.js';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

const errorOf = (response: InjectResponse) => errorResponseSchema.parse(response.json());
const previewOf = (response: InjectResponse): ImportPreviewResponse =>
  importPreviewResponseSchema.parse(response.json());

const COL = IMPORT_COLUMNS;

describe('admin import preview', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let adminToken: string;

  const loginAs = async (user: TestUser): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { loginId: user.loginId, password: user.password },
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)!.value;
  };

  const request = async (options: InjectOptions, token = adminToken) =>
    await app.inject({ ...options, cookies: { [SESSION_COOKIE]: token } });

  const postPreview = async (
    fields: Record<string, string>,
    files: MultipartFile[],
    token = adminToken,
  ) =>
    await request(
      { method: 'POST', url: '/api/admin/import/preview', ...(await multipartBody(fields, files)) },
      token,
    );

  const preview = async (term: string, bytes: Buffer, name = 'import.xlsx') =>
    await postPreview({ term }, [{ name, bytes }]);

  const previewOk = async (term: string, bytes: Buffer): Promise<ImportPreviewResponse> => {
    const response = await preview(term, bytes);
    expect(response.statusCode).toBe(200);
    return previewOf(response);
  };

  const createRound = async (term: string, grade: number) => await createRoundIn(pool, term, grade);
  const createClub = async (
    roundId: number,
    clubCode: string,
    options?: Parameters<typeof createClubIn>[3],
  ) => await createClubIn(pool, roundId, clubCode, options);
  const createStudent = async (options?: Parameters<typeof createStudentIn>[1]) =>
    await createStudentIn(pool, options);
  const register = async (roundId: number, studentId: number, clubId: number) =>
    await registerIn(pool, roundId, studentId, clubId);
  const snapshotDatabase = async () => await snapshotDatabaseOf(pool);

  beforeAll(async () => {
    container = await startMigratedPostgres();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    await stopPostgres(pool, container);
  });

  beforeEach(async () => {
    app = await buildTestApp(pool);
    adminToken = await loginAs(await createTestUser(pool, { role: 'admin' }));
  });

  afterEach(async () => {
    await app.close();
  });

  describe('summary against existing data', () => {
    it('counts students to create, update and leave unchanged', async () => {
      const same = await createStudent({ fullName: 'คงเดิม สมมติ', grade: 2, seatNo: 3 });
      const renamed = await createStudent({ fullName: 'ชื่อเก่า สมมติ' });
      const moved = await createStudent({ classroom: '1', seatNo: 4 });
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: same.loginId, fullName: 'คงเดิม สมมติ', grade: 2, seatNo: 3 }),
          studentRow({ loginId: renamed.loginId, fullName: 'ชื่อใหม่ สมมติ' }),
          studentRow({ loginId: moved.loginId, classroom: '2', seatNo: 4 }),
          studentRow({ loginId: uniqueStudentId() }),
          studentRow({ loginId: uniqueStudentId() }),
        ],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([]);
      expect(result.students).toEqual({ create: 2, update: 2, unchanged: 1 });
      expect(result.clubs).toEqual({ create: 0, update: 0, unchanged: 0 });
    });

    it('matches student IDs the way login does (trimmed, case-insensitive)', async () => {
      const existing = await createStudent({ fullName: 'คงเดิม สมมติ' });
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: `  ${existing.loginId.toUpperCase()} `, fullName: 'คงเดิม สมมติ' }),
        ],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.students).toEqual({ create: 0, update: 0, unchanged: 1 });
    });

    it('counts clubs per round and grade to create, update and leave unchanged', async () => {
      const term = uniqueTerm();
      const [grade1, grade2] = [await createRound(term, 1), await createRound(term, 2)];
      const [same, resized, renamed] = [uniqueCode(), uniqueCode(), uniqueCode()];
      await createClub(grade1, same, { name: 'ดนตรี', capacity: 20, description: 'เดิม' });
      await createClub(grade1, resized, { capacity: 20 });
      await createClub(grade2, renamed, { name: 'ชื่อเก่า' });
      const workbook = await buildImportWorkbook({
        clubs: [
          clubRow({ clubCode: same, name: 'ดนตรี', grade: 1, capacity: 20, description: 'เดิม' }),
          clubRow({ clubCode: resized, grade: 1, capacity: 25 }),
          clubRow({ clubCode: renamed, grade: 2, name: 'ชื่อใหม่' }),
          // The same code in another grade is another club with its own seats.
          clubRow({ clubCode: same, name: 'ดนตรี', grade: 2, capacity: 20 }),
          clubRow({ clubCode: uniqueCode(), grade: 'ม.2' }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([]);
      expect(result.clubs).toEqual({ create: 2, update: 2, unchanged: 1 });
    });

    it('replaces advisors of a code in every round of the term, from the file or the DB', async () => {
      const term = uniqueTerm();
      const [grade1, grade2] = [await createRound(term, 1), await createRound(term, 2)];
      const [stored, both, fresh] = [uniqueCode(), uniqueCode(), uniqueCode()];
      await createClub(grade1, stored);
      await createClub(grade2, stored);
      await createClub(grade1, both);
      const workbook = await buildImportWorkbook({
        clubs: [clubRow({ clubCode: both, grade: 2 }), clubRow({ clubCode: fresh, grade: 1 })],
        advisors: [
          advisorRow({ clubCode: stored, fullName: 'ครูหนึ่ง' }),
          advisorRow({ clubCode: stored, fullName: 'ครูสอง', phone: '081-234-5678' }),
          advisorRow({ clubCode: both, fullName: 'ครูสาม', email: 'teacher@example.com' }),
          advisorRow({ clubCode: fresh.toLowerCase(), fullName: 'ครูสี่', lineId: '@fictional' }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([]);
      // stored: grades 1 and 2; both: grade 1 (DB) and 2 (file); fresh: grade 1.
      expect(result.advisors).toEqual({ clubsReplaced: 5, clubsUnchanged: 0, rows: 4 });
    });

    it('counts a club whose stored advisors already match the file, in order, as unchanged', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(term, 1);
      const [same, reordered] = [uniqueCode(), uniqueCode()];
      const sameId = await createClub(roundId, same);
      const reorderedId = await createClub(roundId, reordered);
      await addAdvisor(pool, sameId, 'ครูหนึ่ง');
      await addAdvisor(pool, sameId, 'ครูสอง');
      await addAdvisor(pool, reorderedId, 'ครูหนึ่ง');
      await addAdvisor(pool, reorderedId, 'ครูสอง');
      const workbook = await buildImportWorkbook({
        advisors: [
          advisorRow({ clubCode: same, fullName: 'ครูหนึ่ง' }),
          advisorRow({ clubCode: same, fullName: 'ครูสอง' }),
          advisorRow({ clubCode: reordered, fullName: 'ครูสอง' }),
          advisorRow({ clubCode: reordered, fullName: 'ครูหนึ่ง' }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.advisors).toEqual({ clubsReplaced: 1, clubsUnchanged: 1, rows: 4 });
    });

    it('accepts the empty template as a file with nothing to change', async () => {
      const result = await previewOk(uniqueTerm(), await readFile(IMPORT_TEMPLATE_PATH));

      expect(result).toMatchObject({
        students: { create: 0, update: 0, unchanged: 0 },
        clubs: { create: 0, update: 0, unchanged: 0 },
        advisors: { clubsReplaced: 0, clubsUnchanged: 0, rows: 0 },
        errors: [],
        errorCount: 0,
      });
    });

    it('returns the sha256 of the uploaded bytes and the chosen term', async () => {
      const term = uniqueTerm();
      const workbook = await buildImportWorkbook({ students: [] });

      const result = await previewOk(`  ${term} `, workbook);

      expect(result.fileSha256).toBe(createHash('sha256').update(workbook).digest('hex'));
      expect(result.term).toBe(term);
    });
  });

  describe('dry run', () => {
    it('leaves every table exactly as it was', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(term, 1);
      const code = uniqueCode();
      const clubId = await createClub(roundId, code, { capacity: 10 });
      const student = await createStudent({ fullName: 'ชื่อเก่า สมมติ' });
      await register(roundId, student.id, clubId);
      await addAdvisor(pool, clubId, 'ครูเดิม สมมติ');
      const before = await snapshotDatabase();
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: student.loginId, fullName: 'ชื่อใหม่ สมมติ' }),
          studentRow({ loginId: uniqueStudentId() }),
        ],
        clubs: [
          clubRow({ clubCode: code, capacity: 12 }),
          clubRow({ clubCode: uniqueCode(), grade: 1 }),
        ],
        advisors: [advisorRow({ clubCode: code, fullName: 'ครูใหม่ สมมติ' })],
      });

      const result = await previewOk(term, workbook);

      expect(result.students).toMatchObject({ create: 1, update: 1 });
      expect(result.clubs).toMatchObject({ create: 1, update: 1 });
      expect(await snapshotDatabase()).toEqual(before);
    });
  });

  describe('validation', () => {
    it('reports every bad student cell on its own row and column', async () => {
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: uniqueStudentId() }),
          studentRow({ loginId: 'has space', fullName: null, grade: 7, classroom: '1', seatNo: 0 }),
          studentRow({ loginId: uniqueStudentId(), fullName: 'ก'.repeat(201), seatNo: 2.5 }),
        ],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors.map(({ sheet, row, column }) => [sheet, row, column])).toEqual([
        ['students', 3, COL.students.loginId],
        ['students', 3, COL.students.fullName],
        ['students', 3, COL.students.grade],
        ['students', 3, COL.students.seatNo],
        ['students', 4, COL.students.fullName],
        ['students', 4, COL.students.seatNo],
      ]);
      expect(result.errorCount).toBe(6);
      // Valid rows still count, so the admin sees the whole picture in one pass.
      expect(result.students.create).toBe(1);
    });

    it('rejects a negative or fractional capacity and a grade outside 1–6', async () => {
      const term = uniqueTerm();
      await createRound(term, 1);
      const workbook = await buildImportWorkbook({
        clubs: [
          clubRow({ clubCode: uniqueCode(), capacity: -1 }),
          clubRow({ clubCode: uniqueCode(), capacity: 'สามสิบ' }),
          clubRow({ clubCode: uniqueCode(), grade: 0 }),
          clubRow({ clubCode: 'has space', name: '' }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors.map(({ sheet, row, column }) => [sheet, row, column])).toEqual([
        ['clubs', 2, COL.clubs.capacity],
        ['clubs', 3, COL.clubs.capacity],
        ['clubs', 4, COL.clubs.grade],
        ['clubs', 5, COL.clubs.clubCode],
        ['clubs', 5, COL.clubs.name],
      ]);
    });

    it('checks advisor phone and e-mail formats but allows empty contact cells', async () => {
      const term = uniqueTerm();
      const code = uniqueCode();
      await createClub(await createRound(term, 1), code);
      const workbook = await buildImportWorkbook({
        advisors: [
          advisorRow({ clubCode: code }),
          advisorRow({ clubCode: code, phone: 'call me' }),
          advisorRow({ clubCode: code, email: 'not-an-email@' }),
          // A phone typed into a number cell has lost its leading zero.
          advisorRow({ clubCode: code, phone: 812345678, lineId: 'has space' }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors.map(({ sheet, row, column }) => [sheet, row, column])).toEqual([
        ['advisors', 3, COL.advisors.phone],
        ['advisors', 4, COL.advisors.email],
        ['advisors', 5, COL.advisors.phone],
        ['advisors', 5, COL.advisors.lineId],
      ]);
      expect(result.advisors).toEqual({ clubsReplaced: 1, clubsUnchanged: 0, rows: 1 });
    });

    it('reports a repeated student ID on the later row, naming the first', async () => {
      const id = uniqueStudentId();
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: id }),
          studentRow({ loginId: uniqueStudentId() }),
          studentRow({ loginId: id.toUpperCase() }),
        ],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        {
          sheet: 'students',
          row: 4,
          column: COL.students.loginId,
          message: expect.stringContaining('ซ้ำกับแถว 2') as string,
        },
      ]);
    });

    it('reports a repeated club code and grade, but not the same code in another grade', async () => {
      const term = uniqueTerm();
      await createRound(term, 1);
      await createRound(term, 2);
      const code = uniqueCode();
      const workbook = await buildImportWorkbook({
        clubs: [
          clubRow({ clubCode: code, grade: 1 }),
          clubRow({ clubCode: code, grade: 2 }),
          clubRow({ clubCode: code.toLowerCase(), grade: 'ม.1' }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([
        {
          sheet: 'clubs',
          row: 4,
          column: COL.clubs.clubCode,
          message: expect.stringContaining('ซ้ำกับแถว 2') as string,
        },
      ]);
    });

    it('refuses a student ID that belongs to an admin account', async () => {
      const admin = await createTestUser(pool, { role: 'admin' });
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: uniqueStudentId() }),
          studentRow({ loginId: admin.loginId }),
        ],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        expect.objectContaining({ sheet: 'students', row: 3, column: COL.students.loginId }),
      ]);
      expect(result.students.update).toBe(0);
    });

    it('refuses a capacity below the number already registered', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(term, 1);
      const code = uniqueCode();
      const clubId = await createClub(roundId, code, { capacity: 10 });
      await register(roundId, (await createStudent()).id, clubId);
      await register(roundId, (await createStudent()).id, clubId);
      const workbook = await buildImportWorkbook({
        clubs: [clubRow({ clubCode: code, capacity: 1 })],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([
        {
          sheet: 'clubs',
          row: 2,
          column: COL.clubs.capacity,
          message: expect.stringContaining('2 คน') as string,
        },
      ]);
    });

    it('accepts a capacity equal to the number already registered', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(term, 1);
      const code = uniqueCode();
      const clubId = await createClub(roundId, code, { capacity: 10 });
      await register(roundId, (await createStudent()).id, clubId);
      const workbook = await buildImportWorkbook({
        clubs: [clubRow({ clubCode: code, capacity: 1 })],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([]);
      expect(result.clubs.update).toBe(1);
    });

    it('needs a round of the term for each club grade', async () => {
      const term = uniqueTerm();
      await createRound(term, 1);
      // A round of the same grade in another term does not count.
      await createRound(uniqueTerm(), 3);
      const workbook = await buildImportWorkbook({
        clubs: [
          clubRow({ clubCode: uniqueCode(), grade: 1 }),
          clubRow({ clubCode: uniqueCode(), grade: 3 }),
        ],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([
        expect.objectContaining({ sheet: 'clubs', row: 3, column: COL.clubs.grade }),
      ]);
    });

    it('refuses advisors for a club code found in neither the file nor the term', async () => {
      const term = uniqueTerm();
      const otherTermCode = uniqueCode();
      await createClub(await createRound(uniqueTerm(), 1), otherTermCode);
      const workbook = await buildImportWorkbook({
        advisors: [advisorRow({ clubCode: uniqueCode() }), advisorRow({ clubCode: otherTermCode })],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors.map(({ sheet, row, column }) => [sheet, row, column])).toEqual([
        ['advisors', 2, COL.advisors.clubCode],
        ['advisors', 3, COL.advisors.clubCode],
      ]);
      expect(result.advisors).toEqual({ clubsReplaced: 0, clubsUnchanged: 0, rows: 0 });
    });

    it('refuses a grade change for a student registered in a round of their grade this term', async () => {
      const term = uniqueTerm();
      const roundId = await createRound(term, 1);
      const clubId = await createClub(roundId, uniqueCode());
      const registered = await createStudent({ grade: 1 });
      await register(roundId, registered.id, clubId);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: registered.loginId, grade: 2 })],
      });

      const result = await previewOk(term, workbook);

      expect(result.errors).toEqual([
        expect.objectContaining({ sheet: 'students', row: 2, column: COL.students.grade }),
      ]);
    });

    it('allows the grade change when the registration belongs to another term', async () => {
      const lastTerm = uniqueTerm();
      const roundId = await createRound(lastTerm, 1);
      const clubId = await createClub(roundId, uniqueCode());
      const student = await createStudent({ grade: 1 });
      await register(roundId, student.id, clubId);
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: student.loginId, grade: 2 })],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([]);
      expect(result.students.update).toBe(1);
    });

    it('reports a missing template column on the header row', async () => {
      const workbook = await buildWorkbook({
        students: {
          header: templateHeader('students').filter((label) => label !== COL.students.seatNo),
          rows: [[uniqueStudentId(), 'นักเรียน สมมติ', 1, '1']],
        },
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        expect.objectContaining({ sheet: 'students', row: 1, column: COL.students.seatNo }),
      ]);
      expect(result.students.create).toBe(0);
    });

    it('ignores columns outside the template and never echoes their contents', async () => {
      const secret = 'fictional-national-id-1234567890123';
      const workbook = await buildWorkbook({
        students: {
          // Extra columns in any position; template columns are matched by name, not position.
          header: ['เลขบัตรประชาชน', ...templateHeader('students').toReversed()],
          rows: [[secret, 3, '2', 1, 'นักเรียน สมมติ', uniqueStudentId()]],
        },
      });

      const response = await preview(uniqueTerm(), workbook);

      expect(response.statusCode).toBe(200);
      expect(previewOf(response)).toMatchObject({ errors: [], students: { create: 1 } });
      expect(response.body).not.toContain(secret);
    });

    it('reports a sheet over the row limit without validating it row by row', async () => {
      const rows = Array.from({ length: 5_001 }, () => studentRow({ loginId: 'bad id' }));
      const workbook = await buildImportWorkbook({ students: rows });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        { sheet: 'students', row: null, column: null, message: expect.any(String) as string },
      ]);
    });

    it('reports a file without any template sheet', async () => {
      const workbook = await buildWorkbook({ Sheet1: { header: ['a'], rows: [['b']] } });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        { sheet: null, row: null, column: null, message: expect.any(String) as string },
      ]);
    });

    it('uses the cached result of a formula and refuses a formula without one', async () => {
      const id = uniqueStudentId();
      const workbook = await buildImportWorkbook({
        students: [
          studentRow({ loginId: { formula: 'LOWER("X")', result: id } }),
          studentRow({ loginId: uniqueStudentId(), fullName: { formula: 'A1&"!"' } }),
        ],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        expect.objectContaining({ sheet: 'students', row: 3, column: COL.students.fullName }),
      ]);
      expect(result.students.create).toBe(1);
    });

    it('refuses a cell Excel turned into a date', async () => {
      const workbook = await buildImportWorkbook({
        students: [studentRow({ loginId: uniqueStudentId(), classroom: new Date('2026-01-02') })],
      });

      const result = await previewOk(uniqueTerm(), workbook);

      expect(result.errors).toEqual([
        expect.objectContaining({ sheet: 'students', row: 2, column: COL.students.classroom }),
      ]);
    });

    it.each([
      ['a missing term', {}],
      ['an empty term', { term: '   ' }],
    ])('answers 400 validation_error for %s', async (_label, fields) => {
      const bytes = await buildImportWorkbook({ students: [] });

      const response = await postPreview(fields, [{ name: 'import.xlsx', bytes }]);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });

    it('answers 400 validation_error when no file is sent', async () => {
      const response = await postPreview({ term: uniqueTerm() }, []);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });

    it('answers 400 validation_error for two files', async () => {
      const bytes = await buildImportWorkbook({ students: [] });

      const response = await postPreview({ term: uniqueTerm() }, [
        { name: 'a.xlsx', bytes },
        { name: 'b.xlsx', bytes },
      ]);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_error');
    });
  });

  describe('file safety', () => {
    it('answers 415 for a text file renamed to .xlsx', async () => {
      const response = await preview(uniqueTerm(), Buffer.from('รหัสนักเรียน,ชื่อ\n1,a\n'));

      expect(response.statusCode).toBe(415);
      expect(errorOf(response).code).toBe('unsupported_file');
    });

    it('answers 415 for a real workbook whose name is not .xlsx', async () => {
      const bytes = await buildImportWorkbook({ students: [] });

      const response = await preview(uniqueTerm(), bytes, 'import.csv');

      expect(response.statusCode).toBe(415);
      expect(errorOf(response).code).toBe('unsupported_file');
    });

    it('answers 413 file_too_large for a file over 5 MB', async () => {
      const bytes = Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1);
      bytes.writeUInt32LE(0x04034b50, 0);

      const response = await preview(uniqueTerm(), bytes);

      expect(response.statusCode).toBe(413);
      expect(errorOf(response).code).toBe('file_too_large');
    });

    it('answers 413 file_too_large from the declared length alone', async () => {
      const response = await request({
        method: 'POST',
        url: '/api/admin/import/preview',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        payload: Buffer.alloc(IMPORT_MAX_FILE_BYTES * 2),
      });

      expect(response.statusCode).toBe(413);
      expect(errorOf(response).code).toBe('file_too_large');
    });

    it('answers 413 for a zip bomb even when the zip understates its size', async () => {
      const bomb = buildZip([
        zipEntry('xl/worksheets/sheet1.xml', Buffer.alloc(40 * 1024 * 1024), { declaredSize: 100 }),
      ]);

      const response = await preview(uniqueTerm(), bomb);

      expect(response.statusCode).toBe(413);
      expect(errorOf(response).code).toBe('file_too_large');
    });

    it('answers 400 invalid_workbook for a truncated zip', async () => {
      const bytes = await buildImportWorkbook({ students: [] });

      const response = await preview(uniqueTerm(), bytes.subarray(0, bytes.length / 2));

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('invalid_workbook');
    });

    it('answers 400 invalid_workbook for a zip with a broken compressed stream', async () => {
      const broken = buildZip([rawZipEntry('xl/workbook.xml', Buffer.alloc(64, 0xff))]);

      const response = await preview(uniqueTerm(), broken);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('invalid_workbook');
    });

    it('answers 400 invalid_workbook for a valid zip that is not a workbook', async () => {
      const notWorkbook = buildZip([zipEntry('notes.txt', Buffer.from('fictional notes'))]);

      const response = await preview(uniqueTerm(), notWorkbook);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('invalid_workbook');
    });

    it('answers 400 bad_request for a JSON body instead of a form', async () => {
      const response = await request({
        method: 'POST',
        url: '/api/admin/import/preview',
        payload: { term: uniqueTerm() },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('template', () => {
    it('serves the committed template as an .xlsx attachment', async () => {
      const response = await request({ method: 'GET', url: '/api/admin/import/template' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="import-template.xlsx"',
      );
      expect(response.rawPayload.equals(await readFile(IMPORT_TEMPLATE_PATH))).toBe(true);
    });

    it('has exactly the template sheets and headers, and no data rows', async () => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(await readFile(IMPORT_TEMPLATE_PATH)).buffer);

      const sheets = workbook.worksheets.map((worksheet) => ({
        name: worksheet.name,
        header: (worksheet.getRow(1).values as ExcelJS.CellValue[]).slice(1),
        rows: worksheet.actualRowCount,
      }));

      expect(sheets).toEqual(
        IMPORT_SHEETS.map((sheet) => ({ name: sheet, header: templateHeader(sheet), rows: 1 })),
      );
    });
  });

  describe('access control', () => {
    it('forbids a student from both import routes', async () => {
      const studentToken = await loginAs(await createTestUser(pool));
      const bytes = await buildImportWorkbook({ students: [] });

      const responses = [
        await request({ method: 'GET', url: '/api/admin/import/template' }, studentToken),
        await postPreview({ term: uniqueTerm() }, [{ name: 'import.xlsx', bytes }], studentToken),
      ];

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([403, 403]);
      expect(responses.map((response) => errorOf(response).code)).toEqual([
        'forbidden',
        'forbidden',
      ]);
    });

    it('requires a session', async () => {
      const responses = [
        await app.inject({ method: 'GET', url: '/api/admin/import/template' }),
        await app.inject({ method: 'POST', url: '/api/admin/import/preview' }),
      ];

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([401, 401]);
    });
  });
});
