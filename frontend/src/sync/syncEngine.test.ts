import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/connection.ts';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip, getTripById } from '../repositories/tripRepository.ts';
import { createSupplier, getSupplierById } from '../repositories/supplierRepository.ts';
import { getSetting } from '../repositories/settingsRepository.ts';
import { countPendingOps, listPendingOps, type PendingOpRecord } from './pendingOps.ts';
import { LAST_SYNC_KEY, pullRemoteChanges, pushPendingOps, type RemoteChange, type SyncTransport } from './syncEngine.ts';

function makeTransport(options: { failOn?: (op: PendingOpRecord) => boolean; pullResult?: RemoteChange[] } = {}) {
  const pushedOps: PendingOpRecord[] = [];
  const pullCalls: Array<string | null> = [];
  const transport: SyncTransport = {
    async pushOperation(op) {
      if (options.failOn?.(op)) {
        throw new Error('network unreachable');
      }
      pushedOps.push(op);
    },
    async pullChanges(since) {
      pullCalls.push(since);
      return options.pullResult ?? [];
    }
  };
  return { transport, pushedOps, pullCalls };
}

test('push drains the queue in order and marks rows synced', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Push Trip' });
  const supplierId = await createSupplier({ name: 'Push Supplier' });
  assert.equal(countPendingOps(), 2);

  const { transport, pushedOps } = makeTransport();
  const result = await pushPendingOps(transport);

  assert.deepEqual(result, { pushed: 2, remaining: 0, error: null });
  assert.deepEqual(
    pushedOps.map((op) => op.row_id),
    [tripId, supplierId]
  );
  assert.equal(countPendingOps(), 0);
  assert.equal((await getTripById(tripId))?.synced, 1);
  assert.equal((await getSupplierById(supplierId))?.synced, 1);
});

test('push stops at the first failure and keeps unpushed ops queued', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Partial Push Trip' });
  const supplierId = await createSupplier({ name: 'Unreachable Supplier' });

  const { transport } = makeTransport({ failOn: (op) => op.row_id === supplierId });
  const result = await pushPendingOps(transport);

  assert.equal(result.pushed, 1);
  assert.equal(result.remaining, 1);
  assert.match(result.error ?? '', /network unreachable/);

  const remaining = listPendingOps();
  assert.deepEqual(
    remaining.map((op) => op.row_id),
    [supplierId]
  );
  assert.equal((await getTripById(tripId))?.synced, 1);
  assert.equal((await getSupplierById(supplierId))?.synced, 0);
});

test('pull applies newer remote rows, skips older ones, and records last sync', async () => {
  initializeDatabase();
  const localId = await createTrip({ name: 'Local Version', notes: 'local wins' });
  const localRow = await getTripById(localId);
  assert.ok(localRow);

  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const incomingId = randomUUID();

  const { transport, pullCalls } = makeTransport({
    pullResult: [
      // New row unknown locally: applied.
      {
        table_name: 'trips',
        row: {
          id: incomingId,
          name: 'Remote Trip',
          start_date: null,
          end_date: null,
          notes: 'from server',
          updated_at: future,
          deleted: 0,
          synced: 0
        }
      },
      // Stale remote copy of the local row: skipped, local edit preserved.
      {
        table_name: 'trips',
        row: { ...localRow, notes: 'stale server copy', updated_at: past }
      }
    ]
  });

  const result = await pullRemoteChanges(transport);
  assert.deepEqual(result, { applied: 1, skipped: 1 });
  assert.deepEqual(pullCalls, [null]);

  const incoming = await getTripById(incomingId);
  assert.equal(incoming?.notes, 'from server');
  assert.equal(incoming?.synced, 1);

  const localAfter = await getTripById(localId);
  assert.equal(localAfter?.notes, 'local wins');

  // Applying a remote row must not enqueue a new pending op for it.
  const opRowIds = listPendingOps().map((op) => op.row_id);
  assert.ok(!opRowIds.includes(incomingId));

  const lastSync = await getSetting(LAST_SYNC_KEY);
  assert.ok(lastSync);

  // A second pull passes the recorded last-sync timestamp as `since`.
  await pullRemoteChanges({ ...transport, pullChanges: async (since) => (pullCalls.push(since), []) });
  assert.equal(pullCalls[1], lastSync);
});

test('newer remote row overwrites older local row on pull', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Will Be Overwritten', notes: 'old local' });
  const localRow = await getTripById(tripId);
  assert.ok(localRow);

  const future = new Date(Date.now() + 60_000).toISOString();
  const { transport } = makeTransport({
    pullResult: [{ table_name: 'trips', row: { ...localRow, notes: 'newer from server', updated_at: future } }]
  });

  const result = await pullRemoteChanges(transport);
  assert.deepEqual(result, { applied: 1, skipped: 0 });

  const after = await getTripById(tripId);
  assert.equal(after?.notes, 'newer from server');
  assert.equal(after?.synced, 1);

  const db = getDatabase();
  const count = db.prepare('SELECT COUNT(*) AS n FROM trips WHERE id = ?').get(tripId) as { n: number };
  assert.equal(count.n, 1);
});

test('pull rejects a remote row with an unrecognized/malicious column name', async () => {
  initializeDatabase();
  const { transport } = makeTransport({
    pullResult: [
      {
        table_name: 'trips',
        row: {
          id: randomUUID(),
          name: 'Injected Row',
          updated_at: new Date().toISOString(),
          // Not a real column on `trips` — must be rejected, not interpolated into SQL.
          "id); DROP TABLE trips; --": 'malicious'
        }
      }
    ]
  });

  await assert.rejects(pullRemoteChanges(transport), /unknown column/);

  // The table must still exist and be queryable, and the malicious row must not be inserted.
  const db2 = getDatabase();
  const rows = db2.prepare('SELECT id FROM trips WHERE name = ?').all('Injected Row');
  assert.equal(rows.length, 0);
});
