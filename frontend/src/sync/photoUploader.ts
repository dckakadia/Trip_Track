import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PhotoRecord } from '../db/schema.ts';
import { listPendingUploads, markPhotoUploaded } from '../repositories/photoRepository.ts';

export interface PhotoUploadTransport {
  uploadPhoto(photo: PhotoRecord): Promise<{ url: string }>;
}

export function createHttpPhotoUploadTransport(baseUrl: string): PhotoUploadTransport {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async uploadPhoto(photo: PhotoRecord): Promise<{ url: string }> {
      if (!photo.local_path) {
        throw new Error(`Photo has no local file: ${photo.id}`);
      }
      const bytes = await readFile(photo.local_path);
      const res = await fetch(`${base}/api/photos/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          photo_id: photo.id,
          filename: basename(photo.local_path),
          data_base64: bytes.toString('base64')
        })
      });
      if (!res.ok) {
        throw new Error(`Photo upload failed: HTTP ${res.status}`);
      }
      return (await res.json()) as { url: string };
    }
  };
}

export interface UploadResult {
  uploaded: number;
  failed: number;
  errors: string[];
}

export async function uploadPendingPhotos(transport: PhotoUploadTransport): Promise<UploadResult> {
  const pending = await listPendingUploads();
  const result: UploadResult = { uploaded: 0, failed: 0, errors: [] };
  for (const photo of pending) {
    try {
      const { url } = await transport.uploadPhoto(photo);
      await markPhotoUploaded(photo.id, url);
      result.uploaded += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}
