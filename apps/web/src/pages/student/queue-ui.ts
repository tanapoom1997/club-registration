import { ERROR_CODES } from '@club-registration/shared';
import type { QueueTicket, StudentQueueResponse, StudentRound } from '@club-registration/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query, QueryFunctionContext } from '@tanstack/react-query';
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
type QueueQueryKey = ReturnType<typeof queueQueryKey>;

const isLive = (ticket: QueueTicket | null | undefined): boolean =>
  ticket?.status === 'waiting' || ticket?.status === 'admitted';

const isApiError = (error: unknown, code: string): boolean =>
  error instanceof ApiError && error.code === code;

// One query holds the ticket, and every fetch of it does the one call the ticket needs: no ticket
// yet (this visit) → join, live → heartbeat, ended → a read. So whatever refetches it (the
// interval, the tab becoming visible again, the invalidation after a write, React StrictMode
// mounting twice) can never join a second time or rejoin after the ticket ended; joining again
// is the student's own click. A POST in a query: the heartbeat writes, but the same heartbeat sent
// twice changes nothing more, and polling is what queries are for.
const syncQueue = async ({
  client,
  queryKey,
}: QueryFunctionContext<QueueQueryKey>): Promise<StudentQueueResponse> => {
  const current = client.getQueryData<StudentQueueResponse>(queryKey);
  if (current === undefined) {
    try {
      return await joinQueue();
    } catch (error) {
      // The round closed (or moved) since the club list said open: refresh it, and the page
      // falls back to the round's own status without the queue.
      if (isApiError(error, ERROR_CODES.roundNotOpen)) {
        await client.invalidateQueries({ queryKey: STUDENT_CLUBS_QUERY_KEY });
      }
      throw error;
    }
  }
  if (!isLive(current.ticket)) return await fetchQueue();
  try {
    return await queueHeartbeat();
  } catch (error) {
    // The ticket ended (timed out, released in another tab): the read says which, without
    // joining again.
    if (isApiError(error, ERROR_CODES.notInQueue)) return await fetchQueue();
    throw error;
  }
};

const hasLiveTicket = (
  query: Query<StudentQueueResponse, Error, StudentQueueResponse, QueueQueryKey>,
) => isLive(query.state.data?.ticket);

export type QueueView =
  | { kind: 'off' }
  | { kind: 'joining' }
  | { kind: 'failed'; message: string }
  | { kind: 'waiting'; position: number }
  | { kind: 'admitted'; admittedUntil: string }
  | { kind: 'expired' }
  | { kind: 'done' };

const JOIN_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ...COMMON_ERRORS,
  [ERROR_CODES.roundNotOpen]: 'เข้าคิวไม่ได้ เพราะตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน กำลังโหลดข้อมูลรอบล่าสุด',
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
  keepOpen: 'อย่าปิดหรือสลับไปหน้าอื่นนาน ระบบอาจถือว่าออกจากคิว',
  connectionLost: 'เชื่อมต่อระบบไม่ได้ชั่วคราว กำลังลองใหม่ ถ้าหลุดนานเกิน 1 นาทีอาจต้องเข้าคิวใหม่',
  expiredHelp:
    'หน้านี้ไม่ได้ติดต่อระบบนานเกินไป (เช่น ปิดหรือสลับไปหน้าอื่นนาน) หรือครบเวลาที่ให้เลือกชุมนุมแล้ว ชุมนุมที่ลงไว้แล้วยังอยู่ ถ้าจะเลือกต่อ กดเข้าคิวใหม่ (ต่อท้ายคิว)',
  doneHelp: 'ชุมนุมที่ลงไว้แล้วยังอยู่ ถ้าจะเลือกใหม่ กดเข้าคิวใหม่ (ต่อท้ายคิว)',
  releaseUnknown: 'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าปล่อยคิวแล้วหรือไม่ กดอีกครั้งได้ (ปล่อยซ้ำไม่มีผลเสีย)',
  releaseFallback: 'ปล่อยคิวไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
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

export const admittedHeadline = (admittedUntil: string): string =>
  `ถึงคิวของคุณแล้ว เลือกชุมนุมได้ถึง ${formatThaiTime(admittedUntil)} น.`;

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
      return { kind: 'admitted', admittedUntil: ticket.admittedUntil };
    case 'done':
      return { kind: 'done' };
    // No ticket at all (never queued in this round) is offered the same way back in.
    default:
      return { kind: 'expired' };
  }
};

// The admission a club confirmation is opened in: its deadline is fixed when the student is let
// in, so a later admission has another. undefined outside an admission.
export const queueTurn = (view: QueueView): string | undefined =>
  view.kind === 'admitted' ? view.admittedUntil : undefined;

// A club confirmation stays on screen in the admission it was opened in, so one left open when the
// turn ended does not come back with the next. Once the queue is off (the round closed under it)
// it stays as it did before the queue, so its answer (likely round_not_open) still explains.
export const isInTurn = (view: QueueView, openedIn: string | undefined): boolean =>
  view.kind === 'off' || (view.kind === 'admitted' && view.admittedUntil === openedIn);

export const showsClubs = (view: QueueView): boolean =>
  view.kind === 'off' || view.kind === 'admitted';

// The queue in front of an open round (README Phase 3, Q3). Only an open round is queued for: an
// upcoming or closed one makes no queue call, and the page shows it as before. When an upcoming
// round opens (the club list's own timer), the query is enabled and joins.
export const useQueue = (round: StudentRound | null) => {
  const queryClient = useQueryClient();
  const open = round?.status === 'open';
  const queryKey = queueQueryKey(round?.id ?? 0);
  const query = useQuery({
    queryKey,
    queryFn: syncQueue,
    enabled: open,
    // Gone as soon as the page is: coming back to the page is a new visit that joins again (a
    // live ticket is answered as it is, so nobody loses their place by it).
    gcTime: 0,
    retry: retryRead,
    refetchInterval: (current) => (hasLiveTicket(current) ? HEARTBEAT_INTERVAL_MS : false),
    // Hidden tabs get their timers throttled (Chrome down to about once a minute), which is the
    // idle timeout. The beats still run when they can, and returning to the tab sends one at
    // once (TanStack's focus manager listens to visibilitychange).
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: hasLiveTicket,
  });
  useLogoutOnExpiredSession(query.error);

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

  const view = viewOf(open, query.data, query.error);
  return {
    view,
    // A heartbeat failed after the ticket was shown; the interval keeps trying.
    connectionLost: query.isRefetchError && isLive(query.data?.ticket),
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
