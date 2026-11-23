import { loginIdSchema } from '@club-registration/shared';
import { skipToken, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { EmptyState, LoadFailed } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { fetchEvents, fetchRoundClubs, fetchRounds } from '@/lib/api';
import { roundOptionLabel } from '@/lib/round-display';
import { CLUBS_QUERY_KEY } from '@/pages/admin-clubs/club-ui';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { EVENTS_TABLE_HELP_ID, EventsTable } from './EventsTable';
import { StudentCodeFilter } from './StudentCodeFilter';
import { EVENTS_QUERY_KEY, LOGIN_ID_FORMAT_ERROR, clubLabel, eventsErrorMessage } from './event-ui';

// The rounds page lists every term under the same key, so the pages share one cached list.
const ALL_TERMS = '';
const ALL = '';

// The admin's event log (README Phase 2, PR 5b). The filters live in this component's state only,
// never in the page URL or its search params: a student's code there would land in the browser
// history. The log starts unfiltered ("ทุกรอบ"), newest first, so it loads at once without waiting
// for the rounds list, and what just happened in any round is on top.
export const AdminEventsPage = () => {
  const queryClient = useQueryClient();
  const [roundId, setRoundId] = useState<number>();
  const [clubId, setClubId] = useState<number>();
  const [loginId, setLoginId] = useState<string>();
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState<string>();
  const roundSelectRef = useRef<HTMLSelectElement>(null);
  const loginInputRef = useRef<HTMLInputElement>(null);
  // Set by "โหลดเพิ่ม": when the page it loads is the last, the button gives way to "แสดงครบแล้ว",
  // and focus moves there instead of falling to the body.
  const focusEndRef = useRef(false);

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, ALL_TERMS],
    queryFn: async () => await fetchRounds(),
  });
  // The clubs page's key, so the two pages share the cached list of a round's clubs.
  const clubsQuery = useQuery({
    queryKey: [...CLUBS_QUERY_KEY, roundId],
    queryFn: roundId === undefined ? skipToken : async () => await fetchRoundClubs(roundId),
  });

  const filters = { roundId, clubId, loginId };
  const queryKey = [...EVENTS_QUERY_KEY, filters] as const;
  const eventsQuery = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) =>
      await fetchEvents({ ...filters, before: pageParam ?? undefined }),
    initialPageParam: null as number | null,
    getNextPageParam: ({ nextBefore }) => nextBefore,
    // Dropped as soon as no filter shows it: going back to an earlier filter starts again from the
    // newest page (a cached list would refetch every page it had), and no student's events stay
    // in memory after the admin moves on. No polling and no refetch on focus, which would also
    // refetch every page loaded.
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const startOver = () => {
    focusEndRef.current = false;
  };
  const chooseRound = (value: string) => {
    startOver();
    setRoundId(value === ALL ? undefined : Number(value));
    // A club belongs to one round.
    setClubId(undefined);
  };
  const chooseClub = (value: string) => {
    startOver();
    setClubId(value === ALL ? undefined : Number(value));
  };
  const applyLoginId = () => {
    startOver();
    if (loginInput.trim() === '') {
      setLoginError(undefined);
      setLoginInput('');
      setLoginId(undefined);
      return;
    }
    const parsed = loginIdSchema.safeParse(loginInput);
    if (!parsed.success) {
      setLoginError(LOGIN_ID_FORMAT_ERROR);
      return;
    }
    setLoginError(undefined);
    setLoginInput(parsed.data);
    setLoginId(parsed.data);
  };
  const pickStudent = (code: string) => {
    startOver();
    setLoginError(undefined);
    setLoginInput(code);
    setLoginId(code);
    // The row's button goes away while the filtered list loads; the filter just set is where the
    // admin can carry on from.
    loginInputRef.current?.focus();
  };
  const clearLoginId = () => {
    startOver();
    setLoginError(undefined);
    setLoginInput('');
    setLoginId(undefined);
    loginInputRef.current?.focus();
  };
  const clearAll = () => {
    startOver();
    setRoundId(undefined);
    setClubId(undefined);
    setLoginError(undefined);
    setLoginInput('');
    setLoginId(undefined);
    roundSelectRef.current?.focus();
  };
  const loadMore = () => {
    if (eventsQuery.isFetchingNextPage) return;
    focusEndRef.current = true;
    void eventsQuery.fetchNextPage();
  };
  // Back to the newest page alone: a refetch would ask again for every page loaded.
  const reload = () => {
    startOver();
    void queryClient.resetQueries({ queryKey, exact: true });
  };
  const focusEndIfLost = (node: HTMLParagraphElement | null) => {
    if (node && focusEndRef.current && document.activeElement === document.body) node.focus();
    focusEndRef.current = false;
  };

  const rounds = roundsQuery.data ?? [];
  const clubs = clubsQuery.data?.clubs ?? [];
  const round = rounds.find(({ id }) => id === roundId);
  const club = clubs.find(({ id }) => id === clubId);
  const activeFilters = [
    ...(roundId === undefined ? [] : [`รอบ ${round ? roundOptionLabel(round) : roundId}`]),
    ...(clubId === undefined ? [] : [`ชุมนุม ${club ? clubLabel(club) : clubId}`]),
    ...(loginId === undefined ? [] : [`นักเรียน ${loginId}`]),
  ];
  const events = eventsQuery.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">ประวัติการลงทะเบียน</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          ทุกการลง ยกเลิก ย้าย เข้า/ออกรายชื่อรอ การได้ที่จากรายชื่อรอ และการแก้แทนของผู้ดูแล เรียงจากใหม่ไปเก่า
          กรองด้วยรอบ ชุมนุม หรือรหัสนักเรียนได้ ประวัติแก้หรือลบไม่ได้
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-card">
        <div className="flex flex-wrap gap-4">
          <div className="w-full max-w-sm space-y-1.5">
            <Label htmlFor="events-round">รอบลงทะเบียน</Label>
            <Select
              id="events-round"
              ref={roundSelectRef}
              value={roundId ?? ALL}
              onChange={(event) => chooseRound(event.target.value)}
            >
              <option value={ALL}>ทุกรอบ</option>
              {rounds.map((option) => (
                <option key={option.id} value={option.id}>
                  {roundOptionLabel(option)}
                </option>
              ))}
            </Select>
            {roundsQuery.isError && (
              <div className="flex items-center gap-2 text-sm" role="alert">
                <span>โหลดรายการรอบไม่สำเร็จ</span>
                <Button
                  variant="outline"
                  className="px-3 py-1"
                  onClick={() => void roundsQuery.refetch()}
                >
                  ลองใหม่
                </Button>
              </div>
            )}
          </div>
          {roundId !== undefined && (
            <div className="w-full max-w-sm space-y-1.5">
              <Label htmlFor="events-club">ชุมนุม</Label>
              <Select
                id="events-club"
                value={clubId ?? ALL}
                disabled={clubsQuery.isPending}
                onChange={(event) => chooseClub(event.target.value)}
              >
                <option value={ALL}>ทุกชุมนุม</option>
                {clubs.map((option) => (
                  <option key={option.id} value={option.id}>
                    {clubLabel(option)}
                  </option>
                ))}
              </Select>
              {clubsQuery.isError && (
                <div className="flex items-center gap-2 text-sm" role="alert">
                  <span>โหลดรายการชุมนุมไม่สำเร็จ</span>
                  <Button
                    variant="outline"
                    className="px-3 py-1"
                    onClick={() => void clubsQuery.refetch()}
                  >
                    ลองใหม่
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        <StudentCodeFilter
          value={loginInput}
          error={loginError}
          inputRef={loginInputRef}
          onChange={setLoginInput}
          onSubmit={applyLoginId}
          onClear={clearLoginId}
        />
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm">
          <p>
            {activeFilters.length === 0
              ? 'ไม่มีตัวกรอง แสดงทุกเหตุการณ์'
              : `ตัวกรองที่ใช้อยู่: ${activeFilters.join(' · ')}`}
          </p>
          {activeFilters.length > 0 && (
            <Button variant="outline" className="px-3 py-1" onClick={clearAll}>
              ล้างตัวกรองทั้งหมด
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          aria-disabled={eventsQuery.isFetching}
          onClick={() => {
            if (!eventsQuery.isFetching) reload();
          }}
        >
          โหลดใหม่
        </Button>
        <span className="text-sm text-muted-foreground">
          หน้านี้ไม่อัปเดตเอง กด "โหลดใหม่" เพื่อดูเหตุการณ์ล่าสุด
        </span>
      </div>

      {eventsQuery.isPending ? (
        <p className="text-muted-foreground" role="status">
          กำลังโหลดประวัติ…
        </p>
      ) : eventsQuery.isError && events.length === 0 && !eventsQuery.isFetchNextPageError ? (
        <LoadFailed
          message={eventsErrorMessage(eventsQuery.error)}
          onRetry={() => void eventsQuery.refetch()}
        />
      ) : events.length === 0 ? (
        <EmptyState>ไม่มีเหตุการณ์ตามตัวกรองนี้</EmptyState>
      ) : (
        <div className="space-y-3">
          <ul
            id={EVENTS_TABLE_HELP_ID}
            className="max-w-prose list-disc space-y-1 rounded-xl bg-muted py-3 pr-3 pl-8 text-sm text-muted-foreground"
          >
            <li>
              ห้องและเลขที่เป็นค่าปัจจุบันของนักเรียน ไม่ใช่ ณ เวลาที่เกิดเหตุการณ์ (อาจต่างไปถ้านำเข้าข้อมูลนักเรียนใหม่)
            </li>
            <li>ผู้ทำของ "ได้ที่จากรายชื่อรอ" คือผู้ที่ทำให้มีที่ว่าง (นักเรียนที่ยกเลิกหรือย้าย หรือผู้ดูแล) ระบบให้ที่เอง</li>
          </ul>
          <EventsTable events={events} onPickStudent={pickStudent} />
          {eventsQuery.isFetchNextPageError && (
            <p className="text-sm text-destructive" role="alert">
              {eventsErrorMessage(eventsQuery.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>แสดง {events.length} เหตุการณ์</span>
            {eventsQuery.hasNextPage ? (
              <Button
                variant="outline"
                aria-disabled={eventsQuery.isFetchingNextPage}
                onClick={loadMore}
              >
                {eventsQuery.isFetchingNextPage ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
              </Button>
            ) : (
              <p ref={focusEndIfLost} tabIndex={-1} className="text-muted-foreground">
                แสดงครบแล้ว
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
