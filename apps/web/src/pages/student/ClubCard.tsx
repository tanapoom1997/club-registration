import type { StudentClub, StudentRegistration, StudentWaitlist } from '@club-registration/shared';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { SeatMeter } from '@/components/SeatMeter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatThaiDateTime } from '@/lib/thai-time';
import { cn } from '@/lib/utils';
import { WritePanel } from '@/components/WritePanel';
import type { FollowUp, WriteState } from '@/components/WritePanel';
import { ClubDescription } from './ClubDescription';
import type { ClubOffer, ClubWriteKind } from './student-ui';

export type ClubWrite = WriteState & { kind: ClubWriteKind; followUp?: FollowUp | undefined };

type ClubCardProps = {
  club: StudentClub;
  // The student's registration and waitlist entry in the round, for what this card offers and
  // what its confirmation warns about.
  registration: StudentRegistration | null;
  waitlist: StudentWaitlist | null;
  offer: ClubOffer;
  // The round has closed: the counts are final, so the card says how many joined, not how many
  // seats are left or who waits.
  closed: boolean;
  // The round is open and no write is on its way.
  enabled: boolean;
  // Set while the round has not opened: the pale button says beside it when it can be pressed, so
  // a student far down the list from the round's own note is not left guessing why.
  opensAt: string | undefined;
  // Set while this club's confirmation is open.
  write: ClubWrite | undefined;
  onStart: (kind: ClubWriteKind) => void;
};

const clubLabel = ({ clubCode, name }: { clubCode: string; name: string }) => `${clubCode} ${name}`;

// The visible text starts the accessible name, which adds the club so every card's button is
// told apart (WCAG label in name).
const ACTION_TEXT: Readonly<Record<ClubWriteKind, string>> = Object.freeze({
  register: 'ลงชุมนุม',
  change: 'ย้ายมาชุมนุมนี้',
  join: 'เข้ารายชื่อรอ',
});

type PanelText = {
  label: string;
  question: string;
  note: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel: string;
};

const panelText = (
  kind: ClubWriteKind,
  club: StudentClub,
  registration: StudentRegistration | null,
  waitlist: StudentWaitlist | null,
): PanelText => {
  const target = clubLabel(club);
  if (kind === 'register') {
    return {
      label: `ยืนยันการลงชุมนุม ${target}`,
      question: `ลงชุมนุม ${target}?`,
      note: 'ลงได้ 1 ชุมนุมต่อรอบ ถ้าจะเปลี่ยนภายหลัง ย้ายไปชุมนุมที่ยังมีที่ว่างได้ หรือเข้ารายชื่อรอของชุมนุมที่เต็ม',
      confirmLabel: 'ยืนยัน ลงชุมนุม',
      pendingLabel: 'กำลังลงทะเบียน…',
      dismissLabel: 'ไม่ลง',
    };
  }
  const held = registration ? clubLabel(registration.club) : undefined;
  if (kind === 'change') {
    return {
      label: `ยืนยันการย้ายไปชุมนุม ${target}`,
      question: `ย้ายจากชุมนุม ${held ?? ''} ไปชุมนุม ${target}?`,
      note: (
        <>
          <p className="font-medium">
            คุณจะออกจากชุมนุมเดิมก็ต่อเมื่อได้ที่ในชุมนุมใหม่แล้วเท่านั้น ถ้าชุมนุมใหม่เต็มก่อน คุณยังอยู่ชุมนุมเดิม
          </p>
          <p>ย้ายแล้วที่นั่งเดิมจะว่างและอาจมีคนอื่นได้แทน ถ้าเปลี่ยนใจภายหลังอาจกลับไปไม่ได้</p>
        </>
      ),
      confirmLabel: 'ยืนยัน ย้ายชุมนุม',
      pendingLabel: 'กำลังย้ายชุมนุม…',
      dismissLabel: 'ไม่ย้าย',
    };
  }
  return {
    label: `ยืนยันการเข้ารายชื่อรอชุมนุม ${target}`,
    question: `เข้ารายชื่อรอชุมนุม ${target}?`,
    note: (
      <>
        <p>
          คุณจะต่อท้ายรายชื่อรอ (ตอนนี้มีคนรอ {club.waitlistCount} คน) เมื่อมีที่ว่าง ระบบจะให้ที่ตามลำดับเอง
          และแจ้งผลที่หน้านี้เท่านั้น
        </p>
        {held && (
          <p className="font-medium">
            ถ้าได้ที่ ระบบจะย้ายคุณออกจากชุมนุม {held} มาชุมนุมนี้ทันที และที่นั่งเดิมจะว่าง
          </p>
        )}
        {waitlist && (
          <p className="font-medium">
            คุณรอชุมนุม {clubLabel(waitlist.club)} อยู่ (ลำดับที่ {waitlist.position}) รอได้ทีละ 1 ชุมนุม
            ถ้าเข้ารายชื่อรอชุมนุมนี้ ลำดับเดิมจะหายไป
          </p>
        )}
      </>
    ),
    confirmLabel: 'ยืนยัน เข้ารายชื่อรอ',
    pendingLabel: 'กำลังเข้ารายชื่อรอ…',
    dismissLabel: 'ไม่เข้า',
  };
};

