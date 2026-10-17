import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getSetting } from '../repositories/settingsRepository.ts';

// Turns something pasted into a supplier/place form into exact GPS coordinates:
//
// 1. A map-app share link (no account or key needed). A WeChat location opens in Amap (高德),
//    whose Share → Copy link gives a surl.amap.com short link that redirects to a URL carrying the
//    POI's exact coordinates, name, and address. Full Baidu (map.baidu.com) and Tencent (map.qq.com)
//    links carry coordinates in the URL too. Baidu short links (j.map.baidu.com) only resolve from
//    inside China, so those ask the user to open the link and copy the full address instead.
// 2. Plain text ("江阴市永芳印刷有限公司(火车站路) 江阴市锡澄路辅路附近", a WeChat location card copied
//    as text) via Baidu place search — only when a Baidu AK is configured (TRIPTRACK_BAIDU_AK, or
//    the local-only setting on the Admin page); Baidu requires a Chinese phone number to get one.
//
// Coordinates: Chinese maps use GCJ-02 (Amap, Tencent) or Baidu's own BD-09 / BD-09 Mercator,
// both offset several hundred metres from WGS-84. Everything is converted to WGS-84 for
// gps_lat/gps_lng so pins land correctly on the OpenStreetMap tiles the Map tab uses, while the
// stored map link stays the original share link, which opens exactly in the user's map app.

export const BAIDU_AK_SETTING = 'baidu_ak';
const BAIDU_BASE = 'https://api.map.baidu.com';
const TIMEOUT_MS = 8000;

export interface GeocodeCandidate {
  name: string;
  address: string;
  lat: number; // WGS-84
  lng: number; // WGS-84
  map_url: string;
  precision: 'place' | 'address';
}

export interface ParsedLocationText {
  name: string;
  address: string;
  city: string | null;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ---------- Parsing the pasted text ----------

export function parseLocationText(text: string): ParsedLocationText {
  const cleaned = text
    .replace(/\[(位置|Location)\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[　\s]+/g, ' ')
    .trim();
  // WeChat puts the place name first and its address after a space; names don't contain spaces.
  const space = cleaned.indexOf(' ');
  const name = space < 0 ? cleaned : cleaned.slice(0, space);
  const address = space < 0 ? '' : cleaned.slice(space + 1).trim();
  return { name, address, city: leadingCity(address) ?? leadingCity(name) };
}

// Chinese addresses run largest to smallest ("浙江省金华市义乌市福田路"), so drop the province and read
// the consecutive "…市" names at the start, keeping the most specific (a county-level city like
// 义乌市 or 江阴市 narrows the search best). Only leading names count — "…超市" mid-address is a shop.
function leadingCity(text: string): string | null {
  let rest = text.replace(/^[一-鿿]{2,7}?(省|自治区)/, '');
  let city: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = /^([一-鿿]{2,3}?市)/.exec(rest))) {
    city = match[1]!;
    rest = rest.slice(city.length);
  }
  return city;
}

// ---------- GCJ-02 → WGS-84 ----------

const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/** Inverse of wgs84ToGcj02 by fixed-point iteration — converges to well under a metre. */
export function gcj02ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng };
  let wgs = { lat, lng };
  for (let i = 0; i < 10; i++) {
    const gcj = wgs84ToGcj02(wgs.lat, wgs.lng);
    const dLat = gcj.lat - lat;
    const dLng = gcj.lng - lng;
    wgs = { lat: wgs.lat - dLat, lng: wgs.lng - dLng };
    if (Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9) break;
  }
  return { lat: Number(wgs.lat.toFixed(6)), lng: Number(wgs.lng.toFixed(6)) };
}

// ---------- BD-09 (Baidu) → GCJ-02 ----------

// Baidu's Mercator (BD-09MC, the "@X,Y" numbers in map.baidu.com URLs) → BD-09 lat/lng, using
// the band polynomials from Baidu's own map JS; then BD-09 → GCJ-02 with the standard inverse.
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5]
];

export function bd09mcToGcj02(x: number, y: number): { lat: number; lng: number } {
  const c = MC2LL[MCBAND.findIndex((band) => Math.abs(y) >= band)]!;
  const bdLng = (c[0]! + c[1]! * Math.abs(x)) * Math.sign(x);
  const t = Math.abs(y) / c[9]!;
  const bdLat = (c[2]! + c[3]! * t + c[4]! * t ** 2 + c[5]! * t ** 3 + c[6]! * t ** 4 + c[7]! * t ** 5 + c[8]! * t ** 6) * Math.sign(y);
  const px = bdLng - 0.0065;
  const py = bdLat - 0.006;
  const xPi = (Math.PI * 3000.0) / 180.0;
  const z = Math.sqrt(px * px + py * py) - 0.00002 * Math.sin(py * xPi);
  const theta = Math.atan2(py, px) - 0.000003 * Math.cos(px * xPi);
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) };
}

