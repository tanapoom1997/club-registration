import { ERROR_CODES } from '@club-registration/shared';
import type {
  QueueTicket,
  StudentClubRef,
  StudentQueueResponse,
  StudentRound,
} from '@club-registration/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query, QueryClient, QueryFunctionContext } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  ApiError,
  fetchQueue,
  isOutcomeUnknown,
  joinQueue,
  queueHeartbeat,
  releaseQueue,
} from '@/lib/api';
import { formatThaiTime } from '@/lib/thai-time';
import {
  COMMON_ERRORS,
  STUDENT_CLUBS_QUERY_KEY,
  STUDENT_QUERY_KEY,
  STUDENT_ROUND_QUERY_KEY,
  retryRead,
  useLogoutOnExpiredSession,
} from './student-ui';

// The API's idle timeout is 60 s (QUEUE_IDLE_TIMEOUT_SECONDS) and its poll budget 60 a minute
// shared with the read: every 4 s is 15 a minute, and a few missed beats still keep the ticket.
export const HEARTBEAT_INTERVAL_MS = 4_000;

// Under the student prefix, so a write's invalidation sends a heartbeat at once and a logout drops
// it with the rest. The round id is in the key so a ticket never carries over to another round.
export const queueQueryKey = (roundId: number) =>
  Object.freeze([...STUDENT_QUERY_KEY, 'queue', roundId] as const);
// The result page's own copy of the ticket (Q2: it keeps the ticket alive, never joins). Another
// key, not one under queueQueryKey: the two queries' fetches differ (one may join), so they must
// never share a cache entry, nor be hit together by an invalidation of either key.
export const keepaliveQueryKey = (roundId: number) =>
  Object.freeze([...STUDENT_QUERY_KEY, 'queue-keepalive', roundId] as const);
type QueueQueryKey = ReturnType<typeof queueQueryKey> | ReturnType<typeof keepaliveQueryKey>;

const isLive = (ticket: QueueTicket | null | undefined): boolean =>
  ticket?.status === 'waiting' || ticket?.status === 'admitted';

const isApiError = (error: unknown, code: string): boolean =>
  error instanceof ApiError && error.code === code;

// The API's answer to the club list or a seat write without a live turn in an open round (Q2). Not
// a missing permission and not a lost session: the page goes back to the queue.
export const isQueueRequired = (error: unknown): boolean =>
  isApiError(error, ERROR_CODES.queueRequired);

// Join or heartbeat in a round an admin turned the queue off for (Q4). Not a lost connection
// either: the round read again says hasQueue false, and the page shows the list.
const isQueueOff = (error: unknown): boolean => isApiError(error, ERROR_CODES.queueOff);

// The round's queue is a property of the round read: a round that is open but has no queue
// (max_active NULL) makes no queue call at all, as an upcoming or closed one.
const isQueued = (round: StudentRound | null | undefined): boolean =>
  round?.status === 'open' && round.hasQueue;

// The queue was turned off (queue_off): read the round again, whose hasQueue false switches the
// page to the list; awaited, so the page has moved on by the time the error lands.
const refreshRound = async (client: QueryClient): Promise<void> => {
  await Promise.all([
    client.invalidateQueries({ queryKey: STUDENT_ROUND_QUERY_KEY }),
    client.invalidateQueries({ queryKey: STUDENT_CLUBS_QUERY_KEY }),
  ]);
};

