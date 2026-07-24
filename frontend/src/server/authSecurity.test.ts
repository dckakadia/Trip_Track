import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase } from '../db/connection.ts';
import { startAppServer } from './appServer.ts';

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  cookie = ''
): Promise<{ status: number; data: any; setCookie: string }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') ?? '' };
}

test('repeated failed logins are throttled with a lockout', async () => {
  closeDatabase();
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;

  try {
    const setup = await api(base, 'POST', '/api/auth/setup', {
      name: 'Throttle Admin',
      email: 'throttle-admin@example.com',
      password: 'secret123'
    });
    assert.equal(setup.status, 201);

    // First 4 failures are plain 401s (lockout kicks in on the 5th consecutive failure).
    for (let i = 0; i < 4; i++) {
      const attempt = await api(base, 'POST', '/api/auth/login', {
        email: 'throttle-admin@example.com',
        password: 'wrong'
      });
      assert.equal(attempt.status, 401);
    }

    const fifth = await api(base, 'POST', '/api/auth/login', {
      email: 'throttle-admin@example.com',
      password: 'wrong'
    });
    assert.equal(fifth.status, 401);

    // Now locked out — even the correct password is rejected until the lockout expires.
    const lockedOut = await api(base, 'POST', '/api/auth/login', {
      email: 'throttle-admin@example.com',
      password: 'secret123'
    });
    assert.equal(lockedOut.status, 429);
    assert.ok(lockedOut.data.retry_after_seconds > 0);
    assert.ok(Number.isFinite(Number(lockedOut.data.retry_after_seconds)));

    // A different account is unaffected by another account's lockout.
    const otherLoginAttempt = await api(base, 'POST', '/api/auth/login', {
      email: 'nonexistent@example.com',
      password: 'whatever'
    });
    assert.equal(otherLoginAttempt.status, 401);
  } finally {
    server.close();
  }
});

test('a successful login resets the failure counter', async () => {
  closeDatabase();
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;

  try {
    await api(base, 'POST', '/api/auth/setup', {
      name: 'Reset Admin',
      email: 'reset-admin@example.com',
      password: 'secret123'
    });

    for (let i = 0; i < 3; i++) {
      const attempt = await api(base, 'POST', '/api/auth/login', {
        email: 'reset-admin@example.com',
        password: 'wrong'
      });
      assert.equal(attempt.status, 401);
    }

    const goodLogin = await api(base, 'POST', '/api/auth/login', {
      email: 'reset-admin@example.com',
      password: 'secret123'
    });
    assert.equal(goodLogin.status, 200);

    // Counter reset: three more failures shouldn't trip the lockout yet.
    for (let i = 0; i < 3; i++) {
      const attempt = await api(base, 'POST', '/api/auth/login', {
        email: 'reset-admin@example.com',
        password: 'wrong'
      });
      assert.equal(attempt.status, 401);
    }
    const stillNotLocked = await api(base, 'POST', '/api/auth/login', {
      email: 'reset-admin@example.com',
      password: 'secret123'
    });
    assert.equal(stillNotLocked.status, 200);
  } finally {
    server.close();
  }
});

test('concurrent setup requests only let one admin account win', async () => {
  closeDatabase();
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;

  try {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api(base, 'POST', '/api/auth/setup', {
          name: `Racer ${i}`,
          email: `racer${i}@example.com`,
          password: 'secret123'
        })
      )
    );

    const succeeded = attempts.filter((a) => a.status === 201);
    const rejected = attempts.filter((a) => a.status === 403);
    assert.equal(succeeded.length, 1);
    assert.equal(rejected.length, 7);

    const status = await api(base, 'GET', '/api/auth/status');
    assert.equal(status.data.needs_setup, false);

    const users = await api(base, 'GET', '/api/users', undefined, succeeded[0]!.setCookie.split(';')[0]);
    assert.equal(users.data.filter((u: { role: string }) => u.role === 'ADMIN').length, 1);
  } finally {
    server.close();
  }
});

test('a deactivated user is locked out immediately, not just on next login', async () => {
  closeDatabase();
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;

  try {
    const setup = await api(base, 'POST', '/api/auth/setup', {
      name: 'Deactivate Admin',
      email: 'deactivate-admin@example.com',
      password: 'secret123'
    });
    const adminCookie = setup.setCookie.split(';')[0]!;

    const member = await api(
      base,
      'POST',
      '/api/users',
      { name: 'Soon Deactivated', email: 'soon-gone@example.com', role: 'MEMBER', password: 'secret123' },
      adminCookie
    );
    assert.equal(member.status, 201);

    const memberLogin = await api(base, 'POST', '/api/auth/login', {
      email: 'soon-gone@example.com',
      password: 'secret123'
    });
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.setCookie.split(';')[0]!;

    // Session works while active.
    const beforeDeactivate = await api(base, 'GET', '/api/trips', undefined, memberCookie);
    assert.equal(beforeDeactivate.status, 200);

    // Admin deactivates the member (soft delete — sets deleted = 1).
    await api(base, 'DELETE', `/api/users/${member.data.id}`, undefined, adminCookie);

    // The member's still-unexpired session cookie is rejected on the very next request.
    const afterDeactivate = await api(base, 'GET', '/api/trips', undefined, memberCookie);
    assert.equal(afterDeactivate.status, 401);
  } finally {
    server.close();
  }
});
