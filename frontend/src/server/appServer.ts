import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase } from '../db/migrations.ts';
import type { PhotoParentType, UserRecord, VisitStatus } from '../db/schema.ts';
import { createTrip, getTripById, listTrips, softDeleteTrip, updateTrip } from '../repositories/tripRepository.ts';
import { createCity, listCitiesByTrip, softDeleteCity, updateCity } from '../repositories/cityRepository.ts';
import {
  createSupplier,
  listSuppliers,
  softDeleteSupplier,
  updateSupplier
} from '../repositories/supplierRepository.ts';
import {
  createVisit,
  listVisitsByDate,
  listVisitsByTrip,
  setVisitStatus,
  softDeleteVisit,
  updateVisit
} from '../repositories/visitRepository.ts';
import {
  createSample,
  listFollowUpSamples,
  listSamplesByVisit,
  softDeleteSample,
  updateSample
} from '../repositories/sampleRepository.ts';
import { listPhotosByParent } from '../repositories/photoRepository.ts';
import {
  countCredentialedUsers,
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  softDeleteUser,
  updateUser
} from '../repositories/userRepository.ts';
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  clearedSessionCookie,
  createSessionToken,
  hashPassword,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifySessionToken
} from './auth.ts';
import { exportData, importData, type DataDump } from '../sync/dataTransfer.ts';
import { buildSampleXlsx, importSupplierFile } from '../importers/supplierImport.ts';
import { getSetting } from '../repositories/settingsRepository.ts';
import { countPendingOps } from '../sync/pendingOps.ts';
import { LAST_SYNC_KEY, runSync } from '../sync/syncEngine.ts';
import { createHttpSyncTransport } from '../sync/httpSyncTransport.ts';
import { createHttpPhotoUploadTransport, uploadPendingPhotos } from '../sync/photoUploader.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function publicUser(user: UserRecord): Omit<UserRecord, 'password_hash'> {
  const { password_hash, ...rest } = user;
  return rest;
}

async function getSessionUser(req: IncomingMessage): Promise<UserRecord | null> {
  const userId = await verifySessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!userId) {
    return null;
  }
  const user = await getUserById(userId);
  return user && !user.deleted && user.active ? user : null;
}

function assertPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return password;
}

