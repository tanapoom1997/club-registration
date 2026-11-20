import { describe, expect, it } from 'vitest';
import {
  UNISSUED_PASSWORD_HASH,
  generatePassword,
  hashPassword,
  verifyPassword,
} from '../src/auth/password.js';
import { interleavedMedianMs } from './support/timing.js';

// Half the time of a real verify: a refusal that skips Argon2 takes a few percent of it.
const MIN_TIME_RATIO = 0.5;
const TIMING_ROUNDS = 7;

describe('password hashing', () => {
  it('stores argon2id in PHC format with the OWASP minimum parameters', async () => {
    const hash = await hashPassword('correct horse');

    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
  });

  it('salts every hash, so equal passwords hash differently', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toBe(second);
  });

  it('verifies the original password', async () => {
    const hash = await hashPassword('correct horse');

    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
  });

  it('rejects a different password', async () => {
    const hash = await hashPassword('correct horse');

    expect(await verifyPassword(hash, 'correct horsf')).toBe(false);
  });

  it('rejects a hash whose tag was tampered with', async () => {
    const hash = await hashPassword('correct horse');
    const tampered = `${hash.slice(0, -2)}${hash.endsWith('AA') ? 'BB' : 'AA'}`;

    expect(await verifyPassword(tampered, 'correct horse')).toBe(false);
  });

  it('rejects stored values that are not argon2id PHC strings', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
    expect(await verifyPassword('$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$dGFn', 'x')).toBe(false);
  });

  // A stored value no password can match (an account still waiting for its initial password, or a
  // malformed hash) must cost as much as a wrong password against a real hash: a quick refusal
  // would tell anyone timing the login which student IDs exist without a password yet.
  it.each([
    ['an account with no password issued yet', UNISSUED_PASSWORD_HASH],
    ['a value that is not a PHC string', 'not-a-real-hash'],
    ['an argon2 variant other than argon2id', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$dGFn'],
    [
      'another argon2 version',
      '$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$dGFndGFndGFndGFndGFn',
    ],
    ['a truncated tag', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$dGFn'],
  ])('takes as long to refuse %s as a wrong password', async (_case, storedValue) => {
    const realHash = await hashPassword('correct horse');

    const [wrongPasswordMs, unusableHashMs] = await interleavedMedianMs(
      [
        async () => await verifyPassword(realHash, 'wrong horse'),
        async () => await verifyPassword(storedValue, 'wrong horse'),
      ],
      TIMING_ROUNDS,
    );

    expect(unusableHashMs).toBeGreaterThan((wrongPasswordMs ?? 0) * MIN_TIME_RATIO);
  });
});

describe('generatePassword', () => {
  it('produces the requested length without look-alike characters', () => {
    const password = generatePassword(200);

    expect(password).toHaveLength(200);
    expect(password).toMatch(/^[a-km-np-z2-9]+$/);
  });

  it('does not repeat itself', () => {
    const passwords = new Set(Array.from({ length: 100 }, () => generatePassword(10)));

    expect(passwords.size).toBe(100);
  });
});
