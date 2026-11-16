import type { ImportCommitResponse } from '@club-registration/shared';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { SummaryTable } from './ImportSummary';

type ConfirmImportProps = {
  // The preview this step belongs to had errors: there is nothing to confirm.
  hasErrors: boolean;
  isPending: boolean;
  result: ImportCommitResponse | undefined;
  errorMessage: string | undefined;
  // After a refusal that means the preview is out of date, only a new preview can go on.
  needsNewPreview: boolean;
  onConfirm: () => void;
};

const formatCount = (count: number) => count.toLocaleString('th-TH');

export const ConfirmImport = ({
  hasErrors,
  isPending,
  result,
  errorMessage,
  needsNewPreview,
  onConfirm,
}: ConfirmImportProps) => {
  if (result) {
    return (
      <section className="space-y-3" aria-labelledby="import-commit-title">
        <h2 id="import-commit-title" className="text-lg font-semibold">
          นำเข้าข้อมูลเรียบร้อยแล้ว
        </h2>
        <SummaryTable preview={result} label="สรุปผลการนำเข้า" />
        {result.students.create > 0 && (
          <p className="text-sm text-muted-foreground">
            นักเรียนที่เพิ่มใหม่ {formatCount(result.students.create)} คน
            ยังเข้าสู่ระบบไม่ได้จนกว่าจะออกรหัสผ่านเริ่มต้นให้
          </p>
        )}
        <Button disabled>ยืนยันนำเข้า</Button>
      </section>
    );
  }

  if (hasErrors) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled>ยืนยันนำเข้า</Button>
        <p className="text-sm text-muted-foreground">
          แก้ไฟล์ให้ไม่มีข้อผิดพลาดแล้วตรวจสอบใหม่ จึงจะยืนยันนำเข้าได้
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        กดยืนยันเพื่อบันทึกทั้งไฟล์ลงระบบในครั้งเดียว ถ้ามีปัญหาแม้แถวเดียวจะไม่บันทึกอะไรเลย
      </p>
      <FormError message={errorMessage} />
      <Button onClick={onConfirm} disabled={isPending || needsNewPreview}>
        {isPending ? 'กำลังนำเข้า…' : 'ยืนยันนำเข้า'}
      </Button>
    </div>
  );
};
