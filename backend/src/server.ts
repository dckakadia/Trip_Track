import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServerDatabase } from './db.ts';
import { SYNCED_TABLES, type SyncedTable } from '../../frontend/src/sync/pendingOps.ts';

interface PushBody {
  table_name: string;
  row_id: string;
  op: string;
  payload: string;
}

interface UploadBody {
  photo_id: string;
  filename: string;
  data_base64: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getUploadDir(): string {
  return process.env.TRIPTRACK_UPLOAD_DIR ?? fileURLToPath(new URL('../uploads/', import.meta.url));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data);
}

function isSyncedTable(tableName: string): tableName is SyncedTable {
  return SYNCED_TABLES.includes(tableName as SyncedTable);
}

function applyPush(body: PushBody): { applied: boolean } {
  if (!isSyncedTable(body.table_name)) {
    throw new Error(`Unknown table: ${body.table_name}`);
  }
  const row = JSON.parse(body.payload) as Record<string, string | number | null>;
  if (typeof row.id !== 'string' || !row.id) {
    throw new Error('Payload is missing a row id');
  }

  const db = getServerDatabase();
  const existing = db.prepare(`SELECT updated_at FROM ${body.table_name} WHERE id = ?`).get(row.id) as
    | { updated_at: string | null }
    | undefined;

  const incomingUpdatedAt = String(row.updated_at ?? '');
  if (existing && existing.updated_at && existing.updated_at >= incomingUpdatedAt) {
    return { applied: false };
  }

  const validColumns = new Set(
    (db.prepare(`PRAGMA table_info(${body.table_name})`).all() as Array<{ name: string }>).map((column) => column.name)
  );
  for (const column of Object.keys(row)) {
    if (!validColumns.has(column)) {
      throw new Error(`Pushed row for table ${body.table_name} has unknown column: ${column}`);
    }
  }

  const stored = { ...row, synced: 1, server_updated_at: nowIso() };
  const columns = Object.keys(stored);
  db.prepare(
    `INSERT OR REPLACE INTO ${body.table_name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((column) => stored[column as keyof typeof stored] as string | number | null));
  return { applied: true };
}

function collectChanges(since: string | null): Array<{ table_name: string; row: Record<string, unknown> }> {
  const db = getServerDatabase();
  const changes: Array<{ table_name: string; row: Record<string, unknown> }> = [];
  for (const table of SYNCED_TABLES) {
    const rows = (
      since
        ? db.prepare(`SELECT * FROM ${table} WHERE server_updated_at > ? ORDER BY server_updated_at`).all(since)
        : db.prepare(`SELECT * FROM ${table} WHERE server_updated_at IS NOT NULL ORDER BY server_updated_at`).all()
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const { server_updated_at, ...clientRow } = row;
      changes.push({ table_name: table, row: clientRow });
    }
  }
  return changes;
}

function storeUpload(body: UploadBody): { url: string } {
  if (!body.photo_id || !body.filename || !body.data_base64) {
    throw new Error('photo_id, filename, and data_base64 are required');
  }
  const uploadDir = getUploadDir();
  mkdirSync(uploadDir, { recursive: true });
  const safeName = `${body.photo_id}-${basename(body.filename)}`;
  writeFileSync(join(uploadDir, safeName), Buffer.from(body.data_base64, 'base64'));
  return { url: `/uploads/${safeName}` };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parsing must happen inside the try: a request with an empty Host header (a client can
    // send `Host: ` with no value) makes `new URL()` throw — outside a try/catch that becomes
    // an unhandled rejection that takes the whole process down, not just this one request.
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sync/push') {
      const body = (await readJsonBody(req)) as PushBody;
      sendJson(res, 200, applyPush(body));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sync/pull') {
      sendJson(res, 200, { changes: collectChanges(url.searchParams.get('since')) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/photos/upload') {
      const body = (await readJsonBody(req)) as UploadBody;
      sendJson(res, 200, storeUpload(body));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      const filePath = join(getUploadDir(), basename(url.pathname));
      if (!existsSync(filePath)) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'Bad request' });
  }
}

export function createSyncServer(): Server {
  return createHttpServer((req, res) => {
    void handleRequest(req, res);
  });
}

export function startSyncServer(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createSyncServer();
    server.on('error', reject);
    // TRIPTRACK_BIND=127.0.0.1 keeps the sync API private to the host when the
    // app server is the only client (it has no auth of its own).
    server.listen(port, process.env.TRIPTRACK_BIND, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ server, port: address.port });
      } else {
        reject(new Error('Failed to determine server port'));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? 4000);
  startSyncServer(port).then(({ port: boundPort }) => {
    console.log(`TripTrack sync server listening on http://localhost:${boundPort}`);
  });
}
