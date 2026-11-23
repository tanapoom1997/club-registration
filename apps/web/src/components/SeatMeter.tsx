import { Badge } from '@/components/ui/badge';
import { seatLevel, takenPercent } from '@/lib/seats';
import type { SeatLevel } from '@/lib/seats';
import { cn } from '@/lib/utils';

const FILL: Readonly<Record<SeatLevel, string>> = Object.freeze({
  open: 'bg-primary',
  low: 'bg-warning-foreground',
  full: 'bg-muted-foreground/50',
});

const COUNT: Readonly<Record<SeatLevel, string>> = Object.freeze({
  open: 'text-primary',
  low: 'text-warning-foreground',
  full: 'text-muted-foreground',
});

type SeatBarProps = { capacity: number; remaining: number; className?: string | undefined };

// How full a club is, as a bar. Decorative: every place that shows it also says the numbers. The
// fill width is set from script (CSSOM), which the page CSP allows, unlike a style attribute in
// the HTML.
export const SeatBar = ({ capacity, remaining, className }: SeatBarProps) => (
  <div aria-hidden="true" className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
    <div
      className={cn(
        'h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none',
        FILL[seatLevel(capacity, remaining)],
      )}
      style={{ width: `${takenPercent(capacity, remaining)}%` }}
    />
  </div>
);

type SeatMeterProps = {
  capacity: number;
  remaining: number;
  waitlistCount: number;
  className?: string;
};

// Seats left as words first ("เหลือ 2 ที่", "ใกล้เต็ม", "เต็ม"), so the bar's colour is never the
// only signal.
export const SeatMeter = ({ capacity, remaining, waitlistCount, className }: SeatMeterProps) => {
  const level = seatLevel(capacity, remaining);
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        {level === 'full' ? (
          <Badge variant="warning">เต็ม</Badge>
        ) : (
          <p>
            เหลือ <span className={cn('text-xl font-bold', COUNT[level])}>{remaining}</span> ที่
            {level === 'low' && (
              <span className="ml-2 text-xs font-medium text-warning-foreground">ใกล้เต็ม</span>
            )}
          </p>
        )}
        <p className="text-xs text-muted-foreground">รับ {capacity} คน</p>
      </div>
      <SeatBar capacity={capacity} remaining={remaining} />
      {waitlistCount > 0 && (
        <p className="text-xs text-warning-foreground">มีคนรอ {waitlistCount} คน</p>
      )}
    </div>
  );
};
