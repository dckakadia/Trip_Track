import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import { createSupplier } from './supplierRepository.ts';
import { createVisit } from './visitRepository.ts';
import {
  createSample,
  getSampleById,
  listFollowUpSamples,
  listSamplesByVisit,
  softDeleteSample,
  updateSample
} from './sampleRepository.ts';

test('sample repository CRUD, defaults, and follow-up listing', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Trip with samples' });
  const supplierId = await createSupplier({ name: 'Sample Source Ltd' });
  const visitId = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-08-05' });

  const sampleId = await createSample({
    visit_id: visitId,
    sample_no: 'S-001',
    description: 'Cotton tote bag',
    qty: 3,
    unit_price: 1.85,
    moq: 500,
    lead_time_days: 30
  });
  const followUpId = await createSample({
    visit_id: visitId,
    sample_no: 'S-002',
    description: 'Canvas backpack',
    follow_up_required: 1
  });

  const created = await getSampleById(sampleId);
  assert.ok(created);
  assert.equal(created?.currency, 'USD');
  assert.equal(created?.collected, 0);
  assert.equal(created?.follow_up_required, 0);
  assert.equal(created?.synced, 0);
  assert.ok(created?.updated_at);

  const byVisit = await listSamplesByVisit(visitId);
  assert.deepEqual(
    byVisit.map((s) => s.id),
    [sampleId, followUpId]
  );

  const followUps = await listFollowUpSamples();
  assert.deepEqual(
    followUps.map((s) => s.id),
    [followUpId]
  );

  const updated = await updateSample(sampleId, { collected: 1, notes: 'Picked up at factory' });
  assert.equal(updated.collected, 1);
  assert.equal(updated.synced, 0);

  const deleted = await softDeleteSample(followUpId);
  assert.equal(deleted.deleted, 1);

  const remaining = await listSamplesByVisit(visitId);
  assert.deepEqual(
    remaining.map((s) => s.id),
    [sampleId]
  );
});

test('createSample requires a visit_id', async () => {
  initializeDatabase();
  await assert.rejects(createSample({ visit_id: '' }), /visit_id is required/);
});
