import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { UserRecord, UserRole } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

const VALID_ROLES: UserRole[] = ['ADMIN', 'MEMBER'];

export interface CreateUserInput {
  name: string;
  email: string;
  role?: UserRole;
  active?: number;
}

function assertValidRole(role: string): asserts role is UserRole {
  if (!VALID_ROLES.includes(role as UserRole)) {
    throw new Error(`Invalid role: ${role}`);
  }
}

function assertEmailAvailable(email: string, excludeId?: string): void {
  const row = excludeId
    ? getDatabase().prepare('SELECT id FROM users WHERE email = ? AND deleted = 0 AND id <> ?').get(email, excludeId)
    : getDatabase().prepare('SELECT id FROM users WHERE email = ? AND deleted = 0').get(email);
  if (row) {
    throw new Error(`Email already in use: ${email}`);
  }
}

export async function createUser(input: CreateUserInput): Promise<string> {
  try {
    if (!input.name || !input.email) {
      throw new Error('Name and email are required');
    }
    const role = input.role ?? 'MEMBER';
    assertValidRole(role);
    assertEmailAvailable(input.email);

    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users (id, name, email, role, active, updated_at, deleted, synced) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(id, input.name, input.email, role, input.active ?? 1, nowIso());
    queueRowUpsert('users', id);
    return id;
  } catch (error) {
    handleDbError('create user', error);
  }
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read user', error);
  }
}

export async function listUsers(): Promise<UserRecord[]> {
  try {
    return getDatabase().prepare('SELECT * FROM users WHERE deleted = 0 ORDER BY name').all() as UserRecord[];
  } catch (error) {
    handleDbError('list users', error);
  }
}

export async function updateUser(
  id: string,
  updates: Partial<Pick<UserRecord, 'name' | 'email' | 'role' | 'active'>>
): Promise<UserRecord> {
  try {
    const existing = await getUserById(id);
    if (!existing) {
      throw new Error('User not found');
    }
    if (updates.role !== undefined) {
      assertValidRole(updates.role);
    }
    if (updates.email) {
      assertEmailAvailable(updates.email, id);
    }

    const { setSql, values } = buildUpdateClause(updates);
    getDatabase().prepare(`UPDATE users SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getUserById(id);
    if (!updated) {
      throw new Error('User not found after update');
    }
    queueRowUpsert('users', id);
    return updated;
  } catch (error) {
    handleDbError('update user', error);
  }
}

export async function softDeleteUser(id: string): Promise<UserRecord> {
  try {
    getDatabase().prepare('UPDATE users SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getUserById(id);
    if (!updated) {
      throw new Error('User not found after delete');
    }
    queueRowUpsert('users', id);
    return updated;
  } catch (error) {
    handleDbError('delete user', error);
  }
}
