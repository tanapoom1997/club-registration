import type { Round } from '@club-registration/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { LoadFailed } from '@/components/StatusBlock';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetchRoundStudents } from '@/lib/api';
import { refetchWhileOpen } from '@/lib/round-refetch';
import { roundStudentsQueryKey } from './club-members-ui';
import {
  STUDENT_SEARCH_LIMIT,
  STUDENT_SEARCH_MESSAGES,
  indexStudents,
  searchStudents,
  studentPlacement,
} from './student-search';

// A whole grade (~450 students) is a large answer, so it is not polled like the counts: the
// panel's own writes and club edits refresh it (their invalidation covers the clubs prefix), and
// while the admin is searching an open round it is read again now and then, since students keep
// registering. Where it says a student stands is a hint; the assign answers with what happened.
const STUDENTS_STALE_MS = 30_000;
const STUDENTS_SEARCH_POLL_MS = 15_000;

type StudentFinderProps = {
  round: Round;
  // The panel's club, so a student already in it is shown as such and cannot be picked.
  clubId: number;
  // A write in flight: picking would move focus to a disabled button.
  disabled: boolean;
  onPick: (loginId: string) => void;
};

// Outside the add form on purpose: Enter in the search box must not submit whatever code the
// field below holds. The count is a polite live region without role="status", which the panel
// keeps for the outcome of its writes.
export const StudentFinder = ({ round, clubId, disabled, onPick }: StudentFinderProps) => {
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const studentsQuery = useQuery({
    queryKey: roundStudentsQueryKey(round.id),
    queryFn: async () => await fetchRoundStudents(round.id),
    staleTime: STUDENTS_STALE_MS,
    refetchInterval: searching ? refetchWhileOpen(round, STUDENTS_SEARCH_POLL_MS) : false,
  });
  const index = useMemo(
    () => (studentsQuery.data ? indexStudents(studentsQuery.data.students, round.grade) : []),
    [studentsQuery.data, round.grade],
  );
  const result = studentsQuery.isSuccess ? searchStudents(index, query) : undefined;

  const message = !result
    ? ''
    : result.total === 0
      ? STUDENT_SEARCH_MESSAGES.none(query)
      : result.total > STUDENT_SEARCH_LIMIT
        ? STUDENT_SEARCH_MESSAGES.more(result.shown.length, result.total)
        : STUDENT_SEARCH_MESSAGES.found(result.total);

  return (
    <div role="search" aria-label={STUDENT_SEARCH_MESSAGES.label} className="space-y-2">
      <div className="max-w-md space-y-1.5">
        <Label htmlFor="student-search">{STUDENT_SEARCH_MESSAGES.label}</Label>
        <Input
          id="student-search"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={STUDENT_SEARCH_MESSAGES.placeholder}
          aria-describedby="student-search-help"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p id="student-search-help" className="max-w-prose text-sm text-muted-foreground">
        {STUDENT_SEARCH_MESSAGES.help(round.grade)}
      </p>
      {searching && studentsQuery.isPending && (
        <p className="text-sm text-muted-foreground">{STUDENT_SEARCH_MESSAGES.loading}</p>
      )}
      {searching && studentsQuery.isError && (
        <LoadFailed
          message={STUDENT_SEARCH_MESSAGES.loadFailed}
          onRetry={() => void studentsQuery.refetch()}
        />
      )}
      <p aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">
        {message}
      </p>
      {result && result.shown.length > 0 && (
        <ul
          aria-label={STUDENT_SEARCH_MESSAGES.results}
          className="divide-y divide-border rounded-2xl border border-border bg-card"
        >
          {result.shown.map((student) => (
            <li
              key={student.loginId}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3"
            >
              <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                <p className="text-base font-medium break-words">{student.fullName}</p>
                <p className="text-muted-foreground">
                  {student.loginId} · ห้อง {student.classroom} เลขที่ {student.seatNo}
                </p>
                <p>{studentPlacement(student, clubId)}</p>
              </div>
              {student.club?.id !== clubId && (
                <Button
                  variant="outline"
                  className="shrink-0"
                  aria-label={`เลือก ${student.loginId} ${student.fullName}`}
                  disabled={disabled}
                  onClick={() => onPick(student.loginId)}
                >
                  เลือก
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
