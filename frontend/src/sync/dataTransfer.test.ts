import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase } from '../db/connection.ts';
import { initializeDatabase } from '../db/migrations.ts';
import { createTrip, getTripById, listTrips } from '../repositories/tripRepository.ts';
import { createSupplier } from '../repositories/supplierRepository.ts';
import { createUser, listUsers } from '../repositories/userRepository.ts';
import { countPendingOps } from './pendingOps.ts';
import { exportData, importData } from './dataTransfer.ts';

test('export/import round-trips data into a fresh database', async () => {
  initializeDatabase();
  const tripId = await createTrip({ name: 'Export Trip', notes: 'take me along' });
  await createSupplier({ name: 'Export Supplier' });
  await createUser({ name: 'Devin', email: 'devin@example.com', role: 'ADMIN' });

  const dump = exportData();
  assert.equal(dump.format, 'triptrack-export');
  assert.equal(dump.tables.trips?.length, 1);
  assert.equal(dump.tables.suppliers?.length, 1);
  assert.equal(dump.tables.users?.length, 1);

  // Simulate a brand-new device: wipe the database and import the dump.
  closeDatabase();
  initializeDatabase();
  assert.deepEqual(await listTrips(), []);

  const result = importData(dump);
  assert.equal(result.applied, 3);
  assert.equal(result.skipped, 0);

  const trip = await getTripById(tripId);
  assert.equal(trip?.notes, 'take me along');
  assert.equal(trip?.synced, 0);
  assert.equal((await listUsers())[0]?.email, 'devin@example.com');

  // Imported rows are queued so they reach the sync server later.
  assert.equal(countPendingOps(), 3);

  // Re-importing the same dump is a no-op thanks to last-write-wins.
  const again = importData(dump);
  assert.equal(again.applied, 0);
  assert.equal(again.skipped, 3);
});

test('import rejects files that are not TripTrack exports', () => {
  initializeDatabase();
  assert.throws(() => importData({ nonsense: true } as never), /Not a TripTrack export/);
  assert.throws(
    () => importData({ format: 'triptrack-export', version: 1, exported_at: '', tables: { settings: [] } } as never),
    /unknown table/
  );
});