// One query holds the ticket, and every fetch of it does the one call the ticket needs: no ticket
// yet (this visit) → join (or, on a page that never joins, a read), live → heartbeat, ended → a
// read. So whatever refetches it (the interval, the tab becoming visible again, the invalidation
// after a write or a queue_required, React StrictMode mounting twice) can never join a second time
// or rejoin after the ticket ended; joining again is the student's own click. A POST in a query:
// the heartbeat writes, but the same heartbeat sent twice changes nothing more, and polling is
// what queries are for.
const queueSync =
  ({ join }: { join: boolean }) =>
  async ({
    client,
    queryKey,
  }: QueryFunctionContext<QueueQueryKey>): Promise<StudentQueueResponse> => {
    const current = client.getQueryData<StudentQueueResponse>(queryKey);
    if (current === undefined && join) {
      try {
        return await joinQueue();
      } catch (error) {
        // The round closed (or moved), or its queue was turned off, since the round read said
        // otherwise: refresh it, and the page falls back to the round without the queue.
        if (isApiError(error, ERROR_CODES.roundNotOpen) || isQueueOff(error)) {
          await refreshRound(client);
        }
        throw error;
      }
    }
    if (!isLive(current?.ticket)) return await fetchQueue();
    try {
      return await queueHeartbeat();
    } catch (error) {
      // The ticket ended (timed out, released in another tab): the read says which, without
      // joining again.
      if (isApiError(error, ERROR_CODES.notInQueue)) return await fetchQueue();
      // The queue was turned off: the ticket is left to expire, and the page shows the list.
      if (isQueueOff(error)) await refreshRound(client);
      throw error;
    }
  };

const syncQueue = queueSync({ join: true });
const keepQueueAlive = queueSync({ join: false });

type TicketQuery = Query<StudentQueueResponse, Error, StudentQueueResponse, QueueQueryKey>;

const hasLiveTicket = (query: TicketQuery) => isLive(query.state.data?.ticket);

// What both ticket queries share: heartbeats every 4 s while the ticket is live, kept going in a
// hidden tab (whose timers the browser throttles, Chrome down to about once a minute, which is the
// idle timeout) and sent at once on returning to the tab (TanStack's focus manager listens to
// visibilitychange). Gone with the page: coming back is a new visit (gcTime 0).
const TICKET_QUERY_OPTIONS = Object.freeze({
  gcTime: 0,
  retry: retryRead,
  refetchInterval: (query: TicketQuery) => (hasLiveTicket(query) ? HEARTBEAT_INTERVAL_MS : false),
  refetchIntervalInBackground: true,
  refetchOnWindowFocus: hasLiveTicket,
});

export type QueueView =
  | { kind: 'off' }
  | { kind: 'joining' }
  | { kind: 'failed'; message: string }
  | { kind: 'waiting'; position: number }
  | { kind: 'admitted'; admittedUntil: string; endsAt: number }
  | { kind: 'expired' }
  | { kind: 'done' };

const JOIN_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ...COMMON_ERRORS,
  [ERROR_CODES.roundNotOpen]: 'เข้าคิวไม่ได้ เพราะตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน กำลังโหลดข้อมูลรอบล่าสุด',
  [ERROR_CODES.queueOff]: 'รอบนี้ไม่ใช้คิวแล้ว เลือกชุมนุมได้เลย กำลังโหลดข้อมูลรอบล่าสุด',
});

const RELEASE_ERRORS: Readonly<Record<string, string>> = COMMON_ERRORS;

