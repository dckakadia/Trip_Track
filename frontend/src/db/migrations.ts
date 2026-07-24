import { getDatabase } from './connection.ts';
import { COLUMN_MIGRATIONS, SCHEMA_STATEMENTS } from './schema.ts';

export function initializeDatabase(): void {
  const db = getDatabase();
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
