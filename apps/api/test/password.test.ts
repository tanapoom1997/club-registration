import { describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, verifyPassword } from '../src/auth/password.js';

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
