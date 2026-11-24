import { ERROR_CODES } from '@club-registration/shared';
import type {
  AdminChangeKind,
  RoundStatus,
  StudentAdminChange,
  StudentClub,
  StudentClubsResponse,
  StudentRegistration,
  StudentRegistrationResponse,
  StudentRound,
  StudentRoundResponse,
  StudentWaitlist,
  StudentWaitlistResponse,
} from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  ApiError,
  cancelRegistration,
  changeRegistration,
  isOutcomeUnknown,
  joinWaitlist,
  leaveWaitlist,
  registerForClub,
} from '@/lib/api';
import { refetchWhileOpen, untilNextStatusChange } from '@/lib/round-refetch';
import { formatThaiDateTime } from '@/lib/thai-time';
import { useSetSession } from '@/lib/session';

const UNAUTHORIZED = 401;
const MAX_READ_RETRIES = 3;

// One prefix, so a write refreshes both student pages with a single invalidation.
export const STUDENT_QUERY_KEY = Object.freeze(['student'] as const);
export const STUDENT_ROUND_QUERY_KEY = Object.freeze([...STUDENT_QUERY_KEY, 'round'] as const);
export const STUDENT_CLUBS_QUERY_KEY = Object.freeze([...STUDENT_QUERY_KEY, 'clubs'] as const);

// While the round is open, seats change under the student's eyes.
export const CLUBS_POLL_INTERVAL_MS = 5_000;

// The server decides the status on every answer; the page only chooses when to ask again. A round
// waiting to open is asked again when it should open, so the page switches without a reload.
export const clubsRefetchInterval = (round: StudentRound | null | undefined): number | false =>
  refetchWhileOpen(round, CLUBS_POLL_INTERVAL_MS);

// The result page needs the status, to show or hide the buttons at the right time. A student on a
// waitlist learns of a promotion from the web page only (README Phase 2, decision 2), so while
// they wait in an open round it polls as often as the club list.
export const roundRefetchInterval = (
  round: StudentRound | null | undefined,
  waitlist: StudentWaitlist | null | undefined,
): number | false => {
  if (!round || round.status === 'closed') return false;
  if (round.status === 'open' && waitlist) return CLUBS_POLL_INTERVAL_MS;
  return untilNextStatusChange(round);
};

// A refused request (4xx) will be refused again; only network and server failures are retried.
export const retryRead = (failureCount: number, error: unknown): boolean =>
  isOutcomeUnknown(error) && failureCount < MAX_READ_RETRIES;

// What a club card offers. join: the club is full, or others already wait for it (a free seat
// with waiters is theirs first, README waitlist rule 2), so the server would answer club_full to
// register and change alike.
export type ClubWriteKind = 'register' | 'change' | 'join';
export type StudentWriteKind = ClubWriteKind | 'cancel' | 'leave';
export type ClubOffer = ClubWriteKind | 'none';

export const isSeatFree = ({ remaining, waitlistCount }: StudentClub): boolean =>
  remaining > 0 && waitlistCount === 0;

// The club held or waited for needs no button, and neither does a club that takes no one
// (capacity 0, README waitlist rule 9). Outside the open window a student without a club still
// sees the button they will get (disabled), as before; one holding a club sees none.
export const clubOffer = (
  club: StudentClub,
  {
    round,
    registration,
    waitlist,
  }: Pick<StudentRoundResponse, 'registration' | 'waitlist'> & { round: StudentRound },
): ClubOffer => {
  if (registration?.club.id === club.id || waitlist?.club.id === club.id) return 'none';
  if (club.capacity <= 0) return 'none';
  if (registration && round.status !== 'open') return 'none';
  if (!isSeatFree(club)) return 'join';
  return registration ? 'change' : 'register';
};

export const COMMON_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.idempotencyKeyReused]: 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง',
  [ERROR_CODES.rateLimited]: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  [ERROR_CODES.studentProfileMissing]: 'บัญชีนี้ยังไม่มีข้อมูลชั้นเรียน กรุณาติดต่อผู้ดูแลระบบหรือครูที่ดูแลการลงทะเบียน',
  [ERROR_CODES.unauthorized]: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่',
});

const ROUND_NOT_OPEN = 'ตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน (ยังไม่เปิดหรือปิดไปแล้ว)';
// queue_required (Q2): the turn ended before the request reached the server, or (Q4) an admin
// turned the queue on while the student chose without one. Shown only until the page has read
// the ticket or the round again and put the queue card back (with its "join again" button, or
// joining by itself).
const QUEUE_REQUIRED = 'ตอนนี้ต้องได้คิวก่อนจึงจะเลือกชุมนุมได้ (คิวของคุณหมดเวลา หรือรอบนี้เพิ่งเริ่มใช้คิว)';
const CLUB_NOT_FOUND = 'ไม่พบชุมนุมนี้แล้ว รายการอาจเปลี่ยนไป กรุณาดูรายการล่าสุด';

