import { DatabaseSync } from 'node:sqlite';
import { COLUMN_MIGRATIONS, SCHEMA_STATEMENTS } from '../../frontend/src/db/schema.ts';
import { SYNCED_TABLES } from '../../frontend/src/sync/pendingOps.ts';

let dbInstance: DatabaseSync | null = null;

function initialize(db: DatabaseSync): void {
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === migration.column)) {
      db.exec(migration.ddl);
    }
  }
  // The server tracks when it received each row, independent of the
  // client-set updated_at, so pulls never miss late-arriving older edits.
  for (const table of SYNCED_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'server_updated_at')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN server_updated_at TEXT`);
    }
  }
}

export function getServerDatabase(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(process.env.TRIPTRACK_SERVER_DB ?? ':memory:');
    initialize(dbInstance);
  }
  return dbInstance;
}

export function closeServerDatabase(): void {
  dbInstance?.close();
  dbInstance = null;
}
