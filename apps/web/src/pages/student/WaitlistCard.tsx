import type { StudentRegistration, StudentRound, StudentWaitlist } from '@club-registration/shared';
import type { ReactNode, Ref } from 'react';
import { alertVariants } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { formatThaiDateTime } from '@/lib/thai-time';
import { cn } from '@/lib/utils';
import { promotedNotice } from './student-ui';

type WaitlistCardProps = {
  waitlist: StudentWaitlist;
  registration: StudentRegistration | null;
  round: StudentRound;
  // When the student joined: the record, shown on my-registration only (as HeldClubCard).
  withTime: boolean;
  children?: ReactNode;
};

// The student's one waitlist entry in the round, shown next to the held club on both pages.
export const WaitlistCard = ({
  waitlist: { club, position, joinedAt },
  registration,
  round,
  withTime,
  children,
}: WaitlistCardProps) => (
  <Card className="space-y-2 border-warning-foreground/40 bg-linear-to-br from-warning to-card p-4 ring-2 ring-warning-foreground/15 sm:p-5">
    <h2 className="text-sm font-medium text-warning-foreground">รายชื่อรอของฉัน</h2>
    <p className="text-lg font-semibold break-words">
      {club.clubCode} {club.name}
    </p>
    <p className="text-sm">
      ลำดับที่ <span className="text-2xl font-bold text-warning-foreground">{position}</span>
    </p>
    {withTime && (
      <p className="text-sm text-muted-foreground">
        เข้ารายชื่อรอเมื่อ {formatThaiDateTime(joinedAt)} น.
      </p>
    )}
    {/* On both pages, and a seat off the waitlist shows on both, so not "this page only": what
        holds is that nothing is sent anywhere else. */}
    <p className="text-sm">
      {round.status === 'closed'
        ? 'รอบนี้ปิดแล้ว จะไม่มีการให้ที่จากรายชื่อรออีก'
        : registration
          ? `ถ้าได้ที่ ระบบจะย้ายคุณออกจากชุมนุม ${registration.club.clubCode} ${registration.club.name} มาชุมนุมนี้ให้เอง ผลจะแสดงบนเว็บนี้เท่านั้น ไม่มีแจ้งทางอื่น`
          : 'ถ้ามีที่ว่าง ระบบจะลงชุมนุมนี้ให้เองตามลำดับ ผลจะแสดงบนเว็บนี้เท่านั้น ไม่มีแจ้งทางอื่น'}
    </p>
    {children}
  </Card>
);

// Always mounted, so a screen reader announces the notice politely when a poll brings the
// promotion. From data (promotedFromWaitlist), so it survives a reload. Focusable only so that
// focus can land here when the poll removed the focused leave button (useFocusRescue).
export const PromotedNotice = ({
  registration,
  ref,
}: {
  registration: StudentRegistration | null | undefined;
  ref?: Ref<HTMLParagraphElement>;
}) => (
  <div role="status">
    {registration?.promotedFromWaitlist && (
      <p
        ref={ref}
        tabIndex={-1}
        className={cn(alertVariants({ variant: 'success' }), 'focus:outline-none')}
      >
        {promotedNotice(registration)}
      </p>
    )}
  </div>
);
