import { performance } from 'node:perf_hooks';

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

// Median duration of each piece of work, measured in turns (a, b, c, a, b, c, ...) so a slow
// moment of the machine falls on every one alike rather than on whichever ran then.
//
// Timing tests here only compare an Argon2 verify (tens of milliseconds) with skipping it (well
// under one): a ratio that coarse survives a noisy CI runner, where a fixed number of
// milliseconds would not.
export const interleavedMedianMs = async (
  works: readonly (() => Promise<unknown>)[],
  rounds: number,
): Promise<number[]> => {
  const samples = works.map((): number[] => []);
  for (let round = 0; round < rounds; round += 1) {
    for (const [index, work] of works.entries()) {
      const started = performance.now();
      await work();
      samples[index]?.push(performance.now() - started);
    }
  }
  return samples.map(median);
};
