import { ERROR_CODES } from '@club-registration/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useSetSession } from '@/lib/session';
import { thaiInputToIso } from '@/lib/thai-time';

export const ROUNDS_QUERY_KEY = Object.freeze(['admin', 'rounds'] as const);

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.roundExists]: 'มีรอบของภาคเรียนและชั้นนี้อยู่แล้ว',
  [ERROR_CODES.roundNotEmpty]: 'ลบไม่ได้ เพราะรอบนี้มีชุมนุมหรือข้อมูลการลงทะเบียนแล้ว',
  [ERROR_CODES.validationError]: 'ข้อมูลไม่ถูกต้อง ตรวจสอบว่าเวลาปิดอยู่หลังเวลาเปิด',
  [ERROR_CODES.notFound]: 'ไม่พบรอบนี้ อาจถูกลบไปแล้ว',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์จัดการรอบลงทะเบียน',
});

export const roundErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';

export type WindowValues = { opensAt: string; closesAt: string; maxActive: string };

// Form strings → request fields. Unparseable input is passed through as-is so the shared Zod
// schema reports it with its own Thai message instead of a second set of rules here.
export const windowFromValues = ({ opensAt, closesAt, maxActive }: WindowValues) => ({
  opensAt: thaiInputToIso(opensAt) ?? opensAt,
  closesAt: thaiInputToIso(closesAt) ?? closesAt,
  maxActive: maxActive.trim() === '' ? Number.NaN : Number(maxActive),
});

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
