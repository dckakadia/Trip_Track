import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { PlaceRecord, PlaceType } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export interface CreatePlaceInput {
  name: string;
  type: PlaceType;
  address?: string | null;
  map_url?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  notes?: string | null;
}

export async function createPlace(input: CreatePlaceInput): Promise<string> {
  try {
    if (!input.name) {
      throw new Error('Name is required');
    }
    if (!input.type) {
      throw new Error('Type is required');
    }
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO places (id, name, type, address, map_url, gps_lat, gps_lng, notes, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(
      id,
      input.name,
      input.type,
      input.address ?? null,
      input.map_url ?? null,
      input.gps_lat ?? null,
      input.gps_lng ?? null,
      input.notes ?? null,
      nowIso()
    );
    queueRowUpsert('places', id);
    return id;
  } catch (error) {
    handleDbError('create place', error);
  }
}

export async function getPlaceById(id: string): Promise<PlaceRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM places WHERE id = ?').get(id) as PlaceRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read place', error);
  }
}

export async function listPlaces(): Promise<PlaceRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM places WHERE deleted = 0 ORDER BY name')
      .all() as PlaceRecord[];
  } catch (error) {
    handleDbError('list places', error);
  }
}

export async function updatePlace(
  id: string,
  updates: Partial<Omit<PlaceRecord, 'id' | 'updated_at' | 'deleted' | 'synced'>>
): Promise<PlaceRecord> {
  try {
    const db = getDatabase();
    const existing = await getPlaceById(id);
    if (!existing) {
      throw new Error('Place not found');
    }

    const { setSql, values } = buildUpdateClause('places', updates);
    db.prepare(`UPDATE places SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getPlaceById(id);
    if (!updated) {
      throw new Error('Place not found after update');
    }
    queueRowUpsert('places', id);
    return updated;
  } catch (error) {
    handleDbError('update place', error);
  }
}

export async function softDeletePlace(id: string): Promise<PlaceRecord> {
  try {
    const db = getDatabase();
    db.prepare('UPDATE places SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getPlaceById(id);
    if (!updated) {
      throw new Error('Place not found after delete');
    }
    queueRowUpsert('places', id);
    return updated;
  } catch (error) {
    handleDbError('delete place', error);
  }
}
