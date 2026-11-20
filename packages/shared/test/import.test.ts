import { describe, expect, it } from 'vitest';
import {
  CAPACITY_MAX,
  SEAT_NO_MAX,
  advisorImportRowSchema,
  classroomSchema,
  clubCodeSchema,
  clubDescriptionSchema,
  clubImportRowSchema,
  importCommitFieldsSchema,
  studentImportRowSchema,
} from '../src/import.js';

// Every row value is the cell's text, as the api hands it over (a numeric cell becomes its
// decimal string). All names and codes are fictional.
const student = {
  loginId: '6599001',
  fullName: 'ด.ช.สมมติ ทดสอบ',
  grade: '4',
  classroom: '4/1',
  seatNo: '12',
};
const club = {
  clubCode: 'smk01',
  name: 'ชุมนุมสมมติ',
  grade: 'ม.4',
  capacity: '30',
  description: undefined,
};
const advisor = {
  clubCode: 'SMK01',
  fullName: 'ครูสมมติ ใจดี',
  phone: undefined,
  email: undefined,
  lineId: undefined,
};

describe('studentImportRowSchema', () => {
  it('turns a row of cell texts into what the database stores', () => {
    expect(studentImportRowSchema.parse({ ...student, loginId: ' 6599001 ' })).toEqual({
      loginId: '6599001',
      fullName: 'ด.ช.สมมติ ทดสอบ',
      grade: 4,
      classroom: '4/1',
      seatNo: 12,
    });
  });

  // Login IDs are normalised like login itself, so the student signs in with the imported key.
  it('lower-cases a login ID', () => {
    expect(studentImportRowSchema.parse({ ...student, loginId: 'STU-A1' }).loginId).toBe('stu-a1');
  });

  it.each([
    ['1', 1],
    ['6', 6],
    ['ม.1', 1],
    ['ม. 3', 3],
    ['ม5', 5],
  ])('reads grade %j as %i', (grade, expected) => {
    expect(studentImportRowSchema.parse({ ...student, grade }).grade).toBe(expected);
  });

  it.each(['0', '7', 'ม.7', '1.0', 'ป.4', ''])('refuses grade %j', (grade) => {
    expect(studentImportRowSchema.safeParse({ ...student, grade }).success).toBe(false);
  });

  // A fraction or a negative must fail rather than be rounded into a different seat, and so does
  // any decimal point: only the digits of a whole number are read.
  it.each(['0', '12.5', '12.0', '-1', '1e2', String(SEAT_NO_MAX + 1), 'สิบ'])(
    'refuses seat number %j',
    (seatNo) => {
      expect(studentImportRowSchema.safeParse({ ...student, seatNo }).success).toBe(false);
    },
  );

  it.each([
    ['a missing name', { fullName: undefined }],
    ['a name of spaces', { fullName: '   ' }],
    ['a control character in the name', { fullName: 'ด.ช.สมมติ\u0007' }],
    ['a line break in the name', { fullName: 'ด.ช.สมมติ\nทดสอบ' }],
    ['a missing classroom', { classroom: undefined }],
  ])('refuses %s', (_case, change) => {
    expect(studentImportRowSchema.safeParse({ ...student, ...change }).success).toBe(false);
  });
});

