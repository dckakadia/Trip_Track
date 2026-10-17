import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from '../db/migrations.ts';
import { setSetting } from '../repositories/settingsRepository.ts';
import { createServer } from 'node:http';
import { BAIDU_AK_SETTING, bd09mcToGcj02, fetchRedirect, gcj02ToWgs84, geocodeLocation, parseLocationText, parseMapUrl, resolveMapLink, wgs84ToGcj02 } from './geocode.ts';

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

test('plain text without a Baidu AK explains how to get an exact share link instead', async () => {
  initializeDatabase();
  delete process.env.TRIPTRACK_BAIDU_AK;
  await assert.rejects(geocodeLocation(WECHAT_TEXT, fakeBaidu([]).fetchImpl), /Amap \(高德地图\) → Share → Copy link/);
  await assert.rejects(geocodeLocation('   ', fakeBaidu([]).fetchImpl), /Paste an Amap\/Baidu share link/);
});

// --- Share links (no key needed) ---

function fakeRedirects(hops: Record<string, { status: number; location?: string }>) {
  const fetched: string[] = [];
  const redirectFetch = async (url: string) => {
    fetched.push(url);
    const hop = hops[url];
    if (!hop) throw new Error('connect ETIMEDOUT');
    return { status: hop.status, headers: { get: (name: string) => (name === 'location' ? hop.location ?? null : null) } };
  };
  return { redirectFetch, fetched };
}

test('an Amap short link resolves through its redirect to exact, converted coordinates', async () => {
  // Real redirect shape (captured from surl.amap.com): Location carries raw UTF-8 Chinese,
  // which fetch hands over decoded as latin1.
  const target = 'http://wb.amap.com/?p=B0LUC7X3BN,22.593418,113.875046,深圳市昊想科技有限公司,西乡街道臣田工业区36栋401室';
  const { redirectFetch, fetched } = fakeRedirects({
    'https://surl.amap.com/PtA5D4u4pD': { status: 302, location: Buffer.from(target, 'utf8').toString('latin1') }
  });
  const pasted = '深圳市昊想科技有限公司 https://surl.amap.com/PtA5D4u4pD 复制链接打开高德地图';
  const [candidate] = await geocodeLocation(pasted, fakeBaidu([]).fetchImpl, redirectFetch);
  assert.deepEqual(fetched, ['https://surl.amap.com/PtA5D4u4pD'], 'only the short-link host is fetched, never the target');
  assert.equal(candidate!.name, '深圳市昊想科技有限公司');
  assert.equal(candidate!.address, '西乡街道臣田工业区36栋401室');
  assert.equal(candidate!.map_url, 'https://surl.amap.com/PtA5D4u4pD');
  assert.equal(candidate!.precision, 'place');
  // Stored WGS-84 converts back to Amap's GCJ-02 point.
  const back = wgs84ToGcj02(candidate!.lat, candidate!.lng);
  assert.ok(Math.abs(back.lat - 22.593418) < 2e-6 && Math.abs(back.lng - 113.875046) < 2e-6, JSON.stringify(back));
});

