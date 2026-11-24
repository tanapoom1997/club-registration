import { EVENT_TYPES } from '@club-registration/shared';
import type {
  AdminClub,
  ClubRef,
  EventActor,
  EventStudent,
  RegistrationEvent,
  Round,
  SessionUser,
} from '@club-registration/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '@/test-support/render-app';
import { PHONE_QUERY } from '@/lib/media-query';
import { formatThaiDateTime } from '@/lib/thai-time';
import { EVENT_TYPE_LABELS } from './event-ui';

// Every name, code and club below is made up.
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
  totalCapacity: 50,
  totalRegistered: 18,
  queueWaiting: 0,
  queueAdmitted: 0,
  studentCount: 0,
  studentsWithoutClub: 0,
  ...overrides,
});
const ROUND_1 = roundFixture();
const ROUND_2 = roundFixture({ id: 2, grade: 2, status: 'closed' });

const CLUB_A: ClubRef = { id: 11, clubCode: 'A100', name: 'ชุมนุมหมากรุกสมมติ' };
const CLUB_B: ClubRef = { id: 12, clubCode: 'B200', name: 'ชุมนุมดนตรีสมมติ' };
const CLUB_C: ClubRef = { id: 21, clubCode: 'C300', name: 'ชุมนุมวาดภาพสมมติ' };

const adminClub = (club: ClubRef, roundId: number): AdminClub => ({
  ...club,
  roundId,
  description: '',
  capacity: 10,
  registered: 1,
  remaining: 9,
  advisors: [],
});
const ROUND_CLUBS: Readonly<Record<number, AdminClub[]>> = {
  1: [adminClub(CLUB_A, 1), adminClub(CLUB_B, 1)],
  2: [adminClub(CLUB_C, 2)],
};

const S1: EventStudent = {
  id: 101,
  loginId: 'demo1001',
  fullName: 'นักเรียนสมมติ หนึ่ง',
  classroom: '1/1',
  seatNo: 1,
};
// Markup in a name must come out as text.
const S2: EventStudent = {
  id: 102,
  loginId: 'demo1002',
  fullName: 'นักเรียนสมมติ <i>สอง</i>',
  classroom: '1/2',
  seatNo: 5,
};
const S3: EventStudent = {
  id: 201,
  loginId: 'demo2001',
  fullName: 'นักเรียนสมมติ สาม',
  classroom: '2/1',
  seatNo: 3,
};
const asActor = ({ id, loginId, fullName }: EventStudent): EventActor => ({
  id,
  loginId,
  fullName,
  role: 'student',
});
const ADMIN_ACTOR: EventActor = {
  id: 9,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
};

const event = (
  id: number,
  eventType: RegistrationEvent['eventType'],
  student: EventStudent,
  club: ClubRef | null,
  actor: EventActor,
  fromClub: ClubRef | null = null,
): RegistrationEvent => {
  const round = club?.id === CLUB_C.id || student.id === S3.id ? ROUND_2 : ROUND_1;
  return {
    id,
    createdAt: `2026-12-01T01:${String(10 + id).padStart(2, '0')}:00.000Z`,
    eventType,
    round: { id: round.id, term: round.term, grade: round.grade },
    student,
    club,
    fromClub,
    actor,
  };
};

// Newest first, as the API answers. Every event type, a promotion whose actor is the student who
// freed the seat, an admin's removal from a waitlist and a join that gave up another queue.
const LOG: readonly RegistrationEvent[] = [
  event(10, 'waitlist_promote', S2, CLUB_A, asActor(S1), CLUB_B),
  event(9, 'cancel', S1, CLUB_A, asActor(S1)),
  event(8, 'waitlist_join', S2, CLUB_A, asActor(S2), CLUB_B),
  event(7, 'admin_remove', S3, CLUB_C, ADMIN_ACTOR),
  event(6, 'admin_assign', S3, CLUB_C, ADMIN_ACTOR),
  event(5, 'waitlist_leave', S1, CLUB_B, ADMIN_ACTOR),
  event(4, 'waitlist_join', S1, CLUB_B, asActor(S1)),
  event(3, 'change', S1, CLUB_A, asActor(S1), CLUB_B),
  event(2, 'register', S2, CLUB_B, asActor(S2)),
  event(1, 'register', S1, CLUB_B, asActor(S1)),
];

