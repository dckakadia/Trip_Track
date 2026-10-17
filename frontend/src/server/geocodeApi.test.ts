import test from 'node:test';
import assert from 'node:assert/strict';
import { startAppServer } from './appServer.ts';

async function call(base: string, method: string, path: string, body?: unknown, cookie = '') {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json(), setCookie: res.headers.get('set-cookie') ?? '' };
}

test('geocode and Baidu key endpoints respect auth and never expose the key', async () => {
  delete process.env.TRIPTRACK_BAIDU_AK;
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;
  try {
    assert.equal((await call(base, 'POST', '/api/geocode', { query: 'x' })).status, 401);
    assert.equal((await call(base, 'GET', '/api/admin/baidu-ak')).status, 401);

    const setup = await call(base, 'POST', '/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: 'secret123' });
    const admin = setup.setCookie.split(';')[0]!;
    await call(base, 'POST', '/api/users', { name: 'Member', email: 'member@example.com', password: 'secret123' }, admin);
    const member = (await call(base, 'POST', '/api/auth/login', { email: 'member@example.com', password: 'secret123' })).setCookie.split(';')[0]!;

    // Not configured: lookup explains how to fix it.
    assert.deepEqual((await call(base, 'GET', '/api/admin/baidu-ak', undefined, admin)).data, { configured: false, source: null, masked: null });
    const notSetUp = await call(base, 'POST', '/api/geocode', { query: '永芳印刷 江阴市锡澄路' }, member);
    assert.equal(notSetUp.status, 400);
    assert.match(notSetUp.data.error, /Admin page/);

    // Only admins can manage the key; it is validated and only ever shown masked.
    assert.equal((await call(base, 'PUT', '/api/admin/baidu-ak', { ak: 'abcd1234efgh5678' }, member)).status, 403);
    assert.equal((await call(base, 'PUT', '/api/admin/baidu-ak', { ak: 'bad key; drop' }, admin)).status, 400);
    assert.equal((await call(base, 'PUT', '/api/admin/baidu-ak', { ak: 'abcd1234efgh5678' }, admin)).status, 200);
    const info = (await call(base, 'GET', '/api/admin/baidu-ak', undefined, admin)).data;
    assert.deepEqual(info, { configured: true, source: 'settings', masked: 'abcd…5678' });
    assert.ok(!JSON.stringify(info).includes('abcd1234efgh5678'));

    // The key is a local setting, not synced data, so it is not in the admin export.
    const exported = await fetch(`${base}/api/admin/export`, { headers: { cookie: admin } });
    assert.ok(!(await exported.text()).includes('abcd1234efgh5678'));

    // Clearing it turns lookup off again.
    await call(base, 'PUT', '/api/admin/baidu-ak', { ak: '' }, admin);
    assert.equal((await call(base, 'GET', '/api/admin/baidu-ak', undefined, admin)).data.configured, false);
  } finally {
    server.close();
  }
});
