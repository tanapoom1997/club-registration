import { IMPORT_COLUMNS, IMPORT_SHEETS } from '@club-registration/shared';
import type {
  AdvisorImportRow,
  ClubImportRow,
  ImportError,
  ImportPreviewResponse,
  StudentImportRow,
} from '@club-registration/shared';
import type { Queryable } from '../db.js';
import type { Located, ParsedImport } from '../import/parse.js';

type StudentRow = Located<StudentImportRow>;
type ClubRow = Located<ClubImportRow>;
type AdvisorRow = Located<AdvisorImportRow>;

// What a commit would write. Built from the DB as it is now, so the commit step must rebuild it
// inside its own transaction rather than trust one from an earlier preview.
export type ImportPlan = {
  students: {
    create: StudentRow[];
    update: (StudentRow & { userId: number })[];
    unchanged: number;
  };
  clubs: {
    create: (ClubRow & { roundId: number })[];
    update: (ClubRow & { roundId: number; clubId: number })[];
    unchanged: number;
  };
  // One entry per club (round + code) whose whole advisor list is replaced; a club created by
  // this import has no id yet, so it is identified by round and code. Clubs that already have
  // exactly the file's list are only counted, so a re-import rewrites nothing.
  advisors: {
    replace: { roundId: number; clubCode: string; advisors: AdvisorRow[] }[];
    unchanged: number;
    rows: number;
  };
  errors: ImportError[];
};

type ExistingUserRow = {
  id: number;
  login_id: string;
  role: string;
  full_name: string;
  grade: number | null;
  classroom: string | null;
  seat_no: number | null;
};

type ExistingUser = {
  id: number;
  role: string;
  fullName: string;
  profile: { grade: number; classroom: string; seatNo: number } | null;
};

type RoundRow = { id: number; grade: number };

type ExistingClubRow = {
  id: number;
  round_id: number;
  club_code: string;
  name: string;
  description: string;
  capacity: number;
  registered: number;
};

type ExistingClub = {
  id: number;
  roundId: number;
  clubCode: string;
  name: string;
  description: string;
  capacity: number;
  registered: number;
};

const toExistingUser = (row: ExistingUserRow): ExistingUser => ({
  id: row.id,
  role: row.role,
  fullName: row.full_name,
  profile:
    row.grade === null || row.classroom === null || row.seat_no === null
      ? null
      : { grade: row.grade, classroom: row.classroom, seatNo: row.seat_no },
});

const toExistingClub = (row: ExistingClubRow): ExistingClub => ({
  id: row.id,
  roundId: row.round_id,
  clubCode: row.club_code,
  name: row.name,
  description: row.description,
  capacity: row.capacity,
  registered: row.registered,
});

const findUsers = async (db: Queryable, loginIds: readonly string[]) => {
  const { rows } = await db.query<ExistingUserRow>(
    `SELECT u.id, u.login_id, u.role, u.full_name, sp.grade, sp.classroom, sp.seat_no
     FROM users u
     LEFT JOIN student_profiles sp ON sp.user_id = u.id
     WHERE u.login_id = ANY($1::text[])`,
    [loginIds],
  );
  return new Map(rows.map((row) => [row.login_id, toExistingUser(row)]));
};

type HeldSeat = { grade: number; term: string };

// Seats that stop a student from changing grade: every registration in a round of this term, and
// every registration in a round of another term that has not closed yet by the DB clock (open or
// upcoming). A seat in a closed round of another term is history (students move up a grade each
// year), not a reason to refuse. Per student, this term's seats come first, then the rest by
// closing time, so the error names the most relevant one.
//
// The commit holds the round lock of every round this can return (lockRoundsForImport took them
// by an earlier statement_timestamp(), and FOR SHARE keeps every window still), so no seat that
// matters can land between this read and the grade update. The preview reads the same from its
// snapshot without any lock.
const findHeldSeats = async (db: Queryable, term: string, studentIds: readonly number[]) => {
  const { rows } = await db.query<{ student_id: number; grade: number; term: string }>(
    `SELECT r.student_id, ro.grade, ro.term
     FROM registrations r
     JOIN rounds ro ON ro.id = r.round_id
     WHERE r.student_id = ANY($2::int[])
       AND (ro.term = $1 OR ro.closes_at > statement_timestamp())
     ORDER BY ro.term = $1 DESC, ro.closes_at, ro.id`,
    [term, studentIds],
  );
  return rows.reduce((seats, { student_id: studentId, grade, term: seatTerm }) => {
    seats.set(studentId, [...(seats.get(studentId) ?? []), { grade, term: seatTerm }]);
    return seats;
  }, new Map<number, HeldSeat[]>());
};

