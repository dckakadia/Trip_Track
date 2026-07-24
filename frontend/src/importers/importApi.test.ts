import test from 'node:test';
import assert from 'node:assert/strict';
import { startAppServer } from '../server/appServer.ts';

test('supplier import endpoint accepts a base64 CSV and creates suppliers', async () => {
  const { server, port } = await startAppServer(0);
  const base = `http://localhost:${port}`;
  try {
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', email: 'admin@example.com', password: 'secret123' })
    });
    assert.equal(setup.status, 201);
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;

    const csv = 'Name,Name CN,Category,Map URL\nAPI Import Co,接口进口公司,gadgets,https://maps.app.goo.gl/api1\n';
    const res = await fetch(`${base}/api/suppliers/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'suppliers.csv', data_base64: Buffer.from(csv).toString('base64') })
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.imported, 1);

    const suppliers = await (await fetch(`${base}/api/suppliers`, { headers: { cookie } })).json();
    const imported = suppliers.find((s: { name: string }) => s.name === 'API Import Co');
    assert.equal(imported?.name_cn, '接口进口公司');
    assert.equal(imported?.map_url, 'https://maps.app.goo.gl/api1');

    const sample = await fetch(`${base}/api/suppliers/sample-sheet`, { headers: { cookie } });
    assert.equal(sample.status, 200);
    assert.match(sample.headers.get('content-disposition') ?? '', /triptrack-suppliers-sample\.xlsx/);
    const sampleBytes = Buffer.from(await sample.arrayBuffer());
    assert.equal(sampleBytes.subarray(0, 2).toString(), 'PK');

    const bad = await fetch(`${base}/api/suppliers/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ filename: 'suppliers.pdf', data_base64: 'eA==' })
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