// ---------- Map-app share links ----------

// Only these hosts are ever fetched, and only to read their redirect Location — never the
// final page — so a pasted URL can't make the server request arbitrary/internal addresses.
const SHORT_LINK_HOSTS = new Set(['surl.amap.com', 'j.map.baidu.com', 'maps.app.goo.gl', 'goo.gl']);
const MAX_HOPS = 5;

type RedirectFetch = (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

/**
 * Fetch one URL without following redirects, trying each of the host's addresses in turn
 * (IPv4 first) with a short per-address timeout. surl.amap.com publishes 8 addresses, and from
 * outside China several of them (all IPv6, plus some IPv4) silently drop connections — global
 * fetch() commits to one address and times out, while curl moves on to the next. This does what
 * curl does.
 */
export async function fetchRedirect(
  url: string,
  options: {
    resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
    attemptTimeoutMs?: number;
  } = {}
): Promise<{ status: number; headers: { get(name: string): string | null } }> {
  const target = new URL(url);
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const addresses = [...(await resolve(target.hostname))].sort((a, b) => a.family - b.family);
  let lastError: unknown = new Error(`No addresses for ${target.hostname}`);
  for (const { address, family } of addresses) {
    try {
      const res = await new Promise<IncomingMessage>((resolveRes, reject) => {
        const req = (target.protocol === 'http:' ? httpRequest : httpsRequest)(
          target,
          {
            headers: { 'user-agent': BROWSER_UA },
            // Pin this attempt to one address; TLS SNI and Host still use the hostname.
            lookup: (_host, opts, callback) =>
              (opts as { all?: boolean }).all
                ? (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }])
                : callback(null, address, family),
            timeout: options.attemptTimeoutMs ?? 3000
          },
          resolveRes
        );
        req.on('timeout', () => req.destroy(new Error(`timed out connecting to ${address}`)));
        req.on('error', reject);
        req.end();
      });
      res.resume();
      return {
        status: res.statusCode ?? 0,
        headers: {
          get: (name: string) => {
            const value = res.headers[name.toLowerCase()];
            return (Array.isArray(value) ? value[0] : value) ?? null;
          }
        }
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function wgsCandidate(gcjLat: number, gcjLng: number, name: string, address: string, mapUrl: string): GeocodeCandidate {
  const wgs = gcj02ToWgs84(gcjLat, gcjLng);
  return { name, address, lat: wgs.lat, lng: wgs.lng, map_url: mapUrl, precision: 'place' };
}

function finite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

/** Parse coordinates out of a resolved Amap / Baidu / Tencent map URL. */
export function parseMapUrl(url: URL, shareUrl: string): GeocodeCandidate | null {
  const host = url.hostname;
  const param = (name: string) => url.searchParams.get(name);

  if (host.endsWith('amap.com')) {
    // wb.amap.com/?p=POIID,lat,lng,name,address   (a shared place)
    // wb.amap.com/?q=lat,lng,label                 (a shared map point)
    // uri.amap.com/marker?position=lng,lat&name=…  (URI API)
    const p = param('p')?.split(',');
    if (p && p.length >= 3 && finite(Number(p[1]), Number(p[2]))) {
      return wgsCandidate(Number(p[1]), Number(p[2]), p[3] || 'Amap location', p.slice(4).join(',') || '', shareUrl);
    }
    const q = param('q')?.split(',');
    if (q && q.length >= 2 && finite(Number(q[0]), Number(q[1]))) {
      const label = q.slice(2).join(',');
      return wgsCandidate(Number(q[0]), Number(q[1]), label || 'Amap location', label, shareUrl);
    }
    const position = param('position')?.split(',');
    if (position && position.length >= 2 && finite(Number(position[0]), Number(position[1]))) {
      return wgsCandidate(Number(position[1]), Number(position[0]), param('name') || 'Amap location', '', shareUrl);
    }
  }

  if (/(^|\.)google\.[a-z.]+$/.test(host) && url.pathname.startsWith('/maps')) {
    // google.com/maps/place/NAME/@lat,lng,17z/data=…!3dLAT!4dLNG  — !3d/!4d is the exact pin,
    // @ is only the viewport centre. Google coordinates are used as WGS-84.
    const path = decodeURIComponent(url.pathname + url.search);
    const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(path);
    const view = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path);
    const query = /[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path);
    const hit = pin ?? query ?? view;
    if (hit && finite(Number(hit[1]), Number(hit[2]))) {
      const name = /\/place\/([^/@]+)/.exec(path)?.[1]?.replace(/\+/g, ' ') ?? 'Google Maps location';
      return { name, address: '', lat: Number(hit[1]), lng: Number(hit[2]), map_url: shareUrl, precision: 'place' };
    }
  }

  if (host.endsWith('map.baidu.com')) {
    // map.baidu.com/poi/NAME/@X,Y,17z…  or  …/place/detail/…&sharegeo=X,Y  (BD-09 Mercator)
    const decodedPath = decodeURIComponent(url.pathname + url.search);
    const mc = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/.exec(decodedPath) ?? /sharegeo=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(decodedPath);
    if (mc) {
      const gcj = bd09mcToGcj02(Number(mc[1]), Number(mc[2]));
      const name = /\/poi\/([^/@]+)\//.exec(decodedPath)?.[1] ?? 'Baidu location';
      return wgsCandidate(gcj.lat, gcj.lng, name, '', shareUrl);
    }
  }

  if (host.endsWith('map.qq.com')) {
    // map.qq.com/?pointx=lng&pointy=lat&name=…   or   apis.map.qq.com/uri/v1/marker?marker=coord:lat,lng;title:…
    const pointx = Number(param('pointx'));
    const pointy = Number(param('pointy'));
    if (param('pointx') && finite(pointx, pointy)) {
      return wgsCandidate(pointy, pointx, param('name') || 'Tencent Maps location', param('addr') || '', shareUrl);
    }
    const marker = /coord:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:;title:([^;]*))?(?:;addr:([^;]*))?/.exec(param('marker') ?? '');
    if (marker) {
      return wgsCandidate(Number(marker[1]), Number(marker[2]), marker[3] || 'Tencent Maps location', marker[4] || '', shareUrl);
    }
  }
  return null;
}

/**
 * Resolve a map-app share link to exact coordinates without any API key, following short-link
 * redirects (Amap's surl.amap.com) by reading Location headers hop by hop.
 */
export async function resolveMapLink(link: string, fetchImpl: RedirectFetch = fetchRedirect as unknown as RedirectFetch): Promise<GeocodeCandidate | null> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  for (let hop = 0; hop < MAX_HOPS && SHORT_LINK_HOSTS.has(url.hostname); hop++) {
    let res;
    try {
      res = await fetchImpl(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': BROWSER_UA }
      });
    } catch {
      if (url.hostname === 'j.map.baidu.com') {
        throw new Error('Baidu short links only open from inside China — open the link in your browser, then copy the full map.baidu.com address from the address bar and paste that here');
      }
      throw new Error(`Could not open ${url.hostname} — check the link, or paste GPS coordinates instead`);
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) {
      throw new Error(`That ${url.hostname} link did not lead to a location — it may have expired; share it again from the map app`);
    }
    // Amap's redirect Location carries raw UTF-8 (Chinese names) that arrives decoded as latin1.
    url = new URL(Buffer.from(location, 'latin1').toString('utf8'), url);
  }
  return parseMapUrl(url, link);
}

