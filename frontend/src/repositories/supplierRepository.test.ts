import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import { createCity } from './cityRepository.ts';
import {
  createSupplier,
  getSupplierById,
  listSuppliers,
  listSuppliersByCity,
  softDeleteSupplier,
  updateSupplier
} from './supplierRepository.ts';

test('supplier repository CRUD with city lookup and sync flags', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Trip with suppliers' });
  const cityId = await createCity({ trip_id: tripId, name: 'Yiwu' });

  const supplierId = await createSupplier({
    name: 'Golden Dragon Textiles',
    name_cn: '金龙纺织',
    city_id: cityId,
    contact_name: 'Mr. Chen',
    wechat_id: 'chen_textiles',
    product_category: 'textiles',
    map_url: 'https://maps.app.goo.gl/example123'
  });
  const unassignedId = await createSupplier({ name: 'Acme Plastics' });

  const created = await getSupplierById(supplierId);
  assert.ok(created);
  assert.equal(created?.name_cn, '金龙纺织');
  assert.equal(created?.map_url, 'https://maps.app.goo.gl/example123');
  assert.equal(created?.synced, 0);
  assert.ok(created?.updated_at);

  const all = await listSuppliers();
  assert.equal(all.length, 2);

  const inCity = await listSuppliersByCity(cityId);
  assert.deepEqual(
    inCity.map((s) => s.id),
    [supplierId]
  );

  const updated = await updateSupplier(supplierId, {
    contact_mobile: '+86 138 0000 0000',
    map_url: 'https://maps.app.goo.gl/updated456'
  });
  assert.equal(updated.contact_mobile, '+86 138 0000 0000');
  assert.equal(updated.map_url, 'https://maps.app.goo.gl/updated456');
  assert.equal(updated.synced, 0);

  const deleted = await softDeleteSupplier(unassignedId);
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.synced, 0);

  const remaining = await listSuppliers();
  assert.deepEqual(
    remaining.map((s) => s.id),
    [supplierId]
  );
});

test('createSupplier requires a name', async () => {
  initializeDatabase();
  await assert.rejects(createSupplier({ name: '' }), /Name is required/);
});
