import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase } from '../db/connection.ts';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from '../repositories/tripRepository.ts';
import { createSupplier, getSupplierById, listSuppliers } from '../repositories/supplierRepository.ts';
import { addSupplierToTrip, getTripSupplierById, listTripSuppliers, removeSupplierFromTrip } from '../repositories/tripSupplierRepository.ts';
import { exportData, importData } from './dataTransfer.ts';

test('export/import round-trips priority, skip_reason, and trip_suppliers (deleted rows included)', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Round Trip' });
  const must = await createSupplier({ name: 'RT Must', priority: 'MUST' });
  const skip = await createSupplier({ name: 'RT Skip', priority: 'SKIP', skip_reason: 'Too far from Ningbo' });
  const kept = await addSupplierToTrip(tripId, must);
  const dropped = await addSupplierToTrip(tripId, skip);
  await removeSupplierFromTrip(tripId, skip);

  const dump = exportData();
  assert.equal(dump.tables.trip_suppliers?.length, 2);

  closeDatabase();
  initializeDatabase();
  assert.deepEqual(await listSuppliers(), []);

  const result = importData(JSON.parse(JSON.stringify(dump)));
  assert.equal(result.tables.trip_suppliers?.applied, 2);

  assert.equal((await getSupplierById(must))?.priority, 'MUST');
  const skipped = await getSupplierById(skip);
  assert.equal(skipped?.priority, 'SKIP');
  assert.equal(skipped?.skip_reason, 'Too far from Ningbo');
  assert.deepEqual((await listTripSuppliers(tripId)).map((r) => r.id), [kept.id]);
  assert.equal((await getTripSupplierById(dropped.id))?.deleted, 1);

  assert.equal(importData(dump).applied, 0);
});
