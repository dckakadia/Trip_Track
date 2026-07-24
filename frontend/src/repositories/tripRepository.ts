import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { TripRecord } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export async function createTrip(input: { name: string; start_date?: string | null; end_date?: string | null; notes?: string | null }): Promise<string> {
  try {
    const db = getDatabase();
    const id = randomUUID();
    const updated_at = nowIso();
    db.prepare(
      `INSERT INTO trips (id, name, start_date, end_date, notes, updated_at, deleted, synced) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(id, input.name, input.start_date ?? null, input.end_date ?? null, input.notes ?? null, updated_at);
    queueRowUpsert('trips', id);
    return id;
  } catch (error) {
    handleDbError('create trip', error);
  }
}

export async function getTripById(id: string): Promise<TripRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM trips WHERE id = ?').get(id) as TripRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read trip', error);
  }
}

export async function listTrips(): Promise<TripRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM trips WHERE deleted = 0 ORDER BY start_date, name')
      .all() as TripRecord[];
  } catch (error) {
    handleDbError('list trips', error);
  }
}

export async function getActiveTripById(id: string): Promise<TripRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM trips WHERE id = ? AND deleted = 0').get(id) as TripRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read active trip', error);
  }
}

export async function updateTrip(id: string, updates: Partial<Pick<TripRecord, 'name' | 'start_date' | 'end_date' | 'notes'>>): Promise<TripRecord> {
  try {
    const db = getDatabase();
    const existing = await getTripById(id);
    if (!existing) {
      throw new Error('Trip not found');
    }

    const { setSql, values } = buildUpdateClause(updates);
    db.prepare(`UPDATE trips SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getTripById(id);
    if (!updated) {
      throw new Error('Trip not found after update');
    }
    queueRowUpsert('trips', id);
    return updated;
  } catch (error) {
    handleDbError('update trip', error);
  }
}

export async function softDeleteTrip(id: string): Promise<TripRecord> {
  try {
    const db = getDatabase();
    const updated_at = nowIso();
    db.prepare('UPDATE trips SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(updated_at, id);
    const updated = await getTripById(id);
    if (!updated) {
      throw new Error('Trip not found after delete');
    }
    queueRowUpsert('trips', id);
    return updated;
  } catch (error) {
    handleDbError('delete trip', error);
  }
}
