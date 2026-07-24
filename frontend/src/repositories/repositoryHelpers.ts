import { getDatabase } from '../db/connection.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

export function handleDbError(operation: string, error: unknown): never {
  if (error instanceof Error) {
    throw new Error(`Failed to ${operation}: ${error.message}`);
  }
  throw new Error(`Failed to ${operation}`);
}

export interface UpdateClause {
  setSql: string;
  values: Array<string | number | null>;
}

// Columns that are never settable through a generic PATCH-style update —
// they're always driven by the repository itself, not caller-supplied data.
const PROTECTED_COLUMNS = new Set(['id', 'updated_at', 'deleted', 'synced']);

/**
 * Builds a `SET a = ?, b = ?` clause for `updates`, whose keys ultimately come
 * from a JSON request body (only compile-time typed, not runtime-validated).
 * Every key is checked against the table's real columns (via PRAGMA table_info,
 * so it can never drift from the schema) before being interpolated into SQL —
 * an unrecognized key throws instead of being written into the query string.
 */
export function buildUpdateClause(table: string, updates: Record<string, unknown>): UpdateClause {
  const columns = getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const allowedColumns = new Set(columns.map((column) => column.name).filter((name) => !PROTECTED_COLUMNS.has(name)));

  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }
    if (!allowedColumns.has(key)) {
      throw new Error(`Cannot update unknown column on ${table}: ${key}`);
    }
    fields.push(`${key} = ?`);
    values.push(value as string | number | null);
  }

  fields.push('updated_at = ?');
  fields.push('synced = 0');
  values.push(nowIso());

  return { setSql: fields.join(', '), values };
}
