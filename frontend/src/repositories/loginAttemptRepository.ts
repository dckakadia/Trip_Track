import { getDatabase } from '../db/connection.ts';
import { handleDbError, nowIso } from './repositoryHelpers.ts';

// After this many consecutive failures, subsequent attempts are locked out
// with an exponentially growing delay, capped at MAX_LOCKOUT_SECONDS.
const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5;
const BASE_LOCKOUT_SECONDS = 30;
const MAX_LOCKOUT_SECONDS = 15 * 60;

export interface LoginThrottleStatus {
  allowed: boolean;
  retryAfterSeconds: number;
}

function lockoutSeconds(failedCount: number): number {
  const excess = failedCount - MAX_ATTEMPTS_BEFORE_LOCKOUT + 1;
  if (excess <= 0) {
    return 0;
  }
  return Math.min(BASE_LOCKOUT_SECONDS * 2 ** (excess - 1), MAX_LOCKOUT_SECONDS);
}

/** Identifier is the raw submitted email/username — throttled whether or not the account exists. */
export async function checkLoginThrottle(identifier: string): Promise<LoginThrottleStatus> {
  try {
    const row = getDatabase().prepare('SELECT locked_until FROM login_attempts WHERE identifier = ?').get(
      identifier
    ) as { locked_until: string | null } | undefined;
    if (!row?.locked_until) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const remainingMs = new Date(row.locked_until).getTime() - Date.now();
    if (remainingMs <= 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  } catch (error) {
    handleDbError('check login throttle', error);
  }
}

export async function recordLoginFailure(identifier: string): Promise<void> {
  try {
    const db = getDatabase();
    const now = nowIso();
    // Atomic increment (no read-then-write gap) so concurrent failed attempts can't lose a count.
    db.prepare(
      `INSERT INTO login_attempts (identifier, failed_count, locked_until, last_attempt_at)
       VALUES (?, 1, NULL, ?)
       ON CONFLICT(identifier) DO UPDATE SET failed_count = failed_count + 1, last_attempt_at = excluded.last_attempt_at`
    ).run(identifier, now);

    const row = db.prepare('SELECT failed_count FROM login_attempts WHERE identifier = ?').get(identifier) as {
      failed_count: number;
    };
    const lockSeconds = lockoutSeconds(row.failed_count);
    if (lockSeconds > 0) {
      const lockedUntil = new Date(Date.now() + lockSeconds * 1000).toISOString();
      db.prepare('UPDATE login_attempts SET locked_until = ? WHERE identifier = ?').run(lockedUntil, identifier);
    }
  } catch (error) {
    handleDbError('record login failure', error);
  }
}

export async function clearLoginFailures(identifier: string): Promise<void> {
  try {
    getDatabase().prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
  } catch (error) {
    handleDbError('clear login failures', error);
  }
}
