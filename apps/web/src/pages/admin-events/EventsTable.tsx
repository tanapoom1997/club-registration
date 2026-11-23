import type { RegistrationEvent } from '@club-registration/shared';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { PHONE_QUERY, useMediaQuery } from '@/lib/media-query';
import { formatThaiDateTime } from '@/lib/thai-time';
import {
  EVENT_TYPE_LABELS,
  EVENT_TYPE_TONES,
  PROMOTE_ACTOR_NOTE,
  actorRoleText,
  clubCellText,
  roundLabel,
} from './event-ui';

export const EVENTS_TABLE_HELP_ID = 'events-table-help';
const LIST_NAME = 'ประวัติการลงทะเบียน';

type EventsTableProps = {
  events: readonly RegistrationEvent[];
  // Filters the log down to this student (by the code shown in the row).
  onPickStudent: (loginId: string) => void;
};

type EventProps = { event: RegistrationEvent; onPickStudent: (loginId: string) => void };

const EventSummary = ({ event }: { event: RegistrationEvent }) => (
  <>
    <Badge variant={EVENT_TYPE_TONES[event.eventType]}>{EVENT_TYPE_LABELS[event.eventType]}</Badge>
    <time dateTime={event.createdAt} className="mt-1.5 block text-xs text-muted-foreground">
      {formatThaiDateTime(event.createdAt)}
    </time>
    <span className="block text-xs text-muted-foreground">{roundLabel(event.round)}</span>
  </>
);

const EventStudent = ({ event, onPickStudent }: EventProps) => (
  <>
    <button
      type="button"
      className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
      aria-label={`กรองเฉพาะนักเรียน ${event.student.loginId} ${event.student.fullName}`}
      onClick={() => onPickStudent(event.student.loginId)}
    >
      {event.student.loginId}
    </button>
    <span className="block">{event.student.fullName}</span>
    <span className="block text-xs text-muted-foreground">
      ห้อง {event.student.classroom} เลขที่ {event.student.seatNo}
    </span>
  </>
);

const EventActor = ({ event }: { event: RegistrationEvent }) => (
  <>
    <span className="block">{event.actor.fullName}</span>
    <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {event.actor.role === 'admin' ? (
        <Badge>{actorRoleText(event)}</Badge>
      ) : (
        <span>{actorRoleText(event)}</span>
      )}
    </span>
    {event.eventType === 'waitlist_promote' && (
      <span className="mt-1 block text-xs text-muted-foreground">{PROMOTE_ACTOR_NOTE}</span>
    )}
  </>
);

// On a phone (V2): one card per event with every field, instead of a table whose club and actor
// columns sit off screen behind a sideways scroll.
const EventCards = ({ events, onPickStudent }: EventsTableProps) => (
  <ul
    aria-label={LIST_NAME}
    aria-describedby={EVENTS_TABLE_HELP_ID}
    className="divide-y divide-border rounded-2xl border border-border bg-card shadow-card"
  >
    {events.map((event) => (
      <li key={event.id} className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <EventStudent event={event} onPickStudent={onPickStudent} />
          </div>
          <div className="shrink-0 text-right">
            <EventSummary event={event} />
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">ชุมนุม</dt>
          <dd className="min-w-0 break-words">{clubCellText(event)}</dd>
          <dt className="text-muted-foreground">ผู้ทำ</dt>
          <dd className="min-w-0">
            <EventActor event={event} />
          </dd>
        </dl>
      </li>
    ))}
  </ul>
);

// Every name and club comes from the Excel import or admin input, so all of it is rendered as
// text nodes only, never as HTML.
export const EventsTable = ({ events, onPickStudent }: EventsTableProps) => {
  const phone = useMediaQuery(PHONE_QUERY);
  if (phone) return <EventCards events={events} onPickStudent={onPickStudent} />;
  return (
    <Table aria-label={LIST_NAME} aria-describedby={EVENTS_TABLE_HELP_ID} className="min-w-3xl">
      <TableHeader>
        <tr>
          <TableHead>เหตุการณ์</TableHead>
          <TableHead>นักเรียน</TableHead>
          <TableHead>ชุมนุม</TableHead>
          <TableHead>ผู้ทำ</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <tr key={event.id} className="align-top">
            <TableCell className="whitespace-nowrap">
              <EventSummary event={event} />
            </TableCell>
            <TableCell>
              <EventStudent event={event} onPickStudent={onPickStudent} />
            </TableCell>
            <TableCell>{clubCellText(event)}</TableCell>
            <TableCell>
              <EventActor event={event} />
            </TableCell>
          </tr>
        ))}
      </TableBody>
    </Table>
  );
};
