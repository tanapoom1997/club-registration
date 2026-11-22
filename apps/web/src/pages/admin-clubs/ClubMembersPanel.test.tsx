import type {
  AdminClub,
  ClubMember,
  ClubSeats,
  ClubWaitlistEntry,
  Round,
  SessionUser,
} from '@club-registration/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';
import type { Handler } from '@/test-support/render-app';
import {
  UUID_PATTERN,
  apiError,
  bodyOf,
  callsTo,
  networkFailure,
} from '@/test-support/student-api';
import { CLUBS_POLL_INTERVAL_MS } from './club-ui';

// Every name below is made up.
const ADMIN: SessionUser = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

const roundFixture = (overrides: Partial<Round> = {}): Round => ({
  id: 1,
  term: '2569/1',
  grade: 1,
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  maxActive: 150,
  status: 'open',
  clubCount: 2,
  totalCapacity: 5,
  totalRegistered: 4,
  queueWaiting: 0,
  queueAdmitted: 0,
  ...overrides,
});

type Student = Omit<ClubMember, 'registeredAt' | 'source'>;

const student = (n: number, classroom: string, seatNo: number, fullName: string): Student => ({
  studentId: 100 + n,
  loginId: `demo100${n}`,
  fullName,
  classroom,
  seatNo,
});

const S1 = student(1, '1/1', 1, 'นักเรียนสมมติ หนึ่ง');
const S2 = student(2, '1/2', 3, 'นักเรียนสมมติ <i>สอง</i>');
const S3 = student(3, '1/1', 2, 'นักเรียนสมมติ สาม');
const S4 = student(4, '1/3', 5, 'นักเรียนสมมติ สี่');
const S5 = student(5, '1/4', 7, 'นักเรียนสมมติ ห้า');
const STUDENTS = [S1, S2, S3, S4, S5];

type ClubBase = Omit<AdminClub, 'registered' | 'remaining'>;
const CHESS: ClubBase = {
  id: 11,
  roundId: 1,
  clubCode: 'A100',
  name: 'ชุมนุมหมากรุกสมมติ',
  description: '',
  capacity: 3,
  advisors: [],
};
const MUSIC: ClubBase = {
  id: 12,
  roundId: 1,
  clubCode: 'B200',
  name: 'ชุมนุมดนตรีสมมติ',
  description: '',
  capacity: 2,
  advisors: [],
};

const SEATED_AT = '2026-12-01T01:05:00.000Z';
const JOINED_AT = '2026-12-01T02:30:00.000Z';

type Seat = { student: Student; source: ClubMember['source'] };
type ServerState = {
  round: Round;
  clubs: ClubBase[];
  seats: Map<number, Seat[]>;
  queues: Map<number, Student[]>;
};

const initialState = (round: Round): ServerState => ({
  round,
  clubs: [CHESS, MUSIC],
  seats: new Map([
    [
      CHESS.id,
      [
        { student: S1, source: 'student' },
        { student: S3, source: 'admin' },
      ],
    ],
    [
      MUSIC.id,
      [
        { student: S2, source: 'waitlist' },
        { student: S4, source: null },
      ],
    ],
  ]),
  queues: new Map([
    [CHESS.id, []],
    [MUSIC.id, [S1, S5]],
  ]),
});

const seatsOf = (state: ServerState, club: ClubBase): ClubSeats => {
  const registered = state.seats.get(club.id)?.length ?? 0;
  return {
    id: club.id,
    roundId: club.roundId,
    clubCode: club.clubCode,
    name: club.name,
    capacity: club.capacity,
    registered,
    remaining: club.capacity - registered,
  };
};

const membersOf = (state: ServerState, clubId: number): ClubMember[] =>
  (state.seats.get(clubId) ?? []).map(({ student: s, source }) => ({
    ...s,
    registeredAt: SEATED_AT,
    source,
  }));

const heldClubOf = (state: ServerState, loginId: string) => {
  const club = state.clubs.find(({ id }) =>
    state.seats.get(id)?.some(({ student: s }) => s.loginId === loginId),
  );
  return club ? { id: club.id, clubCode: club.clubCode, name: club.name } : null;
};

