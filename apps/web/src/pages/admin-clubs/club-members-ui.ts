import { ERROR_CODES } from '@club-registration/shared';
import type {
  ClubMemberSource,
  ClubMemberWriteResponse,
  ClubMembersResponse,
  ClubWaitlistResponse,
  RoundStatus,
} from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError, assignClubMember, removeClubMember, removeClubWaitlistEntry } from '@/lib/api';
import { useSetSession } from '@/lib/session';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { isOutcomeUnknown } from '@/pages/student/student-ui';
import { CLUBS_QUERY_KEY } from './club-ui';

const UNAUTHORIZED = 401;

// Under the clubs prefix, so one invalidation after a write refreshes the table's counts and every
// open list: a move frees a seat in another club and a removal can promote waiters in a cascade
// across the round. The string after the prefix keeps these apart from [...prefix, roundId].
export const membersQueryKey = (clubId: number) => [...CLUBS_QUERY_KEY, 'members', clubId] as const;
export const waitlistQueryKey = (clubId: number) =>
  [...CLUBS_QUERY_KEY, 'waitlist', clubId] as const;

export type MemberWriteKind = 'assign' | 'removeMember' | 'removeWaiter';
export type MemberWrite = { kind: MemberWriteKind; loginId: string };
type SentMemberWrite = MemberWrite & { idempotencyKey: string };

export type MemberWriteOutcome =
  | { kind: 'assign' | 'removeMember'; loginId: string; answer: ClubMemberWriteResponse }
  | { kind: 'removeWaiter'; loginId: string; answer: ClubWaitlistResponse };

export const SOURCE_DISPLAY: Readonly<
  Record<ClubMemberSource | 'none', { label: string; variant: 'success' | 'warning' | 'neutral' }>
> = Object.freeze({
  student: { label: 'ลงเอง', variant: 'neutral' },
  waitlist: { label: 'ได้จากรายชื่อรอ', variant: 'success' },
  admin: { label: 'ผู้ดูแลจัดให้', variant: 'warning' },
  // No event moved this seat: only a row made by hand outside the api.
  none: { label: 'ไม่ทราบ', variant: 'neutral' },
});

// What removing a member leads to. The promote engine runs until the round closes (an upcoming
// round promotes too), so only a closed round leaves the seat empty.
export const removeMemberNote = (status: RoundStatus): string =>
  status === 'closed'
    ? 'รอบนี้ปิดแล้ว จึงไม่มีใครได้ที่จากรายชื่อรอ ที่นั่งจะว่างไว้'
    : 'ที่นั่งจะว่างทันที ถ้ามีคนรอชุมนุมนี้ คนที่รอลำดับแรกจะได้ที่แทนอัตโนมัติ';

const COMMON_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  // One code for a missing club and a missing student, so one message names both.
  [ERROR_CODES.notFound]:
    'ไม่พบนักเรียนรหัสนี้หรือชุมนุมนี้ ตรวจรหัสนักเรียนอีกครั้ง (ชุมนุมอาจถูกลบไปแล้ว)',
  [ERROR_CODES.validationError]: 'รหัสนักเรียนไม่ถูกต้อง ใช้ได้เฉพาะ a-z 0-9 . _ - ไม่เกิน 64 ตัว',
  [ERROR_CODES.idempotencyKeyReused]: 'คำขอนี้ซ้ำกับคำขอก่อนหน้า กรุณากดใหม่อีกครั้ง',
  [ERROR_CODES.rateLimited]: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์แก้รายชื่อชุมนุม',
  [ERROR_CODES.unauthorized]: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่',
});

type WriteMessages = {
  errors: Readonly<Record<string, string>>;
  // No answer: the write may or may not have happened.
  unknownOutcome: string;
  fallback: string;
};

const WRITE_MESSAGES: Readonly<Record<MemberWriteKind, WriteMessages>> = Object.freeze({
  assign: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.clubFull]:
        'ชุมนุมนี้เต็มแล้ว เพิ่มจำนวนรับก่อนด้วยปุ่ม "แก้ไข" ของชุมนุมนี้ แล้วลองใหม่ (ถ้านักเรียนถือชุมนุมอื่นอยู่ ยังอยู่ที่เดิม)',
      [ERROR_CODES.studentNotInRoundGrade]:
        'นักเรียนคนนี้ไม่ได้อยู่ชั้นของรอบนี้ เพิ่มได้เฉพาะนักเรียนชั้นเดียวกับรอบ',
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่าบันทึกสำเร็จหรือไม่ กดเพิ่มอีกครั้งด้วยรหัสเดิมเพื่อส่งคำขอเดิม (ระบบจะไม่ทำซ้ำ)',
    fallback: 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
  removeMember: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.notRegistered]:
        'นักเรียนคนนี้ไม่ได้อยู่ในชุมนุมนี้แล้ว (อาจถูกย้ายหรือนำออกไปแล้ว) ดูรายชื่อล่าสุด',
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่านำออกสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ทำซ้ำ)',
    fallback: 'นำออกจากชุมนุมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
  removeWaiter: {
    errors: {
      ...COMMON_ERRORS,
      [ERROR_CODES.notWaitlisted]:
        'นักเรียนคนนี้ไม่ได้อยู่ในรายชื่อรอของชุมนุมนี้แล้ว (อาจได้ที่แล้วหรือออกไปแล้ว) ดูรายชื่อล่าสุด',
    },
    unknownOutcome:
      'เชื่อมต่อระบบไม่สำเร็จ จึงยังไม่รู้ว่านำออกจากรายชื่อรอสำเร็จหรือไม่ กด "ลองอีกครั้ง" เพื่อส่งคำขอเดิม (ระบบจะไม่ทำซ้ำ)',
    fallback: 'นำออกจากรายชื่อรอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  },
});

