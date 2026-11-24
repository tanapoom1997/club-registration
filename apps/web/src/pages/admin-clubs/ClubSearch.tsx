import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CLUB_SEARCH_MESSAGES } from './club-search';

type ClubSearchProps = {
  query: string;
  onChange: (query: string) => void;
  shown: number;
  total: number;
};

// The search above the round's club table. The count is a polite status, said only while a query
// narrows the list, so a poll that refreshes the table does not read it out again.
export const ClubSearch = ({ query, onChange, shown, total }: ClubSearchProps) => {
  const searching = query.trim() !== '';
  return (
    <div role="search" aria-label={CLUB_SEARCH_MESSAGES.label} className="max-w-md space-y-1.5">
      <Label htmlFor="clubs-search">{CLUB_SEARCH_MESSAGES.label}</Label>
      <Input
        id="clubs-search"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder={CLUB_SEARCH_MESSAGES.placeholder}
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      <p role="status" className="text-sm text-muted-foreground">
        {searching && shown > 0 ? CLUB_SEARCH_MESSAGES.shown(shown, total) : ''}
      </p>
    </div>
  );
};
