import { ERROR_CODES } from '@club-registration/shared';
import type {
  StudentClubsResponse,
  StudentRegistration,
  StudentRegistrationResponse,
  StudentRound,
  StudentRoundResponse,
} from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError } from '@/lib/api';
import { useSetSession } from '@/lib/session';

const UNAUTHORIZED = 401;
const SERVER_ERROR = 500;
const MAX_READ_RETRIES = 3;

// One prefix, so a write refreshes both student pages with a single invalidation.
export const STUDENT_QUERY_KEY = Object.freeze(['student'] as const);
export const STUDENT_ROUND_QUERY_KEY = Object.freeze([...STUDENT_QUERY_KEY, 'round'] as const);
export const STUDENT_CLUBS_QUERY_KEY = Object.freeze([...STUDENT_QUERY_KEY, 'clubs'] as const);

// While the round is open, seats change under the student's eyes.
export const CLUBS_POLL_INTERVAL_MS = 5_000;
// The next status change is timed by the phone's clock, which may be off. The cap bounds how late
// a slow clock notices it; the floor keeps a fast clock from refetching in a tight loop while the
// server still says "upcoming".
const STATUS_CHECK_MAX_MS = 30_000;
const STATUS_CHECK_MIN_MS = 2_000;
// Spreads the refetch of a whole grade waiting on the same opening time over a second.
const STATUS_CHECK_JITTER_MS = 1_000;

const untilNextStatusChange = (round: StudentRound, now: number): number => {
  const boundary = round.status === 'upcoming' ? round.opensAt : round.closesAt;
  const delay = Date.parse(boundary) - now + Math.random() * STATUS_CHECK_JITTER_MS;
  return Math.min(Math.max(delay, STATUS_CHECK_MIN_MS), STATUS_CHECK_MAX_MS);
};

// The server decides the status on every answer; the page only chooses when to ask again. A round
// waiting to open is asked again when it should open, so the page switches without a reload.
export const clubsRefetchInterval = (round: StudentRound | null | undefined): number | false => {
  if (!round || round.status === 'closed') return false;
  return round.status === 'open'
    ? CLUBS_POLL_INTERVAL_MS
    : untilNextStatusChange(round, Date.now());
};

// The result page only needs the status, to show or hide the cancel button at the right time.
export const roundRefetchInterval = (round: StudentRound | null | undefined): number | false =>
  !round || round.status === 'closed' ? false : untilNextStatusChange(round, Date.now());

// A refused request (4xx) will be refused again; only network and server failures are retried.
export const retryRead = (failureCount: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status < SERVER_ERROR) && failureCount < MAX_READ_RETRIES;

// No answer from our server (network down, proxy gateway error, unreadable reply) means the write
// may have been applied with only the reply lost. Retrying with the same idempotency key is then
// the one safe move: the server replays it instead of acting twice. A 500 from the API itself has
// rolled back, so the same key is simply processed again.
export const isOutcomeUnknown = (error: unknown): boolean =>
  !(error instanceof ApiError) || error.status >= SERVER_ERROR;

const COMMON_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.idempotencyKeyReused]: 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง',
  [ERROR_CODES.rateLimited]: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  [ERROR_CODES.studentProfileMissing]:
    'บัญชีนี้ยังไม่มีข้อมูลชั้นเรียน กรุณาติดต่อผู้ดูแลระบบหรือครูที่ดูแลการลงทะเบียน',
  [ERROR_CODES.unauthorized]: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่',
});

const REGISTER_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ...COMMON_ERRORS,
  [ERROR_CODES.clubFull]: 'ชุมนุมนี้เต็มแล้ว กรุณาเลือกชุมนุมอื่น',
  [ERROR_CODES.alreadyRegistered]:
    'คุณลงชุมนุมอื่นในรอบนี้ไว้แล้ว ถ้าจะเปลี่ยนต้องยกเลิกชุมนุมเดิมที่หน้า "ผลของฉัน" ก่อน',
  [ERROR_CODES.roundNotOpen]: 'ตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน (ยังไม่เปิดหรือปิดไปแล้ว)',
  [ERROR_CODES.notFound]: 'ไม่พบชุมนุมนี้แล้ว รายการอาจเปลี่ยนไป กรุณาดูรายการล่าสุด',
});

const CANCEL_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ...COMMON_ERRORS,
  [ERROR_CODES.roundNotOpen]: 'ยกเลิกไม่ได้ เพราะรอบนี้ไม่ได้เปิดอยู่แล้ว',
  [ERROR_CODES.notRegistered]: 'คุณไม่มีชุมนุมที่ลงไว้ในรอบนี้ (อาจยกเลิกไปแล้ว)',
});

const messageFor = (
  messages: Readonly<Record<string, string>>,
  unknownOutcome: string,
  fallback: string,
  error: unknown,
): string =>
  isOutcomeUnknown(error)
    ? unknownOutcome
    : ((error instanceof ApiError ? messages[error.code] : undefined) ?? fallback);

export const registerErrorMessage = (error: unknown): string =>
  messageFor(
    REGISTER_ERRORS,
    'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าลงทะเบียนสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ลงซ้ำ)',
    'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
    error,
  );

export const cancelErrorMessage = (error: unknown): string =>
  messageFor(
    CANCEL_ERRORS,
    'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่ายกเลิกสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ทำซ้ำ)',
    'ยกเลิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
    error,
  );

export const isProfileMissing = (error: unknown): boolean =>
  error instanceof ApiError && error.code === ERROR_CODES.studentProfileMissing;

// A session that expires while the page polls sends the student back to the login page.
export const useLogoutOnExpiredSession = (error: unknown) => {
  const setSession = useSetSession();
  useEffect(() => {
    if (error instanceof ApiError && error.status === UNAUTHORIZED) setSession(null);
  }, [error, setSession]);
};

const withRegistration = <T extends StudentRoundResponse>(
  data: T | undefined,
  registration: StudentRegistration | null,
): T | undefined => (data ? { ...data, registration } : data);

// One write per confirmation. start() makes a new idempotency key for a new confirmation;
// retry() sends the last request again with its key, for when the outcome is unknown.
export const useStudentWrite = <TVariables extends object>(
  write: (request: TVariables & { idempotencyKey: string }) => Promise<StudentRegistrationResponse>,
) => {
  const queryClient = useQueryClient();
  const setSession = useSetSession();
  const mutation = useMutation({
    mutationFn: write,
    // Shown at once; the refetch below then brings the seat counts up to date.
    onSuccess: ({ registration }) => {
      queryClient.setQueryData<StudentClubsResponse>(STUDENT_CLUBS_QUERY_KEY, (data) =>
        withRegistration(data, registration),
      );
      queryClient.setQueryData<StudentRoundResponse>(STUDENT_ROUND_QUERY_KEY, (data) =>
        withRegistration(data, registration),
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === UNAUTHORIZED) setSession(null);
    },
    // Whatever the answer (a full club, a seat held elsewhere, no answer at all), what is on
    // screen may be stale now.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: STUDENT_QUERY_KEY });
    },
  });
  const { variables, mutate } = mutation;
  return {
    mutation,
    start: (request: TVariables) => mutate({ ...request, idempotencyKey: crypto.randomUUID() }),
    retry: () => {
      if (variables) mutate(variables);
    },
    canRetry: mutation.isError && isOutcomeUnknown(mutation.error),
  };
};
