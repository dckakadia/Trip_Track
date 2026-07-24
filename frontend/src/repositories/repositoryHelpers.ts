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

export function buildUpdateClause(updates: Record<string, unknown>): UpdateClause {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }
    fields.push(`${key} = ?`);
    values.push(value as string | number | null);
  }

  fields.push('updated_at = ?');
  fields.push('synced = 0');
  values.push(nowIso());

  return { setSql: fields.join(', '), values };
}