// /api/auth/* endpoints — the only API surface reachable without a session.
async function handleAuthApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/auth/status' && method === 'GET') {
    const user = await getSessionUser(req);
    sendJson(res, 200, {
      needs_setup: (await countCredentialedUsers()) === 0,
      authenticated: user !== null,
      user: user ? publicUser(user) : null
    });
    return true;
  }
  if (pathname === '/api/auth/setup' && method === 'POST') {
    if ((await countCredentialedUsers()) > 0) {
      sendJson(res, 403, { error: 'Already set up — sign in instead' });
      return true;
    }
    const body = await readJsonBody(req);
    const password = assertPassword(body.password);
    const id = await createUser({
      name: String(body.name ?? ''),
      email: String(body.email ?? ''),
      role: 'ADMIN',
      password_hash: hashPassword(password)
    });
    const user = await getUserById(id);
    res.setHeader('set-cookie', sessionCookie(await createSessionToken(id)));
    sendJson(res, 201, { user: user ? publicUser(user) : null });
    return true;
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJsonBody(req);
    const user = await getUserByEmail(String(body.email ?? ''));
    if (!user || !user.active || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
      sendJson(res, 401, { error: 'Invalid email or password' });
      return true;
    }
    res.setHeader('set-cookie', sessionCookie(await createSessionToken(user.id)));
    sendJson(res, 200, { user: publicUser(user) });
    return true;
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    res.setHeader('set-cookie', clearedSessionCookie());
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  // --- Trips ---
  if (pathname === '/api/trips' && method === 'GET') {
    sendJson(res, 200, await listTrips());
    return true;
  }
  if (pathname === '/api/trips' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = await createTrip(body as Parameters<typeof createTrip>[0]);
    sendJson(res, 201, await getTripById(id));
    return true;
  }
  const tripMatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
  if (tripMatch && method === 'PATCH') {
    sendJson(res, 200, await updateTrip(tripMatch[1]!, await readJsonBody(req)));
    return true;
  }
  if (tripMatch && method === 'DELETE') {
    sendJson(res, 200, await softDeleteTrip(tripMatch[1]!));
    return true;
  }

  // --- Cities ---
  const tripCitiesMatch = pathname.match(/^\/api\/trips\/([^/]+)\/cities$/);
  if (tripCitiesMatch && method === 'GET') {
    sendJson(res, 200, await listCitiesByTrip(tripCitiesMatch[1]!));
    return true;
  }
  if (pathname === '/api/cities' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = await createCity(body as Parameters<typeof createCity>[0]);
    sendJson(res, 201, { id });
    return true;
  }
  const cityMatch = pathname.match(/^\/api\/cities\/([^/]+)$/);
  if (cityMatch && method === 'PATCH') {
    sendJson(res, 200, await updateCity(cityMatch[1]!, await readJsonBody(req)));
    return true;
  }
  if (cityMatch && method === 'DELETE') {
    sendJson(res, 200, await softDeleteCity(cityMatch[1]!));
    return true;
  }

  // --- Suppliers ---
  if (pathname === '/api/suppliers/sample-sheet' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="triptrack-suppliers-sample.xlsx"'
    });
    res.end(buildSampleXlsx());
    return true;
  }
  if (pathname === '/api/suppliers/import' && method === 'POST') {
    const body = await readJsonBody(req);
    const filename = String(body.filename ?? '');
    const data = Buffer.from(String(body.data_base64 ?? ''), 'base64');
    sendJson(res, 200, await importSupplierFile(filename, data));
    return true;
  }
  if (pathname === '/api/suppliers' && method === 'GET') {
    sendJson(res, 200, await listSuppliers());
    return true;
  }
  if (pathname === '/api/suppliers' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = await createSupplier(body as Parameters<typeof createSupplier>[0]);
    sendJson(res, 201, { id });
    return true;
  }
  const supplierMatch = pathname.match(/^\/api\/suppliers\/([^/]+)$/);
  if (supplierMatch && method === 'PATCH') {
    sendJson(res, 200, await updateSupplier(supplierMatch[1]!, await readJsonBody(req)));
    return true;
  }
  if (supplierMatch && method === 'DELETE') {
    sendJson(res, 200, await softDeleteSupplier(supplierMatch[1]!));
    return true;
  }

  // --- Visits ---
  const tripVisitsMatch = pathname.match(/^\/api\/trips\/([^/]+)\/visits$/);
  if (tripVisitsMatch && method === 'GET') {
    const date = url.searchParams.get('date');
    sendJson(res, 200, date ? await listVisitsByDate(tripVisitsMatch[1]!, date) : await listVisitsByTrip(tripVisitsMatch[1]!));
    return true;
  }
  if (pathname === '/api/visits' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = await createVisit(body as Parameters<typeof createVisit>[0]);
    sendJson(res, 201, { id });
    return true;
  }
  const visitStatusMatch = pathname.match(/^\/api\/visits\/([^/]+)\/status$/);
  if (visitStatusMatch && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 200, await setVisitStatus(visitStatusMatch[1]!, body.status as VisitStatus));
    return true;
  }
  const visitMatch = pathname.match(/^\/api\/visits\/([^/]+)$/);
  if (visitMatch && method === 'PATCH') {
    sendJson(res, 200, await updateVisit(visitMatch[1]!, await readJsonBody(req)));
    return true;
  }
  if (visitMatch && method === 'DELETE') {
    sendJson(res, 200, await softDeleteVisit(visitMatch[1]!));
    return true;
  }

  // --- Samples ---
  const visitSamplesMatch = pathname.match(/^\/api\/visits\/([^/]+)\/samples$/);
  if (visitSamplesMatch && method === 'GET') {
    sendJson(res, 200, await listSamplesByVisit(visitSamplesMatch[1]!));
    return true;
  }
  if (pathname === '/api/samples/follow-ups' && method === 'GET') {
    sendJson(res, 200, await listFollowUpSamples());
    return true;
  }
  if (pathname === '/api/samples' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = await createSample(body as Parameters<typeof createSample>[0]);
    sendJson(res, 201, { id });
    return true;
  }
  const sampleMatch = pathname.match(/^\/api\/samples\/([^/]+)$/);
  if (sampleMatch && method === 'PATCH') {
    sendJson(res, 200, await updateSample(sampleMatch[1]!, await readJsonBody(req)));
    return true;
  }
  if (sampleMatch && method === 'DELETE') {
    sendJson(res, 200, await softDeleteSample(sampleMatch[1]!));
    return true;
  }

  // --- Photos ---
  const photosMatch = pathname.match(/^\/api\/photos\/([^/]+)\/([^/]+)$/);
  if (photosMatch && method === 'GET') {
    sendJson(res, 200, await listPhotosByParent(photosMatch[1] as PhotoParentType, photosMatch[2]!));
    return true;
  }

  // --- Users (admin) ---
  if (pathname === '/api/users' && method === 'GET') {
    sendJson(res, 200, (await listUsers()).map(publicUser));
    return true;
  }
  if (pathname === '/api/users' && method === 'POST') {
    const { password, ...body } = await readJsonBody(req);
    const id = await createUser({
      ...(body as Parameters<typeof createUser>[0]),
      password_hash: password === undefined ? null : hashPassword(assertPassword(password))
    });
    const created = await getUserById(id);
    sendJson(res, 201, created ? publicUser(created) : null);
    return true;
  }
  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === 'PATCH') {
    const { password, ...body } = await readJsonBody(req);
    const updates = body as Parameters<typeof updateUser>[1];
    if (password !== undefined) {
      updates.password_hash = hashPassword(assertPassword(password));
    }
    sendJson(res, 200, publicUser(await updateUser(userMatch[1]!, updates)));
    return true;
  }
  if (userMatch && method === 'DELETE') {
    sendJson(res, 200, publicUser(await softDeleteUser(userMatch[1]!)));
    return true;
  }

  // --- Data export / import (admin) ---
  if (pathname === '/api/admin/export' && method === 'GET') {
    const dump = exportData();
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="triptrack-export-${dump.exported_at.slice(0, 10)}.json"`
    });
    res.end(JSON.stringify(dump, null, 2));
    return true;
  }
  if (pathname === '/api/admin/import' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 200, importData(body as unknown as DataDump));
    return true;
  }

  // --- Sync ---
  if (pathname === '/api/sync/status' && method === 'GET') {
    sendJson(res, 200, {
      pending: countPendingOps(),
      last_sync_at: await getSetting(LAST_SYNC_KEY),
      sync_url: process.env.TRIPTRACK_SYNC_URL ?? null
    });
    return true;
  }
  if (pathname === '/api/sync/run' && method === 'POST') {
    const syncUrl = process.env.TRIPTRACK_SYNC_URL;
    if (!syncUrl) {
      sendJson(res, 400, { error: 'TRIPTRACK_SYNC_URL is not configured' });
      return true;
    }
    const sync = await runSync(createHttpSyncTransport(syncUrl));
    const photos = await uploadPendingPhotos(createHttpPhotoUploadTransport(syncUrl));
    sendJson(res, 200, { ...sync, photos, pending: countPendingOps() });
    return true;
  }

  return false;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (await handleAuthApi(req, res, url)) {
        return;
      }
      const user = await getSessionUser(req);
      if (!user) {
        sendJson(res, 401, { error: 'Authentication required' });
        return;
      }
      if ((url.pathname.startsWith('/api/users') || url.pathname.startsWith('/api/admin/')) && user.role !== 'ADMIN') {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const handled = await handleApi(req, res, url);
      if (!handled) {
        sendJson(res, 404, { error: 'Not found' });
      }
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    sendJson(res, message.includes('not found') ? 404 : 400, { error: message });
  }
}

export function startAppServer(port: number): Promise<{ server: Server; port: number }> {
  initializeDatabase();
  return new Promise((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      void handleRequest(req, res);
    });
    server.on('error', reject);
    server.listen(port, () => {
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
  const port = Number(process.env.PORT ?? 3000);
  startAppServer(port).then(({ port: boundPort }) => {
    console.log(`TripTrack app running at http://localhost:${boundPort}`);
    if (!process.env.TRIPTRACK_DB) {
      console.log('Warning: TRIPTRACK_DB is not set; data is in-memory and lost on exit.');
    }
    if (!process.env.TRIPTRACK_SYNC_URL) {
      console.log('Note: TRIPTRACK_SYNC_URL is not set; the Sync button will be disabled.');
    }
  });
}
