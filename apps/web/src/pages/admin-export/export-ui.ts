import { ERROR_CODES } from '@club-registration/shared';
import type { ExportFormat, ExportView } from '@club-registration/shared';
import { ApiError } from '@/lib/api';

export const CLASSROOMS_QUERY_KEY = Object.freeze(['admin', 'classrooms'] as const);

export const VIEW_OPTIONS: Readonly<Record<ExportView, { label: string; description: string }>> =
  Object.freeze({
    club: {
      label: 'รายชุมนุม',
      description: 'ให้ครูที่ปรึกษาเช็คชื่อ: สมาชิกของชุมนุม เรียงตามชั้น ห้อง และเลขที่',
    },
    classroom: {
      label: 'รายห้อง',
      description:
        'ให้ครูประจำชั้นตามคนที่ยังไม่ลง: นักเรียนทุกคนในห้อง เรียงตามเลขที่ พร้อมชุมนุมที่ลง',
    },
  });

// PDF joins here once a library that lays out Thai correctly has been chosen.
export const FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = Object.freeze({
  xlsx: 'Excel (.xlsx)',
});

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.notFound]:
    'ไม่พบรอบ ชุมนุม หรือห้องที่เลือก (อาจถูกลบหรือนักเรียนถูกย้ายไปแล้ว) กรุณาโหลดหน้านี้ใหม่',
  [ERROR_CODES.nothingToExport]:
    'ยังไม่มีข้อมูลให้ส่งออก (รอบนี้ยังไม่มีชุมนุม หรือชั้นนี้ยังไม่มีนักเรียน)',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์ส่งออกรายชื่อ',
  [ERROR_CODES.validationError]: 'ตัวเลือกไม่ถูกต้อง กรุณาเลือกใหม่',
});

export const exportErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'ดาวน์โหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
