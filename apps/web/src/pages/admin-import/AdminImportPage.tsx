import {
  ERROR_CODES,
  IMPORT_FILE_EXTENSION,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS_PER_SHEET,
} from '@club-registration/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { ApiError, IMPORT_TEMPLATE_URL, commitImport, fetchRounds, previewImport } from '@/lib/api';
import { useSetSession } from '@/lib/session';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { ConfirmImport } from './ConfirmImport';
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

const PREVIEW_AGAIN = 'กรุณากด “ตรวจสอบไฟล์” อีกครั้งก่อนยืนยัน';

// Each of these means the preview on screen no longer describes what a commit would do.
const STALE_PREVIEW_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [ERROR_CODES.importFileMismatch]: `ไฟล์ที่ส่งไม่ตรงกับไฟล์ที่ตรวจสอบไว้ ยังไม่ได้บันทึกอะไรเลย ${PREVIEW_AGAIN}`,
  [ERROR_CODES.importInvalid]: `ข้อมูลในระบบเปลี่ยนไปหลังการตรวจสอบจนไฟล์นี้มีข้อผิดพลาด ยังไม่ได้บันทึกอะไรเลย ${PREVIEW_AGAIN}`,
  [ERROR_CODES.importConflict]: `ข้อมูลในระบบเปลี่ยนไประหว่างนำเข้า (เช่น มีนักเรียนลงทะเบียนเพิ่ม) ยังไม่ได้บันทึกอะไรเลย ${PREVIEW_AGAIN}`,
});

const uploadErrorMessage = (error: unknown): string =>
  (error instanceof ApiError ? ERROR_MESSAGES[error.code] : undefined) ??
  'ตรวจสอบไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';

const isStalePreview = (error: unknown): boolean =>
  error instanceof ApiError && Object.hasOwn(STALE_PREVIEW_MESSAGES, error.code);

const commitErrorMessage = (error: unknown): string =>
  (error instanceof ApiError
    ? (STALE_PREVIEW_MESSAGES[error.code] ?? ERROR_MESSAGES[error.code])
    : undefined) ?? 'บันทึกไม่สำเร็จ ยังไม่ได้บันทึกอะไรเลย กรุณาลองใหม่อีกครั้ง';

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

export const AdminImportPage = () => {
  const [term, setTerm] = useState('');
  const [file, setFile] = useState<File>();
  const [formError, setFormError] = useState<string>();
  const setSession = useSetSession();
  const queryClient = useQueryClient();

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, ''],
    queryFn: async () => await fetchRounds(),
  });
  const onError = (error: Error) => {
    if (error instanceof ApiError && error.status === 401) setSession(null);
  };
  const mutation = useMutation({
    mutationFn: async ({ term: chosen, file: chosenFile }: { term: string; file: File }) =>
      await previewImport(chosen, chosenFile),
    onError,
  });
  const commitMutation = useMutation({
    mutationFn: commitImport,
    onSuccess: async () => {
      // Club counts and totals on the rounds page change with the import.
      await queryClient.invalidateQueries({ queryKey: ROUNDS_QUERY_KEY });
    },
    onError,
  });

  // Rounds arrive newest term first, so the default is the latest term.
  const terms = [...new Set((roundsQuery.data ?? []).map((round) => round.term))];
  const selectedTerm = term === '' ? (terms[0] ?? '') : term;

  // A summary belongs to one file and term; changing either hides it.
  const resetResult = () => {
    setFormError(undefined);
    mutation.reset();
    commitMutation.reset();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = selectedTerm === '' ? 'กรุณาเลือกภาคเรียน' : fileProblem(file);
    if (problem !== undefined || !file) {
      setFormError(problem);
      return;
    }
    setFormError(undefined);
    commitMutation.reset();
    mutation.mutate({ term: selectedTerm, file });
  };

  // Sends exactly the file that was previewed (not whatever the input holds now), with the hash
  // the server reported for it.
  const handleConfirm = () => {
    const preview = mutation.data;
    const previewed = mutation.variables;
    if (!preview || !previewed) return;
    commitMutation.mutate({
      term: preview.term,
      file: previewed.file,
      fileSha256: preview.fileSha256,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const errorMessage =
    formError ?? (mutation.isError ? uploadErrorMessage(mutation.error) : undefined);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">นำเข้า Excel</h1>
        <p className="text-sm text-muted-foreground">
          อัปโหลดไฟล์ .xlsx ที่มีชีต students, clubs, advisors (มีชีตใดก็ได้)
          ระบบจะตรวจและสรุปให้ดูก่อนโดยยังไม่บันทึก เมื่อไม่มีข้อผิดพลาดจึงกดยืนยันเพื่อบันทึกลงระบบ
          ไฟล์ละไม่เกิน {MAX_FILE_MB} MB และชีตละไม่เกิน{' '}
          {IMPORT_MAX_ROWS_PER_SHEET.toLocaleString('th-TH')} แถว
        </p>
        <p className="text-sm">
          <a
            className="font-medium text-primary underline underline-offset-4"
            href={IMPORT_TEMPLATE_URL}
            download
          >
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
          <Link
            className="font-medium text-primary underline underline-offset-4"
            to="/admin/rounds"
          >
            สร้างรอบ
          </Link>{' '}
          ก่อนนำเข้าชุมนุม
        </p>
      ) : (
        <Card className="max-w-md p-6">
          <form
            aria-label="ตรวจสอบไฟล์นำเข้า"
            className="space-y-4"
            onSubmit={handleSubmit}
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="import-term">ภาคเรียน</Label>
              <Select
                id="import-term"
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
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-file">ไฟล์ Excel (.xlsx)</Label>
              <input
                id="import-file"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="block w-full cursor-pointer rounded-lg border border-dashed border-input p-2 text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-soft file:px-4 file:py-2 file:font-medium file:text-primary hover:border-primary/50 focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/15 focus-visible:outline-none"
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  resetResult();
                }}
              />
            </div>
            <FormError message={errorMessage} />
            <Button type="submit" disabled={mutation.isPending || commitMutation.isPending}>
              {mutation.isPending ? 'กำลังตรวจสอบ…' : 'ตรวจสอบไฟล์'}
            </Button>
          </form>
        </Card>
      )}

      {mutation.isSuccess && (
        <ImportSummary preview={mutation.data}>
          <ConfirmImport
            hasErrors={mutation.data.errorCount > 0}
            isPending={commitMutation.isPending}
            result={commitMutation.data}
            errorMessage={
              commitMutation.isError ? commitErrorMessage(commitMutation.error) : undefined
            }
            needsNewPreview={commitMutation.isError && isStalePreview(commitMutation.error)}
            onConfirm={handleConfirm}
          />
        </ImportSummary>
      )}
    </section>
  );
};