const EVENTS_PATH = '/api/admin/events';

type EventsAnswer = (params: URLSearchParams) => Response | Promise<Response>;

// The API's filters and keyset paging over LOG, in memory.
const pagedLog =
  (pageSize = 50, log: readonly RegistrationEvent[] = LOG): EventsAnswer =>
  (params) => {
    const number = (name: string) => (params.has(name) ? Number(params.get(name)) : undefined);
    const [roundId, clubId, before] = [number('roundId'), number('clubId'), number('before')];
    const loginId = params.get('loginId');
    const matching = log.filter(
      (entry) =>
        (roundId === undefined || entry.round.id === roundId) &&
        (clubId === undefined || entry.club?.id === clubId || entry.fromClub?.id === clubId) &&
        (loginId === null || entry.student.loginId === loginId) &&
        (before === undefined || entry.id < before),
    );
    const events = matching.slice(0, pageSize);
    const last = events.at(-1);
    return Response.json({
      events,
      nextBefore: matching.length > pageSize && last ? last.id : null,
    });
  };

const apiError = (status: number, code: string) =>
  Response.json({ code, message: code }, { status });

// Routes by path like mockApi, but sees the events query string, which carries the filters.
const mockEventsApi = (answer: EventsAnswer = pagedLog()) => {
  const eventQueries: URLSearchParams[] = [];
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname === EVENTS_PATH) {
      eventQueries.push(url.searchParams);
      return Promise.resolve(answer(url.searchParams));
    }
    const clubsMatch = /^\/api\/admin\/rounds\/(\d+)\/clubs$/.exec(url.pathname);
    if (method === 'GET' && clubsMatch) {
      const roundId = Number(clubsMatch[1]);
      const round = roundId === 1 ? ROUND_1 : ROUND_2;
      return Promise.resolve(Response.json({ round, clubs: ROUND_CLUBS[roundId] ?? [] }));
    }
    if (method === 'GET' && input === '/api/auth/me') {
      return Promise.resolve(Response.json({ user: ADMIN }));
    }
    if (method === 'GET' && input === '/api/admin/rounds') {
      return Promise.resolve(Response.json({ rounds: [ROUND_1, ROUND_2] }));
    }
    return Promise.resolve(apiError(404, 'not_found'));
  });
  vi.stubGlobal('fetch', fetchMock);
  // The parameters of each events request, in order.
  return { fetchMock, eventQueries };
};

const queryOf = (params: URLSearchParams | undefined) =>
  Object.fromEntries([...(params?.entries() ?? [])]);

const table = async () => await screen.findByRole('table', { name: 'ประวัติการลงทะเบียน' });
const bodyRows = async () =>
  within(await table())
    .getAllByRole('row')
    .slice(1);
const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell');
const timeOf = (row: HTMLElement) => within(row).getByRole('time').textContent;
const rowOf = async (id: number) => {
  const index = LOG.findIndex((entry) => entry.id === id);
  const rows = await bodyRows();
  return rows[index]!;
};

const roundPicker = () => screen.getByLabelText<HTMLSelectElement>('รอบลงทะเบียน');
const clubPicker = () => screen.getByLabelText<HTMLSelectElement>('ชุมนุม');
const codeInput = () => screen.getByLabelText<HTMLInputElement>('รหัสนักเรียน');

const chooseRound = async (value: string) => {
  if (value !== '') await screen.findByRole('option', { name: /^2569\/1 ม\.2/ });
  fireEvent.change(roundPicker(), { target: { value } });
};
const chooseClub = async (club: ClubRef | null) => {
  if (club) {
    const option = await screen.findByRole('option', { name: `${club.clubCode} ${club.name}` });
    fireEvent.change(clubPicker(), { target: { value: option.getAttribute('value') } });
  } else {
    fireEvent.change(clubPicker(), { target: { value: '' } });
  }
};
const filterByCode = (value: string) => {
  fireEvent.change(codeInput(), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'กรอง' }));
};

