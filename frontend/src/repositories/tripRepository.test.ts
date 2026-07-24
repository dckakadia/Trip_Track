import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip, getTripById, softDeleteTrip, updateTrip } from './tripRepository.ts';

test('trip repository sets updated_at and synced flags correctly', async () => {
  initializeDatabase();

  const tripId = await createTrip({
    name: 'India Sourcing Trip',
    start_date: '2026-07-20',
    end_date: '2026-07-31',
    notes: 'Initial demo trip'
  });

  const created = await getTripById(tripId);
  assert.ok(created);
  assert.equal(created?.name, 'India Sourcing Trip');
  assert.equal(created?.synced, 0);
  assert.ok(created?.updated_at);

  const updated = await updateTrip(tripId, { notes: 'Updated notes' });
  assert.equal(updated.notes, 'Updated notes');
  assert.equal(updated.synced, 0);
  assert.notEqual(updated.updated_at, created?.updated_at);

  const deleted = await softDeleteTrip(tripId);
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.synced, 0);
});

test('updateTrip rejects an unrecognized/malicious column key instead of interpolating it into SQL', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Injection Target' });

  // TypeScript's Partial<Pick<...>> only allows real columns; a JSON request body has no such
  // guarantee at runtime, so simulate an attacker-controlled PATCH body with `as any`.
  await assert.rejects(
    updateTrip(tripId, { "name = 'x'; DROP TABLE trips; --": 'malicious' } as any),
    /unknown column/
  );

  const stillThere = await getTripById(tripId);
  assert.equal(stillThere?.name, 'Injection Target');
});

test('createTrip requires a name', async () => {
  initializeDatabase();
  await assert.rejects(createTrip({ name: '' }), /Name is required/);
  await assert.rejects(createTrip({} as any), /Name is required/);
});
