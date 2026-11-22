import { act } from '@testing-library/react';
import { vi } from 'vitest';

// A stand-in for the Screen Wake Lock API, which jsdom does not have (so a test that installs
// none checks a browser without it). Each request gives a sentinel that fires "release" once,
// whether the page or the browser (hiding the page) releases it.
export type FakeSentinel = {
  released: boolean;
  release: () => Promise<void>;
  // What the browser does to a held lock when the page is hidden.
  dropByBrowser: () => void;
};

type Outcome = 'grant' | 'refuse' | 'hold';

export const installWakeLock = () => {
  const sentinels: FakeSentinel[] = [];
  let outcome: Outcome = 'grant';
  let held: { resolve: (sentinel: WakeLockSentinel) => void } | undefined;

  const makeSentinel = () => {
    const target = new EventTarget();
    const sentinel: FakeSentinel = {
      released: false,
      release: async () => {
        await Promise.resolve();
        sentinel.dropByBrowser();
      },
      dropByBrowser: () => {
        if (sentinel.released) return;
        sentinel.released = true;
        target.dispatchEvent(new Event('release'));
      },
    };
    sentinels.push(sentinel);
    // The hook reads addEventListener and release only.
    return Object.assign(target, { release: sentinel.release }) as unknown as WakeLockSentinel;
  };

  const request = vi.fn(async (): Promise<WakeLockSentinel> => {
    await Promise.resolve();
    if (outcome === 'refuse') throw new DOMException('Wake lock refused', 'NotAllowedError');
    if (outcome === 'hold') {
      return await new Promise<WakeLockSentinel>((resolve) => {
        held = { resolve };
      });
    }
    return makeSentinel();
  });

  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });

  return {
    request,
    sentinels,
    live: () => sentinels.filter(({ released }) => !released),
    // The next requests are refused (battery saver, a page the browser does not allow it on).
    refuse: () => {
      outcome = 'refuse';
    },
    // The next request stays unanswered until grantHeld.
    hold: () => {
      outcome = 'hold';
    },
    grantHeld: async () => {
      outcome = 'grant';
      await act(async () => {
        held?.resolve(makeSentinel());
        await Promise.resolve();
      });
    },
  };
};

// Undone by hand: restoreMocks does not undo defineProperty.
export const removeWakeLock = () => {
  Reflect.deleteProperty(navigator, 'wakeLock');
};

export const setVisibility = (state: DocumentVisibilityState) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
};
