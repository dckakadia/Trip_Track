import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase } from '../db/connection.ts';
import { startAppServer } from './appServer.ts';
import { startSyncServer } from '../../../backend/src/server.ts';

async function api(
  base: string,
  method: string,
  path: string,
  cookie: string
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie } });
  return { status: res.status, data: await res.json() };
}

test('concurrent /api/sync/run requests do not both run at once', async () => {
  closeDatabase();
  const { server: syncServer, port: syncPort } = await startSyncServer(0);
  process.env.TRIPTRACK_SYNC_URL = `http://localhost:${syncPort}`;
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;

  try {
    const setupRes = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sync Admin', email: 'sync-admin@example.com', password: 'secret123' })
    });
    const cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0]!;

    const [first, second] = await Promise.all([
      api(base, 'POST', '/api/sync/run', cookie),
      api(base, 'POST', '/api/sync/run', cookie)
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    // A later sync, once the first has finished, is allowed through again.
    const after = await api(base, 'POST', '/api/sync/run', cookie);
    assert.equal(after.status, 200);
  } finally {
    server.close();
    syncServer.close();
    delete process.env.TRIPTRACK_SYNC_URL;
  }
});
