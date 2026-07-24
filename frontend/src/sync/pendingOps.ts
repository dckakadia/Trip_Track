import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import { handleDbError, nowIso } from '../repositories/repositoryHelpers.ts';

export interface PendingOpRecord {
  id: string;
  table_name: string;
  row_id: string;
  op: string;
  payload: string;
  created_at: string;
}

export const SYNCED_TABLES = ['trips', 'cities', 'suppliers', 'visits', 'samples', 'photos', 'users'] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

function assertSyncedTable(tableName: string): asserts tableName is SyncedTable {
  if (!SYNCED_TABLES.includes(tableName as SyncedTable)) {
    throw new Error(`Table is not synced: ${tableName}`);
  }
}

/**
 * Queue the current state of a row for push to the server. Ops are coalesced:
 * a row has at most one pending op, whose payload always reflects the latest
 * local state (soft deletes included), while keeping its original queue position.
 */
export function queueRowUpsert(tableName: string, rowId: string): void {
  try {
    assertSyncedTable(tableName);
    const db = getDatabase();
    const row = db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(rowId);
    if (!row) {
      throw new Error(`Row not found in ${tableName}: ${rowId}`);
    }
    const payload = JSON.stringify(row);

    const existing = db
      .prepare('SELECT id FROM pending_ops WHERE table_name = ? AND row_id = ?')
      .get(tableName, rowId) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE pending_ops SET payload = ? WHERE id = ?').run(payload, existing.id);
    } else {
      db.prepare(
        'INSERT INTO pending_ops (id, table_name, row_id, op, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(randomUUID(), tableName, rowId, 'upsert', payload, nowIso());
    }
  } catch (error) {
    handleDbError('queue pending op', error);
  }
}

export function listPendingOps(): PendingOpRecord[] {
  try {
    return getDatabase()
      .prepare('SELECT * FROM pending_ops ORDER BY created_at, rowid')
      .all() as PendingOpRecord[];
  } catch (error) {
    handleDbError('list pending ops', error);
  }
}

export function removePendingOp(id: string): void {
  try {
    getDatabase().prepare('DELETE FROM pending_ops WHERE id = ?').run(id);
  } catch (error) {
    handleDbError('remove pending op', error);
  }
}

export function countPendingOps(): number {
  try {
    const row = getDatabase().prepare('SELECT COUNT(*) AS n FROM pending_ops').get() as { n: number };
    return row.n;
  } catch (error) {
    handleDbError('count pending ops', error);
  }
}
