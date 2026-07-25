import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { SupplierRecord } from '../db/schema.ts';
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
}

export async function createSupplier(input: CreateSupplierInput): Promise<string> {
  try {
    if (!input.name) {
      throw new Error('Name is required');
    }
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO suppliers (id, name, name_cn, city_id, address_cn, address_en, contact_name, contact_mobile, whatsapp, email, website, wechat_id, product_category, products, specialty, region, established, employees, export_markets, map_url, gps_lat, gps_lng, notes, updated_at, deleted, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
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

export async function listSuppliers(): Promise<SupplierRecord[]> {
  try {
    return getDatabase()
      .prepare('SELECT * FROM suppliers WHERE deleted = 0 ORDER BY name')
      .all() as SupplierRecord[];
  } catch (error) {
    handleDbError('list suppliers', error);
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
