import type { StudentRound } from '@club-registration/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { alertVariants } from '@/components/ui/alert';
import { formatThaiDateTime } from '@/lib/thai-time';
import { STATUS_DISPLAY, gradeLabel } from '@/lib/round-display';
import { isProfileMissing } from './student-ui';

export const RoundHeader = ({ round }: { round: StudentRound }) => {
  const status = STATUS_DISPLAY[round.status];
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">
          ภาคเรียน {round.term} · {gradeLabel(round.grade)}
        </h2>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">เปิด</dt>
        <dd>{formatThaiDateTime(round.opensAt)} น.</dd>
        <dt className="text-muted-foreground">ปิด</dt>
        <dd>{formatThaiDateTime(round.closesAt)} น.</dd>
      </dl>
    </Card>
  );
};

type LoadStateProps = { error: unknown; isPending: boolean; onRetry: () => void };

// What a student page shows before it has any data to render.
export const StudentLoadState = ({ error, isPending, onRetry }: LoadStateProps) => {
  if (isPending) return <p className="text-muted-foreground">กำลังโหลด…</p>;
  if (isProfileMissing(error)) {
    return (
      <p className={alertVariants({ variant: 'warning' })} role="alert">
        บัญชีนี้ยังไม่มีข้อมูลชั้นเรียน จึงยังดูหรือลงชุมนุมไม่ได้ กรุณาติดต่อผู้ดูแลระบบหรือครูที่ดูแลการลงทะเบียน
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3" role="alert">
      <p>โหลดข้อมูลไม่สำเร็จ</p>
      <Button variant="outline" onClick={onRetry}>
        ลองใหม่
      </Button>
    </div>
  );
};

export const NoRound = () => (
  <p className="rounded-md border border-border bg-card p-4 text-muted-foreground">
    ยังไม่มีรอบลงทะเบียนของชั้นนี้ เมื่อโรงเรียนเปิดรอบแล้วจะแสดงที่หน้านี้
  </p>
);