const findRounds = async (db: Queryable, term: string) => {
  const { rows } = await db.query<RoundRow>('SELECT id, grade FROM rounds WHERE term = $1', [term]);
  return new Map(rows.map(({ id, grade }) => [grade, id]));
};

const findClubs = async (db: Queryable, term: string) => {
  const { rows } = await db.query<ExistingClubRow>(
    `SELECT c.id, c.round_id, c.club_code, c.name, c.description, c.capacity, c.registered
     FROM clubs c
     JOIN rounds ro ON ro.id = c.round_id
     WHERE ro.term = $1`,
    [term],
  );
  return rows.map(toExistingClub);
};

type StoredAdvisor = Pick<AdvisorImportRow, 'fullName' | 'phone' | 'email' | 'lineId'>;

type StoredAdvisorRow = {
  round_id: number;
  club_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  line_id: string | null;
};

const clubKey = (roundId: number, clubCode: string) => `${roundId}|${clubCode}`;

// Advisor lists of the term's clubs, in insertion order (the order the import wrote them).
const findAdvisors = async (db: Queryable, term: string) => {
  const { rows } = await db.query<StoredAdvisorRow>(
    `SELECT c.round_id, c.club_code, a.full_name, a.phone, a.email, a.line_id
     FROM club_advisors a
     JOIN clubs c ON c.id = a.club_id
     JOIN rounds ro ON ro.id = c.round_id
     WHERE ro.term = $1
     ORDER BY a.id`,
    [term],
  );
  return rows.reduce((byClub, row) => {
    const key = clubKey(row.round_id, row.club_code);
    const advisor: StoredAdvisor = {
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      lineId: row.line_id,
    };
    byClub.set(key, [...(byClub.get(key) ?? []), advisor]);
    return byClub;
  }, new Map<string, StoredAdvisor[]>());
};

const sameAdvisors = (stored: readonly StoredAdvisor[], file: readonly AdvisorRow[]): boolean =>
  stored.length === file.length &&
  stored.every((advisor, index) => {
    const row = file[index];
    return (
      row !== undefined &&
      advisor.fullName === row.fullName &&
      advisor.phone === row.phone &&
      advisor.email === row.email &&
      advisor.lineId === row.lineId
    );
  });

const studentChanged = (row: StudentRow, user: ExistingUser): boolean =>
  user.fullName !== row.fullName ||
  user.profile?.grade !== row.grade ||
  user.profile.classroom !== row.classroom ||
  user.profile.seatNo !== row.seatNo;

const clubChanged = (row: ClubRow, club: ExistingClub): boolean =>
  club.name !== row.name || club.capacity !== row.capacity || club.description !== row.description;

