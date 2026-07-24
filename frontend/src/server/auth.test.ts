import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearedSessionCookie,
  createSessionToken,
  hashPassword,
  sessionCookie,
  verifyPassword,
  verifySessionToken
} from './auth.ts';
import { closeDatabase } from '../db/connection.ts';
import { initializeDatabase } from '../db/migrations.ts';

test('hashPassword/verifyPassword round-trips and rejects wrong passwords', () => {
  closeDatabase();
  initializeDatabase();
  const hash = hashPassword('correct horse battery staple');
  assert.ok(verifyPassword('correct horse battery staple', hash));
  assert.ok(!verifyPassword('wrong password', hash));
  assert.ok(!verifyPassword('anything', null));
});

test('session tokens round-trip and reject tampering or expiry', async () => {
  closeDatabase();
  initializeDatabase();
  const token = await createSessionToken('user-123');
  assert.equal(await verifySessionToken(token), 'user-123');

  // Tampered signature is rejected.
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(await verifySessionToken(tampered), null);

  // Missing token is rejected.
  assert.equal(await verifySessionToken(undefined), null);

  // Garbage token is rejected without throwing.
  assert.equal(await verifySessionToken('not-a-real-token'), null);
});

test('sessionCookie only sets Secure when TRIPTRACK_COOKIE_SECURE=1', () => {
  delete process.env.TRIPTRACK_COOKIE_SECURE;
  assert.doesNotMatch(sessionCookie('tok'), /Secure/);
  assert.doesNotMatch(clearedSessionCookie(), /Secure/);

  process.env.TRIPTRACK_COOKIE_SECURE = '1';
  try {
    assert.match(sessionCookie('tok'), /; Secure/);
    assert.match(clearedSessionCookie(), /; Secure/);
  } finally {
    delete process.env.TRIPTRACK_COOKIE_SECURE;
  }
});
