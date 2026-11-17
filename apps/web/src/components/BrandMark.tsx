import { cn } from '@/lib/utils';

// Decorative only: every place that shows it also shows the system name as text.
export const BrandMark = ({ className }: { className?: string }) => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-primary to-brand text-primary-foreground shadow-md shadow-primary/30',
      className,
    )}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-1/2"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="m14.5 17.5 2 2 4-4" />
    </svg>
  </span>
);
