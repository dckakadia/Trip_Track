import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase } from './connection.ts';
import { initializeDatabase } from './migrations.ts';
import { COLUMN_MIGRATIONS, SCHEMA_STATEMENTS } from './schema.ts';
import { SYNCED_TABLES } from '../sync/pendingOps.ts';
import { createSupplier, getSupplierById } from '../repositories/supplierRepository.ts';

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name)
    .sort();
}

// Same logic as initializeDatabase(), but against an arbitrary standalone connection
// instead of the process-wide singleton, so two schemas can be compared side by side.
function runMigrations(db: DatabaseSync): void {
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === migration.column)) {
      db.exec(migration.ddl);
    }
  }
}

test('initializeDatabase upgrades a legacy suppliers table with new columns', async () => {
  const db = getDatabase();

  // Simulate a database created before map_url existed.
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

  initializeDatabase();

  const columns = (db.prepare('PRAGMA table_info(suppliers)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(columns.includes('map_url'));

  // The upgraded table accepts writes through the repository.
  const id = await createSupplier({ name: 'Legacy DB Supplier', map_url: 'https://maps.app.goo.gl/legacy' });
  assert.equal((await getSupplierById(id))?.map_url, 'https://maps.app.goo.gl/legacy');

  // Running migrations again is a no-op.
  initializeDatabase();
  assert.equal((await getSupplierById(id))?.map_url, 'https://maps.app.goo.gl/legacy');
});

test('a fresh database and an upgraded-from-legacy database end up with identical schemas', () => {
  // Fresh DB: migrations create every table from scratch, already including every
  // column that would otherwise arrive via COLUMN_MIGRATIONS.
  const freshDb = new DatabaseSync(':memory:');
  runMigrations(freshDb);

  // Legacy DB: only the pre-migration columns exist, and users has no password_hash column
  // at all (as it would have shipped before auth was added).
  const legacyDb = new DatabaseSync(':memory:');
  runMigrations(legacyDb);
  legacyDb.exec('DROP TABLE suppliers');
  legacyDb.exec(`CREATE TABLE suppliers (
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
  legacyDb.exec('DROP TABLE users');
  legacyDb.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'MEMBER',
    active INTEGER DEFAULT 1,
    updated_at TEXT,
    deleted INTEGER DEFAULT 0,
    synced INTEGER DEFAULT 0
  )`);
  runMigrations(legacyDb);
  runMigrations(legacyDb); // idempotency: running twice on the now-upgraded DB must be a no-op

  for (const table of [...SYNCED_TABLES, 'pending_ops', 'settings', 'login_attempts']) {
    assert.deepEqual(
      tableColumns(legacyDb, table),
      tableColumns(freshDb, table),
      `column set for ${table} differs between a fresh DB and an upgraded legacy DB`
    );
  }
});
