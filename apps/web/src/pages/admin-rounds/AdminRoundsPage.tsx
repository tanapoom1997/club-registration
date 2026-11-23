import type { Round } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ConfirmPanel } from '@/components/ConfirmPanel';
import { FormError } from '@/components/FormError';
import { SeatBar } from '@/components/SeatMeter';
import { Badge } from '@/components/ui/badge';
import { EmptyState, LoadFailed } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { deleteRound, fetchRounds } from '@/lib/api';
import { BELOW_LG_QUERY, useMediaQuery } from '@/lib/media-query';
import { useReturnFocus } from '@/lib/panel-focus';
import { STATUS_DISPLAY, gradeLabel } from '@/lib/round-display';
import { formatThaiDate, formatThaiDateTime, formatThaiTime } from '@/lib/thai-time';
import { cn } from '@/lib/utils';
import { CreateRoundBatchForm, CreateRoundForm } from './CreateRoundForms';
import { EditRoundForm } from './EditRoundForm';
import {
  QUEUE_SETTING_MESSAGES,
  ROUNDS_POLL_INTERVAL_MS,
  ROUNDS_QUERY_KEY,
  roundErrorMessage,
  roundsRefetchInterval,
  useRoundMutation,
} from './round-ui';

const roundName = ({ term, grade }: Round) => `${term} ${gradeLabel(grade)}`;
const CREATE_FORMS_ID = 'create-round-forms';
const LIST_NAME = 'รายการรอบลงทะเบียน';

// The button is passed along so focus can go back to it when what it opened closes.
type RoundAction = (round: Round, opener: HTMLButtonElement) => void;

type RoundsTableProps = {
  rounds: readonly Round[];
  onEdit: RoundAction;
  onDelete: RoundAction;
};

type RoundActionsProps = Omit<RoundsTableProps, 'rounds'> & { round: Round; className: string };

const RoundActions = ({ round, onEdit, onDelete, className }: RoundActionsProps) => (
  <div className={className}>
    <Button
      variant="outline"
      className="px-3 py-1"
      aria-label={`แก้ไขรอบ ${roundName(round)}`}
      onClick={(event) => onEdit(round, event.currentTarget)}
    >
      แก้ไข
    </Button>
    {/* Hidden once clubs exist; the API refuses such a delete regardless. */}
    {round.clubCount === 0 && (
      <Button
        variant="danger"
        className="px-3 py-1"
        aria-label={`ลบรอบ ${roundName(round)}`}
        onClick={(event) => onDelete(round, event.currentTarget)}
      >
        ลบ
      </Button>
    )}
  </div>
);

// Below lg, on a phone or a tablet (W3): one card per round with its buttons in reach, instead
// of a ten-column table whose "แก้ไข" and "ลบ" sit off screen behind a sideways scroll.
const RoundCards = ({ rounds, onEdit, onDelete }: RoundsTableProps) => (
  <ul aria-label={LIST_NAME} className="grid gap-3 md:grid-cols-2">
    {rounds.map((round) => {
      const status = STATUS_DISPLAY[round.status];
      const remaining = round.totalCapacity - round.totalRegistered;
      return (
        <li
          key={round.id}
          className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-card"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-bold">
              {gradeLabel(round.grade)}{' '}
              <span className="font-normal text-muted-foreground">· {round.term}</span>
            </p>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">เปิด</dt>
            <dd>{formatThaiDateTime(round.opensAt)}</dd>
            <dt className="text-muted-foreground">ปิด</dt>
            <dd>{formatThaiDateTime(round.closesAt)}</dd>
          </dl>
          {/* No clubs yet means no seats: an empty round is not a full one. */}
          {round.totalCapacity > 0 ? (
            <div className="space-y-1.5">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span>
                  ลงแล้ว <span className="font-semibold">{round.totalRegistered}</span> /{' '}
                  {round.totalCapacity} คน
                </span>
                <span className="text-xs text-muted-foreground">{round.clubCount} ชุมนุม</span>
              </p>
              <SeatBar capacity={round.totalCapacity} remaining={remaining} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">ยังไม่มีชุมนุมในรอบนี้</p>
          )}
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">เข้าพร้อมกัน</dt>
              <dd>{round.maxActive ?? QUEUE_SETTING_MESSAGES.noQueueCell}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">รอคิว</dt>
              <dd>{round.queueWaiting}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">ได้คิวแล้ว</dt>
              <dd>{round.queueAdmitted}</dd>
            </div>
          </dl>
          <RoundActions
            round={round}
            onEdit={onEdit}
            onDelete={onDelete}
            className="mt-auto flex gap-2"
          />
        </li>
      );
    })}
  </ul>
);