// Every name and the description come from admin input, so they are rendered as text nodes only,
// never as HTML; whitespace-pre-line keeps the admin's line breaks.
export const ClubCard = ({
  club,
  registration,
  waitlist,
  offer,
  closed,
  enabled,
  opensAt,
  write,
  onStart,
}: ClubCardProps) => {
  const headingId = useId();
  const opensNoteId = useId();
  // One ref for whichever action the card shows: after a change refused as full, the refetch
  // turns the same button into the waitlist one, and focus still has to come back to it.
  const actionRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const confirming = write !== undefined;
  const held = registration?.club.id === club.id;
  const waiting = waitlist?.club.id === club.id ? waitlist : undefined;

  // Closing the confirmation removes the focused button, so focus goes back where it started.
  useEffect(() => {
    if (wasConfirming.current && !confirming) actionRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        // A column that fills its grid cell, with the action pushed to the bottom: two cards side by
        // side have their buttons on one line however long either description is (W4).
        'flex h-full flex-col gap-3 rounded-2xl border bg-card p-5 shadow-card transition-shadow hover:shadow-card-hover',
        held ? 'border-success-foreground ring-2 ring-success-foreground/20' : 'border-border',
      )}
    >
      {/* The name gets the card's full width (long Thai names wrapped beside the seat count on a
          phone); the seats sit on their own row under it. */}
      <div className="min-w-0 space-y-1">
        <p className="text-sm text-muted-foreground">{club.clubCode}</p>
        <h3 id={headingId} className="font-semibold break-words">
          {club.name}
        </h3>
        {(held || waiting) && (
          <div className="flex flex-wrap gap-1.5">
            {held && <Badge variant="success">ชุมนุมของฉัน</Badge>}
            {waiting && <Badge variant="warning">รออยู่ ลำดับที่ {waiting.position}</Badge>}
          </div>
        )}
      </div>
      {closed ? (
        <p className="text-sm text-muted-foreground">
          {club.capacity <= 0 ? 'ไม่เปิดรับ' : `ลงแล้ว ${club.registered} / รับ ${club.capacity} คน`}
        </p>
      ) : (
        <SeatMeter
          capacity={club.capacity}
          remaining={club.remaining}
          waitlistCount={club.waitlistCount}
        />
      )}

      <p className="text-sm">
        <span className="text-muted-foreground">ครูที่ปรึกษา: </span>
        {club.advisorNames.length === 0 ? 'ยังไม่ระบุ' : club.advisorNames.join(', ')}
      </p>
      {club.description !== '' && (
        <ClubDescription description={club.description} clubLabel={clubLabel(club)} />
      )}

      {(write !== undefined || offer !== 'none') && (
        <div className="mt-auto">
          {write ? (
            <WritePanel
              // A follow-up (club_full → waitlist) opens a new confirmation that takes focus again.
              key={write.kind}
              state={write}
              followUp={write.followUp}
              {...panelText(write.kind, club, registration, waitlist)}
            />
          ) : (
            offer !== 'none' && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button
                  ref={actionRef}
                  // Only a first seat is the main action. Once the student holds a club, moving is
                  // an option on every other card, and a wall of solid buttons would push it.
                  variant={offer === 'register' ? 'primary' : 'outline'}
                  className="w-full sm:w-auto"
                  aria-label={`${ACTION_TEXT[offer]} ${clubLabel(club)}`}
                  aria-describedby={opensAt === undefined ? undefined : opensNoteId}
                  disabled={!enabled}
                  onClick={() => onStart(offer)}
                >
                  {ACTION_TEXT[offer]}
                </Button>
                {opensAt !== undefined && (
                  <p id={opensNoteId} className="text-sm text-muted-foreground">
                    ลงได้ตั้งแต่ {formatThaiDateTime(opensAt)} น.
                  </p>
                )}
              </div>
            )
          )}
        </div>
      )}
    </article>
  );
};
