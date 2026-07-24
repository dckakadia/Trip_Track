import { getDatabase } from '../db/connection.ts';
import { handleDbError } from './repositoryHelpers.ts';

export async function getSetting(key: string): Promise<string | null> {
  try {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch (error) {
    handleDbError('read setting', error);
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  try {
    getDatabase()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  } catch (error) {
    handleDbError('write setting', error);
  }
}