export const memberWriteErrorMessage = (kind: MemberWriteKind, error: unknown): string => {
  const { errors, unknownOutcome, fallback } = WRITE_MESSAGES[kind];
  if (isOutcomeUnknown(error)) return unknownOutcome;
  return (error instanceof ApiError ? errors[error.code] : undefined) ?? fallback;
};

const clubLabel = ({ clubCode, name }: { clubCode: string; name: string }) => `${clubCode} ${name}`;

// From the answer, never from the request alone: an assign cannot tell a new seat from a move or
// a seat already held, a cascade may carry the student on to the club they waited for, and a
// replayed key answers with the state now.
export const memberWriteNotice = ({ kind, loginId, answer }: MemberWriteOutcome): string => {
  const club = clubLabel(answer.club);
  if (kind === 'removeWaiter') {
    const entry = answer.entries.find((waiter) => waiter.loginId === loginId);
    return entry
      ? `${loginId} ยังอยู่ในรายชื่อรอชุมนุม ${club} (ลำดับที่ ${entry.position}) ดูรายชื่อล่าสุด`
      : `นำ ${loginId} ออกจากรายชื่อรอชุมนุม ${club} แล้ว`;
  }
  const { member } = answer;
  if (kind === 'removeMember') {
    return member
      ? `${loginId} ยังอยู่ในชุมนุม ${club} (มีการจัดให้ใหม่ระหว่างนี้) ดูรายชื่อล่าสุด`
      : `นำ ${loginId} ออกจากชุมนุม ${club} แล้ว`;
  }
  return member
    ? `บันทึกแล้ว: ${member.loginId} ${member.fullName} อยู่ในชุมนุม ${club}`
    : `บันทึกแล้ว แต่ตอนนี้ ${loginId} ไม่ได้อยู่ในชุมนุม ${club}: หลังจัดให้ ระบบย้ายนักเรียนต่อไปยังชุมนุมที่นักเรียนรออยู่ (ได้ที่จากรายชื่อรอ)`;
};

const sendMemberWrite = async (
  clubId: number,
  { kind, loginId, idempotencyKey }: SentMemberWrite,
): Promise<MemberWriteOutcome> => {
  const request = { loginId, idempotencyKey };
  switch (kind) {
    case 'assign':
      return { kind, loginId, answer: await assignClubMember(clubId, request) };
    case 'removeMember':
      return { kind, loginId, answer: await removeClubMember(clubId, request) };
    case 'removeWaiter':
      return { kind, loginId, answer: await removeClubWaitlistEntry(clubId, request) };
  }
};

const sameWrite = (a: MemberWrite, b: MemberWrite) => a.kind === b.kind && a.loginId === b.loginId;

// One write at a time for the whole panel, so one pending state disables every control in it.
// The idempotency key is bound to what was asked (kind and student; the panel is for one club):
// sending the same write again after an unknown outcome reuses it, so the server replays instead
// of acting twice, and anything else (another student, a corrected login ID, another kind) gets a
// new one. Any answer from the server settles the write, so the next one gets a new key too.
// Kept in a ref rather than the mutation's variables, which reset() clears on every close.
export const useMemberWrite = (clubId: number) => {
  const queryClient = useQueryClient();
  const setSession = useSetSession();
  const unsettled = useRef<SentMemberWrite>(undefined);
  const mutation = useMutation({
    mutationFn: async (write: SentMemberWrite) => await sendMemberWrite(clubId, write),
    // Shown at once (the row the admin removed disappears); the refetch below brings the rest.
    onSuccess: (outcome) => {
      if (outcome.kind === 'removeWaiter') {
        queryClient.setQueryData<ClubWaitlistResponse>(waitlistQueryKey(clubId), outcome.answer);
        return;
      }
      const { kind, loginId, answer } = outcome;
      queryClient.setQueryData<ClubMembersResponse>(membersQueryKey(clubId), (data) =>
        data
          ? {
              club: answer.club,
              members:
                kind === 'removeMember' && answer.member === null
                  ? data.members.filter((member) => member.loginId !== loginId)
                  : data.members,
            }
          : data,
      );
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === UNAUTHORIZED) setSession(null);
    },
    // Whatever the answer, the lists and counts on screen may be stale now (a refusal such as
    // club_full or not_registered usually means someone else changed them).
    onSettled: async (_outcome, error, write) => {
      const settled = error === null || !isOutcomeUnknown(error);
      if (settled && unsettled.current?.idempotencyKey === write.idempotencyKey) {
        unsettled.current = undefined;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CLUBS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ROUNDS_QUERY_KEY }),
      ]);
    },
  });
  const { mutate } = mutation;
  return {
    mutation,
    send: (write: MemberWrite) => {
      const last = unsettled.current;
      const idempotencyKey =
        last && sameWrite(last, write) ? last.idempotencyKey : crypto.randomUUID();
      unsettled.current = { ...write, idempotencyKey };
      mutate(unsettled.current);
    },
    canRetry: mutation.isError && isOutcomeUnknown(mutation.error),
  };
};
