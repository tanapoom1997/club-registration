import type { ScrollEdges } from '@/lib/scroll-edges';
import { cn } from '@/lib/utils';

const FADE = 'pointer-events-none absolute inset-y-0 w-8 transition-opacity duration-150';

// Decorative: tells a sighted phone user the box scrolls sideways and which way. Goes inside a
// `relative` parent next to the scrolling element, and fades to the card colour behind it.
export const ScrollFades = ({ start, end }: ScrollEdges) => (
  <>
    <span
      aria-hidden="true"
      className={cn(FADE, 'left-0 bg-linear-to-r from-card to-transparent', !start && 'opacity-0')}
    />
    <span
      aria-hidden="true"
      className={cn(FADE, 'right-0 bg-linear-to-l from-card to-transparent', !end && 'opacity-0')}
    />
  </>
);
