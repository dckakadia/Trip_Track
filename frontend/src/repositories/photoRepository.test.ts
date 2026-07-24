import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from './tripRepository.ts';
import { createSupplier } from './supplierRepository.ts';
import { createVisit } from './visitRepository.ts';
import {
  createPhoto,
  getPhotoById,
  listPendingUploads,
  listPhotosByParent,
  markPhotoUploaded,
  softDeletePhoto,
  updatePhoto
} from './photoRepository.ts';
import { listPendingOps } from '../sync/pendingOps.ts';

test('photo repository CRUD, parent lookup, and upload tracking', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Trip with photos' });
  const supplierId = await createSupplier({ name: 'Photo Factory' });
  const visitId = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-08-10' });

  const earlyId = await createPhoto({
    parent_type: 'visit',
    parent_id: visitId,
    local_path: '/photos/factory-floor.jpg',
    caption: 'Factory floor',
    tag: 'production-line',
    gps_lat: 23.1291,
    gps_lng: 113.2644,
    taken_at: '2026-08-10T09:15:00.000Z'
  });
  const lateId = await createPhoto({
    parent_type: 'visit',
    parent_id: visitId,
    local_path: '/photos/warehouse.jpg',
    taken_at: '2026-08-10T11:40:00.000Z'
  });
  const supplierPhotoId = await createPhoto({
    parent_type: 'supplier',
    parent_id: supplierId,
    local_path: '/photos/gate-sign.jpg'
  });

  const created = await getPhotoById(earlyId);
  assert.ok(created);
  assert.equal(created?.uploaded, 0);
  assert.equal(created?.server_url, null);
  assert.equal(created?.synced, 0);

  const visitPhotos = await listPhotosByParent('visit', visitId);
  assert.deepEqual(
    visitPhotos.map((p) => p.id),
    [earlyId, lateId]
  );

  const pendingBefore = await listPendingUploads();
  assert.equal(pendingBefore.length, 3);

  const uploaded = await markPhotoUploaded(earlyId, 'https://cdn.example.com/photos/factory-floor.jpg');
  assert.equal(uploaded.uploaded, 1);
  assert.equal(uploaded.server_url, 'https://cdn.example.com/photos/factory-floor.jpg');
  assert.equal(uploaded.synced, 0);

  const pendingAfter = await listPendingUploads();
  assert.deepEqual(
    pendingAfter.map((p) => p.id).sort(),
    [lateId, supplierPhotoId].sort()
  );

  const updated = await updatePhoto(lateId, { caption: 'Finished goods warehouse' });
  assert.equal(updated.caption, 'Finished goods warehouse');
  assert.equal(updated.synced, 0);

  const deleted = await softDeletePhoto(supplierPhotoId);
  assert.equal(deleted.deleted, 1);
  assert.deepEqual(await listPhotosByParent('supplier', supplierId), []);

  // Photo writes flow into the sync queue like every other table.
  const photoOps = listPendingOps().filter((op) => op.table_name === 'photos');
  assert.deepEqual(
    photoOps.map((op) => op.row_id).sort(),
    [earlyId, lateId, supplierPhotoId].sort()
  );
});

test('createPhoto requires parent_type, parent_id, and local_path', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Validation Trip' });
  const supplierId = await createSupplier({ name: 'Validation Supplier' });
  const visitId = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-08-10' });
  await assert.rejects(
    createPhoto({ parent_type: 'visit', parent_id: visitId, local_path: '' }),
    /parent_type, parent_id, and local_path are required/
  );
});
