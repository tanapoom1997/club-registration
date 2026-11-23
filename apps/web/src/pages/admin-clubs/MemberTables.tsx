import type { ClubMember, ClubWaitlistEntry } from '@club-registration/shared';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { BELOW_MD_QUERY, useMediaQuery } from '@/lib/media-query';
import { formatThaiDateTime } from '@/lib/thai-time';
import { SOURCE_DISPLAY } from './club-members-ui';

export type RowActions = {
  // A write is on its way.
  disabled: boolean;
  // The confirmation open under this student's row, if any.
  confirmationFor: (loginId: string) => ReactNode;
  // The button is kept so focus can go back to it when the confirmation closes.
  onRemove: (person: Person, opener: HTMLButtonElement) => void;
};

export type Person = { loginId: string; fullName: string };

// The visible text starts the accessible name, which adds the student so every row's button is
// told apart (WCAG label in name).
const RemoveButton = ({ person, actions }: { person: Person; actions: RowActions }) => (
  <div className="flex justify-end">
    <Button
      variant="outline"
      className="px-3 py-1 whitespace-nowrap"
      aria-label={`นำออก ${person.loginId} ${person.fullName}`}
      disabled={actions.disabled}
      onClick={(event) => actions.onRemove(person, event.currentTarget)}
    >
      นำออก
    </Button>
  </div>
);

// The row, then the confirmation (if open) below it across the table, so on a phone it opens
// where the admin tapped.
const PersonRows = ({
  person,
  columns,
  actions,
  children,
}: {
  person: Person;
  columns: number;
  actions: RowActions;
  children: ReactNode;
}) => {
  const confirmation = actions.confirmationFor(person.loginId);
  return (
    <>
      <tr className="align-top">
        {children}
        <TableCell>
          <RemoveButton person={person} actions={actions} />
        </TableCell>
      </tr>
      {confirmation && (
        <tr>
          {/* Pinned to the visible part of a table that scrolls sideways on a phone, so the
              question and its buttons are never cut off past the right edge. */}
          <td colSpan={columns} className="pb-4">
            <div className="sticky left-4 w-[calc(100cqw-2rem)]">{confirmation}</div>
          </td>
        </tr>
      )}
    </>
  );
};

const ManageHead = () => (
  <TableHead>
    <span className="sr-only">จัดการ</span>
  </TableHead>
);

// Below md, on a phone or an upright tablet (W2): one card per student, with "นำออก" beside the
// name instead of off screen past a table that scrolls sideways, and the confirmation opening
// inside the card the admin tapped.
const PersonCards = <T extends Person>({
  label,
  people,
  actions,
  lead,
  details,
}: {
  label: string;
  people: readonly T[];
  actions: RowActions;
  // Shown before the name: the queue position, or nothing.
  lead?: (person: T) => ReactNode;
  details: (person: T) => ReactNode;
}) => (
  <ul
    aria-label={label}
    className="divide-y divide-border rounded-2xl border border-border bg-card shadow-card"
  >
    {people.map((person) => (
      <li key={person.loginId} className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            {lead?.(person)}
            <div className="min-w-0 space-y-1 text-sm">
              <p className="text-base font-medium break-words">{person.fullName}</p>
              {details(person)}
            </div>
          </div>
          <div className="shrink-0">
            <RemoveButton person={person} actions={actions} />
          </div>
        </div>
        {actions.confirmationFor(person.loginId)}
      </li>
    ))}
  </ul>
);

const StudentLine = ({ person }: { person: ClubMember | ClubWaitlistEntry }) => (
  <p className="text-muted-foreground">
    {person.loginId} · ห้อง {person.classroom} เลขที่ {person.seatNo}
  </p>
);

const MemberDetails = ({ member }: { member: ClubMember }) => {
  const source = SOURCE_DISPLAY[member.source ?? 'none'];
  return (
    <>
      <StudentLine person={member} />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          ได้ที่เมื่อ{' '}
          <time dateTime={member.registeredAt}>{formatThaiDateTime(member.registeredAt)}</time>
        </span>
        <Badge variant={source.variant}>{source.label}</Badge>
      </p>
    </>
  );
};

