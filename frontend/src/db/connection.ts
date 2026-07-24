import { DatabaseSync } from 'node:sqlite';

let dbInstance: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(process.env.TRIPTRACK_DB ?? ':memory:');
  }
  return dbInstance;
}

export function closeDatabase(): void {
  dbInstance?.close();
  dbInstance = null;
}
