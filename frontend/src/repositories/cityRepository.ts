import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { CityRecord } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export interface CreateCityInput {
  trip_id: string;
  name: string;
  name_cn?: string | null;
  arrive_date?: string | null;
  depart_date?: string | null;
  hotel_name?: string | null;
  hotel_address_cn?: string | null;
  sort_order?: number | null;
}

export async function createCity(input: CreateCityInput): Promise<string> {
  try {
    if (!input.trip_id || !input.name) {
      throw new Error('trip_id and name are required');
    }
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO cities (id, trip_id, name, name_cn, arrive_date, depart_date, hotel_name, hotel_address_cn, sort_order, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(
      id,
      input.trip_id,
      input.name,
      input.name_cn ?? null,
      input.arrive_date ?? null,
      input.depart_date ?? null,
      input.hotel_name ?? null,
      input.hotel_address_cn ?? null,
      input.sort_order ?? null,
      nowIso()
    );
    queueRowUpsert('cities', id);
    return id;
  } catch (error) {
    handleDbError('create city', error);
  }
}

export async function getCityById(id: string): Promise<CityRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM cities WHERE id = ?').get(id) as CityRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read city', error);
  }
}

export async function listCitiesByTrip(tripId: string): Promise<CityRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM cities WHERE trip_id = ? AND deleted = 0 ORDER BY sort_order, arrive_date, name')
      .all(tripId) as CityRecord[];
  } catch (error) {
    handleDbError('list cities', error);
  }
}

export async function updateCity(
  id: string,
  updates: Partial<Omit<CityRecord, 'id' | 'updated_at' | 'deleted' | 'synced'>>
): Promise<CityRecord> {
  try {
    const db = getDatabase();
    const existing = await getCityById(id);
    if (!existing) {
      throw new Error('City not found');
    }

    const { setSql, values } = buildUpdateClause('cities', updates);
    db.prepare(`UPDATE cities SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getCityById(id);
    if (!updated) {
      throw new Error('City not found after update');
    }
    queueRowUpsert('cities', id);
    return updated;
  } catch (error) {
    handleDbError('update city', error);
  }
}

export async function softDeleteCity(id: string): Promise<CityRecord> {
  try {
    const db = getDatabase();
    db.prepare('UPDATE cities SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getCityById(id);
    if (!updated) {
      throw new Error('City not found after delete');
    }
    queueRowUpsert('cities', id);
    return updated;
  } catch (error) {
    handleDbError('delete city', error);
  }
}
