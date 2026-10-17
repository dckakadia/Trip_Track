import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startSyncServer } from './server.ts';

process.env.TRIPTRACK_UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'triptrack-shortlist-uploads-'));

async function push(base: string, table: string, row: Record<string, unknown>) {
  const res = await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table_name: table, row_id: row.id, op: 'upsert', payload: JSON.stringify(row) })
  });
  return { status: res.status, body: await res.json() };
}

test('sync server stores and serves supplier priority and trip_suppliers with last-write-wins', async () => {
  const { server, port } = await startSyncServer(0);
  const base = `http://localhost:${port}`;
  try {
    const supplierId = randomUUID();
    const linkId = randomUUID();
    const t1 = '2026-10-10T10:00:00.000Z';
    const supplier = { id: supplierId, name: 'Server Priority', priority: 'MUST', skip_reason: 'Key fabric mill', updated_at: t1, deleted: 0, synced: 0 };
    assert.deepEqual((await push(base, 'suppliers', supplier)).body, { applied: true });
    assert.deepEqual(
      (await push(base, 'trip_suppliers', { id: linkId, trip_id: 't1', supplier_id: supplierId, updated_at: t1, deleted: 0, synced: 0 })).body,
      { applied: true }
    );

    // Older edit loses; newer edit wins.
    assert.deepEqual((await push(base, 'suppliers', { ...supplier, priority: 'SKIP', updated_at: '2026-10-10T09:00:00.000Z' })).body, { applied: false });
    assert.deepEqual(
      (await push(base, 'trip_suppliers', { id: linkId, trip_id: 't1', supplier_id: supplierId, updated_at: '2026-10-10T11:00:00.000Z', deleted: 1, synced: 0 })).body,
      { applied: true }
    );

    // Unknown columns on the new table are still rejected.
    const bad = await push(base, 'trip_suppliers', { id: randomUUID(), trip_id: 't1', supplier_id: 's', updated_at: t1, 'x; DROP TABLE trips': 1 });
    assert.equal(bad.status, 400);

    const { changes } = (await (await fetch(`${base}/api/sync/pull`)).json()) as {
      changes: Array<{ table_name: string; row: Record<string, unknown> }>;
    };
    const pulledSupplier = changes.find((c) => c.table_name === 'suppliers')?.row;
    assert.equal(pulledSupplier?.priority, 'MUST');
    assert.equal(pulledSupplier?.skip_reason, 'Key fabric mill');
    const pulledLink = changes.find((c) => c.table_name === 'trip_suppliers')?.row;
    assert.equal(pulledLink?.deleted, 1);
    assert.equal(pulledLink?.supplier_id, supplierId);
  } finally {
    server.close();
  }
});