const openPage = async (answer?: EventsAnswer) => {
  const api = mockEventsApi(answer);
  const router = renderAt('/admin/events');
  await screen.findByRole('heading', { level: 1, name: 'ประวัติการลงทะเบียน' });
  return { ...api, router };
};

describe('AdminEventsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe('the list', () => {
    it('is in the admin menu and shows every event newest first with every column', async () => {
      const { eventQueries } = await openPage();

      const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' });
      expect(within(nav).getByRole('link', { name: /ประวัติการลงทะเบียน/ })).toBeTruthy();
      const rows = await bodyRows();
      expect(rows).toHaveLength(LOG.length);
      // Columns: the event (what, when, which round), student, club, actor.
      expect(cellsOf(rows[0]!).map((cell) => cell.textContent)).toEqual([
        `ได้ที่จากรายชื่อรอ${formatThaiDateTime(LOG[0]!.createdAt)}2569/1 ม.1`,
        `${S2.loginId}${S2.fullName}ห้อง 1/2 เลขที่ 5`,
        'จาก B200 ชุมนุมดนตรีสมมติ → A100 ชุมนุมหมากรุกสมมติ',
        `${S1.fullName}นักเรียนคนอื่นผู้ที่ทำให้มีที่ว่าง ระบบให้ที่จากรายชื่อรออัตโนมัติ`,
      ]);
      expect(within(rows[0]!).getByRole('time').getAttribute('dateTime')).toBe(LOG[0]!.createdAt);
      expect(rows.map(timeOf)).toEqual(LOG.map(({ createdAt }) => formatThaiDateTime(createdAt)));
      expect(queryOf(eventQueries[0])).toEqual({});
      expect(screen.getByText(/ห้องและเลขที่เป็นค่าปัจจุบันของนักเรียน/)).toBeTruthy();
    });

    it.each(EVENT_TYPES)('labels %s events in Thai', async (eventType) => {
      await openPage();

      const rows = await bodyRows();
      // The event cell starts with the label, then the time and the round.
      const eventCells = rows.map((row) => cellsOf(row)[0]!.textContent);

      expect(eventCells.some((text) => text.startsWith(EVENT_TYPE_LABELS[eventType]))).toBe(true);
      expect(eventCells.join('\n')).not.toContain(eventType);
    });

    it('shows the club an event left and the queue a join gave up', async () => {
      await openPage();

      expect(cellsOf(await rowOf(3))[2]!.textContent).toBe(
        'จาก B200 ชุมนุมดนตรีสมมติ → A100 ชุมนุมหมากรุกสมมติ',
      );
      expect(cellsOf(await rowOf(8))[2]!.textContent).toBe(
        'จากรายชื่อรอ B200 ชุมนุมดนตรีสมมติ → A100 ชุมนุมหมากรุกสมมติ',
      );
      expect(cellsOf(await rowOf(6))[2]!.textContent).toBe('C300 ชุมนุมวาดภาพสมมติ');
      expect(within(cellsOf(await rowOf(1))[0]!).getByText('2569/1 ม.1')).toBeTruthy();
      expect(within(cellsOf(await rowOf(6))[0]!).getByText('2569/1 ม.2')).toBeTruthy();
    });

    it('shows a dash for an event without a club', async () => {
      await openPage(pagedLog(50, [LOG[1]!, event(1, 'cancel', S1, null, asActor(S1))]));

      const rows = await bodyRows();

      expect(cellsOf(rows[1]!)[2]!.textContent).toBe('—');
    });

    it('says who acted: the student themself, an admin, or whoever freed the seat', async () => {
      await openPage();

      expect(cellsOf(await rowOf(1))[3]!.textContent).toBe(`${S1.fullName}นักเรียนคนนี้เอง`);
      const byAdmin = cellsOf(await rowOf(5))[3]!;
      expect(byAdmin.textContent).toBe(`${ADMIN_ACTOR.fullName}ผู้ดูแลระบบ`);
      // The promotion names the student who cancelled, not the one promoted.
      const promotion = cellsOf(await rowOf(10))[3]!;
      expect(promotion.textContent).toContain(S1.fullName);
      expect(promotion.textContent).not.toContain(S2.fullName);
      expect(promotion.textContent).toContain('ผู้ที่ทำให้มีที่ว่าง');
    });

    it('keeps markup in a name as text', async () => {
      await openPage();

      const studentCell = cellsOf(await rowOf(2))[1]!;

      expect(studentCell.textContent).toContain('นักเรียนสมมติ <i>สอง</i>');
      expect(studentCell.querySelector('i')).toBeNull();
    });

    it('says when no event matches', async () => {
      await openPage(() => Response.json({ events: [], nextBefore: null }));

      expect(await screen.findByText('ไม่มีเหตุการณ์ตามตัวกรองนี้')).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
    });

    it('offers a retry when the log fails to load', async () => {
      let fail = true;
      const answer = pagedLog();
      await openPage((params) => (fail ? apiError(500, 'internal_error') : answer(params)));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('โหลดประวัติการลงทะเบียนไม่สำเร็จ');
      fail = false;
      fireEvent.click(within(alert).getByRole('button', { name: 'ลองใหม่' }));

      expect(await bodyRows()).toHaveLength(LOG.length);
    });

    it.each([
      [400, 'validation_error', 'ตัวกรองไม่ถูกต้อง'],
      [403, 'forbidden', 'บัญชีนี้ไม่มีสิทธิ์ดูประวัติการลงทะเบียน'],
      [401, 'unauthorized', 'หมดเวลาการเข้าสู่ระบบ'],
    ])('explains a %i %s answer', async (status, code, message) => {
      await openPage(() => apiError(status, code));

      expect((await screen.findByRole('alert')).textContent).toContain(message);
    });
  });

  describe('filters', () => {
    it('starts with every round and filters by round, then by a club of that round', async () => {
      const { eventQueries } = await openPage();
      await bodyRows();
      expect(screen.queryByLabelText('ชุมนุม')).toBeNull();

      await chooseRound('2');
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ roundId: '2' }));
      expect(await bodyRows()).toHaveLength(2);
      await chooseClub(CLUB_C);

      await waitFor(() =>
        expect(queryOf(eventQueries.at(-1))).toEqual({ roundId: '2', clubId: '21' }),
      );
      expect(screen.getByText(/ตัวกรองที่ใช้อยู่: รอบ 2569\/1 ม\.2 \(ปิดแล้ว\) · ชุมนุม C300/)).toBeTruthy();
    });

    it('drops the club when the round changes', async () => {
      const { eventQueries } = await openPage();
      await chooseRound('1');
      await chooseClub(CLUB_A);
      await waitFor(() =>
        expect(queryOf(eventQueries.at(-1))).toEqual({ roundId: '1', clubId: '11' }),
      );

      await chooseRound('2');

      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ roundId: '2' }));
      expect(clubPicker().value).toBe('');
      await chooseRound('');
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({}));
      expect(screen.queryByLabelText('ชุมนุม')).toBeNull();
    });

    it('filters by a student code typed in upper case with spaces around it', async () => {
      const { eventQueries } = await openPage();
      await bodyRows();

      filterByCode('  DEMO1002 ');

      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ loginId: 'demo1002' }));
      expect(codeInput().value).toBe('demo1002');
      await waitFor(async () => expect(await bodyRows()).toHaveLength(3));
      expect(screen.getByText('ตัวกรองที่ใช้อยู่: นักเรียน demo1002')).toBeTruthy();
    });

    it('does not send a malformed student code', async () => {
      const { eventQueries } = await openPage();
      await bodyRows();
      const sent = eventQueries.length;

      filterByCode('demo 1002!');

      expect((await screen.findByRole('alert')).textContent).toContain('รหัสนักเรียนไม่ถูกต้อง');
      expect(eventQueries).toHaveLength(sent);
      expect(screen.getByText('ไม่มีตัวกรอง แสดงทุกเหตุการณ์')).toBeTruthy();
    });

    it('sends exactly the filters set, all three together', async () => {
      const { eventQueries } = await openPage();
      await chooseRound('1');
      await chooseClub(CLUB_B);

      filterByCode('demo1001');

      await waitFor(() => expect(eventQueries.at(-1)?.get('loginId')).toBe('demo1001'));
      expect([...eventQueries.at(-1)!.keys()]).toEqual(['roundId', 'clubId', 'loginId']);
      expect(queryOf(eventQueries.at(-1))).toEqual({
        roundId: '1',
        clubId: '12',
        loginId: 'demo1001',
      });
    });

    it("filters by a row's student when their code is pressed, and keeps focus on the filter", async () => {
      const { eventQueries, router } = await openPage();
      const row = await rowOf(2);

      fireEvent.click(
        within(row).getByRole('button', { name: `กรองเฉพาะนักเรียน ${S2.loginId} ${S2.fullName}` }),
      );

      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ loginId: S2.loginId }));
      expect(codeInput().value).toBe(S2.loginId);
      expect(document.activeElement).toBe(codeInput());
      // The code stays out of the page's address, and so out of the browser history.
      expect(router.state.location.pathname).toBe('/admin/events');
      expect(router.state.location.search).toBe('');
      expect(router.state.location.hash).toBe('');
    });

    it('clears the student code, with its button or with an empty submit', async () => {
      const { eventQueries } = await openPage();
      filterByCode('demo1001');
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ loginId: 'demo1001' }));

      fireEvent.click(screen.getByRole('button', { name: 'ล้างรหัส' }));

      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({}));
      expect(codeInput().value).toBe('');
      filterByCode('demo1002');
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ loginId: 'demo1002' }));
      filterByCode('   ');
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({}));
    });

    it('clears every filter at once', async () => {
      const { eventQueries } = await openPage();
      await chooseRound('1');
      await chooseClub(CLUB_A);
      filterByCode('demo1001');
      await waitFor(() => expect(eventQueries.at(-1)?.get('loginId')).toBe('demo1001'));

      fireEvent.click(screen.getByRole('button', { name: 'ล้างตัวกรองทั้งหมด' }));

      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({}));
      expect(roundPicker().value).toBe('');
      expect(codeInput().value).toBe('');
      expect(document.activeElement).toBe(roundPicker());
      expect(screen.queryByRole('button', { name: 'ล้างตัวกรองทั้งหมด' })).toBeNull();
    });
  });

  describe('paging', () => {
    it('loads older pages with before, keeping focus on the button, then says it is done', async () => {
      const { eventQueries } = await openPage(pagedLog(4));
      expect(await bodyRows()).toHaveLength(4);
      const more = screen.getByRole('button', { name: 'โหลดเพิ่ม' });
      more.focus();

      fireEvent.click(more);

      await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
      expect(queryOf(eventQueries.at(-1))).toEqual({ before: '7' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
      fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));

      const done = await screen.findByText('แสดงครบแล้ว');
      expect(queryOf(eventQueries.at(-1))).toEqual({ before: '3' });
      expect(screen.queryByRole('button', { name: 'โหลดเพิ่ม' })).toBeNull();
      expect(document.activeElement).toBe(done);
      expect((await bodyRows()).map(timeOf)).toEqual(
        LOG.map(({ createdAt }) => formatThaiDateTime(createdAt)),
      );
      expect(eventQueries).toHaveLength(3);
    });

    it('has no button when the first page is the last', async () => {
      await openPage();

      expect(await screen.findByText('แสดงครบแล้ว')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'โหลดเพิ่ม' })).toBeNull();
      expect(document.activeElement).not.toBe(screen.getByText('แสดงครบแล้ว'));
    });

    it('starts from the newest page when a filter changes, and again when it changes back', async () => {
      const { eventQueries } = await openPage(pagedLog(2));
      await bodyRows();
      fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ before: '9' }));

      await chooseRound('1');
      await waitFor(() => expect(queryOf(eventQueries.at(-1))).toEqual({ roundId: '1' }));
      expect(await bodyRows()).toHaveLength(2);
      const sent = eventQueries.length;
      await chooseRound('');

      await waitFor(() => expect(eventQueries).toHaveLength(sent + 1));
      expect(queryOf(eventQueries.at(-1))).toEqual({});
      expect(await bodyRows()).toHaveLength(2);
    });

    it('reloads from the newest page alone', async () => {
      const { eventQueries } = await openPage(pagedLog(4));
      await bodyRows();
      fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
      await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
      const sent = eventQueries.length;

      fireEvent.click(screen.getByRole('button', { name: 'โหลดใหม่' }));

      await waitFor(() => expect(eventQueries).toHaveLength(sent + 1));
      expect(queryOf(eventQueries.at(-1))).toEqual({});
      await waitFor(async () => expect(await bodyRows()).toHaveLength(4));
      expect(eventQueries).toHaveLength(sent + 1);
    });

    it('keeps the loaded rows and offers the button again when an older page fails', async () => {
      const answer = pagedLog(4);
      let failOlder = true;
      const { eventQueries } = await openPage((params) =>
        failOlder && params.has('before') ? apiError(500, 'internal_error') : answer(params),
      );
      await bodyRows();

      fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));

      expect((await screen.findByRole('alert')).textContent).toContain(
        'โหลดประวัติการลงทะเบียนไม่สำเร็จ',
      );
      expect(await bodyRows()).toHaveLength(4);
      failOlder = false;
      fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
      await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
      expect(queryOf(eventQueries.at(-1))).toEqual({ before: '7' });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('ignores a second press while an older page is on its way', async () => {
      const answer = pagedLog(4);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { eventQueries } = await openPage(async (params) => {
        if (params.has('before')) await held;
        return answer(params);
      });
      await bodyRows();

      fireEvent.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
      const pending = await screen.findByRole('button', { name: 'กำลังโหลด…' });
      expect(pending.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(pending);
      fireEvent.click(screen.getByRole('button', { name: 'โหลดใหม่' }));
      release();

      await waitFor(async () => expect(await bodyRows()).toHaveLength(8));
      expect(eventQueries.filter((params) => params.has('before'))).toHaveLength(1);
      expect(eventQueries).toHaveLength(2);
    });
  });
});