// Date over time, each kept whole: the ten columns then fit a 1024px screen without scrolling,
// where a freely wrapping date would break into three ragged lines.
const DateTimeLines = ({ iso }: { iso: string }) => (
  <time dateTime={iso} className="whitespace-nowrap">
    {formatThaiDate(iso)}
    <span className="block text-muted-foreground">{formatThaiTime(iso)}</span>
  </time>
);

const RoundsTable = ({ rounds, onEdit, onDelete }: RoundsTableProps) => {
  const narrow = useMediaQuery(BELOW_LG_QUERY);
  if (narrow) return <RoundCards rounds={rounds} onEdit={onEdit} onDelete={onDelete} />;
  return (
    <Table aria-label={LIST_NAME} className="min-w-4xl">
      <TableHeader>
        <tr>
          <TableHead>ภาคเรียน</TableHead>
          <TableHead>ชั้น</TableHead>
          <TableHead>เปิด</TableHead>
          <TableHead>ปิด</TableHead>
          <TableHead>สถานะ</TableHead>
          <TableHead className="text-right">ชุมนุม</TableHead>
          {/* Long names over short numbers may wrap, so the table fits a 1024px screen. */}
          <TableHead className="text-right whitespace-normal">ลงแล้ว / รับ</TableHead>
          <TableHead className="text-right whitespace-normal">เข้าพร้อมกัน</TableHead>
          <TableHead className="text-right">รอคิว</TableHead>
          <TableHead className="text-right whitespace-normal">ได้คิวแล้ว</TableHead>
          <TableHead>
            <span className="sr-only">จัดการ</span>
          </TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {rounds.map((round) => {
          const status = STATUS_DISPLAY[round.status];
          return (
            <tr key={round.id}>
              <TableCell>{round.term}</TableCell>
              <TableCell>{gradeLabel(round.grade)}</TableCell>
              <TableCell>
                <DateTimeLines iso={round.opensAt} />
              </TableCell>
              <TableCell>
                <DateTimeLines iso={round.closesAt} />
              </TableCell>
              <TableCell>
                <Badge variant={status.variant}>{status.label}</Badge>
              </TableCell>
              <TableCell className="text-right">{round.clubCount}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {round.totalRegistered} / {round.totalCapacity}
                {/* No clubs yet means no seats: an empty round is not a full one. */}
                {round.totalCapacity > 0 && (
                  <SeatBar
                    className="mt-1.5 ml-auto w-20"
                    capacity={round.totalCapacity}
                    remaining={round.totalCapacity - round.totalRegistered}
                  />
                )}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {round.maxActive ?? QUEUE_SETTING_MESSAGES.noQueueCell}
              </TableCell>
              {/* Live tickets now; a round without a queue may still have some left to expire. */}
              <TableCell className="text-right">{round.queueWaiting}</TableCell>
              <TableCell className="text-right">{round.queueAdmitted}</TableCell>
              <TableCell>
                <RoundActions
                  round={round}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  className="flex justify-end gap-1"
                />
              </TableCell>
            </tr>
          );
        })}
      </TableBody>
    </Table>
  );
};

