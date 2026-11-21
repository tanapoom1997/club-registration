import type { StudentRegistration, StudentRound, StudentWaitlist } from '@club-registration/shared';
import type { ReactNode } from 'react';
import { alertVariants } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { formatThaiDateTime } from '@/lib/thai-time';
import { promotedNotice } from './student-ui';

type WaitlistCardProps = {
  waitlist: StudentWaitlist;
  registration: StudentRegistration | null;
  round: StudentRound;
  children?: ReactNode;
};

// The student's one waitlist entry in the round, shown next to the held club on both pages.
export const WaitlistCard = ({
  waitlist: { club, position, joinedAt },
  registration,
  round,
  children,
}: WaitlistCardProps) => (
  <Card className="space-y-2 border-warning-foreground/40 bg-linear-to-br from-warning to-card p-5 ring-2 ring-warning-foreground/15">
    <h2 className="text-sm font-medium text-warning-foreground">รายชื่อรอของฉัน</h2>
    <p className="text-lg font-semibold break-words">
      {club.clubCode} {club.name}
    </p>
    <p className="text-sm">
      ลำดับที่ <span className="text-2xl font-bold text-primary">{position}</span>
    </p>
    <p className="text-sm text-muted-foreground">
      เข้ารายชื่อรอเมื่อ {formatThaiDateTime(joinedAt)} น.
    </p>
    <p className="text-sm">
      {round.status === 'closed'
        ? 'รอบนี้ปิดแล้ว จะไม่มีการให้ที่จากรายชื่อรออีก'
        : registration
          ? `ถ้าได้ที่ ระบบจะย้ายคุณออกจากชุมนุม ${registration.club.clubCode} ${registration.club.name} มาชุมนุมนี้ให้เอง ผลจะแสดงที่หน้านี้เท่านั้น ไม่มีแจ้งทางอื่น`
          : 'ถ้ามีที่ว่าง ระบบจะลงชุมนุมนี้ให้เองตามลำดับ ผลจะแสดงที่หน้านี้เท่านั้น ไม่มีแจ้งทางอื่น'}
    </p>
    {children}
  </Card>
);

// Always mounted, so a screen reader announces the notice politely when a poll brings the
// promotion, without moving focus. From data (promotedFromWaitlist), so it survives a reload.
export const PromotedNotice = ({
  registration,
}: {
  registration: StudentRegistration | null | undefined;
}) => (
  <div role="status">
    {registration?.promotedFromWaitlist && (
      <p className={alertVariants({ variant: 'success' })}>{promotedNotice(registration)}</p>
    )}
  </div>
);
