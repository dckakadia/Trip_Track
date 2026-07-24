import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import { createCity, getCityById, listCitiesByTrip, softDeleteCity, updateCity } from './cityRepository.ts';

test('city repository CRUD with sort ordering and sync flags', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Trip with cities' });

  const guangzhouId = await createCity({
    trip_id: tripId,
    name: 'Guangzhou',
    name_cn: '广州',
    arrive_date: '2026-08-01',
    depart_date: '2026-08-04',
    hotel_name: 'Garden Hotel',
    sort_order: 2
  });
  const shenzhenId = await createCity({
    trip_id: tripId,
    name: 'Shenzhen',
    name_cn: '深圳',
    arrive_date: '2026-07-28',
    depart_date: '2026-08-01',
    sort_order: 1
  });

  const created = await getCityById(guangzhouId);
  assert.ok(created);
  assert.equal(created?.name_cn, '广州');
  assert.equal(created?.synced, 0);
  assert.ok(created?.updated_at);

  const cities = await listCitiesByTrip(tripId);
  assert.deepEqual(
    cities.map((c) => c.id),
    [shenzhenId, guangzhouId]
  );

  const updated = await updateCity(guangzhouId, { hotel_name: 'White Swan Hotel' });
  assert.equal(updated.hotel_name, 'White Swan Hotel');
  assert.equal(updated.synced, 0);

  const deleted = await softDeleteCity(shenzhenId);
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.synced, 0);

  const remaining = await listCitiesByTrip(tripId);
  assert.deepEqual(
    remaining.map((c) => c.id),
    [guangzhouId]
  );
});

test('createCity requires trip_id and name', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Validation Trip' });
  await assert.rejects(createCity({ trip_id: tripId, name: '' }), /trip_id and name are required/);
  await assert.rejects(createCity({ trip_id: '', name: 'No Trip' }), /trip_id and name are required/);
});