describe('clubCodeSchema', () => {
  // Codes key the upsert, so "smk01" and "SMK01" must be the same club.
  it('upper-cases a code and keeps Thai letters', () => {
    expect(clubCodeSchema.parse(' smk01 ')).toBe('SMK01');
    expect(clubCodeSchema.parse('ก30901')).toBe('ก30901');
    expect(clubCodeSchema.parse('a-1/2.b_c')).toBe('A-1/2.B_C');
  });

  it.each(['', 'SMK 01', 'SMK;01', 'x'.repeat(33)])('refuses %j', (code) => {
    expect(clubCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe('clubImportRowSchema', () => {
  it('turns an empty description into an empty text', () => {
    expect(clubImportRowSchema.parse(club)).toEqual({
      clubCode: 'SMK01',
      name: 'ชุมนุมสมมติ',
      grade: 4,
      capacity: 30,
      description: '',
    });
  });

  it.each([
    ['0', 0],
    [String(CAPACITY_MAX), CAPACITY_MAX],
  ])('accepts capacity %j', (capacity, expected) => {
    expect(clubImportRowSchema.parse({ ...club, capacity }).capacity).toBe(expected);
  });

  it.each(['-1', '30.5', String(CAPACITY_MAX + 1), ''])('refuses capacity %j', (capacity) => {
    expect(clubImportRowSchema.safeParse({ ...club, capacity }).success).toBe(false);
  });
});

describe('clubDescriptionSchema', () => {
  // Admins write paragraphs here, so line breaks and tabs are text; other control characters are not.
  it('keeps line breaks and tabs', () => {
    const description = 'วรรคแรก\r\nวรรคสอง\n\tย่อหน้า';

    expect(clubDescriptionSchema.parse(description)).toBe(description);
  });

  it.each(['\u0000', '\u0007', '\u001b[31m'])('refuses control character %j', (control) => {
    expect(clubDescriptionSchema.safeParse(`รายละเอียด${control}`).success).toBe(false);
  });

  it('refuses more than 2,000 characters', () => {
    expect(clubDescriptionSchema.safeParse('ก'.repeat(2_001)).success).toBe(false);
  });
});

describe('advisorImportRowSchema', () => {
  it('stores an empty contact field as null', () => {
    expect(advisorImportRowSchema.parse(advisor)).toEqual({
      clubCode: 'SMK01',
      fullName: 'ครูสมมติ ใจดี',
      phone: null,
      email: null,
      lineId: null,
    });
  });

  it.each(['081-234-5678', '0812345678', '02 123 4567', '+66 81 234 5678'])(
    'accepts phone %j',
    (phone) => {
      expect(advisorImportRowSchema.parse({ ...advisor, phone }).phone).toBe(phone);
    },
  );

  // A phone typed into a number cell loses its leading 0; storing it would give a wrong number.
  it.each([
    ['without its leading 0', '812345678'],
    ['with too few digits', '08123'],
    ['with too many digits', '0812345678901234'],
    ['with letters', '08-ABC-5678'],
  ])('refuses a phone %s', (_case, phone) => {
    expect(advisorImportRowSchema.safeParse({ ...advisor, phone }).success).toBe(false);
  });

  it('accepts an email and refuses text that is not one', () => {
    expect(advisorImportRowSchema.parse({ ...advisor, email: ' teacher@example.com ' }).email).toBe(
      'teacher@example.com',
    );
    expect(advisorImportRowSchema.safeParse({ ...advisor, email: 'not-an-email' }).success).toBe(
      false,
    );
  });

  it.each(['@fictional.teacher', 'fictional_teacher-1'])('accepts LINE ID %j', (lineId) => {
    expect(advisorImportRowSchema.parse({ ...advisor, lineId }).lineId).toBe(lineId);
  });

  it.each(['has space', 'ไลน์สมมติ', 'a@b'])('refuses LINE ID %j', (lineId) => {
    expect(advisorImportRowSchema.safeParse({ ...advisor, lineId }).success).toBe(false);
  });
});

describe('classroomSchema', () => {
  it('trims and refuses an empty or over-long classroom', () => {
    expect(classroomSchema.parse(' 4/1 ')).toBe('4/1');
    expect(classroomSchema.safeParse('').success).toBe(false);
    expect(classroomSchema.safeParse('x'.repeat(17)).success).toBe(false);
  });
});

describe('importCommitFieldsSchema', () => {
  const fields = {
    term: '2/2569',
    fileSha256: 'a'.repeat(64),
    idempotencyKey: 'fictional-key-0001',
  };

  it('accepts a lower-case SHA-256 and refuses any other form', () => {
    expect(importCommitFieldsSchema.safeParse(fields).success).toBe(true);
    for (const fileSha256 of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      expect(importCommitFieldsSchema.safeParse({ ...fields, fileSha256 }).success).toBe(false);
    }
  });

  it('refuses a field the commit does not define', () => {
    expect(importCommitFieldsSchema.safeParse({ ...fields, grade: 4 }).success).toBe(false);
  });
});
