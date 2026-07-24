import { getDatabase } from '../db/connection.ts';
import { handleDbError, nowIso } from '../repositories/repositoryHelpers.ts';
import { queueRowUpsert, SYNCED_TABLES, type SyncedTable } from './pendingOps.ts';

export interface DataDump {
  format: 'triptrack-export';
  version: number;
  exported_at: string;
  tables: Partial<Record<SyncedTable, Array<Record<string, string | number | null>>>>;
}

export interface ImportResult {
  applied: number;
  skipped: number;
  tables: Partial<Record<SyncedTable, { applied: number; skipped: number }>>;
}

/** Full-fidelity dump of every synced table, soft-deleted rows included. */
export function exportData(): DataDump {
  try {
    const db = getDatabase();
    const tables: DataDump['tables'] = {};
    for (const table of SYNCED_TABLES) {
      tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY updated_at, id`).all() as Array<
        Record<string, string | number | null>
      >;
    }
    return { format: 'triptrack-export', version: 1, exported_at: nowIso(), tables };
  } catch (error) {
    handleDbError('export data', error);
  }
}

/**
 * Merge a dump into the local database. Rows win by last-write-wins on
 * updated_at, exactly like a sync pull — but imported rows are treated as
 * local edits: marked dirty and queued so they propagate on the next sync.
 */
export function importData(dump: DataDump): ImportResult {
  try {
    if (!dump || dump.format !== 'triptrack-export' || typeof dump.tables !== 'object') {
      throw new Error('Not a TripTrack export file');
    }

    const db = getDatabase();
    const result: ImportResult = { applied: 0, skipped: 0, tables: {} };

    for (const [tableName, rows] of Object.entries(dump.tables)) {
      if (!SYNCED_TABLES.includes(tableName as SyncedTable)) {
        throw new Error(`Export contains unknown table: ${tableName}`);
      }
      if (!Array.isArray(rows)) {
        throw new Error(`Export table is not a list: ${tableName}`);
      }
      const table = tableName as SyncedTable;
      const counts = { applied: 0, skipped: 0 };
      const validColumns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
      );

      for (const row of rows) {
        const id = row.id;
        if (typeof id !== 'string' || !id) {
          throw new Error(`Row in ${table} is missing an id`);
        }
        for (const column of Object.keys(row)) {
          if (!validColumns.has(column)) {
            throw new Error(`Row in ${table} has unknown column: ${column}`);
          }
        }

        const local = db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as
          | { updated_at: string | null }
          | undefined;
        const incomingUpdatedAt = String(row.updated_at ?? '');
        if (local && local.updated_at && local.updated_at >= incomingUpdatedAt) {
          counts.skipped += 1;
          continue;
        }

        const stored = { ...row, synced: 0 };
        const columns = Object.keys(stored);
        db.prepare(
          `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        ).run(...columns.map((column) => stored[column] as string | number | null));
        queueRowUpsert(table, id);
        counts.applied += 1;
      }

      result.tables[table] = counts;
      result.applied += counts.applied;
      result.skipped += counts.skipped;
    }

    return result;
  } catch (error) {
    handleDbError('import data', error);
  }
}