const WaiterDetails = ({ entry }: { entry: ClubWaitlistEntry }) => (
  <>
    <StudentLine person={entry} />
    <p className="text-xs text-muted-foreground">
      เข้ารอเมื่อ <time dateTime={entry.joinedAt}>{formatThaiDateTime(entry.joinedAt)}</time>
    </p>
    {entry.heldClub && (
      <p className="text-xs text-muted-foreground">
        ถือชุมนุมอยู่: {entry.heldClub.clubCode} {entry.heldClub.name}
      </p>
    )}
  </>
);

const QueuePosition = ({ position }: { position: number }) => (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
    <span className="sr-only">ลำดับที่ </span>
    {position}
  </span>
);

const MEMBER_COLUMNS = 7;

// Names come from the import file, so they are rendered as text nodes only.
export const MembersTable = ({
  clubCode,
  members,
  actions,
}: {
  clubCode: string;
  members: readonly ClubMember[];
  actions: RowActions;
}) => {
  const narrow = useMediaQuery(BELOW_MD_QUERY);
  const label = `สมาชิกชุมนุม ${clubCode}`;
  if (narrow) {
    return (
      <PersonCards
        label={label}
        people={members}
        actions={actions}
        details={(member) => <MemberDetails member={member} />}
      />
    );
  }
  return (
    <Table aria-label={label}>
      <TableHeader>
        <tr>
          <TableHead>ห้อง</TableHead>
          <TableHead className="text-right">เลขที่</TableHead>
          <TableHead>รหัสนักเรียน</TableHead>
          <TableHead>ชื่อ–สกุล</TableHead>
          <TableHead>ได้ที่เมื่อ</TableHead>
          <TableHead>ที่มา</TableHead>
          <ManageHead />
        </tr>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const source = SOURCE_DISPLAY[member.source ?? 'none'];
          return (
            <PersonRows
              key={member.loginId}
              person={member}
              columns={MEMBER_COLUMNS}
              actions={actions}
            >
              <TableCell className="whitespace-nowrap">{member.classroom}</TableCell>
              <TableCell className="text-right">{member.seatNo}</TableCell>
              <TableCell className="whitespace-nowrap">{member.loginId}</TableCell>
              <TableCell>{member.fullName}</TableCell>
              <TableCell className="whitespace-nowrap">
                {formatThaiDateTime(member.registeredAt)}
              </TableCell>
              <TableCell>
                <Badge variant={source.variant}>{source.label}</Badge>
              </TableCell>
            </PersonRows>
          );
        })}
      </TableBody>
    </Table>
  );
};

const WAITLIST_COLUMNS = 8;

export const WaitlistTable = ({
  clubCode,
  entries,
  actions,
}: {
  clubCode: string;
  entries: readonly ClubWaitlistEntry[];
  actions: RowActions;
}) => {
  const narrow = useMediaQuery(BELOW_MD_QUERY);
  const label = `รายชื่อรอชุมนุม ${clubCode}`;
  if (narrow) {
    return (
      <PersonCards
        label={label}
        people={entries}
        actions={actions}
        lead={(entry) => <QueuePosition position={entry.position} />}
        details={(entry) => <WaiterDetails entry={entry} />}
      />
    );
  }
  return (
    <Table aria-label={label}>
      <TableHeader>
        <tr>
          <TableHead className="text-right">ลำดับ</TableHead>
          <TableHead>ห้อง</TableHead>
          <TableHead className="text-right">เลขที่</TableHead>
          <TableHead>รหัสนักเรียน</TableHead>
          <TableHead>ชื่อ–สกุล</TableHead>
          <TableHead>เข้ารอเมื่อ</TableHead>
          <TableHead>ถือชุมนุมอยู่</TableHead>
          <ManageHead />
        </tr>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <PersonRows
            key={entry.loginId}
            person={entry}
            columns={WAITLIST_COLUMNS}
            actions={actions}
          >
            <TableCell className="text-right">{entry.position}</TableCell>
            <TableCell className="whitespace-nowrap">{entry.classroom}</TableCell>
            <TableCell className="text-right">{entry.seatNo}</TableCell>
            <TableCell className="whitespace-nowrap">{entry.loginId}</TableCell>
            <TableCell>{entry.fullName}</TableCell>
            {/* Free to wrap, so the eight columns fit a 768px tablet without scrolling. */}
            <TableCell>{formatThaiDateTime(entry.joinedAt)}</TableCell>
            <TableCell>
              {entry.heldClub ? `${entry.heldClub.clubCode} ${entry.heldClub.name}` : '—'}
            </TableCell>
          </PersonRows>
        ))}
      </TableBody>
    </Table>
  );
};
