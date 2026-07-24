import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { startSyncServer } from './server.ts';

function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(requestText));
    let buf = '';
    socket.on('data', (chunk) => (buf += chunk.toString()));
    socket.on('close', () => resolve(buf));
    socket.on('error', reject);
  });
}

const uploadDir = mkdtempSync(join(tmpdir(), 'triptrack-uploads-'));
process.env.TRIPTRACK_UPLOAD_DIR = uploadDir;

function tripPayload(id: string, name: string, updatedAt: string): string {
  return JSON.stringify({
    id,
    name,
    start_date: null,
    end_date: null,
    notes: null,
    updated_at: updatedAt,
    deleted: 0,
    synced: 0
  });
}

test('sync server push/pull with last-write-wins and photo upload', async () => {
  const { server, port } = await startSyncServer(0);
  const base = `http://localhost:${port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { ok: true });

    // Push a new row: applied.
    const tripId = randomUUID();
    const t1 = '2026-07-24T10:00:00.000Z';
    const push1 = await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table_name: 'trips', row_id: tripId, op: 'upsert', payload: tripPayload(tripId, 'Server Trip', t1) })
    });
    assert.deepEqual(await push1.json(), { applied: true });

    // Push a stale copy of the same row: rejected by LWW.
    const stale = await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table_name: 'trips',
        row_id: tripId,
        op: 'upsert',
        payload: tripPayload(tripId, 'Old Name', '2026-07-24T09:00:00.000Z')
      })
    });
    assert.deepEqual(await stale.json(), { applied: false });

    // Push to an unknown table: rejected.
    const bad = await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table_name: 'settings', row_id: 'x', op: 'upsert', payload: '{"id":"x"}' })
    });
    assert.equal(bad.status, 400);

    // Push with an unrecognized/malicious column name: rejected, not interpolated into SQL.
    const maliciousId = randomUUID();
    const maliciousPush = await fetch(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table_name: 'trips',
        row_id: maliciousId,
        op: 'upsert',
        payload: JSON.stringify({
          id: maliciousId,
          name: 'Injected',
          updated_at: t1,
          "id); DROP TABLE trips; --": 'malicious'
        })
      })
    });
    assert.equal(maliciousPush.status, 400);
    const bodyAfterMalicious = (await maliciousPush.json()) as { error: string };
    assert.match(bodyAfterMalicious.error, /unknown column/);

    // Pull with no `since` returns the stored row without server bookkeeping columns.
    const pull = await fetch(`${base}/api/sync/pull`);
    const { changes } = (await pull.json()) as { changes: Array<{ table_name: string; row: Record<string, unknown> }> };
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.table_name, 'trips');
    assert.equal(changes[0]?.row.name, 'Server Trip');
    assert.ok(!('server_updated_at' in changes[0]!.row));

    // Pull with a future `since` returns nothing.
    const emptyPull = await fetch(`${base}/api/sync/pull?since=2999-01-01T00:00:00.000Z`);
    assert.deepEqual(await emptyPull.json(), { changes: [] });

    // Photo upload stores the bytes and returns a served URL.
    const photoId = randomUUID();
    const bytes = Buffer.from('fake-jpeg-bytes');
    const upload = await fetch(`${base}/api/photos/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_id: photoId, filename: 'floor.jpg', data_base64: bytes.toString('base64') })
    });
    const { url } = (await upload.json()) as { url: string };
    assert.equal(url, `/uploads/${photoId}-floor.jpg`);
    assert.deepEqual(readFileSync(join(uploadDir, `${photoId}-floor.jpg`)), bytes);

    const served = await fetch(`${base}${url}`);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
  } finally {
    server.close();
  }
});

test('a request with an empty Host header gets a clean response, not a crash', async () => {
  const { server, port } = await startSyncServer(0);
  let unhandled: unknown = null;
  const onUnhandledRejection = (reason: unknown) => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    // `new URL(path, \`http://${host}\`)` throws when host is empty — this must be caught
    // inside handleRequest, not escape as an unhandled rejection that kills the process.
    const response = await rawRequest(port, 'GET /health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 \d{3}/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled, null, `expected no unhandled rejection, got: ${unhandled}`);

    // The server is still alive and serving normal requests afterward.
    const health = await fetch(`http://localhost:${port}/health`);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
    server.close();
  }
});
