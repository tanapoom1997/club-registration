import { ERROR_CODES } from '@club-registration/shared';
import type { ClubRef, EventType, RegistrationEvent } from '@club-registration/shared';
import { ApiError } from '@/lib/api';
import { gradeLabel } from '@/lib/round-display';

export const EVENTS_QUERY_KEY = Object.freeze(['admin', 'events'] as const);

// Exhaustive on purpose: a new event type in packages/shared fails the typecheck here until it has
// a label, instead of showing a raw code to the admin.
export const EVENT_TYPE_LABELS: Readonly<Record<EventType, string>> = Object.freeze({
  register: 'ลงชุมนุม',
  cancel: 'ยกเลิกชุมนุม',
  change: 'ย้ายชุมนุม',
  admin_assign: 'ผู้ดูแลจัดเข้าชุมนุม',
  admin_remove: 'ผู้ดูแลนำออกจากชุมนุม',
  waitlist_join: 'เข้ารายชื่อรอ',
  waitlist_leave: 'ออกจากรายชื่อรอ',
  waitlist_promote: 'ได้ที่จากรายชื่อรอ',
});

export const clubLabel = ({ clubCode, name }: ClubRef): string => `${clubCode} ${name}`;

export const roundLabel = ({ term, grade }: RegistrationEvent['round']): string =>
  `${term} ${gradeLabel(grade)}`;

// The club an event is about, and for a move the one it left. A waitlist join that names a
// fromClub gave up the queue of that club (a student waits for one club at a time), not a seat.
export const clubCellText = ({ eventType, club, fromClub }: RegistrationEvent): string => {
  const to = club === null ? '—' : clubLabel(club);
  if (fromClub === null) return to;
  return eventType === 'waitlist_join'
    ? `จากรายชื่อรอ ${clubLabel(fromClub)} → ${to}`
    : `จาก ${clubLabel(fromClub)} → ${to}`;
};

// Who acted, in words. For a promotion the actor is whoever freed the seat (a student's cancel or
// change, or an admin's edit), never the promoted student by virtue of being promoted.
export const actorRoleText = ({ actor, student }: RegistrationEvent): string =>
  actor.role === 'admin' ? 'ผู้ดูแลระบบ' : actor.id === student.id ? 'นักเรียนคนนี้เอง' : 'นักเรียนคนอื่น';

export const PROMOTE_ACTOR_NOTE = 'ผู้ที่ทำให้มีที่ว่าง ระบบให้ที่จากรายชื่อรออัตโนมัติ';

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.validationError]: 'ตัวกรองไม่ถูกต้อง ตรวจรหัสนักเรียน รอบ และชุมนุมอีกครั้ง แล้วลองใหม่',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์ดูประวัติการลงทะเบียน',
  [ERROR_CODES.unauthorized]: 'หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่',
});

export const eventsErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'โหลดประวัติการลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';

export const LOGIN_ID_FORMAT_ERROR = 'รหัสนักเรียนไม่ถูกต้อง ใช้ได้เฉพาะ a-z 0-9 . _ - ไม่เกิน 64 ตัว';
