import { EXPORT_FORMATS, EXPORT_VIEWS } from '@club-registration/shared';
import type { ExportFormat, ExportQuery, ExportView } from '@club-registration/shared';
import { skipToken, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/FormError';
import { EmptyState, LoadFailed } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { alertVariants } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import {
  ApiError,
  downloadNameList,
  fetchRoundClassrooms,
  fetchRoundClubs,
  fetchRounds,
} from '@/lib/api';
import { saveFile } from '@/lib/download';
import { useSetSession } from '@/lib/session';
import { CLUBS_QUERY_KEY } from '@/pages/admin-clubs/club-ui';
import { gradeLabel, roundOptionLabel } from '@/lib/round-display';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import {
  CLASSROOMS_QUERY_KEY,
  FORMAT_OPTIONS,
  VIEW_OPTIONS,
  exportErrorMessage,
} from './export-ui';

const NO_ROUND = '';
const NO_ROUND_HINT_ID = 'export-no-round-hint';
const WHOLE_ROUND = '';
// The rounds page lists every term under the same key, so the pages share one cached list.
const ALL_TERMS = '';

type ScopeOption = { value: string; label: string };
type ScopeChoice = { options: ScopeOption[]; wholeLabel: string; summary: string };

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

// How a whole round is split up in the chosen format.
const PER_LIST: Readonly<Record<ExportFormat, string>> = Object.freeze({
  xlsx: '1 ชีตต่อ',
  pdf: 'หน้าใหม่ต่อ',
});

const studentSummary = (registered: number, total: number, of: string): string =>
  `ลงแล้ว ${registered} / ${of} ${total} คน (ยังไม่ลง ${total - registered} คน)`;

export const AdminExportPage = () => {
  const [roundId, setRoundId] = useState<number>();
  const [view, setView] = useState<ExportView>('club');
  const [scope, setScope] = useState(WHOLE_ROUND);
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const setSession = useSetSession();

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, ALL_TERMS],
    queryFn: async () => await fetchRounds(),
  });
  const clubsQuery = useQuery({
    queryKey: [...CLUBS_QUERY_KEY, roundId],
    queryFn:
      roundId === undefined || view !== 'club'
        ? skipToken
        : async () => await fetchRoundClubs(roundId),
  });
  const classroomsQuery = useQuery({
    queryKey: [...CLASSROOMS_QUERY_KEY, roundId],
    queryFn:
      roundId === undefined || view !== 'classroom'
        ? skipToken
        : async () => await fetchRoundClassrooms(roundId),
  });
  const mutation = useMutation({
    mutationFn: async ({ id, query }: { id: number; query: ExportQuery }) =>
      await downloadNameList(id, query),
    onSuccess: ({ file, filename }) => {
      saveFile(file, filename);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) setSession(null);
    },
  });

  // Any change to the choice starts over: a new scope list and no stale result on screen.
  const choose = (apply: () => void) => {
    apply();
    setScope(WHOLE_ROUND);
    mutation.reset();
  };

  const rounds = roundsQuery.data ?? [];
  const scopeQuery = view === 'club' ? clubsQuery : classroomsQuery;

  const scopeChoice = ((): ScopeChoice | undefined => {
    if (view === 'club') {
      const clubs = clubsQuery.data?.clubs;
      if (!clubs) return undefined;
      const chosen = clubs.find(({ id }) => String(id) === scope);
      return {
        options: clubs.map(({ id, clubCode, name }) => ({
          value: String(id),
          label: `${clubCode} ${name}`,
        })),
        wholeLabel: `ทั้งรอบ (${clubs.length} ชุมนุม, ${PER_LIST[format]}ชุมนุม)`,
        summary: chosen
          ? `ลงแล้ว ${chosen.registered} / รับ ${chosen.capacity} คน`
          : `ลงแล้ว ${sum(clubs.map(({ registered }) => registered))} / รับ ${sum(
              clubs.map(({ capacity }) => capacity),
            )} คน`,
      };
    }
    const data = classroomsQuery.data;
    if (!data) return undefined;
    const grade = gradeLabel(data.round.grade);
    const chosen = data.classrooms.find(({ classroom }) => classroom === scope);
    return {
      options: data.classrooms.map(({ classroom }) => ({
        value: classroom,
        label: `${grade}/${classroom}`,
      })),
      wholeLabel: `ทั้งรอบ (ทุกห้องของ ${grade}, ${PER_LIST[format]}ห้อง)`,
      summary: chosen
        ? studentSummary(chosen.registeredCount, chosen.studentCount, 'ทั้งห้อง')
        : studentSummary(
            sum(data.classrooms.map(({ registeredCount }) => registeredCount)),
            sum(data.classrooms.map(({ studentCount }) => studentCount)),
            'ทั้งหมด',
          ),
    };
  })();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (roundId === undefined) return;
    const query: ExportQuery =
      view === 'club'
        ? { view, format, ...(scope === WHOLE_ROUND ? {} : { clubId: Number(scope) }) }
        : { view, format, ...(scope === WHOLE_ROUND ? {} : { classroom: scope }) };
    mutation.mutate({ id: roundId, query });
  };

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">ส่งออกรายชื่อ</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          เลือกรอบ มุมมอง ขอบเขต และรูปแบบ แล้วดาวน์โหลดเป็นไฟล์ Excel หรือ PDF ไปส่งต่อให้ครู
          ไฟล์มีชื่อนักเรียนแต่ไม่มีเบอร์โทร อีเมล หรือ LINE ของครู กรุณาส่งผ่านช่องทางของโรงเรียนและอย่าโพสต์ในที่สาธารณะ
        </p>
      </div>

      {roundsQuery.isPending ? (
        <p className="text-muted-foreground">กำลังโหลด…</p>
      ) : roundsQuery.isError ? (
        <LoadFailed message="โหลดรายการรอบไม่สำเร็จ" onRetry={() => void roundsQuery.refetch()} />
      ) : rounds.length === 0 ? (
        <EmptyState>
          ยังไม่มีรอบลงทะเบียน ให้{' '}
          <Link
            className="font-medium text-primary underline underline-offset-4"
            to="/admin/rounds"
          >
            สร้างรอบ
          </Link>{' '}
          ก่อน
        </EmptyState>
      ) : (
        <Card className="max-w-xl p-4 sm:p-6">
          <form aria-label="ส่งออกรายชื่อ" className="space-y-5" onSubmit={handleSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="export-round">รอบลงทะเบียน</Label>
              <Select
                id="export-round"
                value={roundId ?? NO_ROUND}
                onChange={(event) =>
                  choose(() =>
                    setRoundId(
                      event.target.value === NO_ROUND ? undefined : Number(event.target.value),
                    ),
                  )
                }
              >
                <option value={NO_ROUND}>เลือกรอบ</option>
                {rounds.map((round) => (
                  <option key={round.id} value={round.id}>
                    {roundOptionLabel(round)}
                  </option>
                ))}
              </Select>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">มุมมอง</legend>
              {EXPORT_VIEWS.map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 text-sm transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-primary-soft"
                >
                  <input
                    type="radio"
                    name="export-view"
                    className="mt-0.5 size-5 shrink-0 accent-primary"
                    value={value}
                    checked={view === value}
                    onChange={() => choose(() => setView(value))}
                  />
                  <span>
                    <span className="font-medium">{VIEW_OPTIONS[value].label}</span>
                    <span className="block text-muted-foreground">
                      {VIEW_OPTIONS[value].description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {roundId === undefined ? null : scopeQuery.isPending ? (
              <p className="text-muted-foreground">กำลังโหลดตัวเลือก…</p>
            ) : scopeQuery.isError || !scopeChoice ? (
              <LoadFailed
                message={`โหลดรายการ${view === 'club' ? 'ชุมนุม' : 'ห้อง'}ไม่สำเร็จ`}
                onRetry={() => void scopeQuery.refetch()}
              />
            ) : scopeChoice.options.length === 0 ? (
              <EmptyState>
                {view === 'club'
                  ? 'รอบนี้ยังไม่มีชุมนุม เพิ่มได้จากการนำเข้า Excel'
                  : 'ชั้นของรอบนี้ยังไม่มีนักเรียน เพิ่มได้จากการนำเข้า Excel'}
              </EmptyState>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="export-scope">ขอบเขต</Label>
                <Select
                  id="export-scope"
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value);
                    mutation.reset();
                  }}
                >
                  <option value={WHOLE_ROUND}>{scopeChoice.wholeLabel}</option>
                  {scopeChoice.options.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {scopeChoice.summary}
                </p>
              </div>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">รูปแบบ</legend>
              {EXPORT_FORMATS.map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 text-sm transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-primary-soft"
                >
                  <input
                    type="radio"
                    name="export-format"
                    className="mt-0.5 size-5 shrink-0 accent-primary"
                    value={value}
                    checked={format === value}
                    onChange={() => {
                      setFormat(value);
                      mutation.reset();
                    }}
                  />
                  <span>
                    <span className="font-medium">{FORMAT_OPTIONS[value].label}</span>
                    <span className="block text-muted-foreground">
                      {FORMAT_OPTIONS[value].description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {/* Before a round is chosen nothing above says why the button is pale (V4); the
                other times it is, the loading line, the retry or the empty note above says so. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="submit"
                className="w-full sm:w-auto"
                disabled={!scopeChoice || scopeChoice.options.length === 0 || mutation.isPending}
                aria-describedby={roundId === undefined ? NO_ROUND_HINT_ID : undefined}
              >
                {mutation.isPending ? 'กำลังสร้างไฟล์…' : 'ดาวน์โหลดรายชื่อ'}
              </Button>
              {roundId === undefined && (
                <p id={NO_ROUND_HINT_ID} className="text-sm text-muted-foreground">
                  เลือกรอบลงทะเบียนด้านบนก่อน จึงจะดาวน์โหลดได้
                </p>
              )}
            </div>

            <FormError
              message={mutation.isError ? exportErrorMessage(mutation.error) : undefined}
            />
            {mutation.isSuccess && (
              <p className={alertVariants({ variant: 'success' })} role="status">
                ดาวน์โหลดไฟล์ {mutation.data.filename} แล้ว
              </p>
            )}
          </form>
        </Card>
      )}
    </section>
  );
};
