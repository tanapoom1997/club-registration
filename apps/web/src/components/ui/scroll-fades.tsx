import type { ScrollEdges } from '@/lib/scroll-edges';
import { cn } from '@/lib/utils';

const FADE = 'pointer-events-none absolute inset-y-0 transition-opacity duration-150';

type ScrollFadesProps = ScrollEdges & {
  // A chevron on each fade that still hides something (X3). For a row of separate items, such as
  // the admin's menu: its edge can fall in the gap between two items, and a fade over blank space
  // then shows nothing. A table always runs under its fade, so it needs no arrow.
  arrows?: boolean;
};

const Chevron = ({ side }: { side: 'start' | 'end' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4 text-muted-foreground"
  >
    <path d={side === 'end' ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
  </svg>
);

// Decorative: tells a sighted phone user the box scrolls sideways and which way. Goes inside a
// `relative` parent next to the scrolling element, and fades to the card colour behind it.
export const ScrollFades = ({ start, end, arrows = false }: ScrollFadesProps) => (
  <>
    <span
      aria-hidden="true"
      data-scroll-fade="start"
      className={cn(
        FADE,
        'left-0 bg-linear-to-r from-card to-transparent',
        arrows ? 'flex w-10 items-center justify-start from-40% pl-1' : 'w-8',
        !start && 'opacity-0',
      )}
    >
      {arrows && <Chevron side="start" />}
    </span>
    <span
      aria-hidden="true"
      data-scroll-fade="end"
      className={cn(
        FADE,
        'right-0 bg-linear-to-l from-card to-transparent',
        arrows ? 'flex w-10 items-center justify-end from-40% pr-1' : 'w-8',
        !end && 'opacity-0',
      )}
    >
      {arrows && <Chevron side="end" />}
    </span>
  </>
);