describe('AdminEventsPage on a phone (V2)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // jsdom has no viewport: this says "narrower than sm" to the page, as a phone's browser would.
  const onPhone = () => {
    const real = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...real(query),
      matches: query === PHONE_QUERY,
    }));
  };

  const cards = async () =>
    within(await screen.findByRole('list', { name: 'ประวัติการลงทะเบียน' })).getAllByRole('listitem');

  it('shows one card per event with every field, and no table to scroll sideways', async () => {
    onPhone();
    await openPage();

    const [promotion] = await cards();
    expect(screen.queryByRole('table')).toBeNull();
    expect(await cards()).toHaveLength(LOG.length);
    const card = promotion as HTMLElement;
    expect(within(card).getByText(EVENT_TYPE_LABELS.waitlist_promote)).toBeTruthy();
    expect(within(card).getByRole('time').textContent).toBe(
      formatThaiDateTime(LOG[0]?.createdAt ?? ''),
    );
    expect(card.textContent).toContain(S2.fullName);
    expect(card.textContent).toContain(
      `จาก ${CLUB_B.clubCode} ${CLUB_B.name} → ${CLUB_A.clubCode}`,
    );
    expect(card.textContent).toContain(S1.fullName);
    expect(card.textContent).toContain('นักเรียนคนอื่น');
  });

  it('filters by the student from a card, as from a table row', async () => {
    onPhone();
    const { eventQueries } = await openPage();
    const [first] = await cards();

    fireEvent.click(
      within(first as HTMLElement).getByRole('button', {
        name: `กรองเฉพาะนักเรียน ${S2.loginId} ${S2.fullName}`,
      }),
    );

    await waitFor(() => expect(eventQueries.at(-1)?.get('loginId')).toBe(S2.loginId));
  });
});