test('Amap, Baidu, and Tencent full links parse with the right axis order and datum', () => {
  const near = (c: { lat: number; lng: number } | null, gcjLat: number, gcjLng: number) => {
    assert.ok(c);
    const back = wgs84ToGcj02(c.lat, c.lng);
    assert.ok(Math.abs(back.lat - gcjLat) < 2e-6 && Math.abs(back.lng - gcjLng) < 2e-6, `${JSON.stringify(back)} vs ${gcjLat},${gcjLng}`);
  };
  const parse = (url: string) => parseMapUrl(new URL(url), url);

  near(parse('https://wb.amap.com/?q=31.222811749011463%2C121.46840706467624%2C%E4%B8%8A%E6%B5%B7%E5%B8%82%E9%BB%84%E6%B5%A6%E5%8C%BA&src=app_C3090'), 31.222811749011463, 121.46840706467624);
  assert.equal(parse('https://wb.amap.com/?q=31.2228,121.4684,上海市黄浦区')!.name, '上海市黄浦区');
  // URI API puts longitude first.
  near(parse('https://uri.amap.com/marker?position=120.268741,31.906512&name=永芳印刷'), 31.906512, 120.268741);

  // Baidu Mercator → GCJ-02 reproduces GeoShare's reference conversions.
  const refs: Array<[number, number, number, number]> = [
    [13520653, 3317203, 28.696786436412197, 121.45032959369264],
    [12613508.26, 2629182.88, 23.110319308993134, 113.30138024838311]
  ];
  for (const [x, y, lat, lng] of refs) {
    const gcj = bd09mcToGcj02(x, y);
    assert.ok(Math.abs(gcj.lat - lat) < 1e-7 && Math.abs(gcj.lng - lng) < 1e-7, JSON.stringify(gcj));
  }
  const baidu = parse('https://map.baidu.com/poi/%E5%9C%B0%E5%9B%BE%E4%B8%8A%E7%9A%84%E7%82%B9/@13520653,3317203,17z?querytype=share&poiShareId=p8cdf');
  near(baidu, 28.696786436412197, 121.45032959369264);
  assert.equal(baidu!.name, '地图上的点');
  near(
    parse('https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=p8cdf/act=read_share&vt=map&sharegeo=12613508.26%2C2629182.88'),
    23.110319308993134,
    113.30138024838311
  );

  // Tencent: pointx is longitude; marker=coord: is lat,lng.
  near(parse('https://map.qq.com/?type=marker&pointx=120.268741&pointy=31.906512&name=永芳'), 31.906512, 120.268741);
  const qq = parse('https://apis.map.qq.com/uri/v1/marker?marker=coord:31.906512,120.268741;title:永芳印刷;addr:锡澄路');
  near(qq, 31.906512, 120.268741);
  assert.deepEqual([qq!.name, qq!.address], ['永芳印刷', '锡澄路']);

  // Links without coordinates yield nothing.
  assert.equal(parse('https://map.baidu.com/?poiShareId=p8cdf0522067cf66173901fc9e4'), null);
  assert.equal(parse('https://example.com/?q=31.2,121.4'), null);
});

test('share links never make the server fetch other hosts, and failures explain what to do', async () => {
  // Internal / arbitrary hosts are parsed, never fetched.
  const internal = fakeRedirects({});
  await assert.rejects(geocodeLocation('http://127.0.0.1:4600/api/sync/pull', fakeBaidu([]).fetchImpl, internal.redirectFetch), /No location found in that link/);
  assert.deepEqual(internal.fetched, []);
  // A short link redirecting somewhere internal stops after that one hop.
  const bounce = fakeRedirects({ 'https://surl.amap.com/evil': { status: 302, location: 'http://127.0.0.1:4600/x' } });
  await assert.rejects(geocodeLocation('https://surl.amap.com/evil', fakeBaidu([]).fetchImpl, bounce.redirectFetch), /No location found/);
  assert.deepEqual(bounce.fetched, ['https://surl.amap.com/evil']);

  // Baidu short links time out outside China.
  await assert.rejects(resolveMapLink('https://j.map.baidu.com/0f/tbWk', fakeRedirects({}).redirectFetch), /copy the full map\.baidu\.com address/);
  // An expired Amap link answers 200 with no redirect.
  const expired = fakeRedirects({ 'https://surl.amap.com/old': { status: 200 } });
  await assert.rejects(resolveMapLink('https://surl.amap.com/old', expired.redirectFetch), /may have expired/);
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

test('fetchRedirect skips addresses that drop connections and reads the redirect from a live one', async () => {
  // Like surl.amap.com seen from outside China: some published addresses never answer.
  const target = 'https://wb.amap.com/?q=31.80362316949228%2C120.24947181344031%2C%E9%94%A1%E6%BE%84%E8%B7%AF1071%E5%8F%B7';
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: target });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const started = Date.now();
    const res = await fetchRedirect(`http://short.example:${port}/2fsYh1aS69Go`, {
      resolve: async () => [
        { address: '192.0.2.1', family: 4 }, // TEST-NET-1: blackholed, never connects
        { address: '127.0.0.1', family: 4 }
      ],
      attemptTimeoutMs: 300
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), target);
    assert.ok(Date.now() - started < 3000, 'gave up on the dead address quickly');

    // Every address dead → the error surfaces.
    await assert.rejects(
      fetchRedirect(`http://short.example:${port}/x`, { resolve: async () => [{ address: '192.0.2.1', family: 4 }], attemptTimeoutMs: 200 }),
      /timed out connecting to 192\.0\.2\.1/
    );
  } finally {
    server.close();
  }
  // The resolved link's q=lat,lng,label shape (the user's real link) parses to a converted point.
  const parsed = parseMapUrl(new URL(target), 'https://surl.amap.com/2fsYh1aS69Go');
  assert.equal(parsed!.name, '锡澄路1071号');
  const back = wgs84ToGcj02(parsed!.lat, parsed!.lng);
  assert.ok(Math.abs(back.lat - 31.80362316949228) < 2e-6 && Math.abs(back.lng - 120.24947181344031) < 2e-6);
});
