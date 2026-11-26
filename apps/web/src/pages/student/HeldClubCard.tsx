import type { StudentRegistration } from '@club-registration/shared';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { formatThaiDateTime } from '@/lib/thai-time';

type HeldClubCardProps = {
  registration: StudentRegistration;
  // When the seat was taken: the record, shown on my-registration. The clubs page is for choosing
  // and leaves it out, so the two pages' cards do not read the same (UX scan item 14).
  withTime: boolean;
  children?: ReactNode;
};

export const HeldClubCard = ({
  registration: { club, registeredAt },
  withTime,
  children,
}: HeldClubCardProps) => (
  <Card className="space-y-2 border-success-foreground bg-linear-to-br from-success to-card p-4 ring-2 ring-success-foreground/15 sm:p-5">
    <h2 className="text-sm font-medium text-success-foreground">ชุมนุมของฉัน</h2>
    <p className="text-lg font-semibold break-words">
      {club.clubCode} {club.name}
    </p>
    {withTime && (
      <p className="text-sm text-muted-foreground">ลงเมื่อ {formatThaiDateTime(registeredAt)} น.</p>
    )}
    {children}
  </Card>
);
