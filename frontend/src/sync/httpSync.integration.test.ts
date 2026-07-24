import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip, getTripById } from '../repositories/tripRepository.ts';
import { createSupplier } from '../repositories/supplierRepository.ts';
import { createVisit } from '../repositories/visitRepository.ts';
import { createPhoto, getPhotoById } from '../repositories/photoRepository.ts';
import { countPendingOps } from './pendingOps.ts';
import { runSync } from './syncEngine.ts';
import { createHttpSyncTransport } from './httpSyncTransport.ts';
import { createHttpPhotoUploadTransport, uploadPendingPhotos } from './photoUploader.ts';
import { startSyncServer } from '../../../backend/src/server.ts';
import { getServerDatabase } from '../../../backend/src/db.ts';

const scratchDir = mkdtempSync(join(tmpdir(), 'triptrack-integration-'));
process.env.TRIPTRACK_UPLOAD_DIR = join(scratchDir, 'uploads');

test('frontend syncs against the real HTTP server end to end', async () => {
  initializeDatabase();
  const { server, port } = await startSyncServer(0);
  const base = `http://localhost:${port}`;
  const transport = createHttpSyncTransport(base);

  try {
    // Local offline edits.
    const tripId = await createTrip({ name: 'HTTP Sync Trip' });
    const supplierId = await createSupplier({ name: 'HTTP Supplier' });
    const visitId = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-09-01' });

    const photoPath = join(scratchDir, 'sample-photo.jpg');
    writeFileSync(photoPath, Buffer.from('jpeg-data-for-upload'));
    const photoId = await createPhoto({ parent_type: 'visit', parent_id: visitId, local_path: photoPath });

    assert.equal(countPendingOps(), 4);

    // First sync pushes everything; the pull echoes rows the client already has, all skipped.
    const first = await runSync(transport);
    assert.deepEqual(first.push, { pushed: 4, remaining: 0, error: null });
    assert.equal(first.pull.applied, 0);
    assert.equal(countPendingOps(), 0);
    assert.equal((await getTripById(tripId))?.synced, 1);

    const serverTrip = getServerDatabase().prepare('SELECT name FROM trips WHERE id = ?').get(tripId) as
      | { name: string }
      | undefined;
    assert.equal(serverTrip?.name, 'HTTP Sync Trip');

    // A row arriving on the server from elsewhere is picked up on the next sync.
    const remoteTripId = randomUUID();
    const future = new Date(Date.now() + 1000).toISOString();
    getServerDatabase()
      .prepare(
        `INSERT INTO trips (id, name, start_date, end_date, notes, updated_at, deleted, synced, server_updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?, 0, 1, ?)`
      )
      .run(remoteTripId, 'Trip From Another Device', 'planned remotely', future, future);

    const second = await runSync(transport);
    assert.equal(second.pull.applied, 1);
    const pulled = await getTripById(remoteTripId);
    assert.equal(pulled?.name, 'Trip From Another Device');
    assert.equal(pulled?.synced, 1);

    // Photo bytes upload over HTTP; metadata change re-queues and syncs.
    const uploadResult = await uploadPendingPhotos(createHttpPhotoUploadTransport(base));
    assert.deepEqual(uploadResult, { uploaded: 1, failed: 0, errors: [] });

    const photo = await getPhotoById(photoId);
    assert.equal(photo?.uploaded, 1);
    assert.equal(photo?.server_url, `/uploads/${photoId}-sample-photo.jpg`);

    const served = await fetch(`${base}${photo?.server_url}`);
    assert.equal(served.status, 200);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), 'jpeg-data-for-upload');

    assert.equal(countPendingOps(), 1);
    const third = await runSync(transport);
    assert.deepEqual(third.push, { pushed: 1, remaining: 0, error: null });
    assert.equal(countPendingOps(), 0);
  } finally {
    server.close();
  }
});