// Every queue message the student sees, in one place like WRITE_MESSAGES.
export const QUEUE_MESSAGES = Object.freeze({
  joining: 'กำลังเข้าคิว…',
  waiting: 'รอคิว',
  expired: 'หมดเวลาคิวแล้ว',
  done: 'ปล่อยคิวแล้ว',
  joinUnknown: 'เข้าคิวไม่สำเร็จ เพราะเชื่อมต่อระบบไม่ได้ กด "ลองเข้าคิวอีกครั้ง"',
  joinFallback: 'เข้าคิวไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  waitingHelp:
    'เมื่อถึงคิว หน้านี้จะแสดงรายการชุมนุมให้เลือกเอง ไม่ต้องโหลดใหม่ เปิดหน้านี้ค้างไว้ ผลของคิวแสดงที่หน้านี้เท่านั้น ไม่มีแจ้งทางอื่น',
  admittedHelp: 'ลงหรือย้ายชุมนุมได้จนถึงเวลานี้ เลือกเสร็จแล้วกด "เสร็จแล้ว ปล่อยคิว" เพื่อให้คนถัดไปได้เข้า',
  // Said with the time it takes (the API's idle timeout, 60 s by default): a phone left to sleep,
  // locked or switched to another app stops the heartbeats (U1). The page asks the browser to keep
  // the screen on (useWakeLock), which not every phone grants.
  keepOpen:
    'เปิดหน้านี้ค้างไว้และอย่าให้จอดับ ถ้าสลับไปแอปอื่นหรือล็อกจอนานราว 1 นาที จะหลุดจากคิวและต้องเข้าคิวใหม่ต่อท้าย (ถ้าลงชุมนุมไว้แล้ว ชุมนุมนั้นยังอยู่)',
  connectionLost: 'เชื่อมต่อระบบไม่ได้ชั่วคราว กำลังลองใหม่ ถ้าหลุดนานเกิน 1 นาทีอาจต้องเข้าคิวใหม่',
  expiredHelp:
    'หน้านี้ไม่ได้ติดต่อระบบนานเกินไป (เช่น ปิดหน้า จอดับ ล็อกจอ หรือสลับไปแอปอื่นนานราว 1 นาที) หรือครบเวลาที่ให้เลือกชุมนุมแล้ว',
  // After the turn ended (expired or released): only a student who holds a club is told it stays.
  heldKept: (club: StudentClubRef) =>
    `ชุมนุม ${club.clubCode} ${club.name} ที่ลงไว้ยังอยู่ ถ้าจะเลือกใหม่ กดเข้าคิวใหม่ (ต่อท้ายคิว)`,
  noneHeld: 'คุณยังไม่ได้ลงชุมนุมในรอบนี้ ถ้าจะเลือก กดเข้าคิวใหม่ (ต่อท้ายคิว)',
  releaseUnknown: 'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าปล่อยคิวแล้วหรือไม่ กดอีกครั้งได้ (ปล่อยซ้ำไม่มีผลเสีย)',
  releaseFallback: 'ปล่อยคิวไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  // The result page (useQueueKeepalive): the place is kept while it is open, but the club list
  // only shows on the clubs page.
  keepaliveWaitingHelp: 'ที่ในคิวยังอยู่ระหว่างเปิดหน้านี้ไว้ เมื่อถึงคิว รายการชุมนุมจะแสดงที่หน้าเลือกชุมนุมเท่านั้น',
  backToClubs: 'กลับไปหน้าเลือกชุมนุม',
  toClubs: 'ไปเลือกชุมนุม',
});

const messageFor = (
  error: unknown,
  errors: Readonly<Record<string, string>>,
  unknown: string,
  fallback: string,
): string => {
  if (isOutcomeUnknown(error)) return unknown;
  return (error instanceof ApiError ? errors[error.code] : undefined) ?? fallback;
};

// The admitted line in parts, so the clubs page can set the deadline apart on its own line and
// keep "HH:MM น." together, while the text (what a screen reader hears) stays the same.
export const admittedParts = (admittedUntil: string) =>
  ({
    lead: 'ถึงคิวของคุณแล้ว',
    until: 'เลือกชุมนุมได้ถึง',
    time: `${formatThaiTime(admittedUntil)} น.`,
  }) as const;

// The turn's end on this device's clock: the server's count of what is left (secondsLeft, by the
// DB clock that ends the turn), from when its answer arrived. A device clock minutes off the
// server's does not move it, and every heartbeat sets it again.
const turnEndsAt = (secondsLeft: number, receivedAt: number): number =>
  receivedAt + secondsLeft * 1_000;

const MINUTE_MS = 60_000;

// The minutes the turn has left, beside its clock time. Rounded down, so the page never promises
// more than the server gives; soon = the last two minutes. undefined once it is up: the next
// heartbeat shows the turn expired.
export const turnTimeLeft = (
  endsAt: number,
  now: number,
): { text: string; soon: boolean } | undefined => {
  const left = endsAt - now;
  if (left <= 0) return undefined;
  const minutes = Math.floor(left / MINUTE_MS);
  return {
    text: minutes === 0 ? 'เหลือไม่ถึง 1 นาที' : `เหลืออีก ${minutes} นาที`,
    soon: left < 2 * MINUTE_MS,
  };
};

export const admittedHeadline = (admittedUntil: string): string => {
  const { lead, until, time } = admittedParts(admittedUntil);
  return `${lead} ${until} ${time}`;
};

// The line in the always-mounted live region. It depends on the state alone (never the position),
// so it changes, and is announced, only on a transition.
export const queueHeadline = (view: QueueView): string => {
  switch (view.kind) {
    case 'off':
      return '';
    case 'failed':
      return view.message;
    case 'admitted':
      return admittedHeadline(view.admittedUntil);
    default:
      return QUEUE_MESSAGES[view.kind];
  }
};

