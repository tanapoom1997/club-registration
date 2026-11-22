import { useRef } from 'react';
import type { ComponentProps } from 'react';
import { useScrollEdges } from '@/lib/scroll-edges';
import { cn } from '@/lib/utils';
import { ScrollFades } from './scroll-fades';

// min-w: a phone gets a table that scrolls sideways with readable columns instead of one squeezed
// to a word per line with its numbers and buttons pushed off screen. A table that needs more room
// passes its own min-w-* in className.
// The scrolling box is `relative`: a header's sr-only text is absolutely positioned, and without a
// positioned ancestor there it is laid out against the page and widens the whole page on a phone.
// While it overflows it is a labelled, focusable region (the WAI pattern for a scrolling table),
// so arrow keys can scroll it where the browser does not make scrollers focusable itself
// (Safari); a table that fits stays out of the tab order and the landmarks.
export const Table = ({ className, ...props }: ComponentProps<'table'>) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scrollRef);
  const overflows = edges.start || edges.end;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      <div
        ref={scrollRef}
        role={overflows ? 'region' : undefined}
        aria-label={overflows ? props['aria-label'] : undefined}
        tabIndex={overflows ? 0 : undefined}
        className="relative overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <table className={cn('w-full min-w-2xl text-left text-sm', className)} {...props} />
      </div>
      <ScrollFades {...edges} />
    </div>
  );
};

export const TableHeader = ({ className, ...props }: ComponentProps<'thead'>) => (
  <thead
    className={cn('border-b border-border bg-muted text-muted-foreground', className)}
    {...props}
  />
);

export const TableBody = ({ className, ...props }: ComponentProps<'tbody'>) => (
  <tbody
    className={cn(
      'divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-muted/50',
      className,
    )}
    {...props}
  />
);

export const TableHead = ({ className, ...props }: ComponentProps<'th'>) => (
  <th className={cn('px-4 py-3 text-left font-medium whitespace-nowrap', className)} {...props} />
);

export const TableCell = ({ className, ...props }: ComponentProps<'td'>) => (
  <td className={cn('px-4 py-3', className)} {...props} />
);
