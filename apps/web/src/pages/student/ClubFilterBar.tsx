import { useId } from 'react';
import type { Ref } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CLUB_FILTER_MESSAGES } from './club-filter';
import type { ClubFilter, SeatFilter } from './club-filter';

const SEAT_FILTERS: readonly SeatFilter[] = Object.freeze(['all', 'free']);

type ClubFilterBarProps = {
  filter: ClubFilter;
  onChange: (next: ClubFilter) => void;
  // Set by the page when the student changes the filter, never from polled data, so a poll that
  // changes the counts does not talk over the student every 5 s.
  announcement: string;
  searchRef: Ref<HTMLInputElement>;
};

// One row on a phone too: the list starts as high as it can (U4). The label is visually hidden
// but names the field; the placeholder only says what to type.
export const ClubFilterBar = ({
  filter,
  onChange,
  announcement,
  searchRef,
}: ClubFilterBarProps) => {
  const searchId = useId();
  const seatsName = useId();
  return (
    <div role="search" aria-label={CLUB_FILTER_MESSAGES.searchLabel} className="space-y-2">
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
      {/* Always mounted while the list shows, so the change is announced, politely. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </div>
  );
};
