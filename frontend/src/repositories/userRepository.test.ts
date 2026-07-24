import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createUser, getUserById, listUsers, softDeleteUser, updateUser } from './userRepository.ts';

test('user repository CRUD with role validation and unique emails', async () => {
  initializeDatabase();

  const adminId = await createUser({ name: 'Devin', email: 'devin@example.com', role: 'ADMIN' });
  const memberId = await createUser({ name: 'Alex', email: 'alex@example.com' });

  const admin = await getUserById(adminId);
  assert.equal(admin?.role, 'ADMIN');
  assert.equal(admin?.active, 1);
  assert.equal(admin?.synced, 0);

  const member = await getUserById(memberId);
  assert.equal(member?.role, 'MEMBER');

  // Duplicate email is rejected.
  await assert.rejects(() => createUser({ name: 'Dupe', email: 'devin@example.com' }), /Email already in use/);

  // Missing email and invalid role are rejected.
  await assert.rejects(() => createUser({ name: 'No Email', email: '' }), /required/);
  await assert.rejects(() => createUser({ name: 'X', email: 'x@example.com', role: 'ROOT' as never }), /Invalid role/);

  const users = await listUsers();
  assert.deepEqual(
    users.map((u) => u.name),
    ['Alex', 'Devin']
  );

  const updated = await updateUser(memberId, { role: 'ADMIN', name: 'Alexandra' });
  assert.equal(updated.role, 'ADMIN');
  assert.equal(updated.name, 'Alexandra');
  assert.equal(updated.synced, 0);

  // Changing email to another active user's email is rejected; keeping your own is fine.
  await assert.rejects(() => updateUser(memberId, { email: 'devin@example.com' }), /Email already in use/);
  await updateUser(memberId, { email: 'alex@example.com' });

  const deleted = await softDeleteUser(adminId);
  assert.equal(deleted.deleted, 1);
  assert.equal((await listUsers()).some((u) => u.id === adminId), false);

  // A deleted user's email can be reused.
  await createUser({ name: 'Devin II', email: 'devin@example.com' });
});
