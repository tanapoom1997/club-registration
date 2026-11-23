import type { ClassroomPasswordStatus } from '@club-registration/shared';
import { formatThaiDateTime } from '@/lib/thai-time';
import { gradeLabel } from '@/lib/round-display';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';

export const formatCount = (count: number) => count.toLocaleString('th-TH');

export const PasswordStatusTable = ({
  classrooms,
}: {
  classrooms: readonly ClassroomPasswordStatus[];
}) => (
  // The count headers wrap, so a phone scrolls sideways less far.
  <Table aria-label="สถานะรหัสผ่านรายห้อง" className="min-w-xl">
    <TableHeader>
      <tr>
        <TableHead>ชั้น</TableHead>
        <TableHead>ห้อง</TableHead>
        <TableHead className="text-right whitespace-normal">ยังไม่เคยออกรหัส</TableHead>
        <TableHead className="text-right whitespace-normal">ออกแล้ว ยังไม่เปลี่ยน</TableHead>
        <TableHead className="text-right whitespace-normal">เปลี่ยนรหัสเองแล้ว</TableHead>
        <TableHead>ออกรหัสล่าสุด</TableHead>
      </tr>
    </TableHeader>
    <TableBody>
      {classrooms.map((row) => (
        <tr key={`${row.grade}-${row.classroom}`}>
          <TableCell>{gradeLabel(row.grade)}</TableCell>
          <TableCell>{row.classroom}</TableCell>
          <TableCell className="text-right">{formatCount(row.neverIssued)}</TableCell>
          <TableCell className="text-right">{formatCount(row.issuedPending)}</TableCell>
          <TableCell className="text-right">{formatCount(row.changed)}</TableCell>
          <TableCell className="whitespace-nowrap">
            {row.lastIssuedAt === null ? '–' : formatThaiDateTime(row.lastIssuedAt)}
          </TableCell>
        </tr>
      ))}
    </TableBody>
  </Table>
);
