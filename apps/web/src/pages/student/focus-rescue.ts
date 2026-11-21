import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// A poll can remove the element that has keyboard focus (the leave button once the student got
// the seat, an admin removed the entry or the round closed; the join notice once it no longer
// holds). The browser then drops focus to <body> and the student has to tab from the top again.
// This moves it to the first fallback on the page instead, but only when that element had focus
// as it went, so focus is never taken from anywhere else.
//
// Why a ref-callback cleanup: React runs it before it removes the node from the DOM, so
// document.activeElement still tells whether the node had focus. A blur event cannot: the spec's
// focus fixup fires none for a removed node, browsers differ, and React need not deliver one to a
// component it is unmounting. The check waits for the passive effect, which runs after the
// children's, so a confirmation panel that took focus in the same commit (opening the leave
// confirmation removes its button on purpose) keeps it.
export const useFocusRescue = <T extends HTMLElement>(
  fallbacks: readonly RefObject<HTMLElement | null>[],
) => {
  const element = useRef<T | null>(null);
  const lostFocus = useRef(false);
  const ref = useCallback((node: T | null) => {
    element.current = node;
    return () => {
      element.current = null;
      lostFocus.current = node === document.activeElement;
    };
  }, []);

  useEffect(() => {
    if (!lostFocus.current) return;
    lostFocus.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    fallbacks
      .map((fallback) => fallback.current)
      .find((fallback) => fallback !== null)
      ?.focus();
  });

  return { element, ref };
};
