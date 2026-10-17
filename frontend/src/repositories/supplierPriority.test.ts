import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import {
  createSupplier,
  getSupplierById,
  getSupplierWithVisitStatus,
  listSuppliers,
  updateSupplier
} from './supplierRepository.ts';
import { createVisit, setVisitStatus, softDeleteVisit } from './visitRepository.ts';
import { addSupplierToTrip } from './tripSupplierRepository.ts';
import { listPendingOps } from '../sync/pendingOps.ts';

test('supplier priority defaults to MAYBE, accepts MUST/MAYBE/SKIP, and rejects anything else', async () => {
  initializeDatabase();
  const id = await createSupplier({ name: 'Priority Supplier' });
  const created = await getSupplierById(id);
  assert.equal(created?.priority, 'MAYBE');
  assert.equal(created?.skip_reason, '');

  for (const priority of ['MUST', 'SKIP', 'MAYBE'] as const) {
    const updated = await updateSupplier(id, { priority });
    assert.equal(updated.priority, priority);
    assert.equal(updated.synced, 0);
  }

  const skipped = await updateSupplier(id, { priority: 'SKIP', skip_reason: 'MOQ too high' });
  assert.equal(skipped.skip_reason, 'MOQ too high');
  // The queued op carries the new fields so they reach the sync server.
  const payload = JSON.parse(listPendingOps().find((op) => op.row_id === id)!.payload);
  assert.equal(payload.priority, 'SKIP');
  assert.equal(payload.skip_reason, 'MOQ too high');

  // Clearing the note stores an empty string, matching the column default.
  assert.equal((await updateSupplier(id, { skip_reason: null as never })).skip_reason, '');

  await assert.rejects(updateSupplier(id, { priority: 'URGENT' as never }), /Invalid priority/);
  await assert.rejects(updateSupplier(id, { priority: null as never }), /Invalid priority/);
  await assert.rejects(createSupplier({ name: 'Bad', priority: 'must' as never }), /Invalid priority/);
  assert.equal((await getSupplierById(id))?.priority, 'SKIP');

  const must = await createSupplier({ name: 'Created as Must', priority: 'MUST' });
  assert.equal((await getSupplierById(must))?.priority, 'MUST');
});

test('only a non-deleted DONE visit marks a supplier visited', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Visited Logic Trip' });
  const supplierId = await createSupplier({ name: 'Visited Logic Supplier' });
  const status = async () => {
    const row = await getSupplierWithVisitStatus(supplierId);
    return { visited: row?.visited, last_visit_date: row?.last_visit_date };
  };

  assert.deepEqual(await status(), { visited: false, last_visit_date: null });

  const visitId = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-10-01' });
  assert.deepEqual(await status(), { visited: false, last_visit_date: null }); // PLANNED
  await setVisitStatus(visitId, 'CONFIRMED');
  assert.deepEqual(await status(), { visited: false, last_visit_date: null });
  await setVisitStatus(visitId, 'CANCELLED');
  assert.deepEqual(await status(), { visited: false, last_visit_date: null });

  await setVisitStatus(visitId, 'DONE');
  assert.deepEqual(await status(), { visited: true, last_visit_date: '2026-10-01' });

  // A later DONE visit moves last_visit_date forward; a later PLANNED one doesn't.
  const second = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-10-05' });
  await setVisitStatus(second, 'DONE');
  await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-10-09' });
  assert.deepEqual(await status(), { visited: true, last_visit_date: '2026-10-05' });

  // Soft-deleted DONE visits don't count.
  await softDeleteVisit(second);
  assert.deepEqual(await status(), { visited: true, last_visit_date: '2026-10-01' });
  await softDeleteVisit(visitId);
  assert.deepEqual(await status(), { visited: false, last_visit_date: null });

  const listed = (await listSuppliers()).find((s) => s.id === supplierId);
  assert.equal(listed?.visited, false);
  assert.equal(listed?.last_visit_date, null);
});

test('listSuppliers filters by priority, skipped, visited, and trip shortlist', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Filter Trip' });
  const must = await createSupplier({ name: 'F Must', priority: 'MUST' });
  const maybe = await createSupplier({ name: 'F Maybe' });
  const skip = await createSupplier({ name: 'F Skip', priority: 'SKIP' });
  const visited = await createSupplier({ name: 'F Visited', priority: 'MUST' });
  const visit = await createVisit({ trip_id: tripId, supplier_id: visited, visit_date: '2026-10-02' });
  await setVisitStatus(visit, 'DONE');
  await addSupplierToTrip(tripId, must);
  await addSupplierToTrip(tripId, skip);

  const names = async (filters: Parameters<typeof listSuppliers>[0]) =>
    (await listSuppliers(filters)).filter((s) => s.name.startsWith('F ')).map((s) => s.id).sort();

  assert.deepEqual(await names({}), [must, maybe, skip, visited].sort());
  assert.deepEqual(await names({ hide_skipped: true, hide_visited: true }), [must, maybe].sort());
  assert.deepEqual(await names({ hide_visited: true }), [must, maybe, skip].sort());
  assert.deepEqual(await names({ priorities: ['MUST'], hide_skipped: true }), [must, visited].sort());
  assert.deepEqual(await names({ shortlist_trip_id: tripId }), [must, skip].sort());
  assert.deepEqual(await names({ shortlist_trip_id: tripId, hide_skipped: true }), [must]);
  assert.deepEqual(await names({ priorities: [], hide_skipped: true }), []);
});
