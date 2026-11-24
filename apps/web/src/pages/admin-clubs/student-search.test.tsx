import type { RoundStudent } from '@club-registration/shared';
import { describe, expect, it } from 'vitest';
import { indexStudents, searchStudents, studentPlacement } from './student-search';

// Every name below is made up. Classrooms as the sample data stores them: the number alone, the
// grade apart (a grade 4 round here), plus one stored with the grade in it.
const person = (
  loginId: string,
  classroom: string,
  seatNo: number,
  fullName = 'นักเรียนสมมติ',
): RoundStudent => ({ loginId, fullName, classroom, seatNo, club: null, waitingFor: null });

const STUDENTS = [
  person('s4021', '2', 1, 'เด็กชายสมมติ ใจดี'),
  person('s4212', '2', 12),
  person('s4121', '21', 2),
  person('s4112', '1', 12),
  person('s4101', '10', 1, 'เด็กหญิงสมมติ ใจดี'),
  person('s4999', '4/3', 5, 'นักเรียนสมมติ ทำดี'),
];
const INDEX = indexStudents(STUDENTS, 4);

const found = (query: string) => searchStudents(INDEX, query)?.shown.map(({ loginId }) => loginId);

describe('searchStudents', () => {
  it('searches nothing for an empty or blank query', () => {
    expect(searchStudents(INDEX, '')).toBeUndefined();
    expect(searchStudents(INDEX, '   ')).toBeUndefined();
    expect(searchStudents(INDEX, 'ห้อง')).toBeUndefined();
  });

  it('matches a classroom exactly, with or without the grade in front', () => {
    // A lone "2" is also part of codes.
    expect(found('2')).toEqual(['s4021', 's4212', 's4121', 's4112']);
    expect(found('4/2')).toEqual(['s4021', 's4212']);
    expect(found('ม.4/2')).toEqual(['s4021', 's4212']);
    expect(found('4/3')).toEqual(['s4999']);
  });

  it('names one seat with a classroom then a number', () => {
    expect(found('4/2 12')).toEqual(['s4212']);
    expect(found('2 12')).toEqual(['s4212']);
    expect(found('ม.4/2 012')).toEqual(['s4212']);
    expect(found('ห้อง 4/2 เลขที่ 1')).toEqual(['s4021']);
    expect(found('4/21 2')).toEqual(['s4121']);
  });

  it('reads a lone number as part of a code, not as a seat number', () => {
    expect(found('12')).toEqual(['s4212', 's4121', 's4112']);
  });

  it('matches part of a name or code, ignoring case and spaces', () => {
    expect(found('ใจดี')).toEqual(['s4021', 's4101']);
    expect(found('เด็กชาย สมมติ')).toEqual(['s4021']);
    expect(found('S41')).toEqual(['s4121', 's4112', 's4101']);
  });

  it('treats the two ways of typing sara am as the same text', () => {
    // nikhahit + sara aa, as some keyboards type it.
    expect(found('ท\u0e4d\u0e32ดี')).toEqual(['s4999']);
  });

  it('matches a name and a classroom given together', () => {
    expect(found('ใจดี 10')).toEqual(['s4101']);
    expect(found('สมมติ 4/2')).toEqual(['s4021', 's4212']);
  });

  it('shows at most 8 and counts the rest', () => {
    const many = indexStudents(
      Array.from({ length: 11 }, (_, i) => person(`s5${String(i).padStart(3, '0')}`, '3', i + 1)),
      5,
    );

    const result = searchStudents(many, '5/3');

    expect(result?.shown).toHaveLength(8);
    expect(result?.total).toBe(11);
  });
});

describe('studentPlacement', () => {
  const HERE = { id: 1, clubCode: 'A100', name: 'ชุมนุมสมมติ หนึ่ง' };
  const THERE = { id: 2, clubCode: 'B200', name: 'ชุมนุมสมมติ สอง' };
  const base = person('s1', '1', 1);

  it.each([
    [null, null, 'ยังไม่มีชุมนุม'],
    [HERE, null, 'อยู่ชุมนุมนี้แล้ว'],
    [THERE, null, 'อยู่ชุมนุม B200 ชุมนุมสมมติ สอง'],
    [null, THERE, 'รอชุมนุม B200 ชุมนุมสมมติ สอง'],
    [null, HERE, 'รอชุมนุมนี้อยู่'],
    [THERE, HERE, 'อยู่ชุมนุม B200 ชุมนุมสมมติ สอง · รอชุมนุมนี้อยู่'],
  ])('says where a student with seat %o waiting for %o is', (club, waitingFor, expected) => {
    expect(studentPlacement({ ...base, club, waitingFor }, HERE.id)).toBe(expected);
  });
});