const planStudents = async (db: Queryable, term: string, rows: readonly StudentRow[]) => {
  const users = await findUsers(
    db,
    rows.map(({ loginId }) => loginId),
  );
  const heldSeats = await findHeldSeats(
    db,
    term,
    [...users.values()].map(({ id }) => id),
  );
  const column = IMPORT_COLUMNS.students;
  const plan: ImportPlan['students'] = { create: [], update: [], unchanged: 0 };
  const errors: ImportError[] = [];

  for (const row of rows) {
    const user = users.get(row.loginId);
    if (!user) {
      plan.create.push(row);
      continue;
    }
    if (user.role !== 'student') {
      errors.push({
        sheet: 'students',
        row: row.row,
        column: column.loginId,
        message: `รหัส ${row.loginId} เป็นบัญชีที่ไม่ใช่นักเรียน`,
      });
      continue;
    }
    // Moving a student out of the grade they hold a seat in would leave a registration in a round
    // they no longer belong to; in a round still to close, one they could no longer see or cancel.
    const currentGrade = user.profile?.grade;
    const seat =
      currentGrade === undefined || currentGrade === row.grade
        ? undefined
        : heldSeats.get(user.id)?.find(({ grade }) => grade === currentGrade);
    if (seat) {
      errors.push({
        sheet: 'students',
        row: row.row,
        column: column.grade,
        message:
          seat.term === term
            ? `นักเรียนลงทะเบียนชุมนุมของ ม.${seat.grade} ในภาคเรียน ${term} แล้ว จึงเปลี่ยนชั้นไม่ได้`
            : `นักเรียนมีชุมนุมในรอบ ม.${seat.grade} ของภาคเรียน ${seat.term} ที่ยังไม่ปิด จึงเปลี่ยนชั้นไม่ได้ ให้ปิดรอบนั้นก่อนแล้วนำเข้าใหม่`,
      });
      continue;
    }
    if (studentChanged(row, user)) {
      plan.update.push({ ...row, userId: user.id });
    } else {
      plan.unchanged += 1;
    }
  }
  return { plan, errors };
};

const planClubs = (
  term: string,
  rows: readonly ClubRow[],
  roundsByGrade: ReadonlyMap<number, number>,
  existingByKey: ReadonlyMap<string, ExistingClub>,
) => {
  const column = IMPORT_COLUMNS.clubs;
  const plan: ImportPlan['clubs'] = { create: [], update: [], unchanged: 0 };
  const errors: ImportError[] = [];

  for (const row of rows) {
    const roundId = roundsByGrade.get(row.grade);
    if (roundId === undefined) {
      errors.push({
        sheet: 'clubs',
        row: row.row,
        column: column.grade,
        message: `ยังไม่มีรอบลงทะเบียนของภาคเรียน ${term} ชั้น ม.${row.grade} ให้สร้างรอบก่อน`,
      });
      continue;
    }
    const existing = existingByKey.get(clubKey(roundId, row.clubCode));
    if (!existing) {
      plan.create.push({ ...row, roundId });
      continue;
    }
    // The DB CHECK would refuse this on commit too; catching it here names the row.
    if (row.capacity < existing.registered) {
      errors.push({
        sheet: 'clubs',
        row: row.row,
        column: column.capacity,
        message: `จำนวนรับน้อยกว่าจำนวนที่ลงทะเบียนแล้ว (${existing.registered} คน)`,
      });
      continue;
    }
    if (clubChanged(row, existing)) {
      plan.update.push({ ...row, roundId, clubId: existing.id });
    } else {
      plan.unchanged += 1;
    }
  }
  return { plan, errors };
};

// An advisor row names a club code, not a round: it applies to that code in every round of the
// term where the code exists, whether the club is already stored or arrives in this file.
const planAdvisors = (
  term: string,
  rows: readonly AdvisorRow[],
  clubCodesInFile: ReadonlySet<string>,
  fileClubs: readonly { roundId: number; clubCode: string }[],
  existingClubs: readonly ExistingClub[],
  storedAdvisors: ReadonlyMap<string, readonly StoredAdvisor[]>,
) => {
  const roundsByCode = [...fileClubs, ...existingClubs].reduce((byCode, { roundId, clubCode }) => {
    byCode.set(clubCode, new Set([...(byCode.get(clubCode) ?? []), roundId]));
    return byCode;
  }, new Map<string, Set<number>>());
  const knownCodes = new Set([...clubCodesInFile, ...roundsByCode.keys()]);

  const errors: ImportError[] = rows
    .filter(({ clubCode }) => !knownCodes.has(clubCode))
    .map(({ row, clubCode }) => ({
      sheet: 'advisors',
      row,
      column: IMPORT_COLUMNS.advisors.clubCode,
      message: `ไม่พบชุมนุมรหัส ${clubCode} ทั้งในไฟล์และในภาคเรียน ${term}`,
    }));
  const accepted = rows.filter(({ clubCode }) => knownCodes.has(clubCode));
  const advisorsByCode = accepted.reduce((byCode, row) => {
    byCode.set(row.clubCode, [...(byCode.get(row.clubCode) ?? []), row]);
    return byCode;
  }, new Map<string, AdvisorRow[]>());

  const targets = [...advisorsByCode].flatMap(([clubCode, advisors]) =>
    [...(roundsByCode.get(clubCode) ?? [])]
      .sort((a, b) => a - b)
      .map((roundId) => ({ roundId, clubCode, advisors })),
  );
  const replace = targets.filter(
    ({ roundId, clubCode, advisors }) =>
      !sameAdvisors(storedAdvisors.get(clubKey(roundId, clubCode)) ?? [], advisors),
  );
  return {
    plan: { replace, unchanged: targets.length - replace.length, rows: accepted.length },
    errors,
  };
};

