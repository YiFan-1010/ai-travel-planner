/**
 * Agent 工具层
 *
 * 每个工具都是「一个确定性的外部能力」：查坐标、算路线、量距离。
 * 模型只负责决策「查什么、怎么排」，不再自己编造经纬度。
 *
 * 地理编码有多条通道，按可用性自动切换：
 *   ① 高德    国内可达（0.5s），POI 精准，需 Key，返回 GCJ-02 已转 WGS-84
 *   ② Photon  免 Key，但国内 DNS 被污染，连续失败后自动熔断
 *   ③ 兜底    两条都不可用时返回空，由上层决定用模型给的坐标
 *
 * 路线规划走 OSRM Demo（实测国内 1.5s 可达）。
 */
import { amapSearch } from './geo/amap';
import type { PlaceCandidate, RouteLeg } from './types';

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';
const OSRM_ENDPOINT = 'https://router.project-osrm.org/route/v1';
const CACHE_PREFIX = 'ai_geo_v2:';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 9000;

/* ------------------------------------------------------------------ */
/* 数据源配置                                                          */
/* ------------------------------------------------------------------ */

export interface GeoConfig {
  /** 高德 Web 服务 Key，配置后优先使用 */
  amapKey?: string;
  /** 强制关闭 Photon（已知网络不可达时可省掉 9 秒超时） */
  disablePhoton?: boolean;
}

let geoConfig: GeoConfig = {};

export function setGeoConfig(cfg: GeoConfig): void {
  geoConfig = { ...geoConfig, ...cfg };
}

export function getGeoConfig(): GeoConfig {
  return { ...geoConfig };
}

/* ------------------------------------------------------------------ */
/* 缓存（按数据源隔离，换源后不会命中旧结果）                            */
/* ------------------------------------------------------------------ */

function readCache(key: string): PlaceCandidate[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { t: number; v: PlaceCandidate[] };
    if (!obj || !Array.isArray(obj.v)) return null;
    if (Date.now() - obj.t > CACHE_TTL) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return obj.v;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: PlaceCandidate[]): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    /* 配额满或隐私模式，忽略 */
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== 'object') return '';
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/* ------------------------------------------------------------------ */
/* 距离                                                                */
/* ------------------------------------------------------------------ */

/** 两点球面距离，单位米 */
export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(x))));
}

/* ------------------------------------------------------------------ */
/* Photon 通道                                                         */
/* ------------------------------------------------------------------ */

interface PhotonFeature {
  geometry?: { coordinates?: unknown };
  properties?: unknown;
}

const ADMIN_KINDS = new Set(['city', 'state', 'country', 'district', 'county', 'region']);

const KIND_BIAS: Record<string, number> = {
  attraction: 12,
  museum: 10,
  gallery: 8,
  viewpoint: 9,
  zoo: 9,
  theme_park: 9,
  park: 7,
  nature_reserve: 7,
  place_of_worship: 6,
  restaurant: 6,
  cafe: 5,
  marketplace: 5,
  mall: 4,
  station: -12,
  bus_stop: -14,
  parking: -16,
  fuel: -16,
  bank: -16,
  atm: -18,
};

function toCandidate(f: PhotonFeature): PlaceCandidate | null {
  const coords = f.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const props = f.properties;
  const name = pickString(props, 'name') || pickString(props, 'street');
  if (!name) return null;

  const parts = [
    pickString(props, 'city'),
    pickString(props, 'district'),
    pickString(props, 'street'),
    pickString(props, 'housenumber'),
  ].filter(Boolean);

  return {
    name,
    address: parts.join(' ') || pickString(props, 'state'),
    lat,
    lng,
    kind: pickString(props, 'osm_value'),
    score: 0,
    source: 'photon',
  };
}

function nameScore(candidateName: string, query: string): number {
  const a = candidateName.replace(/\s+/g, '');
  const b = query.replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 72;
  if (a.includes(b)) return 60;
  if (b.includes(a) && a.length >= 2) return 40;
  if (a.slice(0, 2) === b.slice(0, 2) && b.length >= 3) return 18;
  return 0;
}

/** Photon 连续失败次数，达到阈值就熔断，避免每个地点都等满 9 秒 */
let photonFailStreak = 0;
const PHOTON_BREAK_AFTER = 2;

