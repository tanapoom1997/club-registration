import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWakeLock, removeWakeLock, setVisibility } from '@/test-support/wake-lock';
import { useWakeLock } from './wake-lock';

const Probe = ({ active }: { active: boolean }) => {
  useWakeLock(active);
  return null;
};

// Lets the request (and the release) promises settle inside act.
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const mount = async (active: boolean, { strict = false } = {}) => {
  const view = render(
    strict ? (
      <StrictMode>
        <Probe active={active} />
      </StrictMode>
    ) : (
      <Probe active={active} />
    ),
  );
  await settle();
  return {
    ...view,
    setActive: async (next: boolean) => {
      view.rerender(
        strict ? (
          <StrictMode>
            <Probe active={next} />
          </StrictMode>
        ) : (
          <Probe active={next} />
        ),
      );
      await settle();
    },
  };
};

describe('useWakeLock', () => {
  afterEach(() => {
    cleanup();
    removeWakeLock();
  });

  it('keeps the screen on while active', async () => {
    const lock = installWakeLock();

    await mount(true);

    expect(lock.request).toHaveBeenCalledExactlyOnceWith('screen');
    expect(lock.live()).toHaveLength(1);
  });

  it('asks for nothing while not active', async () => {
    const lock = installWakeLock();

    await mount(false);

    expect(lock.request).not.toHaveBeenCalled();
  });

  it('lets the screen sleep again once no longer active', async () => {
    const lock = installWakeLock();
    const { setActive } = await mount(true);

    await setActive(false);

    expect(lock.live()).toHaveLength(0);
    expect(lock.request).toHaveBeenCalledTimes(1);
  });

  it('lets the screen sleep again when the page goes', async () => {
    const lock = installWakeLock();
    const { unmount } = await mount(true);

    unmount();
    await settle();

    expect(lock.live()).toHaveLength(0);
  });

  it('asks again when the page is visible again after the browser dropped the lock', async () => {
    const lock = installWakeLock();
    await mount(true);

    setVisibility('hidden');
    act(() => {
      lock.sentinels[0]?.dropByBrowser();
    });
    await settle();
    expect(lock.request).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await settle();

    expect(lock.request).toHaveBeenCalledTimes(2);
    expect(lock.live()).toHaveLength(1);
  });

  it('does not ask again on a visibility change while the lock is still held', async () => {
    const lock = installWakeLock();
    await mount(true);

    setVisibility('visible');
    await settle();

    expect(lock.request).toHaveBeenCalledTimes(1);
  });

  it('waits for the page to be visible before asking', async () => {
    const lock = installWakeLock();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await mount(true);
    expect(lock.request).not.toHaveBeenCalled();

    setVisibility('visible');
    await settle();

    expect(lock.request).toHaveBeenCalledTimes(1);
  });

  it('stops listening for visibility once no longer active', async () => {
    const lock = installWakeLock();
    const { setActive } = await mount(true);
    await setActive(false);

    setVisibility('visible');
    await settle();

    expect(lock.request).toHaveBeenCalledTimes(1);
  });

  it('releases a lock that arrives after the page stopped needing it', async () => {
    const lock = installWakeLock();
    lock.hold();
    const { setActive } = await mount(true);

    await setActive(false);
    await lock.grantHeld();
    await settle();

    expect(lock.sentinels).toHaveLength(1);
    expect(lock.live()).toHaveLength(0);
  });

  it('holds one lock under StrictMode, which runs the effect twice', async () => {
    const lock = installWakeLock();

    const { unmount } = await mount(true, { strict: true });

    expect(lock.live()).toHaveLength(1);
    unmount();
    await settle();
    expect(lock.live()).toHaveLength(0);
  });

  it('carries on silently when the browser refuses', async () => {
    const lock = installWakeLock();
    lock.refuse();
    const log = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');

    await mount(true);

    expect(lock.request).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing in a browser without the API', async () => {
    expect('wakeLock' in navigator).toBe(false);

    const { setActive, unmount } = await mount(true);
    await setActive(false);
    unmount();

    expect('wakeLock' in navigator).toBe(false);
  });
});
