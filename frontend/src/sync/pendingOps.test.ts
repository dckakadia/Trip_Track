import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip, softDeleteTrip, updateTrip } from '../repositories/tripRepository.ts';
import { createSupplier } from '../repositories/supplierRepository.ts';
import { countPendingOps, listPendingOps } from './pendingOps.ts';

test('repository writes queue coalesced pending ops', async () => {
  initializeDatabase();

  const tripId = await createTrip({ name: 'Queued Trip', notes: 'first' });
  assert.equal(countPendingOps(), 1);

  const afterCreate = listPendingOps();
  assert.equal(afterCreate[0]?.table_name, 'trips');
  assert.equal(afterCreate[0]?.row_id, tripId);
  assert.equal(afterCreate[0]?.op, 'upsert');

  // An update to the same row coalesces into the existing op with the latest payload.
  await updateTrip(tripId, { notes: 'second' });
  assert.equal(countPendingOps(), 1);
  const afterUpdate = listPendingOps();
  assert.equal(afterUpdate[0]?.id, afterCreate[0]?.id);
  assert.equal(JSON.parse(afterUpdate[0]!.payload).notes, 'second');

  // A soft delete also folds into the same op, payload carrying deleted = 1.
  await softDeleteTrip(tripId);
  assert.equal(countPendingOps(), 1);
  assert.equal(JSON.parse(listPendingOps()[0]!.payload).deleted, 1);

  // A different row gets its own op, queued after the first.
  const supplierId = await createSupplier({ name: 'Queued Supplier' });
  const ops = listPendingOps();
  assert.equal(ops.length, 2);
  assert.deepEqual(
    ops.map((o) => o.row_id),
    [tripId, supplierId]
  );
});
