import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { setSetting } from '../repositories/settingsRepository.ts';
import { BAIDU_AK_SETTING, gcj02ToWgs84, geocodeLocation, parseLocationText, wgs84ToGcj02 } from './geocode.ts';

const WECHAT_TEXT = '江阴市永芳印刷有限公司(火车站路) 江阴市锡澄路辅路附近';

function fakeBaidu(responses: Array<unknown | ((url: URL) => unknown)>) {
  const calls: URL[] = [];
  const fetchImpl = async (url: string) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const next = responses.shift();
    const body = typeof next === 'function' ? (next as (u: URL) => unknown)(parsed) : next;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

test('parseLocationText splits a WeChat location into name, address, and city', () => {
  assert.deepEqual(parseLocationText(WECHAT_TEXT), {
    name: '江阴市永芳印刷有限公司(火车站路)',
    address: '江阴市锡澄路辅路附近',
    city: '江阴市'
  });
  // Province prefix dropped; the most specific leading city wins; [位置] tag and URLs ignored.
  assert.deepEqual(parseLocationText('[位置] 义乌国际商贸城  浙江省金华市义乌市福田路 https://example.com/x'), {
    name: '义乌国际商贸城',
    address: '浙江省金华市义乌市福田路',
    city: '义乌市'
  });
  // A "…市" inside a shop name is not a city.
  assert.equal(parseLocationText('沃尔玛超市 解放路88号').city, null);
});

test('GCJ-02 ⇄ WGS-84 conversion matches the reference offset and round-trips', () => {
  // Tiananmen: the widely published WGS-84 → GCJ-02 shift (~600 m east, ~150 m north).
  const gcj = wgs84ToGcj02(39.908692, 116.397477);
  assert.ok(Math.abs(gcj.lat - 39.910095) < 1e-5 && Math.abs(gcj.lng - 116.403721) < 1e-5, JSON.stringify(gcj));
  const back = gcj02ToWgs84(gcj.lat, gcj.lng);
  assert.ok(Math.abs(back.lat - 39.908692) < 1e-6 && Math.abs(back.lng - 116.397477) < 1e-6, JSON.stringify(back));
  // Outside China there is no offset.
  assert.deepEqual(gcj02ToWgs84(51.5, -0.12), { lat: 51.5, lng: -0.12 });
});

test('geocodeLocation needs a Baidu AK', async () => {
  initializeDatabase();
  delete process.env.TRIPTRACK_BAIDU_AK;
  await assert.rejects(geocodeLocation(WECHAT_TEXT, fakeBaidu([]).fetchImpl), /not set up yet/);
  await assert.rejects(geocodeLocation('   ', fakeBaidu([]).fetchImpl), /Paste a place name/);
});

test('geocodeLocation searches Baidu places, converts to WGS-84, and builds a Baidu map link', async () => {
  initializeDatabase();
  await setSetting(BAIDU_AK_SETTING, 'storedAk1234567890');
  const gcjLat = 31.906512;
  const gcjLng = 120.268741;
  const { fetchImpl, calls } = fakeBaidu([
    {
      status: 0,
      results: [
        { name: '江阴市永芳印刷有限公司', province: '江苏省', city: '无锡市', area: '江阴市', address: '火车站路12号', location: { lat: gcjLat, lng: gcjLng } },
        { name: '永芳印刷(二厂)', province: '江苏省', city: '无锡市', area: '江阴市', address: '锡澄路', location: { lat: 31.88, lng: 120.27 } }
      ]
    }
  ]);

  const candidates = await geocodeLocation(WECHAT_TEXT, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pathname, '/place/v2/search');
  assert.equal(calls[0]!.searchParams.get('query'), '江阴市永芳印刷有限公司(火车站路)');
  assert.equal(calls[0]!.searchParams.get('region'), '江阴市');
  assert.equal(calls[0]!.searchParams.get('ret_coordtype'), 'gcj02ll');
  assert.equal(calls[0]!.searchParams.get('ak'), 'storedAk1234567890');

  assert.equal(candidates.length, 2);
  const [best] = candidates;
  assert.equal(best!.name, '江阴市永芳印刷有限公司');
  assert.equal(best!.address, '江苏省无锡市江阴市火车站路12号');
  assert.equal(best!.precision, 'place');
  // Stored coordinates are WGS-84: converting back gives Baidu's GCJ-02 point.
  const roundTrip = wgs84ToGcj02(best!.lat, best!.lng);
  assert.ok(Math.abs(roundTrip.lat - gcjLat) < 2e-6 && Math.abs(roundTrip.lng - gcjLng) < 2e-6);
  assert.ok(Math.abs(best!.lat - gcjLat) > 1e-3, 'WGS-84 must differ from the raw GCJ-02 point');

  const link = new URL(best!.map_url);
  assert.equal(link.origin + link.pathname, 'https://api.map.baidu.com/marker');
  assert.equal(link.searchParams.get('location'), `${gcjLat},${gcjLng}`);
  assert.equal(link.searchParams.get('coord_type'), 'gcj02');
  assert.equal(link.searchParams.get('title'), '江阴市永芳印刷有限公司');
});

test('geocodeLocation falls back to the name without its branch, then to the address', async () => {
  initializeDatabase();
  process.env.TRIPTRACK_BAIDU_AK = 'envAk1234567890abcd';
  try {
    const { fetchImpl, calls } = fakeBaidu([
      { status: 0, results: [] },
      { status: 0, results: [] },
      { status: 0, result: { location: { lat: 31.9, lng: 120.27 }, precise: 0, level: '道路' } }
    ]);
    const candidates = await geocodeLocation(WECHAT_TEXT, fetchImpl);
    assert.deepEqual(
      calls.map((u) => [u.pathname, u.searchParams.get('query') ?? u.searchParams.get('address')]),
      [
        ['/place/v2/search', '江阴市永芳印刷有限公司(火车站路)'],
        ['/place/v2/search', '江阴市永芳印刷有限公司'],
        ['/geocoding/v3/', '江阴市锡澄路辅路附近']
      ]
    );
    assert.equal(calls[0]!.searchParams.get('ak'), 'envAk1234567890abcd', 'env var wins over the stored setting');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.precision, 'address');

    // Nothing anywhere → empty list (address geocoding reports "no match" as status 1).
    const none = fakeBaidu([{ status: 0, results: [] }, { status: 0, results: [] }, { status: 1, msg: 'Internal Service Error:无相关结果' }]);
    assert.deepEqual(await geocodeLocation(WECHAT_TEXT, none.fetchImpl), []);
  } finally {
    delete process.env.TRIPTRACK_BAIDU_AK;
  }
});

test('Baidu configuration errors come back as actionable messages', async () => {
  initializeDatabase();
  await setSetting(BAIDU_AK_SETTING, 'storedAk1234567890');
  const cases: Array<[number, RegExp]> = [
    [240, /enable 地点检索 and 地理编码/],
    [210, /IP is not on the Baidu AK whitelist/],
    [200, /AK does not exist or is wrong/],
    [302, /daily quota/]
  ];
  for (const [status, message] of cases) {
    await assert.rejects(geocodeLocation(WECHAT_TEXT, fakeBaidu([{ status, message: 'x' }]).fetchImpl), message);
  }
  const unreachable = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await assert.rejects(geocodeLocation(WECHAT_TEXT, unreachable as never), /Could not reach Baidu Maps/);
});
