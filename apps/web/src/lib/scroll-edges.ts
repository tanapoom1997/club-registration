import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

// Whether a sideways-scrolling box has more content past its left (start) or right (end) edge.
export type ScrollEdges = { start: boolean; end: boolean };

const NO_EDGES: ScrollEdges = Object.freeze({ start: false, end: false });

// A zoomed page reports fractional scroll positions, so "at the edge" allows one pixel.
const EDGE_SLACK_PX = 1;

const edgesOf = (element: HTMLElement): ScrollEdges => ({
  start: element.scrollLeft > EDGE_SLACK_PX,
  end: element.scrollLeft + element.clientWidth < element.scrollWidth - EDGE_SLACK_PX,
});

// Follows scrolling and resizing (of the box, and of its content as rows load), so a phone shows
// the fade only on the side that still hides something.
export const useScrollEdges = (ref: RefObject<HTMLElement | null>): ScrollEdges => {
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const next = edgesOf(element);
      setEdges((previous) =>
        previous.start === next.start && previous.end === next.end ? previous : next,
      );
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    // Absent in jsdom and very old browsers; the fades then follow scrolling only.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref]);

  return edges;
};
