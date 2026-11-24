import type { AdminClub, ClubAdvisor } from '@club-registration/shared';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { BELOW_MD_QUERY, useMediaQuery } from '@/lib/media-query';
import { ClubSeats } from './ClubSeats';

const LIST_NAME = 'รายการชุมนุม';

const contactsOf = ({ phone, email, lineId }: ClubAdvisor): string =>
  [phone, email, lineId === null ? null : `LINE ${lineId}`]
    .filter((value): value is string => value !== null)
    .join(' · ');

const Advisors = ({ advisors }: { advisors: readonly ClubAdvisor[] }) =>
  advisors.length === 0 ? (
    <span className="text-muted-foreground">ยังไม่มีครู</span>
  ) : (
    <ul className="space-y-1">
      {advisors.map((advisor) => {
        const contacts = contactsOf(advisor);
        return (
          <li key={advisor.id}>
            <span>{advisor.fullName}</span>
            {contacts !== '' && (
              <span className="block text-xs text-muted-foreground">{contacts}</span>
            )}
          </li>
        );
      })}
    </ul>
  );

// The button is passed along so focus can go back to it when the panel it opened closes.
type ClubAction = (club: AdminClub, opener: HTMLButtonElement) => void;

type ClubsTableProps = {
  clubs: readonly AdminClub[];
  onEdit: ClubAction;
  onShowMembers: ClubAction;
};

type ClubActionsProps = Omit<ClubsTableProps, 'clubs'> & { club: AdminClub; className: string };

const ClubActions = ({ club, onEdit, onShowMembers, className }: ClubActionsProps) => (
  <div className={className}>
    <Button
      variant="outline"
      className="px-3 py-1"
      aria-label={`รายชื่อชุมนุม ${club.clubCode}`}
      onClick={(event) => onShowMembers(club, event.currentTarget)}
    >
      รายชื่อ
    </Button>
    <Button
      variant="outline"
      className="px-3 py-1"
      aria-label={`แก้ไขชุมนุม ${club.clubCode}`}
      onClick={(event) => onEdit(club, event.currentTarget)}
    >
      แก้ไข
    </Button>
  </div>
);

// Below md, on a phone or an upright tablet (W1): one card per club with its buttons in reach, instead of a table whose
// "รายชื่อ" and "แก้ไข" sit off screen behind a sideways scroll, away from the club's name.
// The description is cut to two lines to keep the list short; the editor shows all of it.
const ClubCards = ({ clubs, onEdit, onShowMembers }: ClubsTableProps) => (
  <ul
    aria-label={LIST_NAME}
    className="divide-y divide-border rounded-2xl border border-border bg-card shadow-card"
  >
    {clubs.map((club) => (
      <li key={club.id} className="space-y-3 p-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{club.clubCode}</p>
          <p className="font-medium break-words">{club.name}</p>
          {club.description !== '' && (
            <p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">
              {club.description}
            </p>
          )}
        </div>
        <ClubSeats
          className="w-full"
          capacity={club.capacity}
          registered={club.registered}
          remaining={club.remaining}
          waitlistCount={club.waitlistCount}
        />
        <dl className="text-sm">
          <dt className="text-muted-foreground">ครูที่ปรึกษา</dt>
          <dd className="mt-1 min-w-0 break-words">
            <Advisors advisors={club.advisors} />
          </dd>
        </dl>
        <ClubActions
          club={club}
          onEdit={onEdit}
          onShowMembers={onShowMembers}
          className="grid grid-cols-2 gap-2 sm:flex"
        />
      </li>
    ))}
  </ul>
);

// Names, descriptions and advisor details are rendered as text nodes only: they come from admin
// input and the Excel file, so they must never reach the page as HTML.
export const ClubsTable = ({ clubs, onEdit, onShowMembers }: ClubsTableProps) => {
  const narrow = useMediaQuery(BELOW_MD_QUERY);
  if (narrow) return <ClubCards clubs={clubs} onEdit={onEdit} onShowMembers={onShowMembers} />;
  return (
    <Table aria-label={LIST_NAME} className="min-w-2xl">
      <TableHeader>
        <tr>
          <TableHead>รหัส</TableHead>
          <TableHead>ชุมนุม</TableHead>
          <TableHead>ครูที่ปรึกษา</TableHead>
          <TableHead className="whitespace-nowrap">ลงแล้ว / รับ</TableHead>
          <TableHead>
            <span className="sr-only">จัดการ</span>
          </TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {clubs.map((club) => (
          <tr key={club.id} className="align-top">
            <TableCell className="whitespace-nowrap">{club.clubCode}</TableCell>
            <TableCell>
              <span className="font-medium">{club.name}</span>
              {club.description !== '' && (
                // Two lines, as on the cards: a long description made one row fill the screen.
                // The editor ("แก้ไข") shows all of it.
                <p className="mt-1 line-clamp-2 max-w-prose whitespace-pre-line text-muted-foreground">
                  {club.description}
                </p>
              )}
            </TableCell>
            <TableCell>
              <Advisors advisors={club.advisors} />
            </TableCell>
            <TableCell>
              <ClubSeats
                capacity={club.capacity}
                registered={club.registered}
                remaining={club.remaining}
                waitlistCount={club.waitlistCount}
              />
            </TableCell>
            {/* Thai has no spaces between words, so a narrow cell would break "รายชื่อ" in two. */}
            <TableCell className="whitespace-nowrap">
              <ClubActions
                club={club}
                onEdit={onEdit}
                onShowMembers={onShowMembers}
                className="flex justify-end gap-2"
              />
            </TableCell>
          </tr>
        ))}
      </TableBody>
    </Table>
  );
};
