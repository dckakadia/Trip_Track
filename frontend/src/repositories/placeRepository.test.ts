import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createPlace, getPlaceById, listPlaces, softDeletePlace, updatePlace } from './placeRepository.ts';

test('place repository CRUD with sync flags', async () => {
  initializeDatabase();

  const airportId = await createPlace({
    name: 'Guangzhou Baiyun Airport',
    type: 'airport',
    address: 'Huadu District, Guangzhou',
    gps_lat: 23.392437,
    gps_lng: 113.298786
  });
  const hotelId = await createPlace({ name: 'Canton Hotel', type: 'hotel' });

  const created = await getPlaceById(airportId);
  assert.ok(created);
  assert.equal(created?.type, 'airport');
  assert.equal(created?.gps_lat, 23.392437);
  assert.equal(created?.synced, 0);
  assert.ok(created?.updated_at);

  const all = await listPlaces();
  assert.equal(all.length, 2);

  const updated = await updatePlace(airportId, { notes: 'Terminal 2 is closer to downtown' });
  assert.equal(updated.notes, 'Terminal 2 is closer to downtown');
  assert.equal(updated.synced, 0);

  const deleted = await softDeletePlace(hotelId);
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.synced, 0);

  const remaining = await listPlaces();
  assert.deepEqual(
    remaining.map((p) => p.id),
    [airportId]
  );
});

test('createPlace requires a name and type', async () => {
  initializeDatabase();
  await assert.rejects(createPlace({ name: '', type: 'hotel' }), /Name is required/);
  await assert.rejects(createPlace({ name: 'Some Station', type: '' as never }), /Type is required/);
});
