import test from 'node:test';
import assert from 'node:assert/strict';
import { startAppServer } from './appServer.ts';

let cookie = '';

async function api(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!cookie) cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { status: res.status, data: await res.json() };
}

test('supplier priority, visited status, filters, and trip shortlist over the JSON API', async () => {
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;
  try {
    // Unauthenticated: the new routes are locked like everything else.
    assert.equal((await api(base, 'GET', '/api/trips/x/suppliers')).status, 401);
    assert.equal((await api(base, 'POST', '/api/trip-suppliers', {})).status, 401);
    cookie = '';
    assert.equal(
      (await api(base, 'POST', '/api/auth/setup', { name: 'Admin', email: 'a@example.com', password: 'secret123' })).status,
      201
    );

    const trip = (await api(base, 'POST', '/api/trips', { name: 'Shortlist API Trip' })).data;
    const a = (await api(base, 'POST', '/api/suppliers', { name: 'API A' })).data.id;
    const b = (await api(base, 'POST', '/api/suppliers', { name: 'API B' })).data.id;

    // Priority validation.
    const bad = await api(base, 'PATCH', `/api/suppliers/${b}`, { priority: 'LATER' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Invalid priority/);
    assert.equal((await api(base, 'POST', '/api/suppliers', { name: 'API C', priority: 'nope' })).status, 400);
    assert.equal((await api(base, 'GET', '/api/suppliers?priority=BOGUS')).status, 400);

    const skipped = await api(base, 'PATCH', `/api/suppliers/${b}`, { priority: 'SKIP', skip_reason: 'No OEM' });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.data.priority, 'SKIP');
    assert.equal(skipped.data.skip_reason, 'No OEM');
    assert.equal(skipped.data.visited, false);

    const all = (await api(base, 'GET', '/api/suppliers')).data;
    assert.deepEqual(all.map((s: any) => [s.name, s.priority, s.visited, s.last_visit_date]), [
      ['API A', 'MAYBE', false, null],
      ['API B', 'SKIP', false, null]
    ]);
    const filtered = (await api(base, 'GET', '/api/suppliers?hide_skipped=1&hide_visited=1')).data;
    assert.deepEqual(filtered.map((s: any) => s.id), [a]);

    // Visited: marking a visit DONE surfaces visited + last_visit_date.
    const visit = (await api(base, 'POST', '/api/visits', { trip_id: trip.id, supplier_id: a, visit_date: '2026-10-15' })).data;
    await api(base, 'POST', `/api/visits/${visit.id}/status`, { status: 'DONE' });
    const afterVisit = (await api(base, 'GET', '/api/suppliers')).data.find((s: any) => s.id === a);
    assert.equal(afterVisit.visited, true);
    assert.equal(afterVisit.last_visit_date, '2026-10-15');
    assert.deepEqual((await api(base, 'GET', '/api/suppliers?hide_visited=1')).data.map((s: any) => s.id), [b]);

    // Shortlist add (idempotent), list, count, remove.
    const added = await api(base, 'POST', '/api/trip-suppliers', { trip_id: trip.id, supplier_id: a });
    assert.equal(added.status, 201);
    const addedAgain = await api(base, 'POST', '/api/trip-suppliers', { trip_id: trip.id, supplier_id: a });
    assert.equal(addedAgain.data.id, added.data.id);
    await api(base, 'POST', '/api/trip-suppliers', { trip_id: trip.id, supplier_id: b });
    assert.equal((await api(base, 'POST', '/api/trip-suppliers', { trip_id: trip.id, supplier_id: 'missing' })).status, 404);
    assert.equal((await api(base, 'POST', '/api/trip-suppliers', { trip_id: trip.id })).status, 400);

    assert.deepEqual((await api(base, 'GET', `/api/trips/${trip.id}/suppliers`)).data.map((r: any) => r.supplier_id), [a, b]);
    assert.equal((await api(base, 'GET', '/api/trips')).data[0].shortlist_count, 2);
    assert.deepEqual(
      (await api(base, 'GET', `/api/suppliers?trip_id=${trip.id}&hide_skipped=1`)).data.map((s: any) => s.id),
      [a]
    );

    assert.deepEqual((await api(base, 'DELETE', `/api/trips/${trip.id}/suppliers/${b}`)).data, { removed: 1 });
    const byId = await api(base, 'DELETE', `/api/trip-suppliers/${added.data.id}`);
    assert.equal(byId.data.deleted, 1);
    assert.deepEqual((await api(base, 'GET', `/api/trips/${trip.id}/suppliers`)).data, []);
    assert.equal((await api(base, 'GET', '/api/trips')).data[0].shortlist_count, 0);
    assert.equal((await api(base, 'DELETE', '/api/trip-suppliers/nope')).status, 404);
  } finally {
    server.close();
  }
});
