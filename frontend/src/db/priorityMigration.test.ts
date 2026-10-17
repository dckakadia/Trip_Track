import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from './connection.ts';
import { initializeDatabase } from './migrations.ts';
import { getSupplierById, updateSupplier } from '../repositories/supplierRepository.ts';

test('an old database gains priority/skip_reason (defaulting existing rows) and the trip_suppliers table', async () => {
  const db = getDatabase();

  // A database from before priorities and shortlists existed, with a supplier already in it.
  db.exec(`CREATE TABLE suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_cn TEXT,
    city_id TEXT,
    address_cn TEXT,
    address_en TEXT,
    contact_name TEXT,
    contact_mobile TEXT,
    wechat_id TEXT,
    product_category TEXT,
    notes TEXT,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`);
  db.prepare(`INSERT INTO suppliers (id, name, updated_at, deleted, synced) VALUES ('old-1', 'Old Supplier', '2026-01-01T00:00:00.000Z', 0, 1)`).run();
  const tablesBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trip_suppliers'`).all();
  assert.equal(tablesBefore.length, 0);

  initializeDatabase();

  const columns = db.prepare('PRAGMA table_info(suppliers)').all() as Array<{ name: string; dflt_value: string | null }>;
  assert.equal(columns.find((c) => c.name === 'priority')?.dflt_value, "'MAYBE'");
  assert.equal(columns.find((c) => c.name === 'skip_reason')?.dflt_value, "''");

  const old = await getSupplierById('old-1');
  assert.equal(old?.priority, 'MAYBE');
  assert.equal(old?.skip_reason, '');

  const shortlistColumns = (db.prepare('PRAGMA table_info(trip_suppliers)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
  assert.deepEqual(shortlistColumns, ['deleted', 'id', 'supplier_id', 'synced', 'trip_id', 'updated_at']);

  // The upgraded row is writable and the migration is idempotent.
  await updateSupplier('old-1', { priority: 'MUST' });
  initializeDatabase();
  assert.equal((await getSupplierById('old-1'))?.priority, 'MUST');
});
