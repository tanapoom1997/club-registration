import type { AdminClub } from '@club-registration/shared';
import { SEAT_BADGES, SeatBar } from '@/components/SeatMeter';
import { Badge } from '@/components/ui/badge';
import { seatLevel } from '@/lib/seats';
import { cn } from '@/lib/utils';

type ClubSeatsProps = Pick<AdminClub, 'capacity' | 'registered' | 'remaining'> & {
  // Left out where the waitlist is not the point (the round's own totals).
  waitlistCount?: number;
  // The table column is fixed narrow; a phone card lets the bar run the card's width.
  className?: string;
};

// The admin's one-column view of a club's seats: registered over capacity (the column header says
// which is which), what is left in words, and the same bar the students see. A nearly full club
// shows "เหลือ 2" in the warning colour: the count itself says it, the colour only draws the eye.
export const ClubSeats = ({
  capacity,
  registered,
  remaining,
  waitlistCount = 0,
  className,
}: ClubSeatsProps) => {
  const level = seatLevel(capacity, remaining);
  return (
    <div className={cn('w-32 space-y-1.5', className)}>
      <p className="flex items-center justify-between gap-2 whitespace-nowrap">
        <span>
          <span className="font-semibold">{registered}</span>
          <span className="text-muted-foreground"> / {capacity}</span>
        </span>
        {level === 'full' || level === 'closed' ? (
          <Badge variant={SEAT_BADGES[level].variant}>{SEAT_BADGES[level].label}</Badge>
        ) : (
          <span
            className={
              level === 'low'
                ? 'text-xs font-medium text-warning-foreground'
                : 'text-xs text-muted-foreground'
            }
          >
            เหลือ {remaining}
          </span>
        )}
      </p>
      <SeatBar capacity={capacity} remaining={remaining} />
      {/* Who waits is behind "รายชื่อ"; the count says which clubs have a queue at a glance. */}
      {waitlistCount > 0 && (
        <p className="text-xs whitespace-nowrap text-warning-foreground">รอ {waitlistCount} คน</p>
      )}
    </div>
  );
};
