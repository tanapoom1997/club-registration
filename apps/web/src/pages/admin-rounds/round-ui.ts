import {
  ERROR_CODES,
  ROUND_YEAR_MAX,
  ROUND_YEAR_MESSAGE,
  ROUND_YEAR_MIN,
} from '@club-registration/shared';
import type { Round } from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useSetSession } from '@/lib/session';
import { formatThaiDateTime, thaiInputToIso } from '@/lib/thai-time';

export const ROUNDS_QUERY_KEY = Object.freeze(['admin', 'rounds'] as const);

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.roundExists]: 'มีรอบของภาคเรียนและชั้นนี้อยู่แล้ว',
  [ERROR_CODES.roundNotEmpty]: 'ลบไม่ได้ เพราะรอบนี้มีชุมนุม ข้อมูลการลงทะเบียน หรือมีนักเรียนเข้าคิวแล้ว',
  [ERROR_CODES.validationError]: 'ข้อมูลไม่ถูกต้อง ตรวจสอบว่าเวลาปิดอยู่หลังเวลาเปิด',
  [ERROR_CODES.notFound]: 'ไม่พบรอบนี้ อาจถูกลบไปแล้ว',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์จัดการรอบลงทะเบียน',
});

export const roundErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';

// noQueue: the round has no queue (maxActive null, README Phase 3 decision 6). The number typed
// before is kept in maxActive, so unticking it gives the admin their value back.
export type WindowValues = {
  opensAt: string;
  closesAt: string;
  maxActive: string;
  noQueue: boolean;
};

// The typed number, or NaN when the field is empty (so the schema says why).
const typedMaxActive = (maxActive: string): number =>
  maxActive.trim() === '' ? Number.NaN : Number(maxActive);

// Form strings → request fields. Unparseable input is passed through as-is so the shared Zod
// schema reports it with its own Thai message instead of a second set of rules here.
export const windowFromValues = ({ opensAt, closesAt, maxActive, noQueue }: WindowValues) => ({
  opensAt: thaiInputToIso(opensAt) ?? opensAt,
  closesAt: thaiInputToIso(closesAt) ?? closesAt,
  maxActive: noQueue ? null : typedMaxActive(maxActive),
});

export const WINDOW_TIME_HINTS = Object.freeze({
  empty: 'ปีในช่องนี้เป็น ค.ศ. เช่น 2026 (ตรงกับ พ.ศ. 2569)',
  matches: (iso: string) => `ตรงกับ ${formatThaiDateTime(iso)} น.`,
});

// The line under a date field: the browser's field takes the Christian year while the rest of the
// site reads in the Buddhist one, so the chosen time is repeated the way the site shows it, and a
// year out of range (most likely a Buddhist year typed by habit) is flagged before saving.
export const windowTimeHint = (value: string): { text: string; outOfRange: boolean } => {
  const iso = thaiInputToIso(value);
  if (iso === undefined) return { text: WINDOW_TIME_HINTS.empty, outOfRange: false };
  // The field's own text is Thai time, so its first four digits are the year by Thai time.
  const year = Number(value.slice(0, 4));
  return year < ROUND_YEAR_MIN || year > ROUND_YEAR_MAX
    ? { text: ROUND_YEAR_MESSAGE, outOfRange: true }
    : { text: WINDOW_TIME_HINTS.matches(iso), outOfRange: false };
};

// Every message about the queue setting on this page, in one place like ERROR_MESSAGES.
export const QUEUE_SETTING_MESSAGES = Object.freeze({
  maxActiveLabel: 'จำนวนคนเข้าเลือกพร้อมกันสูงสุด',
  noQueueLabel: 'ไม่มีคิว',
  noQueueHelp: 'นักเรียนเลือกชุมนุมได้ทันทีโดยไม่ต้องรอคิว และไม่จำกัดจำนวนคนที่เลือกพร้อมกัน',
  noQueueCell: 'ไม่มีคิว',
  turningOff:
    'เมื่อบันทึก รอบนี้จะไม่มีคิว นักเรียนที่รอคิวอยู่จะเห็นรายการชุมนุมและเลือกได้เองภายในไม่กี่วินาทีโดยไม่ต้องโหลดหน้าใหม่',
  turningOn:
    'เมื่อบันทึก รอบนี้จะมีคิว นักเรียนที่เปิดหน้าเลือกชุมนุมอยู่จะเข้าคิวเองภายในไม่กี่วินาที ถ้ามีคนได้คิวเต็มแล้วต้องรอคิวก่อนจึงเลือกต่อได้ ชุมนุมที่ลงไว้แล้วยังอยู่',
  lowered: (maxActive: number, admitted: number) =>
    `ตอนนี้มีนักเรียนได้คิวอยู่ ${admitted} คน มากกว่าค่าใหม่ (${maxActive} คน) ระบบไม่เอาใครที่ได้คิวแล้วออก แต่จะไม่ให้ใครได้คิวเพิ่มจนกว่าจำนวนที่ได้คิวจะต่ำกว่า ${maxActive} คน`,
});

// What an edit of the queue setting will do to students, said before it is saved (README Phase
// 3, Q4). Nothing blocks the save: lowering max_active below the admitted count removes nobody,
// and turning the queue off or on mid-round is allowed; the admin only needs to know.
export const queueEditNotes = (round: Round, values: WindowValues): string[] => {
  const hadQueue = round.maxActive !== null;
  const open = round.status === 'open';
  if (values.noQueue) return hadQueue && open ? [QUEUE_SETTING_MESSAGES.turningOff] : [];
  const maxActive = typedMaxActive(values.maxActive);
  const notes = !hadQueue && open ? [QUEUE_SETTING_MESSAGES.turningOn] : [];
  return Number.isInteger(maxActive) && maxActive > 0 && maxActive < round.queueAdmitted
    ? [...notes, QUEUE_SETTING_MESSAGES.lowered(maxActive, round.queueAdmitted)]
    : notes;
};

// The queue counts move only while a round is open, so the list polls then, every 10 s, and
// never in a hidden tab (TanStack's default): an admin watching the queue has the page in front.
// A round that opens or closes while the page is open shows on the next poll or refetch.
export const ROUNDS_POLL_INTERVAL_MS = 10_000;

export const roundsRefetchInterval = (rounds: readonly Round[] | undefined): number | false =>
  rounds?.some(({ status }) => status === 'open') === true ? ROUNDS_POLL_INTERVAL_MS : false;

// Every round write refreshes the list, and an expired session sends the admin back to login.
export const useRoundMutation = <TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) => {
  const queryClient = useQueryClient();
  const setSession = useSetSession();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ROUNDS_QUERY_KEY });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) setSession(null);
    },
  });
};
