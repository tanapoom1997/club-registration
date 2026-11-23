import type {
  ImportChangeCounts,
  ImportPreviewResponse,
  ImportSheet,
} from '@club-registration/shared';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { alertVariants } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { BELOW_MD_QUERY, useMediaQuery } from '@/lib/media-query';

const SHEET_LABELS: Readonly<Record<ImportSheet, string>> = Object.freeze({
  students: 'นักเรียน (students)',
  clubs: 'ชุมนุม (clubs)',
  advisors: 'ครูที่ปรึกษา (advisors)',
});

const formatCount = (count: number) => count.toLocaleString('th-TH');

const CountsRow = ({ label, counts }: { label: string; counts: ImportChangeCounts }) => (
  <tr>
    <TableHead scope="row" className="whitespace-normal">
      {label}
    </TableHead>
    <TableCell className="text-right">{formatCount(counts.create)}</TableCell>
    <TableCell className="text-right">{formatCount(counts.update)}</TableCell>
    <TableCell className="text-right">{formatCount(counts.unchanged)}</TableCell>
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
  // Narrow enough for a phone: three short numbers per row fit without scrolling sideways, with
  // the row labels wrapping and tighter cells below sm.
  <Table aria-label={label} className="min-w-0 max-sm:[&_td]:px-2.5 max-sm:[&_th]:px-2.5">
    <TableHeader>
      <tr>
        <TableHead>ข้อมูล</TableHead>
        <TableHead className="text-right">เพิ่มใหม่</TableHead>
        <TableHead className="text-right">แก้ไข</TableHead>
        <TableHead className="text-right">ไม่เปลี่ยน</TableHead>
      </tr>
    </TableHeader>
    <TableBody>
      <CountsRow label={SHEET_LABELS.students} counts={preview.students} />
      <CountsRow label={SHEET_LABELS.clubs} counts={preview.clubs} />
      <tr>
        <TableHead scope="row" className="whitespace-normal">
          {SHEET_LABELS.advisors}
        </TableHead>
        <TableCell colSpan={3}>
          แทนที่รายชื่อครูของ {formatCount(preview.advisors.clubsReplaced)} ชุมนุม
          {preview.advisors.clubsUnchanged > 0 &&
            ` (ไม่เปลี่ยน ${formatCount(preview.advisors.clubsUnchanged)} ชุมนุม)`}{' '}
          จาก {formatCount(preview.advisors.rows)} แถว
        </TableCell>
      </tr>
    </TableBody>
  </Table>
);

const ERROR_LIST_NAME = 'รายการข้อผิดพลาด';

type ImportError = ImportPreviewResponse['errors'][number];

const sheetText = (error: ImportError) => (error.sheet ? SHEET_LABELS[error.sheet] : 'ทั้งไฟล์');

// Below md, on a phone or an upright tablet (X1): one card per error, where it is, then what is
// wrong, instead of a table whose "ปัญหา" column (what to fix) sits off screen.
const ErrorCards = ({ errors }: { errors: readonly ImportError[] }) => (
  <ul
    aria-label={ERROR_LIST_NAME}
    className="divide-y divide-border rounded-2xl border border-border bg-card shadow-card"
  >
    {errors.map((error, index) => (
      // The list is static once received, so the index is a stable key.
      <li key={index} className="space-y-1 p-4">
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span>{sheetText(error)}</span>
          {error.row !== null && <span>แถว {error.row}</span>}
          {error.column !== null && <span>คอลัมน์ {error.column}</span>}
        </p>
        <p className="text-sm break-words">{error.message}</p>
      </li>
    ))}
  </ul>
);

const ErrorTable = ({ preview }: { preview: ImportPreviewResponse }) => {
  const narrow = useMediaQuery(BELOW_MD_QUERY);
  return (
    <div className="space-y-2">
      <h3 className={cn(alertVariants({ variant: 'danger' }), 'font-medium')}>
        พบข้อผิดพลาด {formatCount(preview.errorCount)} รายการ ต้องแก้ไฟล์แล้วอัปโหลดใหม่
      </h3>
      {preview.errorCount > preview.errors.length && (
        <p className="text-sm text-muted-foreground">
          แสดง {formatCount(preview.errors.length)} รายการแรก
        </p>
      )}
      {narrow ? (
        <ErrorCards errors={preview.errors} />
      ) : (
        <Table aria-label={ERROR_LIST_NAME}>
          <TableHeader>
            <tr>
              <TableHead>ชีต</TableHead>
              <TableHead className="text-right">แถว</TableHead>
              <TableHead>คอลัมน์</TableHead>
              <TableHead>ปัญหา</TableHead>
            </tr>
          </TableHeader>
          <TableBody>
            {preview.errors.map((error, index) => (
              // The list is static once received, so the index is a stable key.
              <tr key={index}>
                <TableCell className="whitespace-nowrap">{sheetText(error)}</TableCell>
                <TableCell className="text-right">{error.row ?? '–'}</TableCell>
                <TableCell className="whitespace-nowrap">{error.column ?? '–'}</TableCell>
                <TableCell>{error.message}</TableCell>
              </tr>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};

// children is the action area under the summary (the confirm step).
export const ImportSummary = ({
  preview,
  children,
}: {
  preview: ImportPreviewResponse;
  children: ReactNode;
}) => (
  <section
    className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-6"
    aria-labelledby="import-result-title"
  >
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
      <p role="status" className={cn(alertVariants({ variant: 'success' }), 'font-medium')}>
        ไม่พบข้อผิดพลาด
      </p>
    ) : (
      <ErrorTable preview={preview} />
    )}
    {children}
  </section>
);
