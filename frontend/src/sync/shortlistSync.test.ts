import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from '../repositories/tripRepository.ts';
import { createSupplier, getSupplierById, updateSupplier } from '../repositories/supplierRepository.ts';
import {
  addSupplierToTrip,
  getTripSupplierById,
  listTripSuppliers,
  removeSupplierFromTrip
} from '../repositories/tripSupplierRepository.ts';
import { countPendingOps } from './pendingOps.ts';
import { runSync } from './syncEngine.ts';
import { createHttpSyncTransport } from './httpSyncTransport.ts';
import { startSyncServer } from '../../../backend/src/server.ts';
import { getServerDatabase } from '../../../backend/src/db.ts';

process.env.TRIPTRACK_UPLOAD_DIR = join(mkdtempSync(join(tmpdir(), 'triptrack-shortlist-')), 'uploads');

function later(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

test('priority, skip_reason, and trip_suppliers push and pull over HTTP with last-write-wins', async () => {
  initializeDatabase();
  const { server, port } = await startSyncServer(0);
  const transport = createHttpSyncTransport(`http://localhost:${port}`);
  const serverDb = getServerDatabase();

  try {
    // --- Push: local edits reach the server ---
    const tripId = await createTrip({ name: 'Shortlist Sync Trip' });
    const supplierId = await createSupplier({ name: 'Shortlist Sync Supplier' });
    await updateSupplier(supplierId, { priority: 'SKIP', skip_reason: 'Visited last year' });
    const link = await addSupplierToTrip(tripId, supplierId);

    const first = await runSync(transport);
    assert.equal(first.push.error, null);
    assert.equal(countPendingOps(), 0);

    const serverSupplier = serverDb.prepare('SELECT priority, skip_reason FROM suppliers WHERE id = ?').get(supplierId);
    assert.deepEqual({ ...serverSupplier }, { priority: 'SKIP', skip_reason: 'Visited last year' });
    const serverLink = serverDb.prepare('SELECT trip_id, supplier_id, deleted FROM trip_suppliers WHERE id = ?').get(link.id);
    assert.deepEqual({ ...serverLink }, { trip_id: tripId, supplier_id: supplierId, deleted: 0 });
    assert.equal((await getTripSupplierById(link.id))?.synced, 1);

    // A shortlist removal syncs as a soft delete.
    await removeSupplierFromTrip(tripId, supplierId);
    await runSync(transport);
    assert.equal((serverDb.prepare('SELECT deleted FROM trip_suppliers WHERE id = ?').get(link.id) as { deleted: number }).deleted, 1);

    // --- Pull: another device's newer edits arrive ---
    const t2 = later(1000);
    serverDb
      .prepare('UPDATE suppliers SET priority = ?, skip_reason = ?, updated_at = ?, server_updated_at = ? WHERE id = ?')
      .run('MUST', 'Changed on phone', t2, t2, supplierId);
    serverDb
      .prepare(
        `INSERT INTO trip_suppliers (id, trip_id, supplier_id, updated_at, deleted, synced, server_updated_at)
         VALUES ('from-phone', ?, ?, ?, 0, 1, ?)`
      )
      .run(tripId, supplierId, t2, t2);

    const second = await runSync(transport);
    assert.equal(second.pull.applied, 2);
    const pulled = await getSupplierById(supplierId);
    assert.equal(pulled?.priority, 'MUST');
    assert.equal(pulled?.skip_reason, 'Changed on phone');
    assert.equal(pulled?.synced, 1);
    assert.deepEqual((await listTripSuppliers(tripId)).map((r) => r.id), ['from-phone']);

    // --- Last-write-wins: an older server copy does not clobber a newer local edit ---
    await new Promise((resolve) => setTimeout(resolve, 5));
    const t3 = later(2000);
    await updateSupplier(supplierId, { priority: 'MAYBE' });
    // The newer local edit sets updated_at = now; force the server copy to be "newer"
    // on server_updated_at (so it is pulled) but older on updated_at (so it loses).
    const stale = new Date(Date.now() - 60_000).toISOString();
    serverDb
      .prepare('UPDATE suppliers SET priority = ?, updated_at = ?, server_updated_at = ? WHERE id = ?')
      .run('SKIP', stale, t3, supplierId);
    const third = await runSync(transport);
    // Push of the local MAYBE overwrote the server's stale row; the pull then echoes it back.
    assert.equal(third.push.pushed, 1);
    assert.equal((await getSupplierById(supplierId))?.priority, 'MAYBE');
    assert.equal((serverDb.prepare('SELECT priority FROM suppliers WHERE id = ?').get(supplierId) as { priority: string }).priority, 'MAYBE');

    // And a stale push is rejected by the server.
    const stalePush = await fetch(`http://localhost:${port}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table_name: 'suppliers',
        row_id: supplierId,
        op: 'upsert',
        payload: JSON.stringify({ ...(await getSupplierById(supplierId)), priority: 'SKIP', updated_at: stale })
      })
    });
    assert.deepEqual(await stalePush.json(), { applied: false });
    assert.equal((serverDb.prepare('SELECT priority FROM suppliers WHERE id = ?').get(supplierId) as { priority: string }).priority, 'MAYBE');
  } finally {
    server.close();
  }
});

test('a row pulled from an older client without priority columns gets the defaults', async () => {
  initializeDatabase();
  const { server, port } = await startSyncServer(0);
  try {
    const t = later(5000);
    getServerDatabase()
      .prepare(
        `INSERT INTO suppliers (id, name, updated_at, deleted, synced, server_updated_at) VALUES ('legacy-client', 'Legacy Client Supplier', ?, 0, 1, ?)`
      )
      .run(t, t);
    await runSync(createHttpSyncTransport(`http://localhost:${port}`));
    const pulled = await getSupplierById('legacy-client');
    assert.equal(pulled?.priority, 'MAYBE');
    assert.equal(pulled?.skip_reason, '');
  } finally {
    server.close();
  }
});
