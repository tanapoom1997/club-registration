import { useEffect } from 'react';

const releaseQuietly = async (sentinel: WakeLockSentinel): Promise<void> => {
  try {
    await sentinel.release();
  } catch {
    // Already released by the browser: nothing is left to undo.
  }
};

// Keeps the screen on while `active` (README Phase 4, P4b): a queue ticket expires after about a
// minute without a heartbeat, and a phone whose screen sleeps suspends or throttles the page's
// timers. Feature-detected: a browser without the Screen Wake Lock API, or one that refuses it
// (battery saver, a hidden page), works as before, with the warning on the page as the only help.
// Nothing is logged, so no refusal can leak anything about the student.
//
// The browser drops the lock whenever the page is hidden (another app, a locked phone), so it is
// asked for again each time the page becomes visible while still active. Real phones (iOS Safari,
// Android Chrome) are still to be checked on the O5 test day.
export const useWakeLock = (active: boolean): void => {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    const { wakeLock } = navigator;
    let sentinel: WakeLockSentinel | undefined;
    let requesting = false;
    let ended = false;

    const acquire = async () => {
      if (ended || requesting || sentinel !== undefined) return;
      if (document.visibilityState !== 'visible') return;
      requesting = true;
      try {
        const next = await wakeLock.request('screen');
        // The page stopped needing it (the ticket ended, the page closed) while it was on its way.
        if (ended) {
          await releaseQuietly(next);
          return;
        }
        sentinel = next;
        next.addEventListener('release', () => {
          if (sentinel === next) sentinel = undefined;
        });
      } catch {
        // Refused: the page carries on without it.
      } finally {
        requesting = false;
      }
    };

    const onVisibilityChange = () => {
      void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      ended = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      const held = sentinel;
      sentinel = undefined;
      if (held) void releaseQuietly(held);
    };
  }, [active]);
};
