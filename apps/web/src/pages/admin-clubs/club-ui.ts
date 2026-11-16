import { ERROR_CODES } from '@club-registration/shared';
import { ApiError } from '@/lib/api';

export const CLUBS_QUERY_KEY = Object.freeze(['admin', 'clubs'] as const);

// While a round is open, registered changes under the admin's eyes; other rounds stay still.
export const CLUBS_POLL_INTERVAL_MS = 5_000;

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.capacityBelowRegistered]:
    'ลดจำนวนรับให้น้อยกว่าจำนวนนักเรียนที่ลงทะเบียนแล้วไม่ได้ (อาจมีคนลงเพิ่มระหว่างแก้ไข) ตรวจจำนวนที่ลงแล้วล่าสุดแล้วลองใหม่',
  [ERROR_CODES.validationError]: 'ข้อมูลไม่ถูกต้อง ตรวจชื่อ รายละเอียด และจำนวนรับอีกครั้ง',
  [ERROR_CODES.notFound]: 'ไม่พบชุมนุมนี้ อาจถูกลบไปแล้ว',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์แก้ไขชุมนุม',
});

export const clubErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
