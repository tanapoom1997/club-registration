import type { RegistrationEvent } from '@club-registration/shared';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
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

type EventsTableProps = {
  events: readonly RegistrationEvent[];
  // Filters the log down to this student (by the code shown in the row).
  onPickStudent: (loginId: string) => void;
};

// Every name and club comes from the Excel import or admin input, so all of it is rendered as
// text nodes only, never as HTML.
export const EventsTable = ({ events, onPickStudent }: EventsTableProps) => (
  <Table
    aria-label="ประวัติการลงทะเบียน"
    aria-describedby={EVENTS_TABLE_HELP_ID}
    className="min-w-3xl"
  >
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
          {/* What happened, when and in which round in one cell, so a phone sees the student next
              to it without scrolling sideways. */}
          <TableCell className="whitespace-nowrap">
            <Badge variant={EVENT_TYPE_TONES[event.eventType]}>
              {EVENT_TYPE_LABELS[event.eventType]}
            </Badge>
            <time dateTime={event.createdAt} className="mt-1.5 block text-xs text-muted-foreground">
              {formatThaiDateTime(event.createdAt)}
            </time>
            <span className="block text-xs text-muted-foreground">{roundLabel(event.round)}</span>
          </TableCell>
          <TableCell>
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
          </TableCell>
          <TableCell>{clubCellText(event)}</TableCell>
          <TableCell>
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
          </TableCell>
        </tr>
      ))}
    </TableBody>
  </Table>
);
