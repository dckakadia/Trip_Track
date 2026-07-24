import test from 'node:test';
import assert from 'node:assert/strict';
import { startAppServer } from './appServer.ts';
import { startSyncServer } from '../../../backend/src/server.ts';

async function api(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

test('app server exposes the full workflow over its JSON API', async () => {
  const { server: syncServer, port: syncPort } = await startSyncServer(0);
  process.env.TRIPTRACK_SYNC_URL = `http://localhost:${syncPort}`;
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;

  try {
    // Trip lifecycle.
    const created = await api(base, 'POST', '/api/trips', { name: 'API Trip', start_date: '2026-09-10' });
    assert.equal(created.status, 201);
    const tripId = created.data.id as string;

    const trips = await api(base, 'GET', '/api/trips');
    assert.deepEqual(
      trips.data.map((t: { id: string }) => t.id),
      [tripId]
    );

    const renamed = await api(base, 'PATCH', `/api/trips/${tripId}`, { name: 'API Trip v2' });
    assert.equal(renamed.data.name, 'API Trip v2');

    // Cities.
    const city = await api(base, 'POST', '/api/cities', { trip_id: tripId, name: 'Dongguan', sort_order: 1 });
    assert.equal(city.status, 201);
    const cities = await api(base, 'GET', `/api/trips/${tripId}/cities`);
    assert.equal(cities.data[0].name, 'Dongguan');

    // Suppliers.
    const supplier = await api(base, 'POST', '/api/suppliers', { name: 'API Supplier', city_id: city.data.id });
    const suppliers = await api(base, 'GET', '/api/suppliers');
    assert.equal(suppliers.data.length, 1);

    // Visits and status flow.
    const visit = await api(base, 'POST', '/api/visits', {
      trip_id: tripId,
      supplier_id: supplier.data.id,
      visit_date: '2026-09-11',
      scheduled_time: '10:00'
    });
    const dayVisits = await api(base, 'GET', `/api/trips/${tripId}/visits?date=2026-09-11`);
    assert.equal(dayVisits.data.length, 1);

    const confirmed = await api(base, 'POST', `/api/visits/${visit.data.id}/status`, { status: 'CONFIRMED' });
    assert.equal(confirmed.data.status, 'CONFIRMED');
    assert.ok(confirmed.data.confirmed_at);

    const badStatus = await api(base, 'POST', `/api/visits/${visit.data.id}/status`, { status: 'NOT_A_STATUS' });
    assert.equal(badStatus.status, 400);

    // Samples.
    await api(base, 'POST', '/api/samples', { visit_id: visit.data.id, sample_no: 'S-100', description: 'Widget' });
    const samples = await api(base, 'GET', `/api/visits/${visit.data.id}/samples`);
    assert.equal(samples.data[0].sample_no, 'S-100');

    // Sync status and a real run against the backend server.
    const statusBefore = await api(base, 'GET', '/api/sync/status');
    assert.ok(statusBefore.data.pending > 0);
    assert.equal(statusBefore.data.last_sync_at, null);

    const sync = await api(base, 'POST', '/api/sync/run');
    assert.equal(sync.status, 200);
    assert.equal(sync.data.push.error, null);
    assert.equal(sync.data.pending, 0);

    const statusAfter = await api(base, 'GET', '/api/sync/status');
    assert.equal(statusAfter.data.pending, 0);
    assert.ok(statusAfter.data.last_sync_at);

    // Static UI is served.
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TripTrack/);

    // Unknown API route 404s.
    const missing = await api(base, 'GET', '/api/nope');
    assert.equal(missing.status, 404);

    // --- Admin: user management ---
    const user = await api(base, 'POST', '/api/users', { name: 'Devin', email: 'devin@example.com', role: 'ADMIN' });
    assert.equal(user.status, 201);
    assert.equal(user.data.role, 'ADMIN');

    const dupe = await api(base, 'POST', '/api/users', { name: 'Dupe', email: 'devin@example.com' });
    assert.equal(dupe.status, 400);

    const edited = await api(base, 'PATCH', `/api/users/${user.data.id}`, { name: 'Devin K', role: 'MEMBER' });
    assert.equal(edited.data.name, 'Devin K');
    assert.equal(edited.data.role, 'MEMBER');

    const removed = await api(base, 'DELETE', `/api/users/${user.data.id}`);
    assert.equal(removed.data.deleted, 1);
    const usersAfter = await api(base, 'GET', '/api/users');
    assert.deepEqual(usersAfter.data, []);

    // --- Admin: export / import ---
    const exportRes = await fetch(`${base}/api/admin/export`);
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-disposition') ?? '', /attachment; filename="triptrack-export-/);
    const dump = await exportRes.json();
    assert.equal(dump.format, 'triptrack-export');
    assert.equal(dump.tables.trips.length, 1);
    assert.equal(dump.tables.users.length, 1); // soft-deleted user kept for full fidelity

    // Re-importing our own export is a clean no-op (everything skipped by LWW).
    const reimport = await api(base, 'POST', '/api/admin/import', dump);
    assert.equal(reimport.status, 200);
    assert.equal(reimport.data.applied, 0);

    // Importing a dump holding a newer edit applies it.
    const tripRow = { ...dump.tables.trips[0], name: 'Imported Rename', updated_at: new Date(Date.now() + 1000).toISOString() };
    const editedDump = { ...dump, tables: { trips: [tripRow] } };
    const applied = await api(base, 'POST', '/api/admin/import', editedDump);
    assert.equal(applied.data.applied, 1);
    const tripsAfterImport = await api(base, 'GET', '/api/trips');
    assert.equal(tripsAfterImport.data[0].name, 'Imported Rename');

    const badImport = await api(base, 'POST', '/api/admin/import', { hello: 'world' });
    assert.equal(badImport.status, 400);
  } finally {
    server.close();
    syncServer.close();
    delete process.env.TRIPTRACK_SYNC_URL;
  }
});
