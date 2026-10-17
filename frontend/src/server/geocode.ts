import { getSetting } from '../repositories/settingsRepository.ts';

// Turns a pasted place description — typically a WeChat "share location" card copied as text,
// e.g. "江阴市永芳印刷有限公司(火车站路) 江阴市锡澄路辅路附近" — into GPS coordinates via Baidu Maps.
//
// Baidu needs a server-side API key (AK). It's read from TRIPTRACK_BAIDU_AK, or else from the
// local-only settings table (set on the Admin page), so it never ships to the browser or syncs.
//
// Coordinates: Baidu returns GCJ-02 here (ret_coordtype=gcj02ll), China's legally mandated
// offset datum. Raw GCJ-02 lands several hundred metres off on WGS-84 maps such as the
// OpenStreetMap tiles the Map tab uses, so results are converted to WGS-84 for gps_lat/gps_lng.
// The map link keeps GCJ-02 and opens in Baidu Maps, where it is exact.

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

/**
 * Best matches first: the exact place name, then the name without its "(branch)" suffix, then
 * the address alone (street-level precision). Stops at the first step that finds something.
 */
export async function geocodeLocation(text: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<GeocodeCandidate[]> {
  const parsed = parseLocationText(String(text ?? ''));
  if (!parsed.name) {
    throw new Error('Paste a place name and address, e.g. from a WeChat location');
  }
  const ak = await getBaiduAk();
  if (!ak) {
    throw new Error('Baidu Maps lookup is not set up yet — an admin can add a Baidu AK on the Admin page');
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