// ---------- Baidu ----------

// Baidu's status codes that point at configuration, not at the query.
const BAIDU_STATUS_HELP: Record<number, string> = {
  101: 'the Baidu AK is missing',
  102: 'this server is not allowed to use the Baidu AK — in the Baidu console, set the AK type to 服务端 (server) and add this server’s IP to the whitelist (or use 0.0.0.0/0)',
  200: 'the Baidu AK does not exist or is wrong',
  210: 'this server’s IP is not on the Baidu AK whitelist',
  211: 'the Baidu AK requires an SN signature — switch it to IP-whitelist verification in the Baidu console',
  240: 'the Baidu AK does not have this service enabled — enable 地点检索 and 地理编码 for it in the Baidu console',
  302: 'the Baidu AK has used up its daily quota',
  401: 'Baidu is rate-limiting this AK — try again in a moment'
};

export async function getBaiduAk(): Promise<string | null> {
  return process.env.TRIPTRACK_BAIDU_AK || (await getSetting(BAIDU_AK_SETTING)) || null;
}

function baiduMarkerUrl(gcjLat: number, gcjLng: number, title: string, content: string): string {
  const params = new URLSearchParams({
    location: `${gcjLat},${gcjLng}`,
    title,
    content,
    output: 'html',
    coord_type: 'gcj02',
    src: 'webapp.triptrack.triptrack'
  });
  return `${BAIDU_BASE}/marker?${params}`;
}

