import type { ClassroomPasswordStatus } from '@club-registration/shared';
import { formatThaiDateTime } from '@/lib/thai-time';
import { gradeLabel } from '@/pages/admin-rounds/round-ui';

export const formatCount = (count: number) => count.toLocaleString('th-TH');

export const PasswordStatusTable = ({
  classrooms,
}: {
  classrooms: readonly ClassroomPasswordStatus[];
}) => (
  <div className="overflow-x-auto rounded-lg border border-border bg-card">
    <table className="w-full text-left text-sm" aria-label="สถานะรหัสผ่านรายห้อง">
      <thead className="border-b border-border text-muted-foreground">
        <tr>
          <th className="p-3 font-medium">ชั้น</th>
          <th className="p-3 font-medium">ห้อง</th>
          <th className="p-3 text-right font-medium">ยังไม่เคยออกรหัส</th>
          <th className="p-3 text-right font-medium">ออกแล้ว ยังไม่เปลี่ยน</th>
          <th className="p-3 text-right font-medium">เปลี่ยนรหัสเองแล้ว</th>
          <th className="p-3 font-medium">ออกรหัสล่าสุด</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {classrooms.map((row) => (
          <tr key={`${row.grade}-${row.classroom}`}>
            <td className="p-3">{gradeLabel(row.grade)}</td>
            <td className="p-3">{row.classroom}</td>
            <td className="p-3 text-right">{formatCount(row.neverIssued)}</td>
            <td className="p-3 text-right">{formatCount(row.issuedPending)}</td>
            <td className="p-3 text-right">{formatCount(row.changed)}</td>
            <td className="p-3 whitespace-nowrap">
              {row.lastIssuedAt === null ? '–' : formatThaiDateTime(row.lastIssuedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
