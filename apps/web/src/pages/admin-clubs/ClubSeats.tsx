import type { AdminClub } from '@club-registration/shared';
import { SeatBar } from '@/components/SeatMeter';
import { Badge } from '@/components/ui/badge';
import { seatLevel } from '@/lib/seats';

type ClubSeatsProps = Pick<AdminClub, 'capacity' | 'registered' | 'remaining'>;

// The admin's one-column view of a club's seats: registered over capacity (the column header says
// which is which), what is left in words, and the same bar the students see. A nearly full club
// shows "เหลือ 2" in the warning colour: the count itself says it, the colour only draws the eye.
export const ClubSeats = ({ capacity, registered, remaining }: ClubSeatsProps) => {
  const level = seatLevel(capacity, remaining);
  return (
    <div className="w-32 space-y-1.5">
      <p className="flex items-center justify-between gap-2 whitespace-nowrap">
        <span>
          <span className="font-semibold">{registered}</span>
          <span className="text-muted-foreground"> / {capacity}</span>
        </span>
        {level === 'full' ? (
          <Badge variant="warning">เต็ม</Badge>
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
    </div>
  );
};
