import type { AdminClub, Round } from '@club-registration/shared';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { fetchRoundClubs, fetchRounds } from '@/lib/api';
import { STATUS_DISPLAY, roundOptionLabel } from '@/lib/round-display';
import { ROUNDS_QUERY_KEY } from '@/pages/admin-rounds/round-ui';
import { ClubsTable } from './ClubsTable';
import { EditClubForm } from './EditClubForm';
import { CLUBS_POLL_INTERVAL_MS, CLUBS_QUERY_KEY, preferredRound } from './club-ui';

// The rounds page lists every term under the same key, so both pages share one cached list.
const ALL_TERMS = '';

const selectClassName =
  'w-full rounded-md border border-input bg-card px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const RoundSummary = ({ round }: { round: Round }) => {
  const status = STATUS_DISPLAY[round.status];
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Badge variant={status.variant}>{status.label}</Badge>
      <span>
        {round.clubCount} ชุมนุม · ลงแล้ว {round.totalRegistered} / รับ {round.totalCapacity}
      </span>
      {round.status === 'open' && (
        <span className="text-muted-foreground">
          รอบนี้เปิดอยู่ ตัวเลขอัปเดตอัตโนมัติทุก {CLUBS_POLL_INTERVAL_MS / 1000} วินาที
        </span>
      )}
    </div>
  );
};

export const AdminClubsPage = () => {
  // Starts unset and is filled in from the rounds list once; after that only the admin changes it.
  const [roundId, setRoundId] = useState<number>();
  // An id, not a snapshot, so the editor sees the latest registered count after every poll.
  const [editingId, setEditingId] = useState<number>();
  const [saved, setSaved] = useState<string>();

  const roundsQuery = useQuery({
    queryKey: [...ROUNDS_QUERY_KEY, ALL_TERMS],
    queryFn: async () => await fetchRounds(),
  });
  // A one-time preselection rather than a value derived on every render, so a later refetch of the
  // rounds list (whose statuses move with the clock) never switches the round under the admin.
  const preselected = roundId === undefined ? preferredRound(roundsQuery.data ?? []) : undefined;
  if (preselected) setRoundId(preselected.id);
  const clubsQuery = useQuery({
    queryKey: [...CLUBS_QUERY_KEY, roundId],
    queryFn: roundId === undefined ? skipToken : async () => await fetchRoundClubs(roundId),
    // The status comes from the server with every answer, so polling stops by itself once the
    // round closes. A round that opens while the page is up starts polling after a manual reload.
    refetchInterval: (query) =>
      query.state.data?.round.status === 'open' ? CLUBS_POLL_INTERVAL_MS : false,
  });

  const chooseRound = (value: string) => {
    setRoundId(Number(value));
    setEditingId(undefined);
    setSaved(undefined);
  };

  const startEdit = ({ id }: AdminClub) => {
    setEditingId(id);
    setSaved(undefined);
  };

  const rounds = roundsQuery.data ?? [];
  const clubs = clubsQuery.data?.clubs ?? [];
  const editing = clubs.find(({ id }) => id === editingId);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">ชุมนุม</h1>
        <p className="text-sm text-muted-foreground">
          ดูจำนวนรับ จำนวนที่ลงแล้ว และครูที่ปรึกษาของแต่ละชุมนุมในรอบ แก้ชื่อ รายละเอียด
          และจำนวนรับได้ เพิ่มหรือลบชุมนุมและครูทำผ่านการนำเข้า Excel
        </p>
      </div>

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
          ยังไม่มีรอบลงทะเบียน ให้{' '}
          <Link className="text-primary underline" to="/admin/rounds">
            สร้างรอบ
          </Link>{' '}
          ก่อน
        </p>
      ) : (
        <div className="max-w-md space-y-1.5">
          <Label htmlFor="clubs-round">รอบลงทะเบียน</Label>
          <select
            id="clubs-round"
            className={selectClassName}
            value={roundId ?? ''}
            onChange={(event) => chooseRound(event.target.value)}
          >
            {rounds.map((round) => (
              <option key={round.id} value={round.id}>
                {roundOptionLabel(round)}
              </option>
            ))}
          </select>
        </div>
      )}

      {roundId === undefined ? null : clubsQuery.isPending ? (
        <p className="text-muted-foreground">กำลังโหลดรายการชุมนุม…</p>
      ) : clubsQuery.isError ? (
        <div className="flex items-center gap-3" role="alert">
          <p>โหลดรายการชุมนุมไม่สำเร็จ</p>
          <Button variant="outline" onClick={() => void clubsQuery.refetch()}>
            ลองใหม่
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <RoundSummary round={clubsQuery.data.round} />
          {saved && (
            <p className="text-sm text-success-foreground" role="status">
              {saved}
            </p>
          )}
          {clubs.length === 0 ? (
            <p className="text-muted-foreground">
              รอบนี้ยังไม่มีชุมนุม เพิ่มได้จาก{' '}
              <Link className="text-primary underline" to="/admin/import">
                นำเข้า Excel
              </Link>
            </p>
          ) : (
            <ClubsTable clubs={clubs} onEdit={startEdit} />
          )}
        </div>
      )}

      {editing && (
        // Keyed so choosing another club starts a fresh form instead of keeping old input.
        <EditClubForm
          key={editing.id}
          club={editing}
          onSaved={(club) => {
            setEditingId(undefined);
            setSaved(`บันทึกชุมนุม ${club.clubCode} แล้ว`);
          }}
          onClose={() => setEditingId(undefined)}
        />
      )}
    </section>
  );
};
