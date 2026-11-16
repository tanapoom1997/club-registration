import { describe, expect, it } from 'vitest';
import { createConcurrencyLimit } from '../src/concurrency-limit.js';

const tick = async () => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

describe('createConcurrencyLimit', () => {
  it('never runs more than max tasks at once and runs every task', async () => {
    const limit = createConcurrencyLimit(2);
    let running = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from(
        { length: 10 },
        async (_, i) =>
          await limit(async () => {
            running += 1;
            peak = Math.max(peak, running);
            await tick();
            running -= 1;
            return i;
          }),
      ),
    );

    expect(peak).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('frees the slot of a task that throws', async () => {
    const limit = createConcurrencyLimit(1);

    await expect(
      limit(async () => {
        await tick();
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');

    expect(await limit(async () => await Promise.resolve('next'))).toBe('next');
  });

  it('rejects a limit that is not a positive integer', () => {
    expect(() => createConcurrencyLimit(0)).toThrow();
  });
});
