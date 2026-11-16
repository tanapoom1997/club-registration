import {
  ERROR_CODES,
  IMPORT_FILE_EXTENSION,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS_PER_SHEET,
} from '@club-registration/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ApiError, IMPORT_TEMPLATE_URL, fetchRounds, previewImport } from '@/lib/api';
import { useSetSession } from '@/lib/session';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { ImportSummary } from './ImportSummary';

const MAX_FILE_MB = IMPORT_MAX_FILE_BYTES / (1024 * 1024);

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.fileTooLarge]: `ไฟล์ใหญ่เกิน ${MAX_FILE_MB} MB หรือมีข้อมูลข้างในมากเกินไป`,
  [ERROR_CODES.unsupportedFile]:
    'รองรับเฉพาะไฟล์ .xlsx (ไฟล์ .xls แบบเก่าหรือไฟล์ที่ตั้งรหัสผ่านไว้ ให้บันทึกใหม่เป็น .xlsx)',
  [ERROR_CODES.invalidWorkbook]:
    'เปิดไฟล์นี้ไม่ได้ ไฟล์อาจเสีย ลองเปิดใน Excel แล้วบันทึกใหม่เป็น .xlsx',
  [ERROR_CODES.validationError]: 'ข้อมูลที่ส่งไม่ครบ กรุณาเลือกภาคเรียนและไฟล์',
  [ERROR_CODES.forbidden]: 'บัญชีนี้ไม่มีสิทธิ์นำเข้าข้อมูล',
  [ERROR_CODES.rateLimited]: 'ส่งไฟล์ถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
});

const uploadErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'ตรวจสอบไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';

// Mirrors the server's checks so an obviously wrong file is caught before uploading; the server
// still checks everything itself.
const fileProblem = (file: File | undefined): string | undefined => {
  if (!file) return 'กรุณาเลือกไฟล์';
  if (!file.name.toLowerCase().endsWith(IMPORT_FILE_EXTENSION)) {
    return ERROR_MESSAGES[ERROR_CODES.unsupportedFile];
  }
  if (file.size > IMPORT_MAX_FILE_BYTES) return ERROR_MESSAGES[ERROR_CODES.fileTooLarge];
  return undefined;
};

const selectClassName =
  'w-full rounded-md border border-input bg-card px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const AdminImportPage = () => {
  const [term, setTerm] = useState('');
  const [file, setFile] = useState<File>();
  const [formError, setFormError] = useState<string>();
  const setSession = useSetSession();

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, ''],
    queryFn: async () => await fetchRounds(),
  });
  const mutation = useMutation({
    mutationFn: async ({ term: chosen, file: chosenFile }: { term: string; file: File }) =>
      await previewImport(chosen, chosenFile),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) setSession(null);
    },
  });

  // Rounds arrive newest term first, so the default is the latest term.
  const terms = [...new Set((roundsQuery.data ?? []).map((round) => round.term))];
  const selectedTerm = term === '' ? (terms[0] ?? '') : term;

  // A summary belongs to one file and term; changing either hides it.
  const resetResult = () => {
    setFormError(undefined);
    mutation.reset();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = selectedTerm === '' ? 'กรุณาเลือกภาคเรียน' : fileProblem(file);
    if (problem !== undefined || !file) {
      setFormError(problem);
      return;
    }
    setFormError(undefined);
    mutation.mutate({ term: selectedTerm, file });
  };

  const errorMessage =
    formError ?? (mutation.isError ? uploadErrorMessage(mutation.error) : undefined);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">นำเข้า Excel</h1>
        <p className="text-sm text-muted-foreground">
          อัปโหลดไฟล์ .xlsx ที่มีชีต students, clubs, advisors (มีชีตใดก็ได้)
          ระบบจะตรวจและสรุปให้ดูก่อน ยังไม่บันทึกอะไรลงระบบ ไฟล์ละไม่เกิน {MAX_FILE_MB} MB
          และชีตละไม่เกิน {IMPORT_MAX_ROWS_PER_SHEET.toLocaleString('th-TH')} แถว
        </p>
        <p className="text-sm">
          <a className="text-primary underline" href={IMPORT_TEMPLATE_URL} download>
            ดาวน์โหลดไฟล์ตัวอย่าง (template)
          </a>
        </p>
      </div>

      {roundsQuery.isPending ? (
        <p className="text-muted-foreground">กำลังโหลด…</p>
      ) : roundsQuery.isError ? (
        <div className="flex items-center gap-3" role="alert">
          <p>โหลดรายการภาคเรียนไม่สำเร็จ</p>
          <Button variant="outline" onClick={() => void roundsQuery.refetch()}>
            ลองใหม่
          </Button>
        </div>
      ) : terms.length === 0 ? (
        <p className="text-muted-foreground">
          ยังไม่มีรอบลงทะเบียน ให้{' '}
          <Link className="text-primary underline" to="/admin/rounds">
            สร้างรอบ
          </Link>{' '}
          ก่อนนำเข้าชุมนุม
        </p>
      ) : (
        <form
          aria-label="ตรวจสอบไฟล์นำเข้า"
          className="max-w-md space-y-4"
          onSubmit={handleSubmit}
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="import-term">ภาคเรียน</Label>
            <select
              id="import-term"
              className={selectClassName}
              value={selectedTerm}
              onChange={(event) => {
                setTerm(event.target.value);
                resetResult();
              }}
            >
              {terms.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-file">ไฟล์ Excel (.xlsx)</Label>
            <input
              id="import-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block w-full text-sm"
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                resetResult();
              }}
            />
          </div>
          <FormError message={errorMessage} />
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'กำลังตรวจสอบ…' : 'ตรวจสอบไฟล์'}
          </Button>
        </form>
      )}

      {mutation.isSuccess && <ImportSummary preview={mutation.data} />}
    </section>
  );
};
