import { ERROR_CODES } from '@club-registration/shared';
import type { ExportFormat, ExportView, Round } from '@club-registration/shared';
import { ApiError } from '@/lib/api';
import { firstRoundBy } from '@/pages/admin-clubs/club-ui';

export const CLASSROOMS_QUERY_KEY = Object.freeze(['admin', 'classrooms'] as const);

// The round an admin most likely came to export: the open one (lists to chase who has not
// registered), else the one that closed last (the final lists for teachers), else the next to open.
// Unlike the clubs page, a closed round beats an upcoming one: an upcoming round has no members.
export const exportRound = (rounds: readonly Round[]): Round | undefined =>
  firstRoundBy(rounds, 'open', 'closesAt') ??
  firstRoundBy(rounds, 'closed', 'closesAt', -1) ??
  firstRoundBy(rounds, 'upcoming', 'opensAt');

export const VIEW_OPTIONS: Readonly<Record<ExportView, { label: string; description: string }>> =
  Object.freeze({
    club: {
      label: 'รายชุมนุม',
      description: 'ให้ครูที่ปรึกษาเช็คชื่อ: สมาชิกของชุมนุม เรียงตามชั้น ห้อง และเลขที่',
    },
    classroom: {
      label: 'รายห้อง',
      description: 'ให้ครูประจำชั้นตามคนที่ยังไม่ลง: นักเรียนทุกคนในห้อง เรียงตามเลขที่ พร้อมชุมนุมที่ลง',
    },
  });

export const FORMAT_OPTIONS: Readonly<
  Record<ExportFormat, { label: string; description: string }>
> = Object.freeze({
  xlsx: {
    label: 'Excel (.xlsx)',
    description: 'แก้ไขหรือจัดเรียงต่อได้ 1 ชีตต่อชุมนุม/ห้อง',
  },
  pdf: {
    label: 'PDF',
    description: 'พร้อมพิมพ์ A4 ขึ้นหน้าใหม่ต่อชุมนุม/ห้อง มีเลขหน้าและเวลาที่ส่งออก',
  },
});

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.notFound]: 'ไม่พบรอบ ชุมนุม หรือห้องที่เลือก (อาจถูกลบหรือนักเรียนถูกย้ายไปแล้ว) กรุณาโหลดหน้านี้ใหม่',
  [ERROR_CODES.nothingToExport]: 'ยังไม่มีข้อมูลให้ส่งออก (รอบนี้ยังไม่มีชุมนุม หรือชั้นนี้ยังไม่มีนักเรียน)',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์ส่งออกรายชื่อ',
  [ERROR_CODES.validationError]: 'ตัวเลือกไม่ถูกต้อง กรุณาเลือกใหม่',
});

export const exportErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'ดาวน์โหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