type WriteMessages = {
  // Codes the server may answer for this kind of write.
  errors: Readonly<Record<string, string>>;
  // No answer: the write may or may not have happened.
  unknownOutcome: string;
  // Any other refusal.
  fallback: string;
};

// Every student-facing write message, by kind of write.
const WRITE_MESSAGES: Readonly<Record<StudentWriteKind, WriteMessages>> = Object.freeze({
  register: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.clubFull]: 'ชุมนุมนี้เต็มแล้วหรือมีคนรอที่ว่างอยู่ เข้ารายชื่อรอของชุมนุมนี้ได้ หรือเลือกชุมนุมอื่น',
      [ERROR_CODES.alreadyRegistered]:
        'คุณลงชุมนุมอื่นในรอบนี้ไว้แล้ว ถ้าจะเปลี่ยน กด "ย้ายมาชุมนุมนี้" ที่ชุมนุมที่ยังมีที่ว่าง',
      [ERROR_CODES.roundNotOpen]: ROUND_NOT_OPEN,
      [ERROR_CODES.queueRequired]: QUEUE_REQUIRED,
      [ERROR_CODES.notFound]: CLUB_NOT_FOUND,
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าลงทะเบียนสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ลงซ้ำ)',
    fallback: 'ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
  change: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.clubFull]:
        'ย้ายไม่สำเร็จ เพราะชุมนุมนี้เต็มแล้วหรือมีคนรอที่ว่างอยู่ คุณยังอยู่ชุมนุมเดิม ถ้ายังอยากได้ชุมนุมนี้ เข้ารายชื่อรอได้',
      [ERROR_CODES.notRegistered]:
        'คุณยังไม่มีชุมนุมในรอบนี้ (อาจยกเลิกไปแล้ว) กรุณาดูรายการล่าสุดแล้วกด "ลงชุมนุม" แทน',
      [ERROR_CODES.roundNotOpen]: ROUND_NOT_OPEN,
      [ERROR_CODES.queueRequired]: QUEUE_REQUIRED,
      [ERROR_CODES.notFound]: CLUB_NOT_FOUND,
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าย้ายชุมนุมสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ย้ายซ้ำ)',
    fallback: 'ย้ายชุมนุมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
  join: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.alreadyInClub]: 'คุณอยู่ในชุมนุมนี้แล้ว ไม่ต้องเข้ารายชื่อรอ',
      [ERROR_CODES.waitlistNotNeeded]:
        'ชุมนุมนี้มีที่ว่างแล้ว ไม่ต้องรอ กรุณาดูรายการล่าสุดแล้วลงหรือย้ายมาชุมนุมนี้ได้เลย',
      [ERROR_CODES.clubNotAccepting]: 'ชุมนุมนี้ไม่เปิดรับในรอบนี้ จึงไม่มีรายชื่อรอ กรุณาเลือกชุมนุมอื่น',
      [ERROR_CODES.roundNotOpen]: 'เข้ารายชื่อรอไม่ได้ เพราะตอนนี้ไม่อยู่ในช่วงเปิดลงทะเบียน',
      [ERROR_CODES.queueRequired]: QUEUE_REQUIRED,
      [ERROR_CODES.notFound]: CLUB_NOT_FOUND,
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าเข้ารายชื่อรอสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่เข้าซ้ำ)',
    fallback: 'เข้ารายชื่อรอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
  cancel: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.roundNotOpen]: 'ยกเลิกไม่ได้ เพราะรอบนี้ไม่ได้เปิดอยู่แล้ว',
      [ERROR_CODES.notRegistered]: 'คุณไม่มีชุมนุมที่ลงไว้ในรอบนี้ (อาจยกเลิกไปแล้ว)',
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่ายกเลิกสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ทำซ้ำ)',
    fallback: 'ยกเลิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
  leave: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.roundNotOpen]: 'ออกจากรายชื่อรอไม่ได้ เพราะรอบนี้ไม่ได้เปิดอยู่แล้ว',
      [ERROR_CODES.notWaitlisted]:
        'คุณไม่ได้อยู่ในรายชื่อรอของรอบนี้แล้ว (อาจได้ที่แล้วหรือออกไปแล้ว) กรุณาดูสถานะล่าสุด',
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าออกจากรายชื่อรอสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ทำซ้ำ)',
    fallback: 'ออกจากรายชื่อรอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
});

