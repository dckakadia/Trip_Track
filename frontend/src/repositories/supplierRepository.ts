import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { SupplierPriority, SupplierRecord } from '../db/schema.ts';
import { buildUpdateClause, handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

export interface CreateSupplierInput {
  name: string;
  name_cn?: string | null;
  city_id?: string | null;
  address_cn?: string | null;
  address_en?: string | null;
  contact_name?: string | null;
  contact_mobile?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  website?: string | null;
  wechat_id?: string | null;
  product_category?: string | null;
  products?: string | null;
  specialty?: string | null;
  region?: string | null;
  established?: string | null;
  employees?: string | null;
  export_markets?: string | null;
  map_url?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  notes?: string | null;
  priority?: SupplierPriority;
  skip_reason?: string | null;
}

export const SUPPLIER_PRIORITIES: SupplierPriority[] = ['MUST', 'MAYBE', 'SKIP'];

export function assertValidPriority(priority: unknown): asserts priority is SupplierPriority {
  if (!SUPPLIER_PRIORITIES.includes(priority as SupplierPriority)) {
    throw new Error(`Invalid priority: ${String(priority)} (expected MUST, MAYBE, or SKIP)`);
  }
}

/** A supplier counts as visited once it has a non-deleted visit marked DONE. */
export interface SupplierWithVisitStatus extends SupplierRecord {
  visited: boolean;
  last_visit_date: string | null;
}

// `priorities` picks which of MUST/MAYBE to show; SKIP is governed by `hide_skipped` alone,
// mirroring the Must / Maybe / Hide skipped chips in the UI.
export interface SupplierFilters {
  priorities?: SupplierPriority[];
  hide_visited?: boolean;
  hide_skipped?: boolean;
  shortlist_trip_id?: string | null;
}

const LAST_VISIT_SQL = `(SELECT MAX(v.visit_date) FROM visits v
  WHERE v.supplier_id = s.id AND v.status = 'DONE' AND v.deleted = 0) AS last_visit_date`;

function toVisitStatus(row: SupplierRecord & { last_visit_date: string | null }): SupplierWithVisitStatus {
  return { ...row, visited: row.last_visit_date !== null, last_visit_date: row.last_visit_date };
}

export async function createSupplier(input: CreateSupplierInput): Promise<string> {
  try {
    if (!input.name) {
      throw new Error('Name is required');
    }
    const priority = input.priority ?? 'MAYBE';
    assertValidPriority(priority);
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO suppliers (id, name, name_cn, city_id, address_cn, address_en, contact_name, contact_mobile, whatsapp, email, website, wechat_id, product_category, products, specialty, region, established, employees, export_markets, map_url, gps_lat, gps_lng, notes, priority, skip_reason, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
    ).run(
      id,
      input.name,
      input.name_cn ?? null,
      input.city_id ?? null,
      input.address_cn ?? null,
      input.address_en ?? null,
      input.contact_name ?? null,
      input.contact_mobile ?? null,
      input.whatsapp ?? null,
      input.email ?? null,
      input.website ?? null,
      input.wechat_id ?? null,
      input.product_category ?? null,
      input.products ?? null,
      input.specialty ?? null,
      input.region ?? null,
      input.established ?? null,
      input.employees ?? null,
      input.export_markets ?? null,
      input.map_url ?? null,
      input.gps_lat ?? null,
      input.gps_lng ?? null,
      input.notes ?? null,
      priority,
      input.skip_reason ?? '',
      nowIso()
    );
    queueRowUpsert('suppliers', id);
    return id;
  } catch (error) {
    handleDbError('create supplier', error);
  }
}

export async function getSupplierById(id: string): Promise<SupplierRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as SupplierRecord | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read supplier', error);
  }
}

export async function listSuppliers(filters: SupplierFilters = {}): Promise<SupplierWithVisitStatus[]> {
  try {
    const db = getDatabase();
    const rows = (
      db.prepare(`SELECT s.*, ${LAST_VISIT_SQL} FROM suppliers s WHERE s.deleted = 0 ORDER BY s.name`).all() as Array<
        SupplierRecord & { last_visit_date: string | null }
      >
    ).map(toVisitStatus);
    const shortlist = filters.shortlist_trip_id
      ? new Set(
          (
            db
              .prepare('SELECT supplier_id FROM trip_suppliers WHERE trip_id = ? AND deleted = 0')
              .all(filters.shortlist_trip_id) as Array<{ supplier_id: string }>
          ).map((row) => row.supplier_id)
        )
      : null;
    return rows.filter((supplier) => {
      const priority = supplier.priority ?? 'MAYBE';
      if (filters.priorities && priority !== 'SKIP' && !filters.priorities.includes(priority)) return false;
      if (filters.hide_skipped && priority === 'SKIP') return false;
      if (filters.hide_visited && supplier.visited) return false;
      if (shortlist && !shortlist.has(supplier.id)) return false;
      return true;
    });
  } catch (error) {
    handleDbError('list suppliers', error);
  }
}

export async function getSupplierWithVisitStatus(id: string): Promise<SupplierWithVisitStatus | null> {
  try {
    const row = getDatabase().prepare(`SELECT s.*, ${LAST_VISIT_SQL} FROM suppliers s WHERE s.id = ?`).get(id) as
      | (SupplierRecord & { last_visit_date: string | null })
      | undefined;
    return row ? toVisitStatus(row) : null;
  } catch (error) {
    handleDbError('read supplier', error);
  }
}

export async function listSuppliersByCity(cityId: string): Promise<SupplierRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM suppliers WHERE city_id = ? AND deleted = 0 ORDER BY name')
      .all(cityId) as SupplierRecord[];
  } catch (error) {
    handleDbError('list suppliers by city', error);
  }
}

export async function updateSupplier(
  id: string,
  updates: Partial<Omit<SupplierRecord, 'id' | 'updated_at' | 'deleted' | 'synced'>>
): Promise<SupplierRecord> {
  try {
    const db = getDatabase();
    const existing = await getSupplierById(id);
    if (!existing) {
      throw new Error('Supplier not found');
    }
    if (updates.priority !== undefined) {
      assertValidPriority(updates.priority);
    }
    if (updates.skip_reason === null) {
      updates = { ...updates, skip_reason: '' };
    }

    const { setSql, values } = buildUpdateClause('suppliers', updates);
    db.prepare(`UPDATE suppliers SET ${setSql} WHERE id = ?`).run(...values, id);
    const updated = await getSupplierById(id);
    if (!updated) {
      throw new Error('Supplier not found after update');
    }
    queueRowUpsert('suppliers', id);
    return updated;
  } catch (error) {
    handleDbError('update supplier', error);
  }
}

export async function softDeleteSupplier(id: string): Promise<SupplierRecord> {
  try {
    const db = getDatabase();
    db.prepare('UPDATE suppliers SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getSupplierById(id);
    if (!updated) {
      throw new Error('Supplier not found after delete');
    }
    queueRowUpsert('suppliers', id);
    return updated;
  } catch (error) {
    handleDbError('delete supplier', error);
  }
}
