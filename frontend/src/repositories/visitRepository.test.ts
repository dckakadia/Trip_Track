import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import { createSupplier } from './supplierRepository.ts';
import {
  createVisit,
  getVisitById,
  listVisitsByDate,
  listVisitsByTrip,
  setVisitStatus,
  softDeleteVisit,
  updateVisit
} from './visitRepository.ts';

test('visit repository CRUD, day schedule ordering, and status transitions', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Trip with visits' });
  const supplierId = await createSupplier({ name: 'Visit Target Co' });

  const afternoonId = await createVisit({
    trip_id: tripId,
    supplier_id: supplierId,
    visit_date: '2026-08-02',
    scheduled_time: '14:00',
    purpose: 'Factory audit'
  });
  const morningId = await createVisit({
    trip_id: tripId,
    supplier_id: supplierId,
    visit_date: '2026-08-02',
    scheduled_time: '09:30'
  });
  const nextDayId = await createVisit({
    trip_id: tripId,
    supplier_id: supplierId,
    visit_date: '2026-08-03'
  });

  const created = await getVisitById(afternoonId);
  assert.ok(created);
  assert.equal(created?.status, 'PLANNED');
  assert.equal(created?.confirmed_at, null);
  assert.equal(created?.synced, 0);

  const byTrip = await listVisitsByTrip(tripId);
  assert.deepEqual(
    byTrip.map((v) => v.id),
    [morningId, afternoonId, nextDayId]
  );

  const daySchedule = await listVisitsByDate(tripId, '2026-08-02');
  assert.deepEqual(
    daySchedule.map((v) => v.id),
    [morningId, afternoonId]
  );

  const confirmed = await setVisitStatus(afternoonId, 'CONFIRMED');
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.ok(confirmed.confirmed_at);
  assert.equal(confirmed.synced, 0);

  const done = await setVisitStatus(afternoonId, 'DONE');
  assert.equal(done.status, 'DONE');
  assert.equal(done.confirmed_at, confirmed.confirmed_at);

  const updated = await updateVisit(afternoonId, { outcome_notes: 'Good quality, request samples', next_action: 'Send PO draft' });
  assert.equal(updated.outcome_notes, 'Good quality, request samples');
  assert.equal(updated.synced, 0);

  const deleted = await softDeleteVisit(nextDayId);
  assert.equal(deleted.deleted, 1);

  const remaining = await listVisitsByTrip(tripId);
  assert.deepEqual(
    remaining.map((v) => v.id),
    [morningId, afternoonId]
  );
});

test('createVisit requires trip_id, supplier_id, and visit_date', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Validation Trip' });
  const supplierId = await createSupplier({ name: 'Validation Supplier' });
  await assert.rejects(
    createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '' }),
    /trip_id, supplier_id, and visit_date are required/
  );
  await assert.rejects(
    createVisit({ trip_id: '', supplier_id: supplierId, visit_date: '2026-08-10' }),
    /trip_id, supplier_id, and visit_date are required/
  );
});
