import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip } from '../repositories/tripRepository.ts';
import { createSupplier } from '../repositories/supplierRepository.ts';
import { createVisit } from '../repositories/visitRepository.ts';
import { createPhoto, getPhotoById, listPendingUploads } from '../repositories/photoRepository.ts';
import { uploadPendingPhotos, type PhotoUploadTransport } from './photoUploader.ts';

async function makePhoto(): Promise<string> {
  const tripId = await createTrip({ name: 'Photo Upload Trip' });
  const supplierId = await createSupplier({ name: 'Upload Test Supplier' });
  const visitId = await createVisit({ trip_id: tripId, supplier_id: supplierId, visit_date: '2026-08-10' });
  const dir = mkdtempSync(join(tmpdir(), 'triptrack-photo-'));
  const localPath = join(dir, 'photo.jpg');
  writeFileSync(localPath, 'fake-bytes');
  return createPhoto({ parent_type: 'visit', parent_id: visitId, local_path: localPath });
}

test('a failed upload is left pending for retry and is not marked uploaded', async () => {
  initializeDatabase();
  const photoId = await makePhoto();

  let calls = 0;
  const flakyTransport: PhotoUploadTransport = {
    async uploadPhoto() {
      calls += 1;
      throw new Error('network unreachable');
    }
  };

  const firstAttempt = await uploadPendingPhotos(flakyTransport);
  assert.equal(firstAttempt.uploaded, 0);
  assert.equal(firstAttempt.failed, 1);
  assert.match(firstAttempt.errors[0] ?? '', /network unreachable/);

  const afterFailure = await getPhotoById(photoId);
  assert.equal(afterFailure?.uploaded, 0);
  assert.equal(afterFailure?.server_url, null);

  // Still queued for retry — a second attempt tries again rather than skipping it.
  const pending = await listPendingUploads();
  assert.ok(pending.some((p) => p.id === photoId));

  // Retry succeeds.
  const workingTransport: PhotoUploadTransport = {
    async uploadPhoto(photo) {
      calls += 1;
      return { url: `https://cdn.example.com/${photo.id}.jpg` };
    }
  };
  const secondAttempt = await uploadPendingPhotos(workingTransport);
  assert.equal(secondAttempt.uploaded, 1);
  assert.equal(secondAttempt.failed, 0);
  assert.equal(calls, 2);

  const afterSuccess = await getPhotoById(photoId);
  assert.equal(afterSuccess?.uploaded, 1);
  assert.equal(afterSuccess?.server_url, `https://cdn.example.com/${photoId}.jpg`);
});

test('an already-uploaded photo is never re-uploaded on a later sync', async () => {
  initializeDatabase();
  const photoId = await makePhoto();

  let calls = 0;
  const transport: PhotoUploadTransport = {
    async uploadPhoto(photo) {
      calls += 1;
      return { url: `https://cdn.example.com/${photo.id}.jpg` };
    }
  };

  await uploadPendingPhotos(transport);
  assert.equal(calls, 1);

  // A second sync pass with pending uploads from elsewhere must not touch the already-uploaded photo.
  const result = await uploadPendingPhotos(transport);
  assert.equal(result.uploaded, 0);
  assert.equal(result.failed, 0);
  assert.equal(calls, 1);

  const photo = await getPhotoById(photoId);
  assert.equal(photo?.uploaded, 1);
});

test('one failure in a batch does not block or duplicate other uploads', async () => {
  initializeDatabase();
  const okId = await makePhoto();
  const badId = await makePhoto();

  const transport: PhotoUploadTransport = {
    async uploadPhoto(photo) {
      if (photo.id === badId) {
        throw new Error('disk full');
      }
      return { url: `https://cdn.example.com/${photo.id}.jpg` };
    }
  };

  const result = await uploadPendingPhotos(transport);
  assert.equal(result.uploaded, 1);
  assert.equal(result.failed, 1);

  const ok = await getPhotoById(okId);
  const bad = await getPhotoById(badId);
  assert.equal(ok?.uploaded, 1);
  assert.equal(bad?.uploaded, 0);
});