async function photonSearch(
  query: string,
  city: string,
  limit: number
): Promise<PlaceCandidate[]> {
  const q = city && !query.includes(city) ? `${city} ${query}` : query;
  const url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(q)}&limit=12&lang=default`;

  let data: unknown;
  try {
    data = await fetchJson(url);
    photonFailStreak = 0;
  } catch {
    photonFailStreak += 1;
    throw new Error('Photon 不可达');
  }

  const features = (data as { features?: PhotonFeature[] })?.features;
  if (!Array.isArray(features)) return [];

  const out: PlaceCandidate[] = [];
  for (const f of features) {
    const c = toCandidate(f);
    if (!c) continue;
    let score = nameScore(c.name, query);
    if (score <= 0) continue;
    if (city && c.address.includes(city)) score += 12;
    if (ADMIN_KINDS.has(c.kind)) score -= 45;
    score += KIND_BIAS[c.kind] ?? 0;
    c.score = score;
    out.push(c);
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 统一入口：多源分发                                                   */
/* ------------------------------------------------------------------ */

/**
 * 查一个地名的真实坐标。
 *
 * 优先走高德（国内可达、POI 精准），失败再试 Photon。
 * 两条都不可用时返回空数组——调用方应据此走「模型坐标 + 路线校验」的降级路径。
 *
 * @param name 地点名，如「武侯祠」
 * @param city 所属城市，用来消歧
 * @param limit 返回候选数，默认 3
 */
export async function searchPlace(
  name: string,
  city = '',
  limit = 3
): Promise<PlaceCandidate[]> {
  const query = name.trim();
  if (!query) return [];

  const useAmap = Boolean(geoConfig.amapKey);
  const cacheKey = `${useAmap ? 'amap' : 'photon'}|${city}|${query}|${limit}`;

  const cached = readCache(cacheKey);
  if (cached) return cached;

  /* ① 高德 */
  if (useAmap && geoConfig.amapKey) {
    try {
      const list = await amapSearch(query, city, limit, geoConfig.amapKey);
      if (list.length > 0) {
        writeCache(cacheKey, list);
        return list;
      }
    } catch {
      /* 配额或网络问题，落下一个通道 */
    }
  }

  /* ② Photon（熔断后跳过） */
  if (!geoConfig.disablePhoton && photonFailStreak < PHOTON_BREAK_AFTER) {
    try {
      const list = await photonSearch(query, city, limit);
      if (list.length > 0) {
        writeCache(cacheKey, list);
        return list;
      }
    } catch {
      /* 已计数 */
    }
  }

  return [];
}

/* ------------------------------------------------------------------ */
/* 批量地理编码                                                        */
/* ------------------------------------------------------------------ */

/**
 * 并发查询一批地名的坐标，单点失败不影响整体。
 * 这是 Agent 把「模型编的假坐标」换成「真实坐标」的核心一步。
 *
 * 高德对并发友好，但 Photon 突发并发会被拒，
 * 所以默认 3 路 + 请求间隔 + 失败退避重试。
 */
export async function geocodeAll(
  names: string[],
  city: string,
  onEach?: (name: string, hit: PlaceCandidate | null) => void,
  concurrency = 3
): Promise<Map<string, PlaceCandidate>> {
  const result = new Map<string, PlaceCandidate>();
  const queue = Array.from(new Set(names.filter(Boolean)));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const name = queue[cursor++];
      let hit: PlaceCandidate | null = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const list = await searchPlace(name, city, 1);
          hit = list[0] ?? null;
          break;
        } catch {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
        }
      }

      if (hit) result.set(name, hit);
      onEach?.(name, hit);
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    () => worker()
  );
  await Promise.all(workers);
  return result;
}

/* ------------------------------------------------------------------ */
/* 路线可行性                                                          */
/* ------------------------------------------------------------------ */

/**
 * 让 OSRM 算一段行程的真实距离与耗时，用来判断某一天是否排得太满。
 * 失败返回 null，调用方按「无法判断」处理，不阻断主流程。
 */
export async function routeFeasibility(
  points: Array<[number, number]>,
  profile: 'driving' | 'foot' = 'driving'
): Promise<RouteLeg | null> {
  if (!Array.isArray(points) || points.length < 2) return null;

  const path = points.map((p) => `${p[0]},${p[1]}`).join(';');
  const url = `${OSRM_ENDPOINT}/${profile}/${path}?overview=false`;

  try {
    const data = (await fetchJson(url)) as {
      routes?: Array<{ distance?: number; duration?: number }>;
    };
    const route = data?.routes?.[0];
    if (!route || typeof route.distance !== 'number') return null;
    return {
      distance: Math.round(route.distance),
      duration: Math.round(route.duration ?? 0),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 统一出口                                                            */
/* ------------------------------------------------------------------ */

export const tools = {
  searchPlace,
  geocodeAll,
  routeFeasibility,
  haversine,
  setGeoConfig,
  getGeoConfig,
};
