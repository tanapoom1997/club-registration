import type { AdminClub, ClubAdvisor } from '@club-registration/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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

type ClubsTableProps = { clubs: readonly AdminClub[]; onEdit: (club: AdminClub) => void };

// Names, descriptions and advisor details are rendered as text nodes only: they come from admin
// input and the Excel file, so they must never reach the page as HTML.
export const ClubsTable = ({ clubs, onEdit }: ClubsTableProps) => (
  <div className="overflow-x-auto rounded-lg border border-border bg-card">
    <table className="w-full text-left text-sm" aria-label="รายการชุมนุม">
      <thead className="border-b border-border text-muted-foreground">
        <tr>
          <th className="p-3 font-medium">รหัส</th>
          <th className="p-3 font-medium">ชุมนุม</th>
          <th className="p-3 font-medium">ครูที่ปรึกษา</th>
          <th className="p-3 text-right font-medium">รับ</th>
          <th className="p-3 text-right font-medium">ลงแล้ว</th>
          <th className="p-3 text-right font-medium">เหลือ</th>
          <th className="p-3">
            <span className="sr-only">จัดการ</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {clubs.map((club) => (
          <tr key={club.id} className="align-top">
            <td className="p-3 whitespace-nowrap">{club.clubCode}</td>
            <td className="p-3">
              <span className="font-medium">{club.name}</span>
              {club.description !== '' && (
                <p className="mt-1 max-w-prose whitespace-pre-line text-muted-foreground">
                  {club.description}
                </p>
              )}
            </td>
            <td className="p-3">
              <Advisors advisors={club.advisors} />
            </td>
            <td className="p-3 text-right">{club.capacity}</td>
            <td className="p-3 text-right">{club.registered}</td>
            <td className="p-3 text-right">
              {club.remaining === 0 ? <Badge variant="warning">เต็ม</Badge> : club.remaining}
            </td>
            <td className="p-3">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  className="px-3 py-1"
                  aria-label={`แก้ไขชุมนุม ${club.clubCode}`}
                  onClick={() => onEdit(club)}
                >
                  แก้ไข
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
