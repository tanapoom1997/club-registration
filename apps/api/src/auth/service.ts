import { ERROR_CODES } from '@club-registration/shared';
import type { ChangePasswordRequest, LoginRequest, Role } from '@club-registration/shared';
import { AppError } from '../errors.js';
import { generatePassword, hashPassword, spendVerifyWork, verifyPassword } from './password.js';
import {
  bumpSessionVersion,
  createUserIfMissing,
  findPasswordHashById,
  findUserWithHashByLoginId,
  replacePassword,
} from './users.js';
import type { AuthenticatedUser, Queryable } from './users.js';

export const login = async (
  db: Queryable,
  { loginId, password }: LoginRequest,
): Promise<AuthenticatedUser> => {
  const found = await findUserWithHashByLoginId(db, loginId);
  if (!found) {
    // Unknown IDs pay for one verify too, so response time does not reveal which IDs exist.
    await spendVerifyWork(password);
    throw new AppError(ERROR_CODES.invalidCredentials);
  }
  if (!(await verifyPassword(found.passwordHash, password))) {
    throw new AppError(ERROR_CODES.invalidCredentials);
  }
  return found.user;
};

export const changePassword = async (
  db: Queryable,
  user: AuthenticatedUser,
  { currentPassword, newPassword }: ChangePasswordRequest,
): Promise<AuthenticatedUser> => {
  const currentHash = await findPasswordHashById(db, user.id);
  if (currentHash === undefined) throw new AppError(ERROR_CODES.unauthorized);
  if (!(await verifyPassword(currentHash, currentPassword))) {
    throw new AppError(ERROR_CODES.invalidCurrentPassword);
  }

  const updated = await replacePassword(db, {
    id: user.id,
    passwordHash: await hashPassword(newPassword),
    expectedVersion: user.sessionVersion,
  });
  if (!updated) throw new AppError(ERROR_CODES.unauthorized);
  return updated;
};

// Logout ends every session of the user, not only this browser: on shared lab computers a
// forgotten tab elsewhere is the risk, and per-device sessions would need a sessions table.
export const logout = async (db: Queryable, user: AuthenticatedUser): Promise<void> => {
  await bumpSessionVersion(db, { id: user.id, expectedVersion: user.sessionVersion });
};

// Longer than the paper-slip student passwords: an admin account can do far more damage.
const ADMIN_PASSWORD_LENGTH = 16;
const ADMIN_FULL_NAME = 'Administrator';

export type CreateAdminResult =
  | { status: 'created'; user: AuthenticatedUser; initialPassword: string }
  | { status: 'exists' }
  | { status: 'conflict'; existingRole: Role };

// The initial password exists only in the return value; the caller shows it once and drops it.
export const createAdmin = async (db: Queryable, loginId: string): Promise<CreateAdminResult> => {
  const initialPassword = generatePassword(ADMIN_PASSWORD_LENGTH);
  const result = await createUserIfMissing(db, {
    loginId,
    fullName: ADMIN_FULL_NAME,
    role: 'admin',
    passwordHash: await hashPassword(initialPassword),
  });
  if (result.created) return { status: 'created', user: result.user, initialPassword };
  return result.existingRole === 'admin'
    ? { status: 'exists' }
    : { status: 'conflict', existingRole: result.existingRole };
};
