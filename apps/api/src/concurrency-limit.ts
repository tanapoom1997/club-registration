// Runs at most `max` tasks at once; later ones wait in arrival order. Used to keep CPU-heavy work
// (Argon2 hashing on the libuv threadpool) from taking every thread at the same time.
export const createConcurrencyLimit = (max: number) => {
  if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active += 1;
      return;
    }
    // The slot is handed over by release, so active stays the same.
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};

export type ConcurrencyLimit = ReturnType<typeof createConcurrencyLimit>;
