import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const Icon = ({ children, className }: { children: ReactNode; className: string }) => (
  <span
    aria-hidden="true"
    className={cn('grid size-9 shrink-0 place-items-center rounded-xl', className)}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      {children}
    </svg>
  </span>
);

type LoadFailedProps = { message: string; onRetry: () => void; className?: string };

// A list or a page that could not be loaded, with the way to try again beside the words. One look
// on every page, so it reads as "this did not load" rather than as more content. The retry is a
// plain button (type="button"), so inside a form it never submits it.
export const LoadFailed = ({ message, onRetry, className }: LoadFailedProps) => (
  <div
    role="alert"
    className={cn(
      'flex flex-wrap items-center gap-3 rounded-2xl bg-destructive/5 p-4 ring-1 ring-destructive/20 ring-inset',
      className,
    )}
  >
    <Icon className="bg-destructive/10 text-destructive">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </Icon>
    <p className="min-w-0 flex-1 text-sm font-medium">{message}</p>
    <Button variant="outline" onClick={onRetry}>
      ลองใหม่
    </Button>
  </div>
);

// Nothing to show yet (no rounds, no clubs, no matching events), and where to go next if there is
// somewhere. Dashed, so it reads as an empty slot for what will appear there.
export const EmptyState = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      'flex items-start gap-3 rounded-2xl border border-dashed border-border bg-card p-4 text-sm text-muted-foreground',
      className,
    )}
  >
    <Icon className="bg-muted text-muted-foreground">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </Icon>
    <div className="min-w-0 flex-1 self-center">{children}</div>
  </div>
);