export const writeErrorMessage = (kind: StudentWriteKind, error: unknown): string => {
  const { errors, unknownOutcome, fallback } = WRITE_MESSAGES[kind];
  if (isOutcomeUnknown(error)) return unknownOutcome;
  return (error instanceof ApiError ? errors[error.code] : undefined) ?? fallback;
};

// club_full to a register or change: the card can offer that club's waitlist straight away.
export const isClubFull = (error: unknown): boolean =>
  error instanceof ApiError && error.code === ERROR_CODES.clubFull;

export const isProfileMissing = (error: unknown): boolean =>
  error instanceof ApiError && error.code === ERROR_CODES.studentProfileMissing;

const clubName = ({ clubCode, name }: { clubCode: string; name: string }) => `${clubCode} ${name}`;

// The notice for a promotion off the waitlist. Shown from data (promotedFromWaitlist), so it is
// there after a reload too, and appears by itself when a poll brings the new seat.
export const promotedNotice = (registration: StudentRegistration): string =>
  `ได้ที่ในชุมนุม ${clubName(registration.club)} จากรายชื่อรอแล้ว`;

const AFTER_CLOSE = 'รอบนี้ปิดแล้ว ถ้ามีข้อสงสัยกรุณาติดต่อครูที่ดูแลการลงทะเบียน';

// The notices of what an admin did to the student's seat or waitlist place (README Phase 4, P3).
// Never who: the answer has no admin in it to name.
const adminChangeSays = (change: StudentAdminChange): string => {
  switch (change.kind) {
    case 'assigned':
      return `ผู้ดูแลระบบจัดให้คุณอยู่ชุมนุม ${clubName(change.club)}`;
    case 'moved':
      return `ผู้ดูแลระบบย้ายคุณจากชุมนุม ${clubName(change.fromClub)} ไปชุมนุม ${clubName(change.club)}`;
    case 'removed':
      return `ผู้ดูแลระบบนำคุณออกจากชุมนุม ${clubName(change.club)}`;
    case 'waitlist_removed':
      return `ผู้ดูแลระบบนำคุณออกจากรายชื่อรอของชุมนุม ${clubName(change.club)}`;
  }
};

// After a removal, what the student can do now, by the round's status (admins fix closed rounds
// too, PR 3a). A seat given needs nothing more.
const ADMIN_CHANGE_NEXT: Readonly<Partial<Record<AdminChangeKind, Record<RoundStatus, string>>>> =
  Object.freeze({
    removed: {
      open: 'ตอนนี้คุณยังไม่มีชุมนุมในรอบนี้ เลือกชุมนุมใหม่ได้ระหว่างที่รอบยังเปิดอยู่',
      upcoming: 'ตอนนี้คุณยังไม่มีชุมนุมในรอบนี้ เลือกชุมนุมได้เมื่อรอบเปิด',
      closed: AFTER_CLOSE,
    },
    waitlist_removed: {
      open: 'ถ้ายังอยากได้ชุมนุมนี้ เข้ารายชื่อรอใหม่ได้ระหว่างที่รอบยังเปิดอยู่ (จะได้ลำดับท้ายคิว)',
      upcoming: 'ถ้ายังอยากได้ชุมนุมนี้ เข้ารายชื่อรอใหม่ได้เมื่อรอบเปิด',
      closed: AFTER_CLOSE,
    },
  });

export const isAdminRemoval = ({ kind }: StudentAdminChange): boolean =>
  kind === 'removed' || kind === 'waitlist_removed';

// The whole notice as one sentence, so a screen reader reads it in one go: what, when (Thai
// time) and, after a removal, what next. Only absolute values, so a poll that brings the same
// answer leaves the text, and so the live region, untouched.
export const adminChangeNotice = (change: StudentAdminChange, status: RoundStatus): string => {
  const sentence = `${adminChangeSays(change)} เมื่อ ${formatThaiDateTime(change.at)} น.`;
  const next = ADMIN_CHANGE_NEXT[change.kind];
  return next ? `${sentence} ${next[status]}` : sentence;
};

