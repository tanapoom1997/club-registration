import { roleSchema } from '@club-registration/shared';
import type { Role, SessionUser } from '@club-registration/shared';
import type pg from 'pg';

export type Queryable = pg.Pool | pg.PoolClient;

// Server-side view of a user: what the client sees plus the token version it must match.
export type AuthenticatedUser = SessionUser & { sessionVersion: number };

type UserRow = {
  id: number;
  login_id: string;
  full_name: string;
  role: string;
  must_change_password: boolean;
  session_version: number;
};

const USER_COLUMNS = 'id, login_id, full_name, role, must_change_password, session_version';

// The one place snake_case rows become camelCase; role is parsed so a bad row fails loudly.
const toAuthenticatedUser = (row: UserRow): AuthenticatedUser => ({
  id: row.id,
  loginId: row.login_id,
  fullName: row.full_name,
  role: roleSchema.parse(row.role),
  mustChangePassword: row.must_change_password,
  sessionVersion: row.session_version,
});

export const toSessionUser = ({
  id,
  loginId,
  fullName,
  role,
  mustChangePassword,
}: AuthenticatedUser): SessionUser => ({ id, loginId, fullName, role, mustChangePassword });

export const findUserWithHashByLoginId = async (
  db: Queryable,
  loginId: string,
): Promise<{ user: AuthenticatedUser; passwordHash: string } | undefined> => {
  const { rows } = await db.query<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE login_id = $1`,
    [loginId],
  );
  const row = rows[0];
  return row && { user: toAuthenticatedUser(row), passwordHash: row.password_hash };
};

export const findUserById = async (
  db: Queryable,
  id: number,
): Promise<AuthenticatedUser | undefined> => {
  const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = rows[0];
  return row && toAuthenticatedUser(row);
};

export const findPasswordHashById = async (
  db: Queryable,
  id: number,
): Promise<string | undefined> => {
  const { rows } = await db.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [id],
  );
  return rows[0]?.password_hash;
};

// The version check makes this a compare-and-set: a request racing a logout or another password
// change finds no row and must not succeed.
export const replacePassword = async (
  db: Queryable,
  {
    id,
    passwordHash,
    expectedVersion,
  }: { id: number; passwordHash: string; expectedVersion: number },
): Promise<AuthenticatedUser | undefined> => {
  const { rows } = await db.query<UserRow>(
    `UPDATE users
     SET password_hash = $2, must_change_password = false, session_version = session_version + 1
     WHERE id = $1 AND session_version = $3
     RETURNING ${USER_COLUMNS}`,
    [id, passwordHash, expectedVersion],
  );
  const row = rows[0];
  return row && toAuthenticatedUser(row);
};

export const bumpSessionVersion = async (
  db: Queryable,
  { id, expectedVersion }: { id: number; expectedVersion: number },
): Promise<void> => {
  await db.query(
    'UPDATE users SET session_version = session_version + 1 WHERE id = $1 AND session_version = $2',
    [id, expectedVersion],
  );
};

export type NewUser = { loginId: string; fullName: string; role: Role; passwordHash: string };

export type CreateUserResult =
  { created: true; user: AuthenticatedUser } | { created: false; existingRole: Role };

// ON CONFLICT keeps reruns from creating duplicates even if two run at once.
export const createUserIfMissing = async (
  db: Queryable,
  { loginId, fullName, role, passwordHash }: NewUser,
): Promise<CreateUserResult> => {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (login_id, full_name, role, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (login_id) DO NOTHING
     RETURNING ${USER_COLUMNS}`,
    [loginId, fullName, role, passwordHash],
  );
  const inserted = rows[0];
  if (inserted) return { created: true, user: toAuthenticatedUser(inserted) };

  const { rows: existing } = await db.query<{ role: string }>(
    'SELECT role FROM users WHERE login_id = $1',
    [loginId],
  );
  const existingRow = existing[0];
  if (!existingRow) throw new Error('User vanished between insert and lookup');
  return { created: false, existingRole: roleSchema.parse(existingRow.role) };
};
