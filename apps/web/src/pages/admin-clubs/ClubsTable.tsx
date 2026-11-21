import type { AdminClub, ClubAdvisor } from '@club-registration/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';

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

type ClubsTableProps = {
  clubs: readonly AdminClub[];
  onEdit: (club: AdminClub) => void;
  onShowMembers: (club: AdminClub) => void;
};

// Names, descriptions and advisor details are rendered as text nodes only: they come from admin
// input and the Excel file, so they must never reach the page as HTML.
export const ClubsTable = ({ clubs, onEdit, onShowMembers }: ClubsTableProps) => (
  <Table aria-label="รายการชุมนุม">
    <TableHeader>
      <tr>
        <TableHead>รหัส</TableHead>
        <TableHead>ชุมนุม</TableHead>
        <TableHead>ครูที่ปรึกษา</TableHead>
        <TableHead className="text-right">รับ</TableHead>
        <TableHead className="text-right">ลงแล้ว</TableHead>
        <TableHead className="text-right">เหลือ</TableHead>
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
              <p className="mt-1 max-w-prose whitespace-pre-line text-muted-foreground">
                {club.description}
              </p>
            )}
          </TableCell>
          <TableCell>
            <Advisors advisors={club.advisors} />
          </TableCell>
          <TableCell className="text-right">{club.capacity}</TableCell>
          <TableCell className="text-right">{club.registered}</TableCell>
          <TableCell className="text-right">
            {club.remaining === 0 ? <Badge variant="warning">เต็ม</Badge> : club.remaining}
          </TableCell>
          <TableCell>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                className="px-3 py-1"
                aria-label={`รายชื่อชุมนุม ${club.clubCode}`}
                onClick={() => onShowMembers(club)}
              >
                รายชื่อ
              </Button>
              <Button
                variant="outline"
                className="px-3 py-1"
                aria-label={`แก้ไขชุมนุม ${club.clubCode}`}
                onClick={() => onEdit(club)}
              >
                แก้ไข
              </Button>
            </div>
          </TableCell>
        </tr>
      ))}
    </TableBody>
  </Table>
);
