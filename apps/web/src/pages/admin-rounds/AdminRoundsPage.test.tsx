import type { Round, SessionUser } from '@club-registration/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '@/test-support/render-app';
import { ROUNDS_POLL_INTERVAL_MS } from './round-ui';

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
  // 08:00–16:00 Thai time.
  opensAt: '2026-12-01T01:00:00.000Z',
  closesAt: '2026-12-01T09:00:00.000Z',
  maxActive: 150,
  status: 'upcoming',
  clubCount: 0,
  totalCapacity: 0,
  totalRegistered: 0,
  queueWaiting: 0,
  queueAdmitted: 0,
  ...overrides,
});

// The app always sends JSON bodies as strings (see lib/api.ts).
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

const fetchCalls = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([input, init]) => input === path && init?.method === method);

// A tiny in-memory stand-in for the rounds API, so the page's refetch shows what was saved.
const mockRoundsApi = (initial: Round[], extra: Parameters<typeof mockApi>[0] = {}) => {
  let rounds = [...initial];
  return mockApi({
    'GET /api/auth/me': () => Response.json({ user: ADMIN }),
    'GET /api/admin/rounds': () => Response.json({ rounds }),
    'POST /api/admin/rounds': (init) => {
      const created = roundFixture({ ...(bodyOf(init) as Partial<Round>), id: rounds.length + 1 });
      rounds = [...rounds, created];
      return Response.json({ round: created }, { status: 201 });
    },
    ...Object.fromEntries(
      initial.map((round) => [
        `PATCH /api/admin/rounds/${round.id}`,
        (init: RequestInit | undefined) => {
          const updated = { ...round, ...(bodyOf(init) as Partial<Round>) };
          rounds = rounds.map((existing) => (existing.id === round.id ? updated : existing));
          return Response.json({ round: updated });
        },
      ]),
    ),
    ...Object.fromEntries(
      initial.map((round) => [
        `DELETE /api/admin/rounds/${round.id}`,
        () => {
          rounds = rounds.filter(({ id }) => id !== round.id);
          return new Response(null, { status: 204 });
        },
      ]),
    ),
    ...extra,
  });
};

const fillTimes = (form: HTMLElement, opensAt: string, closesAt: string) => {
  fireEvent.change(within(form).getByLabelText('เวลาเปิด (เวลาไทย)'), {
    target: { value: opensAt },
  });
  fireEvent.change(within(form).getByLabelText('เวลาปิด (เวลาไทย)'), {
    target: { value: closesAt },
  });
};

const openEditor = async (round: Round) => {
  fireEvent.click(
    await screen.findByRole('button', { name: `แก้ไขรอบ ${round.term} ม.${round.grade}` }),
  );
  return screen.getByRole('form', { name: `แก้ไขรอบ ${round.term} ม.${round.grade}` });
};

const rowOf = async (round: Round) =>
  (await screen.findByRole('button', { name: `แก้ไขรอบ ${round.term} ม.${round.grade}` })).closest(
    'tr',
  ) as HTMLElement;

const listCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => input === '/api/admin/rounds' && (init?.method ?? 'GET') === 'GET',
  );

const NO_QUEUE = 'ไม่มีคิว';
const LOWERED = /ระบบไม่เอาใครที่ได้คิวแล้วออก/;
const TURNING_OFF = /รอบนี้จะไม่มีคิว/;
const TURNING_ON = /รอบนี้จะมีคิว/;

