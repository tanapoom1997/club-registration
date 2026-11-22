import { useEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A panel that opens below a long table (a club's member lists, an editor) is out of sight of
// the button that opened it, so on its own nothing seems to happen (U6). This brings its heading
// into view and puts focus on it, so keyboard and screen reader users land there too. `reveal`
// changes on every open, including a second click on the button of the panel already open: that
// click changes nothing else, and the admin may have scrolled away since.
//
// Focus first without scrolling: a plain focus() jumps to the heading at once, which would cut
// the smooth scroll short. The heading needs tabIndex={-1} and a scroll margin for the header,
// which is sticky from sm up.
export const useRevealPanel = <T extends HTMLElement>(reveal: number) => {
  const ref = useRef<T>(null);
  useEffect(() => {
    const heading = ref.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [reveal]);
  return ref;
};

// Gives focus back when a panel or confirmation closes, to the first of `targets` that is still on
// the page and can take it: usually the button that opened it, then a fallback for when that
// button went away with what it acted on (a deleted round) or is disabled now. Only when focus
// went down with the panel (the browser leaves it on <body>): a close caused by another control,
// such as choosing another round, leaves focus on that control.
//
// `open` must stay true until whatever decides the targets has settled (a request in flight),
// since they are read once, on the render where it turns false.
export const useReturnFocus = (
  open: boolean,
  targets: readonly RefObject<HTMLElement | null>[],
) => {
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    targets
      .map((target) => target.current)
      .filter((element): element is HTMLElement => element?.isConnected ?? false)
      .some((element) => {
        element.focus();
        return document.activeElement === element;
      });
  });
};

// The behaviour every inline confirmation shares (WritePanel, ConfirmPanel): it takes focus when it
// opens, so keyboard and screen reader users land on the question, and Escape dismisses it like its
// cancel button, except while the request is in flight.
export const useConfirmationFocus = <T extends HTMLElement>(
  onDismiss: () => void,
  pending: boolean,
) => {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<T>) => {
    if (event.key !== 'Escape' || pending) return;
    event.preventDefault();
    onDismiss();
  };

  return { ref, onKeyDown };
};
