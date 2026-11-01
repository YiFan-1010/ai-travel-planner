/**
 * 高德 POI 搜索
 *
 * 为什么要接商业服务：Photon / Nominatim 在国内被 DNS 污染，
 * 实测解析到内网地址，完全不可达。高德实测 0.5 秒内返回。
 *
 * 注意：高德返回 GCJ-02，这里立刻转成 WGS-84 再往外交，
 * 应用内部永远只见 WGS-84，偏移不外溢。
 */
import { gcj02ToWgs84 } from '../coord';
import type { PlaceCandidate } from '../types';

const ENDPOINT = 'https://restapi.amap.com/v3/place/text';
const TIMEOUT = 9000;

interface AmapPoi {
  name?: string;
  location?: string;
  address?: string;
  pname?: string;
  cityname?: string;
  adname?: string;
  typecode?: string;
}

interface AmapResponse {
  status?: string;
  info?: string;
  infocode?: string;
  pois?: AmapPoi[];
}

/** 与 Photon 通道保持一致的名称匹配评分 */
function nameScore(candidateName: string, query: string): number {
  const a = candidateName.replace(/\s+/g, '');
  const b = query.replace(/\s+/g, '');
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 72;
  if (a.includes(b)) return 60;
  if (b.includes(a) && a.length >= 2) return 40;
  /* 字符覆盖率：「西溪湿地」要能命中「西溪国家湿地公园」这类中间插字的官方全称。
     限定查询词至少 3 个字，避免「西湖」误命中「西湖区」。 */
  const qChars = new Set(b);
  if (qChars.size >= 3) {
    let covered = 0;
    qChars.forEach((ch) => {
      if (a.includes(ch)) covered += 1;
    });
    if (covered / qChars.size >= 0.8) return 30;
  }
  return 0;
}

/** 高德 typecode 前缀：停车/出入口/公交站对行程没价值 */
function kindBias(typecode: string): number {
  if (typecode.startsWith('1509') || typecode.startsWith('1507')) return -18; // 停车场/加油站
  if (typecode.startsWith('1505')) return -14; // 公交站
  if (typecode.startsWith('1502')) return -6; // 地铁站
  if (typecode.startsWith('1101') || typecode.startsWith('1102')) return 10; // 风景名胜/公园
  if (typecode.startsWith('1401') || typecode.startsWith('1402')) return 8; // 博物馆/展览馆
  return 0;
}

/**
 * 按名称搜 POI。
 * @throws 网络或配额问题会抛出，调用方据此切换到下一个数据源
 */
export async function amapSearch(
  name: string,
  city: string,
  limit: number,
  key: string
): Promise<PlaceCandidate[]> {
  if (!key) throw new Error('未配置高德 Key');

  const query = name.trim();
  if (!query) return [];

  const params = new URLSearchParams({
    keywords: query,
    city: city || '全国',
    citylimit: city ? 'true' : 'false',
    offset: String(Math.max(1, Math.min(10, limit))),
    page: '1',
    extensions: 'base',
    key,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  let data: AmapResponse;
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as AmapResponse;
  } finally {
    clearTimeout(timer);
  }

  if (data.status !== '1') {
    const code = data.infocode ?? '';
    /* 10020/10021/10019 都是并发或频率超限，等一会重试即可 */
    const rateLimited = ['10019', '10020', '10021', '10003', '10004'].includes(code);
    const err = new Error(
      `${rateLimited ? 'RATE_LIMIT' : 'AMAP_ERROR'} ${code} ${data.info ?? ''}`.trim()
    );
    (err as Error & { rateLimited?: boolean }).rateLimited = rateLimited;
    throw err;
  }

  const pois = Array.isArray(data.pois) ? data.pois : [];
  const out: PlaceCandidate[] = [];

  for (const p of pois) {
    const poiName = (p.name ?? '').trim();
    const loc = (p.location ?? '').trim();
    if (!poiName || !loc) continue;

    const [lngRaw, latRaw] = loc.split(',').map(Number);
    if (!Number.isFinite(latRaw) || !Number.isFinite(lngRaw)) continue;

    /* 高德给的是 GCJ-02，立刻转 WGS-84 */
    const [lat, lng] = gcj02ToWgs84(latRaw, lngRaw);

    const base = nameScore(poiName, query);
    if (base <= 0) continue;

    const typecode = p.typecode ?? '';
    const address = [p.pname, p.cityname, p.adname, p.address]
      .filter((v) => v && v !== '[]')
      .join(' ');

    out.push({
      name: poiName,
      address,
      lat,
      lng,
      kind: typecode,
      score: base + kindBias(typecode),
      source: 'amap',
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
