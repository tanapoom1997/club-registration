import type { Round } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ConfirmPanel } from '@/components/ConfirmPanel';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { deleteRound, fetchRounds } from '@/lib/api';
import { useReturnFocus } from '@/lib/panel-focus';
import { STATUS_DISPLAY, gradeLabel } from '@/lib/round-display';
import { formatThaiDateTime } from '@/lib/thai-time';
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

// The button is passed along so focus can go back to it when what it opened closes.
type RoundAction = (round: Round, opener: HTMLButtonElement) => void;

type RoundsTableProps = {
  rounds: readonly Round[];
  onEdit: RoundAction;
  onDelete: RoundAction;
};

const RoundsTable = ({ rounds, onEdit, onDelete }: RoundsTableProps) => (
  <Table aria-label="รายการรอบลงทะเบียน">
    <TableHeader>
      <tr>
        <TableHead>ภาคเรียน</TableHead>
        <TableHead>ชั้น</TableHead>
        <TableHead>เปิด</TableHead>
        <TableHead>ปิด</TableHead>
        <TableHead>สถานะ</TableHead>
        <TableHead className="text-right">ชุมนุม</TableHead>
        <TableHead className="text-right">ลงแล้ว / รับ</TableHead>
        <TableHead className="text-right">เข้าพร้อมกัน</TableHead>
        <TableHead className="text-right">รอคิว</TableHead>
        <TableHead className="text-right">ได้คิวแล้ว</TableHead>
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
            <TableCell className="whitespace-nowrap">{formatThaiDateTime(round.opensAt)}</TableCell>
            <TableCell className="whitespace-nowrap">
              {formatThaiDateTime(round.closesAt)}
            </TableCell>
            <TableCell>
              <Badge variant={status.variant}>{status.label}</Badge>
            </TableCell>
            <TableCell className="text-right">{round.clubCount}</TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {round.totalRegistered} / {round.totalCapacity}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              {round.maxActive ?? QUEUE_SETTING_MESSAGES.noQueueCell}
            </TableCell>
            {/* Live tickets now; a round without a queue may still have some left to expire. */}
            <TableCell className="text-right">{round.queueWaiting}</TableCell>
            <TableCell className="text-right">{round.queueAdmitted}</TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
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
            </TableCell>
          </tr>
        );
      })}
    </TableBody>
  </Table>
);

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
  useReturnFocus(editing !== undefined, [editOpener]);
  // A deleted round's button is gone with its row, so focus goes to the page heading instead.
  useReturnFocus(deleting !== undefined, [deleteOpener, headingRef]);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
          รอบลงทะเบียน
        </h1>
        <p className="text-sm text-muted-foreground">
          1 รอบต่อชั้นต่อภาคเรียน เวลาทั้งหมดเป็นเวลาประเทศไทย สถานะคำนวณจากเวลาของเซิร์ฟเวอร์
          จำนวนรอคิวและได้คิวแล้วอัปเดตเองทุก {ROUNDS_POLL_INTERVAL_MS / 1000} วินาทีระหว่างที่มีรอบเปิดอยู่
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-2" onSubmit={handleFilter}>
        <div className="space-y-1.5">
          <Label htmlFor="term-filter">กรองตามภาคเรียน</Label>
          <Input
            id="term-filter"
            placeholder="ทุกภาคเรียน"
            value={termInput}
            onChange={(event) => setTermInput(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline">
          แสดง
        </Button>
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
        <div className="flex items-center gap-3" role="alert">
          <p>โหลดรายการรอบไม่สำเร็จ</p>
          <Button variant="outline" onClick={() => void roundsQuery.refetch()}>
            ลองใหม่
          </Button>
        </div>
      ) : rounds.length === 0 ? (
        <p className="text-muted-foreground">
          {termFilter === '' ? 'ยังไม่มีรอบลงทะเบียน' : `ไม่มีรอบของภาคเรียน ${termFilter}`}
        </p>
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

      <div className="grid gap-4 md:grid-cols-2">
        <CreateRoundForm />
        <CreateRoundBatchForm />
      </div>
    </section>
  );
};