describe('admin rounds page', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // README Phase 3, Q4: the queue setting and the live counts of each round.
  describe('the queue', () => {
    it('shows a round without a queue and the waiting and admitted counts', async () => {
      const queued = roundFixture({ status: 'open', queueWaiting: 37, queueAdmitted: 150 });
      const unqueued = roundFixture({ id: 2, grade: 2, maxActive: null, queueAdmitted: 4 });
      mockRoundsApi([queued, unqueued]);
      renderAt('/admin/rounds');

      const cells = (row: HTMLElement) =>
        within(row)
          .getAllByRole('cell')
          .map(({ textContent }) => textContent);
      // Columns: ..., at once, waiting, admitted, actions.
      expect(cells(await rowOf(queued)).slice(7, 10)).toEqual(['150', '37', '150']);
      expect(cells(await rowOf(unqueued)).slice(7, 10)).toEqual([NO_QUEUE, '0', '4']);
    });

    it('refreshes the counts every 10 seconds while a round is open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const round = roundFixture({ status: 'open' });
      const fetchMock = mockRoundsApi([round]);
      renderAt('/admin/rounds');
      await rowOf(round);
      const before = listCalls(fetchMock).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROUNDS_POLL_INTERVAL_MS);
      });

      await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(before + 1));
    });

    it('does not poll when no round is open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const upcoming = roundFixture();
      const closed = roundFixture({ id: 2, grade: 2, status: 'closed' });
      const fetchMock = mockRoundsApi([upcoming, closed]);
      renderAt('/admin/rounds');
      await rowOf(upcoming);
      const before = listCalls(fetchMock).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * ROUNDS_POLL_INTERVAL_MS);
      });

      expect(listCalls(fetchMock)).toHaveLength(before);
    });

    it.each([
      ['สร้างรอบ', 'POST /api/admin/rounds'],
      ['สร้างครบทุกชั้น', 'POST /api/admin/rounds/batch'],
    ])('creates a round without a queue from the "%s" form', async (formName, route) => {
      const fetchMock = mockRoundsApi([], {
        'POST /api/admin/rounds/batch': () => Response.json({ rounds: [] }, { status: 201 }),
      });
      renderAt('/admin/rounds');
      await screen.findByText('ยังไม่มีรอบลงทะเบียน');
      const form = screen.getByRole('form', { name: formName });
      fireEvent.change(within(form).getByLabelText('ภาคเรียน'), { target: { value: '2569/2' } });
      fillTimes(form, '2027-05-10T08:30', '2027-05-10T15:00');

      fireEvent.click(within(form).getByRole('checkbox', { name: NO_QUEUE }));
      fireEvent.click(within(form).getByRole('button', { name: /^สร้าง/ }));

      const number = within(form).getByLabelText<HTMLInputElement>('จำนวนคนเข้าเลือกพร้อมกันสูงสุด');
      expect(number.disabled).toBe(true);
      const [method, path] = route.split(' ') as [string, string];
      await waitFor(() => expect(fetchCalls(fetchMock, method, path)).toHaveLength(1));
      expect(bodyOf(fetchCalls(fetchMock, method, path)[0]![1])).toMatchObject({ maxActive: null });
    });

    it('turns the queue of an upcoming round off and back on with the number typed', async () => {
      const round = roundFixture({ maxActive: 120 });
      const fetchMock = mockRoundsApi([round]);
      renderAt('/admin/rounds');
      let form = await openEditor(round);
      fireEvent.click(within(form).getByRole('checkbox', { name: NO_QUEUE }));
      fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));
      expect((await rowOf(round)).textContent).toContain(NO_QUEUE);

      form = await openEditor(round);
      const checkbox = within(form).getByRole<HTMLInputElement>('checkbox', { name: NO_QUEUE });
      expect(checkbox.checked).toBe(true);
      fireEvent.click(checkbox);
      fireEvent.change(within(form).getByLabelText('จำนวนคนเข้าเลือกพร้อมกันสูงสุด'), {
        target: { value: '80' },
      });
      fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

      await waitFor(() =>
        expect(fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')).toHaveLength(2),
      );
      const bodies = fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1').map(([, init]) =>
        bodyOf(init),
      );
      expect(bodies).toMatchObject([{ maxActive: null }, { maxActive: 80 }]);
      // No note for a round that is not open: no student is choosing yet.
      expect(screen.queryByText(TURNING_ON)).toBeNull();
    });

    it('warns, without blocking, when the new number is below the students let in', async () => {
      const round = roundFixture({ status: 'open', maxActive: 150, queueAdmitted: 120 });
      const fetchMock = mockRoundsApi([round]);
      renderAt('/admin/rounds');
      const form = await openEditor(round);
      const number = within(form).getByLabelText('จำนวนคนเข้าเลือกพร้อมกันสูงสุด');

      fireEvent.change(number, { target: { value: '130' } });
      expect(within(form).queryByText(LOWERED)).toBeNull();
      fireEvent.change(number, { target: { value: '100' } });

      expect(within(form).getByText(LOWERED).textContent).toContain('120 คน');
      fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));
      fireEvent.click(within(form).getByRole('button', { name: 'ยืนยันบันทึก' }));
      await waitFor(() =>
        expect(fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')).toHaveLength(1),
      );
      expect(bodyOf(fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')[0]![1])).toMatchObject({
        maxActive: 100,
      });
    });

    it('says what students will see when the queue of an open round goes off or on', async () => {
      const queued = roundFixture({ status: 'open' });
      const unqueued = roundFixture({ id: 2, grade: 2, status: 'open', maxActive: null });
      mockRoundsApi([queued, unqueued]);
      renderAt('/admin/rounds');

      let form = await openEditor(queued);
      expect(within(form).queryByText(TURNING_OFF)).toBeNull();
      fireEvent.click(within(form).getByRole('checkbox', { name: NO_QUEUE }));
      expect(within(form).getByText(TURNING_OFF)).toBeTruthy();
      fireEvent.click(within(form).getByRole('button', { name: 'ปิด' }));

      form = await openEditor(unqueued);
      expect(within(form).queryByText(TURNING_ON)).toBeNull();
      fireEvent.click(within(form).getByRole('checkbox', { name: NO_QUEUE }));
      expect(within(form).getByText(TURNING_ON)).toBeTruthy();
    });
  });

  it('creates a round from Thai time and lists it in Thai time', async () => {
    const fetchMock = mockRoundsApi([]);
    renderAt('/admin/rounds');
    await screen.findByText('ยังไม่มีรอบลงทะเบียน');
    const form = screen.getByRole('form', { name: 'สร้างรอบ' });

    fireEvent.change(within(form).getByLabelText('ภาคเรียน'), { target: { value: '2569/2' } });
    fireEvent.change(within(form).getByLabelText('ชั้น'), { target: { value: '2' } });
    fillTimes(form, '2027-05-10T08:30', '2027-05-10T15:00');
    fireEvent.click(within(form).getByRole('button', { name: 'สร้างรอบ' }));

    const row = (await screen.findByRole('button', { name: 'แก้ไขรอบ 2569/2 ม.2' })).closest(
      'tr',
    ) as HTMLElement;
    expect(row.textContent).toContain('08:30');
    expect(row.textContent).toContain('15:00');
    const [, init] = fetchCalls(fetchMock, 'POST', '/api/admin/rounds')[0]!;
    expect(bodyOf(init)).toEqual({
      term: '2569/2',
      grade: 2,
      opensAt: '2027-05-10T01:30:00.000Z',
      closesAt: '2027-05-10T08:00:00.000Z',
      maxActive: 150,
    });
  });

  it('shows why a create failed when the round already exists', async () => {
    mockRoundsApi([], {
      'POST /api/admin/rounds': () =>
        Response.json({ code: 'round_exists', message: 'exists' }, { status: 409 }),
    });
    renderAt('/admin/rounds');
    await screen.findByText('ยังไม่มีรอบลงทะเบียน');
    const form = screen.getByRole('form', { name: 'สร้างรอบ' });

    fireEvent.change(within(form).getByLabelText('ภาคเรียน'), { target: { value: '2569/1' } });
    fillTimes(form, '2026-12-01T08:00', '2026-12-01T16:00');
    fireEvent.click(within(form).getByRole('button', { name: 'สร้างรอบ' }));

    expect((await within(form).findByRole('alert')).textContent).toBe('มีรอบของภาคเรียนและชั้นนี้อยู่แล้ว');
  });

  it('does not send a round whose closing time is not after its opening time', async () => {
    const fetchMock = mockRoundsApi([]);
    renderAt('/admin/rounds');
    await screen.findByText('ยังไม่มีรอบลงทะเบียน');
    const form = screen.getByRole('form', { name: 'สร้างรอบ' });

    fireEvent.change(within(form).getByLabelText('ภาคเรียน'), { target: { value: '2569/1' } });
    fillTimes(form, '2026-12-01T16:00', '2026-12-01T08:00');
    fireEvent.click(within(form).getByRole('button', { name: 'สร้างรอบ' }));

    expect((await within(form).findByRole('alert')).textContent).toBe('เวลาปิดต้องอยู่หลังเวลาเปิด');
    expect(fetchCalls(fetchMock, 'POST', '/api/admin/rounds')).toHaveLength(0);
  });

  it('edits an upcoming round straight away', async () => {
    const round = roundFixture();
    const fetchMock = mockRoundsApi([round]);
    renderAt('/admin/rounds');
    const form = await openEditor(round);

    fireEvent.change(within(form).getByLabelText('เวลาปิด (เวลาไทย)'), {
      target: { value: '2026-12-01T18:00' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'แก้ไขรอบ 2569/1 ม.1' })).toBeNull(),
    );
    const [, init] = fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')[0]!;
    expect(bodyOf(init)).toEqual({
      opensAt: '2026-12-01T01:00:00.000Z',
      closesAt: '2026-12-01T11:00:00.000Z',
      maxActive: 150,
    });
    const row = screen.getByRole('button', { name: 'แก้ไขรอบ 2569/1 ม.1' }).closest('tr');
    expect(row?.textContent).toContain('18:00');
  });

  it('asks for confirmation before changing the times of an open round', async () => {
    const round = roundFixture({ status: 'open' });
    const fetchMock = mockRoundsApi([round]);
    renderAt('/admin/rounds');
    const form = await openEditor(round);
    fireEvent.change(within(form).getByLabelText('เวลาปิด (เวลาไทย)'), {
      target: { value: '2026-12-01T17:00' },
    });

    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    expect(within(form).getByRole('alertdialog').textContent).toContain('รอบนี้เปิดให้ลงทะเบียนอยู่');
    expect(fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')).toHaveLength(0);

    fireEvent.click(within(form).getByRole('button', { name: 'ยืนยันบันทึก' }));

    await waitFor(() =>
      expect(fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')).toHaveLength(1),
    );
    const [, init] = fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')[0]!;
    expect(bodyOf(init)).toMatchObject({ closesAt: '2026-12-01T10:00:00.000Z' });
  });

  it('keeps an open round unchanged when the admin backs out of the confirmation', async () => {
    const round = roundFixture({ status: 'open' });
    const fetchMock = mockRoundsApi([round]);
    renderAt('/admin/rounds');
    const form = await openEditor(round);
    fireEvent.click(within(form).getByRole('button', { name: 'บันทึกการแก้ไข' }));

    fireEvent.click(within(form).getByRole('button', { name: 'ยังไม่บันทึก' }));

    expect(within(form).queryByRole('alertdialog')).toBeNull();
    expect(fetchCalls(fetchMock, 'PATCH', '/api/admin/rounds/1')).toHaveLength(0);
  });

  it('deletes an empty round only after the admin confirms', async () => {
    const round = roundFixture();
    const fetchMock = mockRoundsApi([round]);
    renderAt('/admin/rounds');
    fireEvent.click(await screen.findByRole('button', { name: 'ลบรอบ 2569/1 ม.1' }));

    expect(screen.getByRole('alertdialog', { name: 'ลบรอบ 2569/1 ม.1 ใช่หรือไม่' })).toBeTruthy();
    expect(fetchCalls(fetchMock, 'DELETE', '/api/admin/rounds/1')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบ' }));

    expect(await screen.findByText('ยังไม่มีรอบลงทะเบียน')).toBeTruthy();
    expect(fetchCalls(fetchMock, 'DELETE', '/api/admin/rounds/1')).toHaveLength(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the round when the admin cancels the delete', async () => {
    const round = roundFixture();
    const fetchMock = mockRoundsApi([round]);
    renderAt('/admin/rounds');
    fireEvent.click(await screen.findByRole('button', { name: 'ลบรอบ 2569/1 ม.1' }));

    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'แก้ไขรอบ 2569/1 ม.1' })).toBeTruthy();
    expect(fetchCalls(fetchMock, 'DELETE', '/api/admin/rounds/1')).toHaveLength(0);
  });

  it('offers no delete for a round that already has clubs', async () => {
    mockRoundsApi([roundFixture({ clubCount: 2, totalCapacity: 60 })]);
    renderAt('/admin/rounds');

    await screen.findByRole('button', { name: 'แก้ไขรอบ 2569/1 ม.1' });

    expect(screen.queryByRole('button', { name: 'ลบรอบ 2569/1 ม.1' })).toBeNull();
  });

  it('says why a delete was refused and keeps the round listed', async () => {
    const round = roundFixture();
    mockRoundsApi([round], {
      'DELETE /api/admin/rounds/1': () =>
        Response.json({ code: 'round_not_empty', message: 'not empty' }, { status: 409 }),
    });
    renderAt('/admin/rounds');
    fireEvent.click(await screen.findByRole('button', { name: 'ลบรอบ 2569/1 ม.1' }));

    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบ' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'ลบไม่ได้ เพราะรอบนี้มีชุมนุม ข้อมูลการลงทะเบียน หรือมีนักเรียนเข้าคิวแล้ว',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'แก้ไขรอบ 2569/1 ม.1' })).toBeTruthy();
  });

  it('closes the editor of a round once that round is deleted', async () => {
    const round = roundFixture();
    mockRoundsApi([round]);
    renderAt('/admin/rounds');
    await openEditor(round);

    fireEvent.click(screen.getByRole('button', { name: 'ลบรอบ 2569/1 ม.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบ' }));

    await screen.findByText('ยังไม่มีรอบลงทะเบียน');
    expect(screen.queryByRole('form', { name: 'แก้ไขรอบ 2569/1 ม.1' })).toBeNull();
  });

  it('closes the editor of a deleted round even when the list then fails to reload', async () => {
    const round = roundFixture();
    let deleted = false;
    mockRoundsApi([round], {
      'GET /api/admin/rounds': () =>
        deleted
          ? Response.json({ code: 'internal_error', message: 'boom' }, { status: 500 })
          : Response.json({ rounds: [round] }),
      'DELETE /api/admin/rounds/1': () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    });
    renderAt('/admin/rounds');
    await openEditor(round);

    fireEvent.click(screen.getByRole('button', { name: 'ลบรอบ 2569/1 ม.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบ' }));

    expect((await screen.findByRole('alert')).textContent).toContain('โหลดรายการรอบไม่สำเร็จ');
    expect(screen.queryByRole('form', { name: 'แก้ไขรอบ 2569/1 ม.1' })).toBeNull();
  });

  it('asks the API for one term and says when that term has no rounds', async () => {
    const fetchMock = mockRoundsApi([roundFixture()], {
      'GET /api/admin/rounds?term=2570%2F1': () => Response.json({ rounds: [] }),
    });
    renderAt('/admin/rounds');
    await screen.findByRole('button', { name: 'แก้ไขรอบ 2569/1 ม.1' });

    fireEvent.change(screen.getByLabelText('กรองตามภาคเรียน'), { target: { value: ' 2570/1 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'แสดง' }));

    expect(await screen.findByText('ไม่มีรอบของภาคเรียน 2570/1')).toBeTruthy();
    expect(fetchCalls(fetchMock, 'GET', '/api/admin/rounds?term=2570%2F1')).toHaveLength(1);
  });

  it('offers a retry when the list fails to load', async () => {
    let failures = 1;
    mockRoundsApi([roundFixture()], {
      'GET /api/admin/rounds': () => {
        if (failures-- > 0) {
          return Response.json({ code: 'internal_error', message: 'boom' }, { status: 500 });
        }
        return Response.json({ rounds: [roundFixture()] });
      },
    });
    renderAt('/admin/rounds');

    expect((await screen.findByRole('alert')).textContent).toContain('โหลดรายการรอบไม่สำเร็จ');
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่' }));

    expect(await screen.findByRole('button', { name: 'แก้ไขรอบ 2569/1 ม.1' })).toBeTruthy();
  });
});