const viewOf = (
  open: boolean,
  data: StudentQueueResponse | undefined,
  error: unknown,
  receivedAt: number,
): QueueView => {
  if (!open) return { kind: 'off' };
  if (data === undefined) {
    return error
      ? {
          kind: 'failed',
          message: messageFor(
            error,
            JOIN_ERRORS,
            QUEUE_MESSAGES.joinUnknown,
            QUEUE_MESSAGES.joinFallback,
          ),
        }
      : { kind: 'joining' };
  }
  const { ticket } = data;
  switch (ticket?.status) {
    case 'waiting':
      return { kind: 'waiting', position: ticket.position };
    case 'admitted':
      return {
        kind: 'admitted',
        admittedUntil: ticket.admittedUntil,
        endsAt: turnEndsAt(ticket.secondsLeft, receivedAt),
      };
    case 'done':
      return { kind: 'done' };
    // No ticket at all (never queued in this round) is offered the same way back in.
    default:
      return { kind: 'expired' };
  }
};

// The admission a club confirmation is opened in: its deadline is fixed when the student is let
// in, so a later admission has another (endsAt moves a little with every answer, so never it). undefined outside an admission.
export const queueTurn = (view: QueueView): string | undefined =>
  view.kind === 'admitted' ? view.admittedUntil : undefined;

// A club confirmation stays on screen in the admission it was opened in, so one left open when the
// turn ended does not come back with the next. Once the queue is off (the round closed under it)
// it stays as it did before the queue, so its answer (likely round_not_open) still explains.
export const isInTurn = (view: QueueView, openedIn: string | undefined): boolean =>
  view.kind === 'off' || (view.kind === 'admitted' && view.admittedUntil === openedIn);

export const showsClubs = (view: QueueView): boolean =>
  view.kind === 'off' || view.kind === 'admitted';

// The queue in front of an open round (README Phase 3, Q3). Only an open round with a queue is
// queued for: an upcoming or closed one, or one without a queue (hasQueue false, Q4), makes no
// queue call, and the page shows it as before the queue. When an upcoming round opens (the club
// list's own timer), or an admin turns the queue on mid-round (the round read says hasQueue
// true), the query is enabled and joins, once.
// The round comes from GET /api/student/round (Q2: the club list answers 403 queue_required while
// the student waits, so it cannot be what tells the page the round is open).
export const useQueue = (round: StudentRound | null) => {
  const queryClient = useQueryClient();
  const queued = isQueued(round);
  const queueOff = round?.status === 'open' && !round.hasQueue;
  const roundId = round?.id ?? 0;
  const queryKey = queueQueryKey(roundId);
  const query = useQuery({
    ...TICKET_QUERY_OPTIONS,
    queryKey,
    queryFn: syncQueue,
    enabled: queued,
  });
  useLogoutOnExpiredSession(query.error);
  // A disabled query keeps its data while the page observes it (gcTime 0 only drops it once
  // nobody does). So once the queue is off, the ticket shown before is dropped: should the queue
  // come back on while the page is open, the query has no ticket and joins (the API answers the
  // old ticket if it is still live) instead of heartbeating one that ran out meanwhile and showing
  // "expired". Disabled at this point, so the reset fetches nothing.
  useEffect(() => {
    if (queueOff) {
      void queryClient.resetQueries({ queryKey: queueQueryKey(roundId), exact: true });
    }
  }, [queryClient, queueOff, roundId]);

  const release = useMutation({
    mutationFn: releaseQueue,
    retry: retryRead,
    // A heartbeat answered after the release would show the ticket admitted again.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey, exact: true });
    },
    onSuccess: (response) => {
      queryClient.setQueryData(queryKey, response);
    },
  });
  useLogoutOnExpiredSession(release.error);

  const view = viewOf(queued, query.data, query.error, query.dataUpdatedAt);
  return {
    view,
    // A heartbeat failed after the ticket was shown; the interval keeps trying. A queue_off is no
    // lost connection: the round read it caused switches the page to the list.
    connectionLost: query.isRefetchError && isLive(query.data?.ticket) && !isQueueOff(query.error),
    // To the back of the queue: the ticket is dropped, and the refetch with none joins.
    rejoin: () => {
      release.reset();
      void queryClient.resetQueries({ queryKey, exact: true });
    },
    release: {
      start: () => release.mutate(),
      pending: release.isPending,
      error: release.isError
        ? messageFor(
            release.error,
            RELEASE_ERRORS,
            QUEUE_MESSAGES.releaseUnknown,
            QUEUE_MESSAGES.releaseFallback,
          )
        : undefined,
    },
  };
};

