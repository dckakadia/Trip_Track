import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import type { TripSupplierRecord } from '../db/schema.ts';
import { handleDbError, nowIso } from './repositoryHelpers.ts';
import { queueRowUpsert } from '../sync/pendingOps.ts';

// A trip's shortlist: the suppliers worth visiting on that trip. Rows are keyed by UUID like
// every other synced table (no UNIQUE(trip_id, supplier_id) constraint — two offline devices can
// each create a row for the same pair, and a REPLACE-on-conflict during pull would silently drop
// one of them). Duplicates are prevented locally on add, and collapsed by supplier_id on read.

export async function getTripSupplierById(id: string): Promise<TripSupplierRecord | null> {
  try {
    const row = getDatabase().prepare('SELECT * FROM trip_suppliers WHERE id = ?').get(id) as
      | TripSupplierRecord
      | undefined;
    return row ?? null;
  } catch (error) {
    handleDbError('read trip supplier', error);
  }
}

/**
 * Add a supplier to a trip's shortlist. Idempotent: an active row for the pair is returned as-is,
 * and a soft-deleted one is revived instead of inserting a duplicate. The lookup and the write run
 * back-to-back with no `await` between them, so two concurrent adds can't both insert.
 */
export async function addSupplierToTrip(tripId: string, supplierId: string): Promise<TripSupplierRecord> {
  try {
    if (!tripId || !supplierId) {
      throw new Error('trip_id and supplier_id are required');
    }
    const db = getDatabase();
    if (!db.prepare('SELECT id FROM trips WHERE id = ? AND deleted = 0').get(tripId)) {
      throw new Error('Trip not found');
    }
    if (!db.prepare('SELECT id FROM suppliers WHERE id = ? AND deleted = 0').get(supplierId)) {
      throw new Error('Supplier not found');
    }

    const existing = db
      .prepare(
        'SELECT * FROM trip_suppliers WHERE trip_id = ? AND supplier_id = ? ORDER BY deleted, updated_at DESC LIMIT 1'
      )
      .get(tripId, supplierId) as TripSupplierRecord | undefined;

    let id: string;
    if (existing && existing.deleted === 0) {
      return existing;
    } else if (existing) {
      id = existing.id;
      db.prepare('UPDATE trip_suppliers SET deleted = 0, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    } else {
      id = randomUUID();
      db.prepare(
        `INSERT INTO trip_suppliers (id, trip_id, supplier_id, updated_at, deleted, synced) VALUES (?, ?, ?, ?, 0, 0)`
      ).run(id, tripId, supplierId, nowIso());
    }
    queueRowUpsert('trip_suppliers', id);
    const row = await getTripSupplierById(id);
    if (!row) {
      throw new Error('Trip supplier not found after add');
    }
    return row;
  } catch (error) {
    handleDbError('add supplier to trip', error);
  }
}

/** Active shortlist rows for a trip, one per (non-deleted) supplier. */
export async function listTripSuppliers(tripId: string): Promise<TripSupplierRecord[]> {
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT ts.* FROM trip_suppliers ts
         JOIN suppliers s ON s.id = ts.supplier_id AND s.deleted = 0
         WHERE ts.trip_id = ? AND ts.deleted = 0
         ORDER BY ts.updated_at, ts.rowid`
      )
      .all(tripId) as TripSupplierRecord[];
    const seen = new Set<string>();
    return rows.filter((row) => !seen.has(row.supplier_id) && seen.add(row.supplier_id));
  } catch (error) {
    handleDbError('list trip suppliers', error);
  }
}

/** trip_id → number of distinct active suppliers on that trip's shortlist. */
export async function countShortlistedByTrip(): Promise<Record<string, number>> {
  try {
    const rows = getDatabase()
      .prepare(
        `SELECT ts.trip_id, COUNT(DISTINCT ts.supplier_id) AS n FROM trip_suppliers ts
         JOIN suppliers s ON s.id = ts.supplier_id AND s.deleted = 0
         WHERE ts.deleted = 0
         GROUP BY ts.trip_id`
      )
      .all() as Array<{ trip_id: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.trip_id, row.n]));
  } catch (error) {
    handleDbError('count trip shortlists', error);
  }
}

export async function softDeleteTripSupplier(id: string): Promise<TripSupplierRecord> {
  try {
    getDatabase().prepare('UPDATE trip_suppliers SET deleted = 1, updated_at = ?, synced = 0 WHERE id = ?').run(nowIso(), id);
    const updated = await getTripSupplierById(id);
    if (!updated) {
      throw new Error('Trip supplier not found after delete');
    }
    queueRowUpsert('trip_suppliers', id);
    return updated;
  } catch (error) {
    handleDbError('delete trip supplier', error);
  }
}

/** Remove a supplier from a trip's shortlist, soft-deleting every active row for the pair. */
export async function removeSupplierFromTrip(tripId: string, supplierId: string): Promise<{ removed: number }> {
  try {
    const rows = getDatabase()
      .prepare('SELECT id FROM trip_suppliers WHERE trip_id = ? AND supplier_id = ? AND deleted = 0')
      .all(tripId, supplierId) as Array<{ id: string }>;
    for (const row of rows) {
      await softDeleteTripSupplier(row.id);
    }
    return { removed: rows.length };
  } catch (error) {
    handleDbError('remove supplier from trip', error);
  }
}
