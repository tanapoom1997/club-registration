import { useId } from 'react';
import type { Ref } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CLUB_FILTER_MESSAGES } from './club-filter';
import type { ClubFilter, SeatFilter } from './club-filter';
import { admittedParts } from './queue-ui';

const SEAT_FILTERS: readonly SeatFilter[] = Object.freeze(['all', 'free']);

type ClubFilterBarProps = {
  filter: ClubFilter;
  onChange: (next: ClubFilter) => void;
  // Set by the page when the student changes the filter, never from polled data, so a poll that
  // changes the counts does not talk over the student every 5 s.
  announcement: string;
  searchRef: Ref<HTMLInputElement>;
  // While the student holds a turn: when it ends (ISO), as on the queue card.
  admittedUntil?: string | undefined;
};

// One row on a phone too: the list starts as high as it can (U4). The label is visually hidden
// but names the field; the placeholder only says what to type. On a phone it sticks to the top of
// the screen while the list scrolls under it (V1): a round can have 30+ clubs in one column, and a
// student whose turn is running should not have to scroll back up to search. It stays inside the
// list's own box, so it leaves with the list. data-sticky-filter makes room for it in what the
// browser scrolls into view (index.css). On a screen wide and tall enough the header is the
// sticky part instead; a phone on its side counts as compact too (Y2, index.css).
export const ClubFilterBar = ({
  filter,
  onChange,
  announcement,
  searchRef,
  admittedUntil,
}: ClubFilterBarProps) => {
  const searchId = useId();
  const turn = admittedUntil === undefined ? undefined : admittedParts(admittedUntil);
  const seatsName = useId();
  return (
    <div
      role="search"
      aria-label={CLUB_FILTER_MESSAGES.searchLabel}
      data-sticky-filter={turn === undefined ? '' : 'deadline'}
      className="space-y-2 compact:sticky compact:top-0 compact:z-10 compact:-mx-4 compact:border-b compact:border-border compact:bg-background/95 compact:px-4 compact:py-2 compact:backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Label htmlFor={searchId} className="sr-only">
            {CLUB_FILTER_MESSAGES.searchLabel}
          </Label>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          {/* text-base (16 px): a smaller field makes iOS zoom the page on focus. */}
          <Input
            ref={searchRef}
            id={searchId}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={CLUB_FILTER_MESSAGES.searchPlaceholder}
            className="min-h-11 pl-9 sm:min-h-10"
            value={filter.query}
            onChange={(event) => onChange({ ...filter, query: event.target.value })}
          />
        </div>
        <fieldset className="flex shrink-0 gap-1 rounded-lg bg-muted p-1">
          <legend className="sr-only">{CLUB_FILTER_MESSAGES.seatsLegend}</legend>
          {SEAT_FILTERS.map((seats) => (
            <label
              key={seats}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-md px-3.5 text-sm text-muted-foreground transition-colors has-checked:bg-card has-checked:font-medium has-checked:text-primary has-checked:shadow-xs has-focus-visible:ring-2 has-focus-visible:ring-ring sm:min-h-8"
            >
              <input
                type="radio"
                name={seatsName}
                className="sr-only"
                value={seats}
                checked={filter.seats === seats}
                onChange={() => onChange({ ...filter, seats })}
              />
              {CLUB_FILTER_MESSAGES.seats[seats]}
            </label>
          ))}
        </fieldset>
      </div>
      {/* The turn's end, repeated where a phone still shows it once the queue card above has
          scrolled away (X2): the time is fixed from when the turn began, and a student reading
          club after club loses track of it. Only where the bar sticks (compact, index.css). Not a
          live region; the queue card's status line announces the turn. */}
      {turn && (
        <p className="text-xs text-muted-foreground tall:hidden">
          {turn.until} <span className="font-semibold text-foreground">{turn.time}</span>
        </p>
      )}
      {/* Always mounted while the list shows, so the change is announced, politely. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
};
