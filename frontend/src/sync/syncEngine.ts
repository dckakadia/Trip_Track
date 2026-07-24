import { getDatabase } from '../db/connection.ts';
import { handleDbError, nowIso } from '../repositories/repositoryHelpers.ts';
import { getSetting, setSetting } from '../repositories/settingsRepository.ts';
import { listPendingOps, removePendingOp, SYNCED_TABLES, type PendingOpRecord, type SyncedTable } from './pendingOps.ts';

export const LAST_SYNC_KEY = 'last_sync_at';

export interface RemoteChange {
  table_name: string;
  row: Record<string, string | number | null>;
}

/**
 * Transport to the sync server. pushOperation must throw on failure;
 * pullChanges returns rows changed on the server since `since` (null = everything).
 */
export interface SyncTransport {
  pushOperation(op: PendingOpRecord): Promise<void>;
  pullChanges(since: string | null): Promise<RemoteChange[]>;
}

export interface PushResult {
  pushed: number;
  remaining: number;
  error: string | null;
}

export interface PullResult {
  applied: number;
  skipped: number;
}

export async function pushPendingOps(transport: SyncTransport): Promise<PushResult> {
  const ops = listPendingOps();
  const db = getDatabase();
  let pushed = 0;

  for (const op of ops) {
    try {
      await transport.pushOperation(op);
    } catch (error) {
      // Stop at the first failure so ops reach the server in queue order.
      return {
        pushed,
        remaining: ops.length - pushed,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    removePendingOp(op.id);
    const payload = JSON.parse(op.payload) as { updated_at?: string };
    // Only mark synced if the row was not modified again while the push was in flight.
    db.prepare(`UPDATE ${op.table_name} SET synced = 1 WHERE id = ? AND updated_at = ?`).run(
      op.row_id,
      payload.updated_at ?? ''
    );
    pushed += 1;
  }

  return { pushed, remaining: 0, error: null };
}

export async function pullRemoteChanges(transport: SyncTransport): Promise<PullResult> {
  try {
    const since = await getSetting(LAST_SYNC_KEY);
    const changes = await transport.pullChanges(since);
    const db = getDatabase();
    let applied = 0;
    let skipped = 0;

    for (const change of changes) {
      if (!SYNCED_TABLES.includes(change.table_name as SyncedTable)) {
        throw new Error(`Remote change targets unknown table: ${change.table_name}`);
      }
      const remoteRow = change.row;
      const id = remoteRow.id;
      if (typeof id !== 'string' || !id) {
        throw new Error(`Remote change is missing a row id for table ${change.table_name}`);
      }

      const local = db.prepare(`SELECT updated_at FROM ${change.table_name} WHERE id = ?`).get(id) as
        | { updated_at: string | null }
        | undefined;

      // Last-write-wins on updated_at (ISO strings compare chronologically).
      const remoteUpdatedAt = String(remoteRow.updated_at ?? '');
      if (local && local.updated_at && local.updated_at >= remoteUpdatedAt) {
        skipped += 1;
        continue;
      }

      const row = { ...remoteRow, synced: 1 };
      const columns = Object.keys(row);
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(
        `INSERT OR REPLACE INTO ${change.table_name} (${columns.join(', ')}) VALUES (${placeholders})`
      ).run(...columns.map((column) => row[column] as string | number | null));
      applied += 1;
    }

    await setSetting(LAST_SYNC_KEY, nowIso());
    return { applied, skipped };
  } catch (error) {
    handleDbError('pull remote changes', error);
  }
}

export interface SyncResult {
  push: PushResult;
  pull: PullResult;
}

export async function runSync(transport: SyncTransport): Promise<SyncResult> {
  const push = await pushPendingOps(transport);
  if (push.error) {
    throw new Error(`Sync aborted during push: ${push.error}`);
  }
  const pull = await pullRemoteChanges(transport);
  return { push, pull };
}