const entriesOf = (state: ServerState, clubId: number): ClubWaitlistEntry[] =>
  (state.queues.get(clubId) ?? []).map((s, index) => ({
    ...s,
    position: index + 1,
    joinedAt: JOINED_AT,
    heldClub: heldClubOf(state, s.loginId),
  }));

const membersPath = (clubId: number) => `/api/admin/clubs/${clubId}/members`;
const removePath = (clubId: number) => `/api/admin/clubs/${clubId}/members/remove`;
const waitlistPath = (clubId: number) => `/api/admin/clubs/${clubId}/waitlist`;
const unwaitPath = (clubId: number) => `/api/admin/clubs/${clubId}/waitlist/remove`;
const CLUBS_PATH = '/api/admin/rounds/1/clubs';

const loginIdIn = (init: RequestInit | undefined) => (bodyOf(init) as { loginId: string }).loginId;

// A small in-memory stand-in for the admin API, so the refetch after a write shows what it
// changed: the table's counts, the lists, and the other club a move left. `once` answers the next
// request to a route differently (a lost reply, a refusal), then the server is back to normal.
// Other rounds are listed with no clubs, for choosing another round.
const mockMembersApi = (round: Round = roundFixture(), otherRounds: Round[] = []) => {
  const state = initialState(round);
  const pending = new Map<string, Handler[]>();
  const routes: Record<string, Handler> = {
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    'GET /api/admin/rounds': () => Response.json({ rounds: [state.round, ...otherRounds] }),
    ...Object.fromEntries(
      otherRounds.map((other) => [
        `GET /api/admin/rounds/${other.id}/clubs`,
        () => Response.json({ round: other, clubs: [] }),
      ]),
    ),
    [`GET ${CLUBS_PATH}`]: () =>
      Response.json({
        round: state.round,
        clubs: state.clubs.map((club) => {
          const { registered, remaining } = seatsOf(state, club);
          return { ...club, registered, remaining };
        }),
      }),
  };
  for (const club of state.clubs) {
    routes[`GET ${membersPath(club.id)}`] = () =>
      Response.json({ club: seatsOf(state, club), members: membersOf(state, club.id) });
    routes[`GET ${waitlistPath(club.id)}`] = () =>
      Response.json({ club: seatsOf(state, club), entries: entriesOf(state, club.id) });
    routes[`POST ${membersPath(club.id)}`] = (init) => {
      const target = STUDENTS.find(({ loginId }) => loginId === loginIdIn(init));
      if (!target) return apiError(404, 'not_found')();
      const from = heldClubOf(state, target.loginId);
      if (from?.id !== club.id) {
        if (seatsOf(state, club).remaining === 0) return apiError(409, 'club_full')();
        if (from) {
          const left = state.seats.get(from.id) ?? [];
          state.seats.set(
            from.id,
            left.filter(({ student: s }) => s.loginId !== target.loginId),
          );
        }
        state.seats.set(club.id, [
          ...(state.seats.get(club.id) ?? []),
          { student: target, source: 'admin' },
        ]);
        const queue = state.queues.get(club.id) ?? [];
        state.queues.set(
          club.id,
          queue.filter(({ loginId }) => loginId !== target.loginId),
        );
      }
      const member = membersOf(state, club.id).find(({ loginId }) => loginId === target.loginId);
      return Response.json({ club: seatsOf(state, club), member });
    };
    routes[`POST ${removePath(club.id)}`] = (init) => {
      const loginId = loginIdIn(init);
      const seats = state.seats.get(club.id) ?? [];
      if (!seats.some(({ student: s }) => s.loginId === loginId)) {
        return apiError(409, 'not_registered')();
      }
      state.seats.set(
        club.id,
        seats.filter(({ student: s }) => s.loginId !== loginId),
      );
      return Response.json({ club: seatsOf(state, club), member: null });
    };
    routes[`POST ${unwaitPath(club.id)}`] = (init) => {
      const loginId = loginIdIn(init);
      const queue = state.queues.get(club.id) ?? [];
      if (!queue.some((s) => s.loginId === loginId)) return apiError(409, 'not_waitlisted')();
      state.queues.set(
        club.id,
        queue.filter((s) => s.loginId !== loginId),
      );
      return Response.json({ club: seatsOf(state, club), entries: entriesOf(state, club.id) });
    };
  }
  const fetchMock = mockApi(
    Object.fromEntries(
      Object.entries(routes).map(([key, handler]) => [
        key,
        (init: RequestInit | undefined) => {
          const next = pending.get(key)?.shift();
          return next ? next(init) : handler(init);
        },
      ]),
    ),
  );
  const once = (key: string, handler: Handler) =>
    pending.set(key, [...(pending.get(key) ?? []), handler]);
  return { fetchMock, state, once };
};

