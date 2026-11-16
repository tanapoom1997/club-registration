import type {
  ImportChangeCounts,
  ImportPreviewResponse,
  ImportSheet,
} from '@club-registration/shared';
import type { ReactNode } from 'react';

const SHEET_LABELS: Readonly<Record<ImportSheet, string>> = Object.freeze({
  students: 'นักเรียน (students)',
  clubs: 'ชุมนุม (clubs)',
  advisors: 'ครูที่ปรึกษา (advisors)',
});

const formatCount = (count: number) => count.toLocaleString('th-TH');

const CountsRow = ({ label, counts }: { label: string; counts: ImportChangeCounts }) => (
  <tr>
    <th scope="row" className="p-3 text-left font-medium">
      {label}
    </th>
    <td className="p-3 text-right">{formatCount(counts.create)}</td>
    <td className="p-3 text-right">{formatCount(counts.update)}</td>
    <td className="p-3 text-right">{formatCount(counts.unchanged)}</td>
  </tr>
);

// The commit answers in the same shape as the preview, so both are shown with this table.
export const SummaryTable = ({
  preview,
  label,
}: {
  preview: Pick<ImportPreviewResponse, 'students' | 'clubs' | 'advisors'>;
  label: string;
}) => (
  <div className="overflow-x-auto rounded-lg border border-border bg-card">
    <table className="w-full text-sm" aria-label={label}>
      <thead className="border-b border-border text-muted-foreground">
        <tr>
          <th className="p-3 text-left font-medium">ข้อมูล</th>
          <th className="p-3 text-right font-medium">เพิ่มใหม่</th>
          <th className="p-3 text-right font-medium">แก้ไข</th>
          <th className="p-3 text-right font-medium">ไม่เปลี่ยน</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        <CountsRow label={SHEET_LABELS.students} counts={preview.students} />
        <CountsRow label={SHEET_LABELS.clubs} counts={preview.clubs} />
        <tr>
          <th scope="row" className="p-3 text-left font-medium">
            {SHEET_LABELS.advisors}
          </th>
          <td className="p-3" colSpan={3}>
            แทนที่รายชื่อครูของ {formatCount(preview.advisors.clubsReplaced)} ชุมนุม
            {preview.advisors.clubsUnchanged > 0 &&
              ` (ไม่เปลี่ยน ${formatCount(preview.advisors.clubsUnchanged)} ชุมนุม)`}{' '}
            จาก {formatCount(preview.advisors.rows)} แถว
          </td>
        </tr>
      </tbody>
    </table>
  </div>
);

const ErrorTable = ({ preview }: { preview: ImportPreviewResponse }) => (
  <div className="space-y-2">
    <h3 className="font-medium text-destructive">
      พบข้อผิดพลาด {formatCount(preview.errorCount)} รายการ ต้องแก้ไฟล์แล้วอัปโหลดใหม่
    </h3>
    {preview.errorCount > preview.errors.length && (
      <p className="text-sm text-muted-foreground">
        แสดง {formatCount(preview.errors.length)} รายการแรก
      </p>
    )}
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-sm" aria-label="รายการข้อผิดพลาด">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">ชีต</th>
            <th className="p-3 text-right font-medium">แถว</th>
            <th className="p-3 font-medium">คอลัมน์</th>
            <th className="p-3 font-medium">ปัญหา</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {preview.errors.map((error, index) => (
            // The list is static once received, so the index is a stable key.
            <tr key={index}>
              <td className="p-3 whitespace-nowrap">
                {error.sheet ? SHEET_LABELS[error.sheet] : 'ทั้งไฟล์'}
              </td>
              <td className="p-3 text-right">{error.row ?? '–'}</td>
              <td className="p-3 whitespace-nowrap">{error.column ?? '–'}</td>
              <td className="p-3">{error.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

// children is the action area under the summary (the confirm step).
export const ImportSummary = ({
  preview,
  children,
}: {
  preview: ImportPreviewResponse;
  children: ReactNode;
}) => (
  <section className="space-y-4" aria-labelledby="import-result-title">
    <div className="space-y-1">
      <h2 id="import-result-title" className="text-lg font-semibold">
        ผลการตรวจสอบ (ยังไม่ได้บันทึกข้อมูล)
      </h2>
      <p className="text-sm text-muted-foreground">
        ภาคเรียน {preview.term} · รหัสไฟล์ (SHA-256){' '}
        <code className="break-all">{preview.fileSha256.slice(0, 12)}</code>
      </p>
    </div>
    <SummaryTable preview={preview} label="สรุปผลการตรวจสอบ" />
    {preview.errorCount === 0 ? (
      <p role="status" className="text-sm text-success-foreground">
        ไม่พบข้อผิดพลาด
      </p>
    ) : (
      <ErrorTable preview={preview} />
    )}
    {children}
  </section>
);
