import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { SampleRecord } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export interface CreateSampleInput {
  visit_id: string;
  sample_no?: string | null;
  description?: string | null;
  description_cn?: string | null;
  qty?: number | null;
  unit_price?: number | null;
  currency?: string | null;
  moq?: number | null;
  lead_time_days?: number | null;
  collected?: number;
  follow_up_required?: number;
  notes?: string | null;
}

export async function createSample(input: CreateSampleInput): Promise<string> {
  try {
    if (!input.visit_id) {
      throw new Error('visit_id is required');
    }
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO samples (id, visit_id, sample_no, description, description_cn, qty, unit_price, currency, moq, lead_time_days, collected, follow_up_required, notes, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(
      id,
      input.visit_id,
      input.sample_no ?? null,
      input.description ?? null,
      input.description_cn ?? null,
      input.qty ?? null,
      input.unit_price ?? null,
      input.currency ?? 'USD',
      input.moq ?? null,
      input.lead_time_days ?? null,
      input.collected ?? 0,
      input.follow_up_required ?? 0,
      input.notes ?? null,
      nowIso()
    );
    queueRowUpsert('samples', id);
    return id;
  } catch (error) {
    handleDbError('create sample', error);
  }
}

export async function getSampleById(id: string): Promise<SampleRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM samples WHERE id = ?').get(id) as SampleRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read sample', error);
  }
}

export async function listSamplesByVisit(visitId: string): Promise<SampleRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM samples WHERE visit_id = ? AND deleted = 0 ORDER BY sample_no, updated_at')
      .all(visitId) as SampleRecord[];
  } catch (error) {
    handleDbError('list samples', error);
  }
}

export async function listFollowUpSamples(): Promise<SampleRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM samples WHERE follow_up_required = 1 AND deleted = 0 ORDER BY updated_at')
      .all() as SampleRecord[];
  } catch (error) {
    handleDbError('list follow-up samples', error);
  }
}

export async function updateSample(
  id: string,
  updates: Partial<Omit<SampleRecord, 'id' | 'updated_at' | 'deleted' | 'synced'>>
): Promise<SampleRecord> {
  try {
    const db = getDatabase();
    const existing = await getSampleById(id);
    if (!existing) {
      throw new Error('Sample not found');
    }

    const { setSql, values } = buildUpdateClause('samples', updates);
    db.prepare(`UPDATE samples SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getSampleById(id);
    if (!updated) {
      throw new Error('Sample not found after update');
    }
    queueRowUpsert('samples', id);
    return updated;
  } catch (error) {
    handleDbError('update sample', error);
  }
}

export async function softDeleteSample(id: string): Promise<SampleRecord> {
  try {
    const db = getDatabase();
    db.prepare('UPDATE samples SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getSampleById(id);
    if (!updated) {
      throw new Error('Sample not found after delete');
    }
    queueRowUpsert('samples', id);
    return updated;
  } catch (error) {
    handleDbError('delete sample', error);
  }
}
