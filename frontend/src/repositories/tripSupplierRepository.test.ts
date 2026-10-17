import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from '../db/connection.ts';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import { createSupplier, softDeleteSupplier } from './supplierRepository.ts';
import {
  addSupplierToTrip,
  countShortlistedByTrip,
  getTripSupplierById,
  listTripSuppliers,
  removeSupplierFromTrip,
  softDeleteTripSupplier
} from './tripSupplierRepository.ts';
import { listPendingOps } from '../sync/pendingOps.ts';

test('trip shortlist add, remove (soft delete), and no duplicates', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Shortlist Trip' });
  const otherTrip = await createTrip({ name: 'Other Trip' });
  const a = await createSupplier({ name: 'Shortlist A' });
  const b = await createSupplier({ name: 'Shortlist B' });

  const added = await addSupplierToTrip(tripId, a);
  assert.equal(added.trip_id, tripId);
  assert.equal(added.supplier_id, a);
  assert.equal(added.deleted, 0);
  assert.equal(added.synced, 0);
  assert.ok(added.updated_at);
  assert.ok(listPendingOps().some((op) => op.table_name === 'trip_suppliers' && op.row_id === added.id));

  // Adding the same pair again reuses the row.
  const again = await addSupplierToTrip(tripId, a);
  assert.equal(again.id, added.id);
  await addSupplierToTrip(tripId, b);
  await addSupplierToTrip(otherTrip, a);
  const count = (getDatabase().prepare('SELECT COUNT(*) AS n FROM trip_suppliers WHERE trip_id = ?').get(tripId) as { n: number }).n;
  assert.equal(count, 2);
  assert.deepEqual((await listTripSuppliers(tripId)).map((r) => r.supplier_id), [a, b]);
  assert.deepEqual(await countShortlistedByTrip(), { [tripId]: 2, [otherTrip]: 1 });

  // Remove soft-deletes; re-adding revives the same row instead of inserting a new one.
  assert.deepEqual(await removeSupplierFromTrip(tripId, a), { removed: 1 });
  const removed = await getTripSupplierById(added.id);
  assert.equal(removed?.deleted, 1);
  assert.equal(removed?.synced, 0);
  assert.deepEqual((await listTripSuppliers(tripId)).map((r) => r.supplier_id), [b]);
  assert.deepEqual(await removeSupplierFromTrip(tripId, a), { removed: 0 });

  const revived = await addSupplierToTrip(tripId, a);
  assert.equal(revived.id, added.id);
  assert.equal(revived.deleted, 0);
  assert.equal(
    (getDatabase().prepare('SELECT COUNT(*) AS n FROM trip_suppliers WHERE trip_id = ?').get(tripId) as { n: number }).n,
    2
  );

  // Delete by row id too.
  const deleted = await softDeleteTripSupplier(revived.id);
  assert.equal(deleted.deleted, 1);
  await assert.rejects(softDeleteTripSupplier('no-such-id'), /not found/);

  // Deleted suppliers drop off the shortlist and its count.
  await softDeleteSupplier(b);
  assert.deepEqual(await listTripSuppliers(tripId), []);
  assert.equal((await countShortlistedByTrip())[tripId], undefined);
});

test('addSupplierToTrip validates its inputs', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Validation Trip' });
  const supplierId = await createSupplier({ name: 'Validation Supplier' });
  await assert.rejects(addSupplierToTrip('', supplierId), /required/);
  await assert.rejects(addSupplierToTrip(tripId, 'missing'), /Supplier not found/);
  await assert.rejects(addSupplierToTrip('missing', supplierId), /Trip not found/);
});

test('listTripSuppliers collapses duplicate rows that arrived from two devices', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Dupes Trip' });
  const supplierId = await createSupplier({ name: 'Dupes Supplier' });
  const db = getDatabase();
  // Two offline devices each shortlisted the same supplier; both rows synced in.
  for (const id of ['dev-1', 'dev-2']) {
    db.prepare(`INSERT INTO trip_suppliers (id, trip_id, supplier_id, updated_at, deleted, synced) VALUES (?, ?, ?, ?, 0, 1)`)
      .run(id, tripId, supplierId, new Date().toISOString());
  }
  assert.equal((await listTripSuppliers(tripId)).length, 1);
  assert.equal((await countShortlistedByTrip())[tripId], 1);
  // Adding reuses one of them; removing clears both.
  assert.ok(['dev-1', 'dev-2'].includes((await addSupplierToTrip(tripId, supplierId)).id));
  assert.deepEqual(await removeSupplierFromTrip(tripId, supplierId), { removed: 2 });
  assert.deepEqual(await listTripSuppliers(tripId), []);
});
