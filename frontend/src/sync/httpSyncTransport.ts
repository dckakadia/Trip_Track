import type { PendingOpRecord } from './pendingOps.ts';
import type { RemoteChange, SyncTransport } from './syncEngine.ts';

export function createHttpSyncTransport(baseUrl: string): SyncTransport {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async pushOperation(op: PendingOpRecord): Promise<void> {
      const res = await fetch(`${base}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op)
      });
      if (!res.ok) {
        throw new Error(`Push failed: HTTP ${res.status}`);
      }
    },
    async pullChanges(since: string | null): Promise<RemoteChange[]> {
      const url = new URL(`${base}/api/sync/pull`);
      if (since) {
        url.searchParams.set('since', since);
      }
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Pull failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { changes: RemoteChange[] };
      return body.changes;
    }
  };
}