// What a successful write says, from the answer rather than from the club the student picked: a
// change or cancel can cascade (README Phase 2, "คำตอบหลัง promote") and a replayed key answers
// with the state now.
export const writeSuccessNotice = (kind: StudentWriteKind, result: StudentWriteResult): string => {
  if ('waitlist' in result) {
    const { waitlist } = result;
    if (kind === 'leave') return waitlist ? 'ยังอยู่ในรายชื่อรอ กรุณาดูสถานะล่าสุด' : 'ออกจากรายชื่อรอแล้ว';
    return waitlist
      ? `เข้ารายชื่อรอชุมนุม ${clubName(waitlist.club)} แล้ว ลำดับที่ ${waitlist.position}`
      : 'ไม่ได้อยู่ในรายชื่อรอ กรุณาดูรายการล่าสุดแล้วลองใหม่';
  }
  const { registration } = result;
  if (kind === 'cancel') {
    return registration ? 'ยกเลิกชุมนุมเดิมแล้ว' : 'ยกเลิกชุมนุมแล้ว';
  }
  if (!registration) return 'ยังไม่ได้ลงชุมนุมนี้ กรุณาดูรายการล่าสุดแล้วลองใหม่';
  // The change freed a seat whose cascade then promoted the student off their own waitlist entry;
  // the promoted notice beside it says which club, so this one does not repeat it.
  if (registration.promotedFromWaitlist) return 'ย้ายชุมนุมแล้ว และได้ที่จากรายชื่อรอต่อ';
  return kind === 'change'
    ? `ย้ายมาชุมนุม ${clubName(registration.club)} เรียบร้อยแล้ว`
    : `ลงชุมนุม ${clubName(registration.club)} เรียบร้อยแล้ว`;
};

// A join's notice names a place in a queue. Once the data shows no such entry any more (the
// student got the seat, an admin removed them), it would contradict the page beside the promoted
// notice, so it is no longer shown. Derived from the data, so no effect has to clear it.
export const isNoticeOutdated = (
  kind: StudentWriteKind,
  result: StudentWriteResult,
  waitlist: StudentWaitlist | null,
): boolean =>
  kind === 'join' &&
  'waitlist' in result &&
  result.waitlist !== null &&
  waitlist?.club.id !== result.waitlist.club.id;

// A session that expires while the page polls sends the student back to the login page.
export const useLogoutOnExpiredSession = (error: unknown) => {
  const setSession = useSetSession();
  useEffect(() => {
    if (error instanceof ApiError && error.status === UNAUTHORIZED) setSession(null);
  }, [error, setSession]);
};

export type StudentWriteRequest =
  { kind: ClubWriteKind; clubId: number } | { kind: 'cancel' | 'leave' };
export type StudentWriteResult = StudentRegistrationResponse | StudentWaitlistResponse;

// The API bodies are strict, so only clubId and the key are sent, never the kind.
const sendStudentWrite = async (
  request: StudentWriteRequest & { idempotencyKey: string },
): Promise<StudentWriteResult> => {
  const { idempotencyKey } = request;
  switch (request.kind) {
    case 'register':
      return await registerForClub({ clubId: request.clubId, idempotencyKey });
    case 'change':
      return await changeRegistration({ clubId: request.clubId, idempotencyKey });
    case 'join':
      return await joinWaitlist({ clubId: request.clubId, idempotencyKey });
    case 'cancel':
      return await cancelRegistration({ idempotencyKey });
    case 'leave':
      return await leaveWaitlist({ idempotencyKey });
  }
};

// The answer names the registration or the waitlist entry as it stands now; the rest of the
// cached page is brought up to date by the refetch.
const withWriteResult = <T extends StudentRoundResponse>(
  data: T | undefined,
  result: StudentWriteResult,
): T | undefined => (data ? { ...data, ...result } : data);

// One write per confirmation, whatever its kind, so one pending state disables every button on
// the page. start() makes a new idempotency key for a new confirmation; retry() sends the last
// request again with its key, for when the outcome is unknown.
export const useStudentWrite = () => {
  const queryClient = useQueryClient();
  const setSession = useSetSession();
  const mutation = useMutation({
    mutationFn: sendStudentWrite,
    // Shown at once; the refetch below then brings the seat counts up to date.
    onSuccess: (result) => {
      queryClient.setQueryData<StudentClubsResponse>(STUDENT_CLUBS_QUERY_KEY, (data) =>
        withWriteResult(data, result),
      );
      queryClient.setQueryData<StudentRoundResponse>(STUDENT_ROUND_QUERY_KEY, (data) =>
        withWriteResult(data, result),
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
    start: (request: StudentWriteRequest) =>
      mutate({ ...request, idempotencyKey: crypto.randomUUID() }),
    retry: () => {
      if (variables) mutate(variables);
    },
    canRetry: mutation.isError && isOutcomeUnknown(mutation.error),
  };
};