// Compares the parsed file with the DB and lists what a commit would change. Reads only, and
// takes a Queryable so the commit step can run it inside the transaction that writes.
export const planImport = async (
  db: Queryable,
  term: string,
  parsed: ParsedImport,
): Promise<ImportPlan> => {
  const students = await planStudents(db, term, parsed.students ?? []);
  const roundsByGrade = await findRounds(db, term);
  const existingClubs = await findClubs(db, term);
  const existingByKey = new Map(
    existingClubs.map((club) => [clubKey(club.roundId, club.clubCode), club]),
  );
  const clubs = planClubs(term, parsed.clubs ?? [], roundsByGrade, existingByKey);
  const fileClubs = (parsed.clubs ?? []).flatMap(({ grade, clubCode }) => {
    const roundId = roundsByGrade.get(grade);
    return roundId === undefined ? [] : [{ roundId, clubCode }];
  });
  // Read only when the file has advisor rows: comparing is what lets a re-import report them
  // unchanged.
  const storedAdvisors =
    (parsed.advisors?.length ?? 0) > 0
      ? await findAdvisors(db, term)
      : new Map<string, StoredAdvisor[]>();
  const advisors = planAdvisors(
    term,
    parsed.advisors ?? [],
    parsed.clubCodesInFile,
    fileClubs,
    existingClubs,
    storedAdvisors,
  );

  return {
    students: students.plan,
    clubs: clubs.plan,
    advisors: advisors.plan,
    errors: sortErrors([...parsed.errors, ...students.errors, ...clubs.errors, ...advisors.errors]),
  };
};

const SHEET_ORDER = new Map(IMPORT_SHEETS.map((sheet, index) => [sheet, index]));
const COLUMN_ORDER = new Map(
  IMPORT_SHEETS.flatMap((sheet) =>
    Object.values(IMPORT_COLUMNS[sheet]).map((label, index): [string, number] => [
      `${sheet}|${label}`,
      index,
    ]),
  ),
);

// Errors without a sheet, row or column (whole-file problems) come first.
export const sortErrors = (errors: readonly ImportError[]): ImportError[] =>
  errors.toSorted(
    (a, b) =>
      (a.sheet === null ? -1 : (SHEET_ORDER.get(a.sheet) ?? 0)) -
        (b.sheet === null ? -1 : (SHEET_ORDER.get(b.sheet) ?? 0)) ||
      (a.row ?? 0) - (b.row ?? 0) ||
      (COLUMN_ORDER.get(`${a.sheet}|${a.column}`) ?? -1) -
        (COLUMN_ORDER.get(`${b.sheet}|${b.column}`) ?? -1),
  );

export const summarizeImportPlan = (
  plan: ImportPlan,
  { fileSha256, term, maxErrors }: { fileSha256: string; term: string; maxErrors: number },
): ImportPreviewResponse => ({
  fileSha256,
  term,
  students: {
    create: plan.students.create.length,
    update: plan.students.update.length,
    unchanged: plan.students.unchanged,
  },
  clubs: {
    create: plan.clubs.create.length,
    update: plan.clubs.update.length,
    unchanged: plan.clubs.unchanged,
  },
  advisors: {
    clubsReplaced: plan.advisors.replace.length,
    clubsUnchanged: plan.advisors.unchanged,
    rows: plan.advisors.rows,
  },
  errors: plan.errors.slice(0, maxErrors),
  errorCount: plan.errors.length,
});
