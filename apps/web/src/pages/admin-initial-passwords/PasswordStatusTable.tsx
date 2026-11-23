import type { ClassroomPasswordStatus } from '@club-registration/shared';
import { formatThaiDateTime } from '@/lib/thai-time';
import { gradeLabel } from '@/lib/round-display';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { BELOW_MD_QUERY, useMediaQuery } from '@/lib/media-query';

export const formatCount = (count: number) => count.toLocaleString('th-TH');

const LIST_NAME = 'สถานะรหัสผ่านรายห้อง';

type Classrooms = { classrooms: readonly ClassroomPasswordStatus[] };

// Below md (X4): one card per classroom with its three counts side by side and when it was last
// issued, instead of a six-column table whose last columns sit off screen on a phone.
const StatusCards = ({ classrooms }: Classrooms) => (
  <ul aria-label={LIST_NAME} className="grid gap-3 sm:grid-cols-2">
    {classrooms.map((row) => (
      <li
        key={`${row.grade}-${row.classroom}`}
        className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-card"
      >
        <p className="font-semibold">
          {gradeLabel(row.grade)} ห้อง {row.classroom}
        </p>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          {(
            [
              ['ยังไม่เคยออกรหัส', row.neverIssued],
              ['ออกแล้ว ยังไม่เปลี่ยน', row.issuedPending],
              ['เปลี่ยนรหัสเองแล้ว', row.changed],
            ] as const
          ).map(([label, count]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-base font-semibold">{formatCount(count)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          ออกรหัสล่าสุด{' '}
          {row.lastIssuedAt === null ? (
            'ยังไม่เคย'
          ) : (
            <time dateTime={row.lastIssuedAt}>{formatThaiDateTime(row.lastIssuedAt)}</time>
          )}
        </p>
      </li>
    ))}
  </ul>
);

export const PasswordStatusTable = ({ classrooms }: Classrooms) => {
  const narrow = useMediaQuery(BELOW_MD_QUERY);
  if (narrow) return <StatusCards classrooms={classrooms} />;
  return (
    // The count headers wrap, so the six columns need less width.
    <Table aria-label={LIST_NAME} className="min-w-xl">
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
};