const keysOf = (calls: ReturnType<typeof callsTo>) =>
  calls.map(([, init]) => (bodyOf(init) as { idempotencyKey: string }).idempotencyKey);

const openTable = async () => await screen.findByRole('table', { name: 'รายการชุมนุม' });

const rowOf = (table: HTMLElement, text: string) =>
  within(table).getByText(text).closest('tr') as HTMLElement;

const clubCells = (clubCode: string) =>
  within(rowOf(screen.getByRole('table', { name: 'รายการชุมนุม' }), clubCode))
    .getAllByRole('cell')
    .map((cell) => cell.textContent)
    .slice(3, 6);

const panelOf = (club: ClubBase) =>
  screen.getByRole('region', { name: `รายชื่อชุมนุม ${club.clubCode} ${club.name}` });

const openMembers = async (club: ClubBase) => {
  await openTable();
  fireEvent.click(screen.getByRole('button', { name: `รายชื่อชุมนุม ${club.clubCode}` }));
  const panel = panelOf(club);
  await within(panel).findByRole('table', { name: `สมาชิกชุมนุม ${club.clubCode}` });
  await within(panel).findByText(/^รายชื่อรอ \(/);
  return panel;
};

const membersTable = (panel: HTMLElement, club: ClubBase) =>
  within(panel).getByRole('table', { name: `สมาชิกชุมนุม ${club.clubCode}` });

const waitlistTable = (panel: HTMLElement, club: ClubBase) =>
  within(panel).getByRole('table', { name: `รายชื่อรอชุมนุม ${club.clubCode}` });

const assign = (panel: HTMLElement, loginId: string) => {
  fireEvent.change(within(panel).getByLabelText('รหัสนักเรียน'), { target: { value: loginId } });
  fireEvent.click(within(panel).getByRole('button', { name: 'เพิ่มเข้าชุมนุม' }));
};

const notice = async (panel: HTMLElement) =>
  await waitFor(() => {
    const text = within(panel).getByRole('status').textContent;
    expect(text).not.toBe('');
    return text;
  });

const removeButton = (table: HTMLElement, s: Student) =>
  within(table).getByRole('button', { name: `นำออก ${s.loginId} ${s.fullName}` });

const startRemove = (table: HTMLElement, s: Student, what: 'ชุมนุม' | 'รายชื่อรอชุมนุม') => {
  fireEvent.click(removeButton(table, s));
  return screen.getByRole('alertdialog', {
    name: new RegExp(`^ยืนยันการนำ ${s.loginId} .* ออกจาก${what} `),
  });
};

describe('admin club members panel', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists the members and the waitlist with counts, seats and where each seat came from', async () => {
    mockMembersApi();
    renderAt('/admin/clubs');

    const panel = await openMembers(MUSIC);

    expect(within(panel).getByText('รับ 2 · ลงแล้ว 2 · เหลือ 0')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'สมาชิก (2 คน)' })).toBeTruthy();
    const members = membersTable(panel, MUSIC);
    const two = rowOf(members, S2.loginId);
    expect(
      within(two)
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
        .slice(0, 6),
    ).toEqual([
      '1/2',
      '3',
      'demo1002',
      S2.fullName,
      expect.stringContaining('2569'),
      'ได้จากรายชื่อรอ',
    ]);
    // An imported name is text, never markup.
    expect(two.querySelector('i')).toBeNull();
    expect(rowOf(members, S4.loginId).textContent).toContain('ไม่ทราบ');
    expect(within(panel).getByRole('heading', { name: 'รายชื่อรอ (2 คน)' })).toBeTruthy();
    const waiters = waitlistTable(panel, MUSIC);
    const cellsOf = (s: Student) =>
      within(rowOf(waiters, s.loginId))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
        .slice(0, 7);
    expect(cellsOf(S1)).toEqual([
      '1',
      '1/1',
      '1',
      'demo1001',
      S1.fullName,
      expect.stringContaining('2569'),
      'A100 ชุมนุมหมากรุกสมมติ',
    ]);
    expect(cellsOf(S5)[0]).toBe('2');
    expect(cellsOf(S5)[6]).toBe('—');
  });

  it('shows how the other seats were taken, and an empty waitlist', async () => {
    mockMembersApi();
    renderAt('/admin/clubs');

    const panel = await openMembers(CHESS);

    const members = membersTable(panel, CHESS);
    expect(rowOf(members, S1.loginId).textContent).toContain('ลงเอง');
    expect(rowOf(members, S3.loginId).textContent).toContain('ผู้ดูแลจัดให้');
    expect(within(panel).getByText('ไม่มีคนรอ')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'รายชื่อรอ (0 คน)' })).toBeTruthy();
  });

  it('says so when a club has no members yet', async () => {
    const api = mockMembersApi();
    api.state.seats.set(CHESS.id, []);
    renderAt('/admin/clubs');
    await openTable();

    fireEvent.click(screen.getByRole('button', { name: 'รายชื่อชุมนุม A100' }));

    expect(await within(panelOf(CHESS)).findByText('ยังไม่มีสมาชิก')).toBeTruthy();
  });

  it('opens either the members or the editor of one club, and closes both on another round', async () => {
    mockMembersApi(roundFixture(), [roundFixture({ id: 2, grade: 2, status: 'upcoming' })]);
    renderAt('/admin/clubs');
    await openMembers(CHESS);

    fireEvent.click(screen.getByRole('button', { name: 'แก้ไขชุมนุม A100' }));
    expect(screen.getByRole('form', { name: 'แก้ไขชุมนุม A100' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^รายชื่อชุมนุม/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'รายชื่อชุมนุม B200' }));
    expect(panelOf(MUSIC)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'แก้ไขชุมนุม A100' })).toBeNull();

    fireEvent.change(screen.getByLabelText('รอบลงทะเบียน'), { target: { value: '2' } });
    expect(await screen.findByText(/รอบนี้ยังไม่มีชุมนุม/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^รายชื่อชุมนุม/ })).toBeNull();
  });

  it('closes with its own button', async () => {
    mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    fireEvent.click(within(panel).getByRole('button', { name: 'ปิด' }));

    expect(screen.queryByRole('region', { name: /^รายชื่อชุมนุม/ })).toBeNull();
  });

  it('seats a student by login ID, normalised, and refreshes the lists and the table counts', async () => {
    const { fetchMock } = mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);
    expect(clubCells('A100')).toEqual(['3', '2', '1']);

    assign(panel, '  DEMO1005 ');

    expect(await notice(panel)).toBe(
      `บันทึกแล้ว: demo1005 ${S5.fullName} อยู่ในชุมนุม A100 ชุมนุมหมากรุกสมมติ`,
    );
    const [[, init]] = callsTo(fetchMock, 'POST', membersPath(CHESS.id)) as [[string, RequestInit]];
    expect(bodyOf(init)).toEqual({
      loginId: 'demo1005',
      idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
    });
    expect(await within(membersTable(panel, CHESS)).findByText('demo1005')).toBeTruthy();
    await waitFor(() => expect(clubCells('A100')).toEqual(['3', '3', 'เต็ม']));
    expect(within(panel).getByText('รับ 3 · ลงแล้ว 3 · เหลือ 0')).toBeTruthy();
  });

  it('moves a student from another club, and that club count drops too', async () => {
    mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);
    expect(clubCells('B200')).toEqual(['2', '2', 'เต็ม']);

    assign(panel, S4.loginId);

    expect(await notice(panel)).toBe(
      `บันทึกแล้ว: demo1004 ${S4.fullName} อยู่ในชุมนุม A100 ชุมนุมหมากรุกสมมติ`,
    );
    await waitFor(() => expect(clubCells('B200')).toEqual(['2', '1', '1']));
    expect(clubCells('A100')).toEqual(['3', '3', 'เต็ม']);
  });

  it('says the student is not in the club when a cascade carried them on to the club they waited for', async () => {
    const api = mockMembersApi();
    api.once(`POST ${membersPath(CHESS.id)}`, () =>
      Response.json({ club: seatsOf(api.state, CHESS), member: null }),
    );
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, S2.loginId);

    const text = await notice(panel);
    expect(text).toContain('ตอนนี้ demo1002 ไม่ได้อยู่ในชุมนุม A100 ชุมนุมหมากรุกสมมติ');
    expect(text).toContain('ย้ายนักเรียนต่อไปยังชุมนุมที่นักเรียนรออยู่');
    expect(text).not.toContain('อยู่ในชุมนุม A100 ชุมนุมหมากรุกสมมติ แล้ว');
  });

  it.each([
    ['club_full', 409, 'เพิ่มจำนวนรับก่อนด้วยปุ่ม "แก้ไข"'],
    ['not_found', 404, 'ไม่พบนักเรียนรหัสนี้หรือชุมนุมนี้'],
    ['student_not_in_round_grade', 409, 'ไม่ได้อยู่ชั้นของรอบนี้'],
    ['validation_error', 400, 'รหัสนักเรียนไม่ถูกต้อง'],
    ['idempotency_key_reused', 409, 'คำขอนี้ซ้ำกับคำขอก่อนหน้า'],
    ['rate_limited', 429, 'ส่งคำขอถี่เกินไป'],
    ['forbidden', 403, 'ไม่มีสิทธิ์แก้รายชื่อชุมนุม'],
    ['something_new', 409, 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'],
  ])('explains an assign refused with %s in Thai', async (code, status, message) => {
    const api = mockMembersApi();
    api.once(`POST ${membersPath(CHESS.id)}`, apiError(status, code));
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, S5.loginId);

    const form = within(panel).getByRole('form', { name: 'เพิ่มนักเรียนเข้าชุมนุม A100' });
    expect((await within(form).findByRole('alert')).textContent).toContain(message);
  });

  it('does not send a login ID that cannot exist', async () => {
    const { fetchMock } = mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, 'demo 1005!');

    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'กรุณากรอกรหัสนักเรียนให้ถูกต้อง',
    );
    expect(callsTo(fetchMock, 'POST', membersPath(CHESS.id))).toHaveLength(0);
  });

  it('resends an assign whose reply was lost with the same key, so the server replays it', async () => {
    const api = mockMembersApi();
    api.once(`POST ${membersPath(CHESS.id)}`, networkFailure);
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, S5.loginId);
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'ยังไม่รู้ว่าบันทึกสำเร็จหรือไม่',
    );
    assign(panel, S5.loginId);

    await notice(panel);
    const keys = keysOf(callsTo(api.fetchMock, 'POST', membersPath(CHESS.id)));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('uses a new key once the login ID is corrected after a lost reply', async () => {
    const api = mockMembersApi();
    api.once(`POST ${membersPath(CHESS.id)}`, networkFailure);
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, 'demo1006');
    await within(panel).findByRole('alert');
    assign(panel, S5.loginId);

    await notice(panel);
    const calls = callsTo(api.fetchMock, 'POST', membersPath(CHESS.id));
    expect(calls.map(([, init]) => loginIdIn(init))).toEqual(['demo1006', 'demo1005']);
    const [first, second] = keysOf(calls);
    expect(second).not.toBe(first);
  });

  it('uses a new key for the next write after an answer', async () => {
    const api = mockMembersApi();
    api.once(`POST ${membersPath(CHESS.id)}`, apiError(409, 'club_full'));
    renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, S5.loginId);
    await within(panel).findByRole('alert');
    assign(panel, S5.loginId);

    await notice(panel);
    const [first, second] = keysOf(callsTo(api.fetchMock, 'POST', membersPath(CHESS.id)));
    expect(second).not.toBe(first);
  });

  it('removes a member after a confirmation that says the next waiter gets the seat', async () => {
    const { fetchMock } = mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(membersTable(panel, MUSIC), S4, 'ชุมนุม');
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain('คนที่รอลำดับแรกจะได้ที่แทนอัตโนมัติ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากชุมนุม' }));

    expect(await notice(panel)).toBe('นำ demo1004 ออกจากชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว');
    expect(document.activeElement).toBe(within(panel).getByRole('status').firstElementChild);
    expect(within(membersTable(panel, MUSIC)).queryByText(S4.loginId)).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const [[, init]] = callsTo(fetchMock, 'POST', removePath(MUSIC.id)) as [[string, RequestInit]];
    expect(bodyOf(init)).toEqual({
      loginId: 'demo1004',
      idempotencyKey: expect.stringMatching(UUID_PATTERN) as unknown,
    });
    await waitFor(() => expect(clubCells('B200')).toEqual(['2', '1', '1']));
  });

  it('says the seat stays empty when removing in a closed round, and still allows every write', async () => {
    mockMembersApi(roundFixture({ status: 'closed' }));
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    expect(within(panel).getByText(/รอบนี้ปิดแล้ว ยังแก้รายชื่อได้/)).toBeTruthy();
    expect(
      within(panel).getByRole<HTMLButtonElement>('button', { name: 'เพิ่มเข้าชุมนุม' }).disabled,
    ).toBe(false);
    const dialog = startRemove(membersTable(panel, MUSIC), S2, 'ชุมนุม');
    expect(dialog.textContent).toContain('จึงไม่มีใครได้ที่จากรายชื่อรอ');
    expect(dialog.textContent).not.toContain('จะได้ที่แทนอัตโนมัติ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากชุมนุม' }));

    expect(await notice(panel)).toBe('นำ demo1002 ออกจากชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว');
  });

  it('tells of promotion in a round that has not opened yet, which still promotes', async () => {
    mockMembersApi(roundFixture({ status: 'upcoming' }));
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(membersTable(panel, MUSIC), S2, 'ชุมนุม');

    expect(dialog.textContent).toContain('คนที่รอลำดับแรกจะได้ที่แทนอัตโนมัติ');
  });

  it('closes a confirmation with Escape or its dismiss button and returns focus to the button', async () => {
    const { fetchMock } = mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(membersTable(panel, MUSIC), S4, 'ชุมนุม');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(removeButton(membersTable(panel, MUSIC), S4));

    const again = startRemove(waitlistTable(panel, MUSIC), S5, 'รายชื่อรอชุมนุม');
    fireEvent.click(within(again).getByRole('button', { name: 'ไม่นำออก' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(removeButton(waitlistTable(panel, MUSIC), S5));
    expect(callsTo(fetchMock, 'POST', removePath(MUSIC.id))).toHaveLength(0);
  });

  it('keeps the refusal on screen when the refetch removed the row', async () => {
    const api = mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);
    // Another admin removes the student while this confirmation is open.
    api.state.seats.set(MUSIC.id, [{ student: S2, source: 'waitlist' }]);

    const dialog = startRemove(membersTable(panel, MUSIC), S4, 'ชุมนุม');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากชุมนุม' }));

    await waitFor(() =>
      expect(within(membersTable(panel, MUSIC)).queryByText(S4.loginId)).toBeNull(),
    );
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'นักเรียนคนนี้ไม่ได้อยู่ในชุมนุมนี้แล้ว',
    );
  });

  it('retries a removal whose reply was lost with the same key', async () => {
    const api = mockMembersApi();
    api.once(`POST ${removePath(MUSIC.id)}`, networkFailure);
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(membersTable(panel, MUSIC), S4, 'ชุมนุม');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากชุมนุม' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'ยังไม่รู้ว่านำออกสำเร็จหรือไม่',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'ลองอีกครั้ง' }));

    await notice(panel);
    const [first, second] = keysOf(callsTo(api.fetchMock, 'POST', removePath(MUSIC.id)));
    expect(second).toBe(first);
  });

  it.each([
    {
      list: 'club',
      tableOf: membersTable,
      student: S4,
      place: 'ชุมนุม',
      confirm: 'ยืนยัน นำออกจากชุมนุม',
    },
    {
      list: 'waitlist',
      tableOf: waitlistTable,
      student: S1,
      place: 'รายชื่อรอชุมนุม',
      confirm: 'ยืนยัน นำออกจากรายชื่อรอ',
    },
  ] as const)(
    'shows the removal from the $list in the destructive style',
    async ({ tableOf, student, place, confirm }) => {
      mockMembersApi();
      renderAt('/admin/clubs');
      const panel = await openMembers(MUSIC);

      const dialog = startRemove(tableOf(panel, MUSIC), student, place);

      expect(within(dialog).getByRole('button', { name: confirm }).dataset.variant).toBe(
        'destructive',
      );
    },
  );

  it('removes a waiter, never promoting anyone, and shows the queue that moved up', async () => {
    const { fetchMock } = mockMembersApi();
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(waitlistTable(panel, MUSIC), S1, 'รายชื่อรอชุมนุม');
    expect(dialog.textContent).toContain('ไม่ทำให้ใครได้ที่');
    expect(dialog.textContent).toContain('คนที่รอข้างหลังเลื่อนขึ้นหนึ่งลำดับ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากรายชื่อรอ' }));

    expect(await notice(panel)).toBe('นำ demo1001 ออกจากรายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ แล้ว');
    expect(document.activeElement).toBe(within(panel).getByRole('status').firstElementChild);
    const waiters = waitlistTable(panel, MUSIC);
    expect(within(waiters).queryByText(S1.loginId)).toBeNull();
    expect(within(rowOf(waiters, S5.loginId)).getAllByRole('cell')[0]?.textContent).toBe('1');
    expect(within(panel).getByRole('heading', { name: 'รายชื่อรอ (1 คน)' })).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', unwaitPath(MUSIC.id))).toHaveLength(1);
    expect(clubCells('B200')).toEqual(['2', '2', 'เต็ม']);
  });

  it.each([
    ['a member', 'removeMember', 'not_registered', 'ไม่ได้อยู่ในชุมนุมนี้แล้ว'],
    ['a waiter', 'removeWaiter', 'not_waitlisted', 'ไม่ได้อยู่ในรายชื่อรอของชุมนุมนี้แล้ว'],
    ['a member', 'removeMember', 'rate_limited', 'ส่งคำขอถี่เกินไป'],
    ['a waiter', 'removeWaiter', 'something_new', 'นำออกจากรายชื่อรอไม่สำเร็จ'],
    ['a member', 'removeMember', 'something_new', 'นำออกจากชุมนุมไม่สำเร็จ'],
  ] as const)('explains removing %s refused with %s', async (_, kind, code, message) => {
    const api = mockMembersApi();
    const path = kind === 'removeMember' ? removePath(MUSIC.id) : unwaitPath(MUSIC.id);
    api.once(`POST ${path}`, apiError(409, code));
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog =
      kind === 'removeMember'
        ? startRemove(membersTable(panel, MUSIC), S2, 'ชุมนุม')
        : startRemove(waitlistTable(panel, MUSIC), S5, 'รายชื่อรอชุมนุม');
    fireEvent.click(within(dialog).getAllByRole('button')[0]!);

    expect((await within(dialog).findByRole('alert')).textContent).toContain(message);
  });

  it('says a waiter is still queued when a replayed key answers with them back in the queue', async () => {
    const api = mockMembersApi();
    api.once(`POST ${unwaitPath(MUSIC.id)}`, () =>
      Response.json({ club: seatsOf(api.state, MUSIC), entries: entriesOf(api.state, MUSIC.id) }),
    );
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(waitlistTable(panel, MUSIC), S5, 'รายชื่อรอชุมนุม');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากรายชื่อรอ' }));

    expect(await notice(panel)).toBe(
      'demo1005 ยังอยู่ในรายชื่อรอชุมนุม B200 ชุมนุมดนตรีสมมติ (ลำดับที่ 2) ดูรายชื่อล่าสุด',
    );
  });

  it('says a member is still seated when a replayed key answers with them in the club', async () => {
    const api = mockMembersApi();
    api.once(`POST ${removePath(MUSIC.id)}`, () =>
      Response.json({
        club: seatsOf(api.state, MUSIC),
        member: membersOf(api.state, MUSIC.id)[0],
      }),
    );
    renderAt('/admin/clubs');
    const panel = await openMembers(MUSIC);

    const dialog = startRemove(membersTable(panel, MUSIC), S2, 'ชุมนุม');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ยืนยัน นำออกจากชุมนุม' }));

    expect(await notice(panel)).toContain('demo1002 ยังอยู่ในชุมนุม B200');
    expect(within(membersTable(panel, MUSIC)).getByText(S2.loginId)).toBeTruthy();
  });

  it('sends the admin to log in again when the session expired', async () => {
    const api = mockMembersApi();
    api.once(`POST ${membersPath(CHESS.id)}`, apiError(401, 'unauthorized'));
    const router = renderAt('/admin/clubs');
    const panel = await openMembers(CHESS);

    assign(panel, S5.loginId);

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('offers to load the lists again when they fail to load', async () => {
    const api = mockMembersApi();
    api.once(`GET ${membersPath(CHESS.id)}`, apiError(500, 'internal_error'));
    api.once(`GET ${waitlistPath(CHESS.id)}`, apiError(500, 'internal_error'));
    renderAt('/admin/clubs');
    await openTable();
    fireEvent.click(screen.getByRole('button', { name: 'รายชื่อชุมนุม A100' }));
    const panel = panelOf(CHESS);

    expect(await within(panel).findByText('โหลดรายชื่อสมาชิกไม่สำเร็จ')).toBeTruthy();
    expect(await within(panel).findByText('โหลดรายชื่อรอไม่สำเร็จ')).toBeTruthy();
    for (const button of within(panel).getAllByRole('button', { name: 'ลองใหม่' })) {
      fireEvent.click(button);
    }

    expect(await within(panel).findByRole('table', { name: 'สมาชิกชุมนุม A100' })).toBeTruthy();
    expect(await within(panel).findByText('ไม่มีคนรอ')).toBeTruthy();
  });

  it('keeps both lists fresh while the round is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = mockMembersApi();
    renderAt('/admin/clubs');
    await openMembers(CHESS);
    expect(callsTo(fetchMock, 'GET', membersPath(CHESS.id))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLUBS_POLL_INTERVAL_MS);
    });

    await waitFor(() => expect(callsTo(fetchMock, 'GET', membersPath(CHESS.id))).toHaveLength(2));
    expect(callsTo(fetchMock, 'GET', waitlistPath(CHESS.id))).toHaveLength(2);
  });

  it('does not poll the lists of a closed round', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchMock } = mockMembersApi(roundFixture({ status: 'closed' }));
    renderAt('/admin/clubs');
    await openMembers(CHESS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(callsTo(fetchMock, 'GET', membersPath(CHESS.id))).toHaveLength(1);
    expect(callsTo(fetchMock, 'GET', waitlistPath(CHESS.id))).toHaveLength(1);
  });
});
