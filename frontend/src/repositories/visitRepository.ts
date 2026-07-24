import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { VisitRecord, VisitStatus } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export interface CreateVisitInput {
  trip_id: string;
  supplier_id: string;
  visit_date: string;
  slot?: string | null;
  scheduled_time?: string | null;
  purpose?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
}

const VALID_STATUSES: VisitStatus[] = ['PLANNED', 'CONFIRMED', 'DONE', 'CANCELLED'];

export async function createVisit(input: CreateVisitInput): Promise<string> {
  try {
    if (!input.trip_id || !input.supplier_id || !input.visit_date) {
      throw new Error('trip_id, supplier_id, and visit_date are required');
    }
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO visits (id, trip_id, supplier_id, visit_date, slot, scheduled_time, purpose, status, confirmed_at, outcome_notes, next_action, gps_lat, gps_lng, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', NULL, NULL, NULL, ?, ?, ?, 0, 0)`
    ).run(
      id,
      input.trip_id,
      input.supplier_id,
      input.visit_date,
      input.slot ?? null,
      input.scheduled_time ?? null,
      input.purpose ?? null,
      input.gps_lat ?? null,
      input.gps_lng ?? null,
      nowIso()
    );
    queueRowUpsert('visits', id);
    return id;
  } catch (error) {
    handleDbError('create visit', error);
  }
}

export async function getVisitById(id: string): Promise<VisitRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM visits WHERE id = ?').get(id) as VisitRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read visit', error);
  }
}

export async function listVisitsByTrip(tripId: string): Promise<VisitRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM visits WHERE trip_id = ? AND deleted = 0 ORDER BY visit_date, scheduled_time, slot')
      .all(tripId) as VisitRecord[];
  } catch (error) {
    handleDbError('list visits', error);
  }
}

export async function listVisitsByDate(tripId: string, visitDate: string): Promise<VisitRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM visits WHERE trip_id = ? AND visit_date = ? AND deleted = 0 ORDER BY scheduled_time, slot')
      .all(tripId, visitDate) as VisitRecord[];
  } catch (error) {
    handleDbError('list visits by date', error);
  }
}

export async function updateVisit(
  id: string,
  updates: Partial<Omit<VisitRecord, 'id' | 'updated_at' | 'deleted' | 'synced' | 'status' | 'confirmed_at'>>
): Promise<VisitRecord> {
  try {
    const db = getDatabase();
    const existing = await getVisitById(id);
    if (!existing) {
      throw new Error('Visit not found');
    }

    const { setSql, values } = buildUpdateClause('visits', updates);
    db.prepare(`UPDATE visits SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getVisitById(id);
    if (!updated) {
      throw new Error('Visit not found after update');
    }
    queueRowUpsert('visits', id);
    return updated;
  } catch (error) {
    handleDbError('update visit', error);
  }
}

export async function setVisitStatus(id: string, status: VisitStatus): Promise<VisitRecord> {
  try {
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid visit status: ${status}`);
    }
    const db = getDatabase();
    const existing = await getVisitById(id);
    if (!existing) {
      throw new Error('Visit not found');
    }

    const timestamp = nowIso();
    const confirmedAt = status === 'CONFIRMED' ? timestamp : existing.confirmed_at;
    db.prepare('UPDATE visits SET status = ?, confirmed_at = ?, updated_at = ?, synced = 0 WHERE id = ?').run(
      status,
      confirmedAt,
      timestamp,
      id
    );
    const updated = await getVisitById(id);
    if (!updated) {
      throw new Error('Visit not found after status update');
    }
    queueRowUpsert('visits', id);
    return updated;
  } catch (error) {
    handleDbError('set visit status', error);
  }
}

export async function softDeleteVisit(id: string): Promise<VisitRecord> {
  try {
    const db = getDatabase();
    db.prepare('UPDATE visits SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getVisitById(id);
    if (!updated) {
      throw new Error('Visit not found after delete');
    }
    queueRowUpsert('visits', id);
    return updated;
  } catch (error) {
    handleDbError('delete visit', error);
  }
}