async function callBaidu(path: string, params: Record<string, string>, ak: string, fetchImpl: FetchLike): Promise<any> {
  const query = new URLSearchParams({ ...params, output: 'json', ret_coordtype: 'gcj02ll', ak });
  let res;
  try {
    res = await fetchImpl(`${BAIDU_BASE}${path}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach Baidu Maps: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    throw new Error(`Baidu Maps returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { status?: number | string; message?: string; msg?: string };
  const status = Number(body.status);
  if (status !== 0) {
    // Geocoding reports "no match" as status 1; treat it as an empty result rather than an error.
    if (status === 1 && path.startsWith('/geocoding')) return null;
    const help = BAIDU_STATUS_HELP[status];
    throw new Error(`Baidu Maps error ${status}: ${help ?? body.message ?? body.msg ?? 'unknown error'}`);
  }
  return body;
}

interface BaiduPlace {
  name?: string;
  address?: string;
  province?: string;
  city?: string;
  area?: string;
  location?: { lat: number; lng: number };
}

async function searchPlaces(query: string, city: string | null, ak: string, fetchImpl: FetchLike): Promise<GeocodeCandidate[]> {
  const body = await callBaidu(
    '/place/v2/search',
    { query, region: city ?? '全国', city_limit: 'false', scope: '1', page_size: '5' },
    ak,
    fetchImpl
  );
  const results = (body?.results ?? []) as BaiduPlace[];
  return results
    .filter((place) => place.location && typeof place.location.lat === 'number' && place.name)
    .map((place) => {
      const address = [place.province, place.city, place.area, place.address]
        .filter((part, index, parts) => part && parts.indexOf(part) === index)
        .join('');
      const wgs = gcj02ToWgs84(place.location!.lat, place.location!.lng);
      return {
        name: place.name!,
        address,
        lat: wgs.lat,
        lng: wgs.lng,
        map_url: baiduMarkerUrl(place.location!.lat, place.location!.lng, place.name!, address),
        precision: 'place' as const
      };
    });
}

async function geocodeAddress(address: string, city: string | null, ak: string, fetchImpl: FetchLike): Promise<GeocodeCandidate[]> {
  const body = await callBaidu('/geocoding/v3/', { address, ...(city ? { city } : {}) }, ak, fetchImpl);
  const location = body?.result?.location as { lat: number; lng: number } | undefined;
  if (!location) return [];
  const wgs = gcj02ToWgs84(location.lat, location.lng);
  return [{ name: address, address, lat: wgs.lat, lng: wgs.lng, map_url: baiduMarkerUrl(location.lat, location.lng, address, address), precision: 'address' }];
}

export const SHARE_LINK_HELP =
  'To pin it exactly: in WeChat, open the location → tap the navigation button → choose Amap (高德地图) → Share → Copy link, then paste that link here';

/**
 * A share link wins (exact, no key). Otherwise plain text goes to Baidu place search when a
 * Baidu AK is configured: the exact place name, then the name without its "(branch)" suffix,
 * then the address alone (street-level precision), stopping at the first step with results.
 */
export async function geocodeLocation(
  text: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  redirectFetch?: RedirectFetch
): Promise<GeocodeCandidate[]> {
  const raw = String(text ?? '');
  const link = /https?:\/\/[^\s，。]+/.exec(raw)?.[0];
  if (link) {
    const candidate = await resolveMapLink(link, redirectFetch);
    if (!candidate) {
      throw new Error(`No location found in that link. ${SHARE_LINK_HELP}`);
    }
    return [candidate];
  }

  const parsed = parseLocationText(raw);
  if (!parsed.name) {
    throw new Error('Paste a Google Maps/Amap/Baidu share link, GPS coordinates, or a WeChat location');
  }
  const ak = await getBaiduAk();
  if (!ak) {
    throw new Error(`Plain text can't be pinned exactly without a map service account. ${SHARE_LINK_HELP}`);
  }

  const baseName = parsed.name.replace(/[（(][^）)]*[）)]$/, '');
  const attempts: Array<() => Promise<GeocodeCandidate[]>> = [
    () => searchPlaces(parsed.name, parsed.city, ak, fetchImpl),
    ...(baseName !== parsed.name ? [() => searchPlaces(baseName, parsed.city, ak, fetchImpl)] : []),
    ...(parsed.address ? [() => geocodeAddress(parsed.address, parsed.city, ak, fetchImpl)] : [])
  ];
  for (const attempt of attempts) {
    const candidates = await attempt();
    if (candidates.length > 0) return candidates;
  }
  return [];
}
