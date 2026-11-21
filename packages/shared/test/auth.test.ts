import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  changePasswordRequestSchema,
  loginIdSchema,
  loginRequestSchema,
  newPasswordSchema,
} from '../src/auth.js';

describe('loginIdSchema', () => {
  // The DB stores what this returns and holds the same rule (users_login_id_format), so a student
  // signs in with exactly the key the import stored, however it was typed.
  it.each([
    ['DEMO1001', 'demo1001'],
    ['  demo-admin  ', 'demo-admin'],
    ['First.Last_2', 'first.last_2'],
    ['6512345', '6512345'],
  ])('normalises %j to %j', (input, stored) => {
    expect(loginIdSchema.parse(input)).toBe(stored);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['a space inside', 'has space'],
    ['Thai letters', 'ไทยสมมติ'],
    ['an accented letter', 'café'],
    ['a semicolon', 'semi;colon'],
    ['65 characters', 'x'.repeat(65)],
  ])('refuses %s', (_case, input) => {
    expect(loginIdSchema.safeParse(input).success).toBe(false);
  });

  it('accepts exactly 64 characters', () => {
    expect(loginIdSchema.safeParse('x'.repeat(64)).success).toBe(true);
  });
});

describe('newPasswordSchema', () => {
  it('accepts the shortest and the longest allowed password', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
  });

  // The upper bound limits the work one request can force into Argon2.
  it('refuses one character too short or too long', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('normalises the login ID but leaves the password exactly as typed', () => {
    expect(loginRequestSchema.parse({ loginId: ' Demo1001 ', password: ' Pass Word ' })).toEqual({
      loginId: 'demo1001',
      password: ' Pass Word ',
    });
  });

  it('refuses a password longer than any account can have', () => {
    const result = loginRequestSchema.safeParse({
      loginId: 'demo1001',
      password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1),
    });

    expect(result.success).toBe(false);
  });
});

describe('changePasswordRequestSchema', () => {
  it('refuses a new password equal to the current one, on the newPassword field', () => {
    const result = changePasswordRequestSchema.safeParse({
      currentPassword: 'fictional-pass-1',
      newPassword: 'fictional-pass-1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ path }) => path)).toEqual([['newPassword']]);
  });

  // The change-password page shows the first message as is, so each must be one a student reads.
  it.each([
    ['an empty current password', '', 'fictional-pass-2', 'กรุณากรอกรหัสผ่านเดิม', 'currentPassword'],
    [
      'a current password longer than any account can have',
      'a'.repeat(PASSWORD_MAX_LENGTH + 1),
      'fictional-pass-2',
      'รหัสผ่านเดิมไม่ถูกต้อง',
      'currentPassword',
    ],
    [
      'a new password one character too short',
      'fictional-pass-1',
      'a'.repeat(PASSWORD_MIN_LENGTH - 1),
      `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัว`,
      'newPassword',
    ],
    [
      'a new password one character too long',
      'fictional-pass-1',
      'a'.repeat(PASSWORD_MAX_LENGTH + 1),
      `รหัสผ่านต้องยาวไม่เกิน ${PASSWORD_MAX_LENGTH} ตัว`,
      'newPassword',
    ],
  ])(
    'refuses %s with a Thai message on that field',
    (_case, currentPassword, newPassword, message, field) => {
      const result = changePasswordRequestSchema.safeParse({ currentPassword, newPassword });

      expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
        [[field], message],
      ]);
    },
  );

  it('accepts a different new password', () => {
    const result = changePasswordRequestSchema.safeParse({
      currentPassword: 'fictional-pass-1',
      newPassword: 'fictional-pass-2',
    });

    expect(result.success).toBe(true);
  });
});
