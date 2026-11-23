import type { ClubMember, ClubWaitlistEntry } from '@club-registration/shared';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
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
}) => (
  <Table aria-label={`สมาชิกชุมนุม ${clubCode}`}>
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

const WAITLIST_COLUMNS = 8;

export const WaitlistTable = ({
  clubCode,
  entries,
  actions,
}: {
  clubCode: string;
  entries: readonly ClubWaitlistEntry[];
  actions: RowActions;
}) => (
  <Table aria-label={`รายชื่อรอชุมนุม ${clubCode}`}>
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
        <PersonRows key={entry.loginId} person={entry} columns={WAITLIST_COLUMNS} actions={actions}>
          <TableCell className="text-right">{entry.position}</TableCell>
          <TableCell className="whitespace-nowrap">{entry.classroom}</TableCell>
          <TableCell className="text-right">{entry.seatNo}</TableCell>
          <TableCell className="whitespace-nowrap">{entry.loginId}</TableCell>
          <TableCell>{entry.fullName}</TableCell>
          <TableCell className="whitespace-nowrap">{formatThaiDateTime(entry.joinedAt)}</TableCell>
          <TableCell>
            {entry.heldClub ? `${entry.heldClub.clubCode} ${entry.heldClub.name}` : '—'}
          </TableCell>
        </PersonRows>
      ))}
    </TableBody>
  </Table>
);
