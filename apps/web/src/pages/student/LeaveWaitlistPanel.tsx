import type { StudentClubRef } from '@club-registration/shared';
import { WritePanel } from './WritePanel';
import type { WriteState } from './WritePanel';

// The confirmation of leaving the waitlist, the same on both student pages.
export const LeaveWaitlistPanel = ({
  club,
  state,
}: {
  club: StudentClubRef;
  state: WriteState;
}) => (
  <WritePanel
    state={state}
    label={`ยืนยันการออกจากรายชื่อรอชุมนุม ${club.clubCode} ${club.name}`}
    question={`ออกจากรายชื่อรอชุมนุม ${club.clubCode} ${club.name}?`}
    note="ลำดับที่ของคุณจะหายไปทันที ถ้าเข้ารายชื่อรอใหม่ภายหลังจะต่อท้ายคิว"
    confirmLabel="ยืนยัน ออกจากรายชื่อรอ"
    pendingLabel="กำลังออกจากรายชื่อรอ…"
    dismissLabel="ไม่ออก"
  />
);
