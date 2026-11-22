import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// relative: a header's sr-only text is absolutely positioned, and without a positioned ancestor
// here it is laid out against the page and widens the whole page on a phone instead of scrolling
// inside this box.
export const Table = ({ className, ...props }: ComponentProps<'table'>) => (
  <div className="relative overflow-x-auto rounded-2xl border border-border bg-card shadow-card">
    <table className={cn('w-full text-left text-sm', className)} {...props} />
  </div>
);

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
