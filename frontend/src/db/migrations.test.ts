import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabase } from './connection.ts';
import { initializeDatabase } from './migrations.ts';
import { createSupplier, getSupplierById } from '../repositories/supplierRepository.ts';

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
