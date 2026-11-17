import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// The chevron is inline SVG rather than a background-image because the page CSP has no `data:` in
// img-src.
export const Select = ({ className, ...props }: ComponentProps<'select'>) => (
  <div className="relative">
    <select
      className={cn(
        'w-full appearance-none rounded-lg border border-input bg-card py-2 pr-10 pl-3 text-base shadow-xs transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/15 focus-visible:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
    >
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  </div>
);
