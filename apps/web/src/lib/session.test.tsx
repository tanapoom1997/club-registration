import type { SessionUser } from '@club-registration/shared';
import { describe, expect, it } from 'vitest';
import { returnPathFor } from './session';

const ADMIN: SessionUser = {
  id: 2,
  loginId: 'demo-admin',
  fullName: 'ผู้ดูแลสมมติ',
  role: 'admin',
  mustChangePassword: false,
};

describe('returnPathFor (Y1)', () => {
  it.each(['/admin', '/admin/events', '/admin/clubs'])(
    'goes back to %s, a page of the role',
    (from) => {
      expect(returnPathFor(ADMIN, { from })).toBe(from);
    },
  );

  it.each([
    ['another role', '/student/clubs'],
    ['a path that only starts like the role', '/administrator'],
    ['another site', '//attacker.example/admin'],
    ['an absolute URL', 'https://attacker.example/admin'],
    ['a shared page', '/change-password'],
    ['an empty path', ''],
  ])('ignores %s and goes home', (_, from) => {
    expect(returnPathFor(ADMIN, { from })).toBe('/admin');
  });

  it.each([undefined, null, 'admin/events', { from: 42 }, {}])(
    'goes home when the state is not one RequireSession left (%j)',
    (state) => {
      expect(returnPathFor(ADMIN, state)).toBe('/admin');
    },
  );

  it('sends a user with a pending password change to change it, wherever they were going', () => {
    expect(returnPathFor({ ...ADMIN, mustChangePassword: true }, { from: '/admin/events' })).toBe(
      '/change-password',
    );
  });
});
