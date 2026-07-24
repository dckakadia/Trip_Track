import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { PhotoParentType, PhotoRecord } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export interface CreatePhotoInput {
  parent_type: PhotoParentType;
  parent_id: string;
  local_path: string;
  caption?: string | null;
  tag?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  taken_at?: string | null;
}

export async function createPhoto(input: CreatePhotoInput): Promise<string> {
  try {
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO photos (id, parent_type, parent_id, local_path, server_url, caption, tag, gps_lat, gps_lng, taken_at, uploaded, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, 0, 0)`
    ).run(
      id,
      input.parent_type,
      input.parent_id,
      input.local_path,
      input.caption ?? null,
      input.tag ?? null,
      input.gps_lat ?? null,
      input.gps_lng ?? null,
      input.taken_at ?? null,
      nowIso()
    );
    queueRowUpsert('photos', id);
    return id;
  } catch (error) {
    handleDbError('create photo', error);
  }
}

export async function getPhotoById(id: string): Promise<PhotoRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read photo', error);
  }
}

export async function listPhotosByParent(parentType: PhotoParentType, parentId: string): Promise<PhotoRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM photos WHERE parent_type = ? AND parent_id = ? AND deleted = 0 ORDER BY taken_at, updated_at')
      .all(parentType, parentId) as PhotoRecord[];
  } catch (error) {
    handleDbError('list photos', error);
  }
}

export async function listPendingUploads(): Promise<PhotoRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM photos WHERE uploaded = 0 AND deleted = 0 ORDER BY taken_at, updated_at')
      .all() as PhotoRecord[];
  } catch (error) {
    handleDbError('list pending uploads', error);
  }
}

export async function updatePhoto(
  id: string,
  updates: Partial<Omit<PhotoRecord, 'id' | 'updated_at' | 'deleted' | 'synced' | 'uploaded' | 'server_url'>>
): Promise<PhotoRecord> {
  try {
    const db = getDatabase();
    const existing = await getPhotoById(id);
    if (!existing) {
      throw new Error('Photo not found');
    }

    const { setSql, values } = buildUpdateClause(updates);
    db.prepare(`UPDATE photos SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getPhotoById(id);
    if (!updated) {
      throw new Error('Photo not found after update');
    }
    queueRowUpsert('photos', id);
    return updated;
  } catch (error) {
    handleDbError('update photo', error);
  }
}

export async function markPhotoUploaded(id: string, serverUrl: string): Promise<PhotoRecord> {
  try {
    const db = getDatabase();
    const existing = await getPhotoById(id);
    if (!existing) {
      throw new Error('Photo not found');
    }

    db.prepare('UPDATE photos SET uploaded = 1, server_url = ?, updated_at = ?, synced = 0 WHERE id = ?').run(
      serverUrl,
      nowIso(),
      id
    );
    const updated = await getPhotoById(id);
    if (!updated) {
      throw new Error('Photo not found after upload');
    }
    queueRowUpsert('photos', id);
    return updated;
  } catch (error) {
    handleDbError('mark photo uploaded', error);
  }
}

export async function softDeletePhoto(id: string): Promise<PhotoRecord> {
  try {
    const db = getDatabase();
    db.prepare('UPDATE photos SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getPhotoById(id);
    if (!updated) {
      throw new Error('Photo not found after delete');
    }
    queueRowUpsert('photos', id);
    return updated;
  } catch (error) {
    handleDbError('delete photo', error);
  }
}
