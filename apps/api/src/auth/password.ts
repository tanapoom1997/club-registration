import { argon2, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

type Argon2Params = { memory: number; passes: number; parallelism: number };

// OWASP Password Storage Cheat Sheet minimum for argon2id (19 MiB, 2 passes, 1 lane).
const ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({
  memory: 19_456,
  passes: 2,
  parallelism: 1,
});
const ARGON2_VERSION = 19;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const MIN_TAG_BYTES = 16;

// PHC string format, the layout libargon2 and the npm argon2 package also produce, so stored
// hashes stay portable if the implementation ever changes.
const PHC_PATTERN =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

// Stored for an account that has no password yet (e.g. a student created by the Excel import,
// waiting for an admin to issue an initial one). It is not a PHC string, so verifyPassword
// rejects every password against it and nobody can sign in until a real hash replaces it.
export const UNISSUED_PASSWORD_HASH = '!unissued';

const toUnpaddedBase64 = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '');

const derive = async (
  password: string,
  salt: Buffer,
  params: Argon2Params,
  tagLength: number,
): Promise<Buffer> =>
  await argon2Async('argon2id', { message: password, nonce: salt, tagLength, ...params });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, ARGON2_PARAMS, TAG_BYTES);
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  return [
    '',
    'argon2id',
    `v=${ARGON2_VERSION}`,
    `m=${memory},t=${passes},p=${parallelism}`,
    toUnpaddedBase64(salt),
    toUnpaddedBase64(tag),
  ].join('$');
};

export const verifyPassword = async (storedHash: string, password: string): Promise<boolean> => {
  const match = PHC_PATTERN.exec(storedHash);
  if (!match) return false;
  const [, version, memory, passes, parallelism, salt = '', tag = ''] = match;
  if (Number(version) !== ARGON2_VERSION) return false;

  const expected = Buffer.from(tag, 'base64');
  if (expected.length < MIN_TAG_BYTES) return false;
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) },
    expected.length,
  );
  return timingSafeEqual(actual, expected);
};

// No 0/o, 1/l/i: initial passwords are handed out on paper and typed by hand.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const generatePassword = (length: number): string =>
  Array.from({ length }, () => PASSWORD_ALPHABET.charAt(randomInt(PASSWORD_ALPHABET.length))).join(
    '',
  );
