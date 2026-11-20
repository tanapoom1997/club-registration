import type { Round } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { deleteRound, fetchRounds } from '@/lib/api';
import { STATUS_DISPLAY, gradeLabel } from '@/lib/round-display';
import { formatThaiDateTime } from '@/lib/thai-time';
import { ConfirmPanel } from './ConfirmPanel';
import { CreateRoundBatchForm, CreateRoundForm } from './CreateRoundForms';
import { EditRoundForm } from './EditRoundForm';
import { ROUNDS_QUERY_KEY, roundErrorMessage, useRoundMutation } from './round-ui';

const roundName = ({ term, grade }: Round) => `${term} ${gradeLabel(grade)}`;

type RoundsTableProps = {
  rounds: readonly Round[];
  onEdit: (round: Round) => void;
  onDelete: (round: Round) => void;
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
            <TableCell className="text-right">{round.maxActive}</TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
                <Button
                  variant="outline"
                  className="px-3 py-1"
                  aria-label={`แก้ไขรอบ ${roundName(round)}`}
                  onClick={() => onEdit(round)}
                >
                  แก้ไข
                </Button>
                {/* Hidden once clubs exist; the API refuses such a delete regardless. */}
                {round.clubCount === 0 && (
                  <Button
                    variant="danger"
                    className="px-3 py-1"
                    aria-label={`ลบรอบ ${roundName(round)}`}
                    onClick={() => onDelete(round)}
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
  // An id, not a snapshot, so the editor sees the latest status after every refetch.
  const [editingId, setEditingId] = useState<number>();
  const [deleting, setDeleting] = useState<Round>();

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, termFilter],
    queryFn: async () => await fetchRounds(termFilter === '' ? undefined : termFilter),
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
        if (editingId === round.id) setEditingId(undefined);
      },
    });
  };

  const startDelete = (round: Round) => {
    deleteMutation.reset();
    setDeleting(round);
  };

  const rounds = roundsQuery.data ?? [];
  const editing = rounds.find(({ id }) => id === editingId);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">รอบลงทะเบียน</h1>
        <p className="text-sm text-muted-foreground">
          1 รอบต่อชั้นต่อภาคเรียน เวลาทั้งหมดเป็นเวลาประเทศไทย สถานะคำนวณจากเวลาของเซิร์ฟเวอร์
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
          message={`ลบรอบ ${roundName(deleting)} ใช่หรือไม่`}
          confirmLabel="ยืนยันลบ"
          pending={deleteMutation.isPending}
          onConfirm={() => confirmDelete(deleting)}
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
        <RoundsTable rounds={rounds} onEdit={({ id }) => setEditingId(id)} onDelete={startDelete} />
      )}

      {editing && (
        // Keyed so choosing another round starts a fresh form instead of keeping old input.
        <EditRoundForm key={editing.id} round={editing} onDone={() => setEditingId(undefined)} />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <CreateRoundForm />
        <CreateRoundBatchForm />
      </div>
    </section>
  );
};
