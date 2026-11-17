import type { StudentClub } from '@club-registration/shared';
import { useEffect, useId, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { WritePanel } from './WritePanel';
import type { WriteState } from './WritePanel';

type ClubCardProps = {
  club: StudentClub;
  // This card is the club the student holds.
  held: boolean;
  // The student holds a club in this round, this one or another. The held-club card at the top
  // already explains how to change, so no card offers a register button that could never work.
  holdsClub: boolean;
  canRegister: boolean;
  // Set while this club's confirmation is open.
  write: WriteState | undefined;
  onRegister: () => void;
};

const clubLabel = ({ clubCode, name }: StudentClub) => `${clubCode} ${name}`;

// Every name and the description come from admin input, so they are rendered as text nodes only,
// never as HTML; whitespace-pre-line keeps the admin's line breaks.
export const ClubCard = ({
  club,
  held,
  holdsClub,
  canRegister,
  write,
  onRegister,
}: ClubCardProps) => {
  const headingId = useId();
  const registerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const confirming = write !== undefined;

  // Closing the confirmation removes the focused button, so focus goes back where it started.
  useEffect(() => {
    if (wasConfirming.current && !confirming) registerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        'space-y-3 rounded-2xl border bg-card p-5 shadow-card transition-shadow hover:shadow-card-hover',
        held ? 'border-success-foreground ring-2 ring-success-foreground/20' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{club.clubCode}</p>
          <h3 id={headingId} className="font-semibold break-words">
            {club.name}
          </h3>
          {held && <Badge variant="success">ชุมนุมของฉัน</Badge>}
        </div>
        <div className="shrink-0 text-right">
          {club.remaining === 0 ? (
            <Badge variant="warning">เต็ม</Badge>
          ) : (
            <p className="text-sm">
              เหลือ <span className="text-xl font-bold text-primary">{club.remaining}</span> ที่
            </p>
          )}
          <p className="text-xs text-muted-foreground">รับ {club.capacity} คน</p>
        </div>
      </div>

      <p className="text-sm">
        <span className="text-muted-foreground">ครูที่ปรึกษา: </span>
        {club.advisorNames.length === 0 ? 'ยังไม่ระบุ' : club.advisorNames.join(', ')}
      </p>
      {club.description !== '' && (
        <p className="text-sm break-words whitespace-pre-line text-muted-foreground">
          {club.description}
        </p>
      )}

      {write ? (
        <WritePanel
          state={write}
          label={`ยืนยันการลงชุมนุม ${clubLabel(club)}`}
          question={`ลงชุมนุม ${clubLabel(club)}?`}
          note="ลงได้ 1 ชุมนุมต่อรอบ ถ้าจะเปลี่ยนภายหลังต้องยกเลิกก่อน และที่นั่งที่ยกเลิกอาจมีคนอื่นลงแทน"
          confirmLabel="ยืนยัน ลงชุมนุม"
          pendingLabel="กำลังลงทะเบียน…"
          dismissLabel="ไม่ลง"
        />
      ) : (
        !holdsClub && (
          <Button
            ref={registerRef}
            className="w-full sm:w-auto"
            aria-label={`ลงชุมนุม ${clubLabel(club)}`}
            disabled={!canRegister || club.remaining === 0}
            onClick={onRegister}
          >
            ลงชุมนุม
          </Button>
        )
      )}
    </article>
  );
};