export const AdminRoundsPage = () => {
  const [termInput, setTermInput] = useState('');
  const [termFilter, setTermFilter] = useState('');
  // An id, not a snapshot, so the editor sees the latest status after every refetch. `reveal`
  // counts the clicks on edit buttons, so a second click brings the open editor back into view.
  const [editTarget, setEditTarget] = useState<{ id: number; reveal: number }>();
  const editingId = editTarget?.id;
  // `opened` keys the confirmation, so a click on another round's delete button opens a new one,
  // which takes focus again.
  const [deleting, setDeleting] = useState<{ round: Round; opened: number }>();
  const editOpener = useRef<HTMLButtonElement>(null);
  const deleteOpener = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, termFilter],
    queryFn: async () => await fetchRounds(termFilter === '' ? undefined : termFilter),
    // The queue counts are live only while a round is open (round-ui.ts).
    refetchInterval: (query) => roundsRefetchInterval(query.state.data),
  });
  const deleteMutation = useRoundMutation(async (round: Round) => await deleteRound(round.id));

  const handleFilter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTermFilter(termInput.trim());
  };

  const confirmDelete = (round: Round) => {
    deleteMutation.mutate(round, {
      onSettled: () => setDeleting(undefined),
      onSuccess: () => {
        // The refetch usually drops the round and closes its editor, but if the reload fails the
        // stale list still holds it, and the editor would stay open on a round that is gone.
        if (editingId === round.id) setEditTarget(undefined);
      },
    });
  };

  const startDelete: RoundAction = (round, opener) => {
    deleteMutation.reset();
    deleteOpener.current = opener;
    setDeleting((current) => ({ round, opened: (current?.opened ?? 0) + 1 }));
  };

  const startEdit: RoundAction = ({ id }, opener) => {
    editOpener.current = opener;
    setEditTarget((current) => ({ id, reveal: (current?.reveal ?? 0) + 1 }));
  };

  const rounds = roundsQuery.data ?? [];
  const editing = rounds.find(({ id }) => id === editingId);
  // The create forms are folded away behind a button (V3): rounds are made once a term, and on a
  // phone the two forms doubled the page under the list the admin comes to check. They start open
  // only while there is no round at all, where creating one is the only thing to do, and stay open
  // after that first round is made, so its success message does not vanish with them.
  const [createOpen, setCreateOpen] = useState<boolean>();
  const noRoundsYet = roundsQuery.isSuccess && rounds.length === 0 && termFilter === '';
  // Set while rendering (React's pattern for state that follows other state), not in an effect.
  if (noRoundsYet && createOpen === undefined) setCreateOpen(true);
  const showCreate = createOpen ?? noRoundsYet;
  useReturnFocus(editing !== undefined, [editOpener]);
  // A deleted round's button is gone with its row, so focus goes to the page heading instead.
  useReturnFocus(deleting !== undefined, [deleteOpener, headingRef]);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
            รอบลงทะเบียน
          </h1>
          <Button
            variant={showCreate ? 'outline' : 'primary'}
            aria-expanded={showCreate}
            aria-controls={CREATE_FORMS_ID}
            onClick={() => setCreateOpen(!showCreate)}
          >
            สร้างรอบใหม่
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn('size-4 transition-transform', showCreate && 'rotate-180')}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </Button>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          1 รอบต่อชั้นต่อภาคเรียน เวลาทั้งหมดเป็นเวลาประเทศไทย สถานะคำนวณจากเวลาของเซิร์ฟเวอร์
          จำนวนรอคิวและได้คิวแล้วอัปเดตเองทุก {ROUNDS_POLL_INTERVAL_MS / 1000} วินาทีระหว่างที่มีรอบเปิดอยู่
        </p>
      </div>

      {showCreate && (
        <div id={CREATE_FORMS_ID} className="grid gap-4 md:grid-cols-2">
          <CreateRoundForm />
          <CreateRoundBatchForm />
        </div>
      )}

      {/* One row at every width: on a phone the button stays beside the field it applies. */}
      <form className="max-w-sm space-y-1.5" onSubmit={handleFilter}>
        <Label htmlFor="term-filter">กรองตามภาคเรียน</Label>
        <div className="flex gap-2">
          <Input
            id="term-filter"
            className="min-w-0 flex-1"
            placeholder="ทุกภาคเรียน"
            value={termInput}
            onChange={(event) => setTermInput(event.target.value)}
          />
          <Button type="submit" variant="outline" className="shrink-0 sm:min-h-10">
            แสดง
          </Button>
        </div>
      </form>

      {deleting && (
        <ConfirmPanel
          key={deleting.opened}
          message={`ลบรอบ ${roundName(deleting.round)} ใช่หรือไม่`}
          confirmLabel="ยืนยันลบ"
          destructive
          pending={deleteMutation.isPending}
          onConfirm={() => confirmDelete(deleting.round)}
          onCancel={() => setDeleting(undefined)}
        />
      )}
      <FormError
        message={deleteMutation.isError ? roundErrorMessage(deleteMutation.error) : undefined}
      />

      {roundsQuery.isPending ? (
        <p className="text-muted-foreground">กำลังโหลด…</p>
      ) : roundsQuery.isError ? (
        <LoadFailed message="โหลดรายการรอบไม่สำเร็จ" onRetry={() => void roundsQuery.refetch()} />
      ) : rounds.length === 0 ? (
        <EmptyState>
          {termFilter === '' ? 'ยังไม่มีรอบลงทะเบียน' : `ไม่มีรอบของภาคเรียน ${termFilter}`}
        </EmptyState>
      ) : (
        <RoundsTable rounds={rounds} onEdit={startEdit} onDelete={startDelete} />
      )}

      {editing && (
        // Keyed so choosing another round starts a fresh form instead of keeping old input.
        <EditRoundForm
          key={editing.id}
          round={editing}
          reveal={editTarget?.reveal ?? 0}
          onDone={() => setEditTarget(undefined)}
        />
      )}
    </section>
  );
};