export type Queue = ReturnType<typeof useQueue>;

// A queue_required answer (Q2) to the club list: the turn ended (or the round opened) since the
// page last looked. The ticket query asks again, which, the ticket being over, ends in its
// heartbeat's not_in_queue and a read that shows it expired, with the "join again" button. Never a
// reset: a ticket query without data would join, and joining again is the student's own click.
// The round is read again too, for when it opened by the API's clock before the page saw it.
// Writes need nothing of their own here: every write's settlement invalidates all student queries
// (and the list refetched by it may then answer queue_required too). cancelRefetch: false joins a
// fetch already on its way instead of sending another, and a ticket already shown as ended needs
// no new answer. When the page thinks the round is not open yet, the round read alone does it:
// once it says open, the ticket query starts and joins, as for any round opening on screen. The
// same goes for a queue an admin turned on mid-round (Q4): the page showed the list without a
// queue, so the ticket query has no data (useQueue drops it while the queue is off) and is not
// asked here; the round read says hasQueue true, and the ticket query joins once. A list that
// keeps answering queue_required while the round read still says no queue asks for one round read
// per answer, at the list's own poll interval: no loop.
export const useBackToQueue = (error: unknown, roundId: number | undefined) => {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isQueueRequired(error) || roundId === undefined) return;
    const queryKey = queueQueryKey(roundId);
    const shown = queryClient.getQueryData<StudentQueueResponse>(queryKey);
    // Only a ticket shown live: one with no answer yet is joining (or the queue is off), and
    // asking that query again would join a second time.
    if (shown !== undefined && isLive(shown.ticket)) {
      void queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
    }
    void queryClient.invalidateQueries(
      { queryKey: STUDENT_ROUND_QUERY_KEY, exact: true },
      { cancelRefetch: false },
    );
  }, [error, queryClient, roundId]);
};

// The ticket as the result page shows it: only while it is live.
export type QueueTurn =
  | { kind: 'none' }
  | { kind: 'waiting'; position: number }
  | { kind: 'admitted'; admittedUntil: string; endsAt: number };

// Keeps the student's ticket alive from the result page (README Phase 3, Q2): a student who went
// there to cancel, or to leave a waitlist, keeps their place in the queue. It never joins: on
// mount it reads the ticket, and only a live one gets heartbeats, until it ends (not_in_queue →
// a read), the round is not open any more (by the page's round or the queue's own answer), or the
// page goes. No ticket, or one that ended, shows nothing.
export const useQueueKeepalive = (round: StudentRound | null | undefined): QueueTurn => {
  const queued = isQueued(round);
  const query = useQuery({
    ...TICKET_QUERY_OPTIONS,
    queryKey: keepaliveQueryKey(round?.id ?? 0),
    queryFn: keepQueueAlive,
    // Not for a round without a queue (Q4); a heartbeat answered queue_off reads the round again,
    // and its hasQueue false stops this.
    enabled: queued,
    refetchInterval: (current: TicketQuery) =>
      hasLiveTicket(current) && isQueued(current.state.data?.round) ? HEARTBEAT_INTERVAL_MS : false,
  });
  useLogoutOnExpiredSession(query.error);
  const ticket = queued ? query.data?.ticket : undefined;
  switch (ticket?.status) {
    case 'waiting':
      return { kind: 'waiting', position: ticket.position };
    case 'admitted':
      return {
        kind: 'admitted',
        admittedUntil: ticket.admittedUntil,
        endsAt: turnEndsAt(ticket.secondsLeft, query.dataUpdatedAt),
      };
    default:
      return { kind: 'none' };
  }
};
