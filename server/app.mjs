/**
 * 服务端：静态托管 + API 代理 + 限流
 *
 * 存在意义只有一个 —— 把 API Key 留在服务端，不让它进浏览器。
 * 顺带做了限流，防止演示链接被刷爆额度。
 *
 * 零依赖：只用 Node 18+ 内置的 http / fs / fetch。
 * 同一份 handler 被 vite dev 中间件和线上 Node 服务复用，本地线上行为一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const DEFAULTS = {
  DEEPSEEK_BASE: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-chat',
  AMAP_ENDPOINT: 'https://restapi.amap.com/v3/place/text',
  /* 单个 IP 每小时可用的对话次数 */
  RL_CHAT_PER_HOUR: 12,
  /* 单个 IP 每小时可用的地理编码次数（一次行程约 10-15 次） */
  RL_GEO_PER_HOUR: 120,
  /* 全局每日对话上限，兜住额度 */
  RL_CHAT_PER_DAY: 220,
  RL_GEO_PER_DAY: 4000,
};

/* ------------------------------------------------------------------ */
/* 限流：进程内滑动窗口。单副本部署足够；多副本需要换 Redis           */
/* ------------------------------------------------------------------ */

class Window {
  constructor() {
    /** @type {Map<string, {n: number, reset: number}>} */
    this.buckets = new Map();
    this.timer = null;
  }

  /** @returns {{ok: boolean, left: number, retryAfter: number}} */
  take(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now >= b.reset) {
      b = { n: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    if (b.n >= limit) {
      return { ok: false, left: 0, retryAfter: Math.ceil((b.reset - now) / 1000) };
    }
    b.n += 1;
    this.sweep(now);
    return { ok: true, left: limit - b.n, retryAfter: 0 };
  }

  sweep(now) {
    /* 每 5 分钟清一次过期桶，避免长跑内存涨 */
    if (this.timer && now - this.timer < 300000) return;
    this.timer = now;
    for (const [k, v] of this.buckets) {
      if (now >= v.reset) this.buckets.delete(k);
    }
  }
}

const ipHour = new Window();
const ipDay = new Window();
const globalDay = new Window();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 三层限流：单 IP 小时 / 单 IP 天 / 全局天。
 * 任何一层超限都拒绝，给出明确的重试时间。
 */
function checkRate(ip, kind, cfg) {
  const hourLimit = kind === 'chat' ? cfg.RL_CHAT_PER_HOUR : cfg.RL_GEO_PER_HOUR;
  const dayLimit = kind === 'chat' ? cfg.RL_CHAT_PER_DAY : cfg.RL_GEO_PER_DAY;

  const h = ipHour.take(`${kind}:h:${ip}`, hourLimit, 3600_000);
  if (!h.ok) {
    return { ok: false, msg: `请求太频繁，请 ${Math.ceil(h.retryAfter / 60)} 分钟后再试`, retryAfter: h.retryAfter };
  }

  const d = ipDay.take(`${kind}:d:${ip}`, hourLimit * 6, 86400_000);
  if (!d.ok) {
    return { ok: false, msg: '今天的额度用完了，明天再来', retryAfter: d.retryAfter };
  }

  const g = globalDay.take(`g:${kind}`, dayLimit, 86400_000);
  if (!g.ok) {
    return { ok: false, msg: '演示额度已用完，可以填写自己的 API Key 继续使用', retryAfter: g.retryAfter };
  }

  return { ok: true, retryAfter: 0 };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/**
 * POST /api/chat
 *
 * body 就是标准的 chat/completions 请求体（model / messages / stream …），
 * 服务端补上 Authorization 后转发，SSE 原样回灌。
 */
async function handleChat(req, res, cfg) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  if (!cfg.DEEPSEEK_API_KEY) {
    return sendJson(res, 503, { error: '服务端未配置 DEEPSEEK_API_KEY' });
  }

  const ip = clientIp(req);
  const rate = checkRate(ip, 'chat', cfg);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return sendJson(res, 429, { error: rate.msg });
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }

  /* 服务端强制覆盖模型与流式开关，防止前端传奇怪参数 */
  payload.model = cfg.DEEPSEEK_MODEL;
  payload.stream = true;
  delete payload.api_key;
  delete payload.key;

  const url = cfg.DEEPSEEK_BASE.replace(/\/+$/, '') + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.DEEPSEEK_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return sendJson(res, aborted ? 504 : 502, {
      error: aborted ? '上游超时' : '上游不可达：' + (e?.message || '网络错误'),
    });
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    let detail = '';
    try {
      detail = (await upstream.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return sendJson(res, upstream.status || 502, {
      error: `上游返回 ${upstream.status}`,
      detail,
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    /* 关掉 nginx / 云厂商反代的缓冲，否则流式会攒成一坨 */
    'X-Accel-Buffering': 'no',
  });

  const reader = upstream.body.getReader();
  let closed = false;
  /* 客户端断开（用户关页面）时立刻掐掉上游，别让它白跑完 */
  req.on('close', () => {
    closed = true;
    clearTimeout(timer);
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
    ctrl.abort();
  });

  try {
    /* 每收到一块就刷一次，保证首字节尽快到达浏览器 */
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (value && value.length) res.write(Buffer.from(value));
    }
  } catch {
    /* 上游中断：已经写了响应头，只能结束连接让前端感知 */
  } finally {
    clearTimeout(timer);
    if (!closed) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * GET /api/geo?keywords=&city=&offset=&citylimit=
 *
 * 高德 POI 文本搜索的服务端转发。原样回高德 JSON，
 * 由前端的 amapSearch 做评分、排序、GCJ-02 → WGS-84 转换，
 * 保证本地直连与走代理走同一套排序逻辑。
 */
async function handleGeo(req, res, cfg, search) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  if (!cfg.AMAP_KEY) {
    return sendJson(res, 503, { error: '服务端未配置 AMAP_KEY' });
  }

  const ip = clientIp(req);
  const rate = checkRate(ip, 'geo', cfg);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return sendJson(res, 429, { error: rate.msg });
  }

  const keywords = (search.get('keywords') || '').trim();
  if (!keywords) return sendJson(res, 400, { error: '缺少 keywords' });

  const params = new URLSearchParams({
    keywords,
    city: search.get('city') || '全国',
    citylimit: search.get('citylimit') || (search.get('city') ? 'true' : 'false'),
    offset: search.get('offset') || '5',
    page: '1',
    extensions: 'base',
    key: cfg.AMAP_KEY,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);

  try {
    const upstream = await fetch(`${cfg.AMAP_ENDPOINT}?${params}`, { signal: ctrl.signal });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    sendJson(res, aborted ? 504 : 502, { error: aborted ? '高德超时' : '高德不可达' });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 坐标转换（服务端只做一次，前端拿到的永远是 WGS-84）                  */
/* ------------------------------------------------------------------ */

const PI = Math.PI;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lat + dLat, lng + dLng];
}

/** 没有解析反函数，三轮迭代逼近，误差 < 1 米 */
function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let wgsLat = lat;
  let wgsLng = lng;
  for (let i = 0; i < 3; i += 1) {
    const [gLat, gLng] = wgs84ToGcj02(wgsLat, wgsLng);
    wgsLat += lat - gLat;
    wgsLng += lng - gLng;
  }
  return [wgsLat, wgsLng];
}

/**
 * GET /api/search?q=&city=&limit=
 *
 * 世界模型的搜索框用。高德只覆盖中国境内，境外地名会返回空数组，
 * 由前端决定是否回退到 Photon。
 *
 * 返回已转成 WGS-84 的统一结构，前端不需要再关心坐标系。
 */
async function handleSearch(req, res, cfg, search) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  if (!cfg.AMAP_KEY) return sendJson(res, 503, { error: '服务端未配置 AMAP_KEY' });

  const rate = checkRate(clientIp(req), 'geo', cfg);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return sendJson(res, 429, { error: rate.msg });
  }

  const q = (search.get('q') || '').trim();
  if (!q) return sendJson(res, 400, { error: '缺少 q' });

  const city = (search.get('city') || '').trim();
  const limit = Math.max(1, Math.min(15, Number(search.get('limit')) || 10));

  const params = new URLSearchParams({
    keywords: q,
    city: city || '全国',
    citylimit: city ? 'true' : 'false',
    offset: String(limit),
    page: '1',
    extensions: 'base',
    key: cfg.AMAP_KEY,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);

  try {
    const upstream = await fetch(`${cfg.AMAP_ENDPOINT}?${params}`, { signal: ctrl.signal });
    const data = await upstream.json();

    if (data.status !== '1') {
      return sendJson(res, 200, {
        results: [],
        error: `${data.infocode || ''} ${data.info || '高德返回异常'}`.trim(),
      });
    }

    const results = [];
    for (const p of Array.isArray(data.pois) ? data.pois : []) {
      const name = (p.name || '').trim();
      const loc = (p.location || '').trim();
      if (!name || !loc) continue;

      const [lngRaw, latRaw] = loc.split(',').map(Number);
      if (!Number.isFinite(latRaw) || !Number.isFinite(lngRaw)) continue;

      const [lat, lng] = gcj02ToWgs84(latRaw, lngRaw);
      const address = [p.pname, p.cityname, p.adname, p.address]
        .filter((v) => v && v !== '[]')
        .join(' ');

      results.push({
        name,
        lng: Number(lng.toFixed(6)),
        lat: Number(lat.toFixed(6)),
        address,
        type: p.type || '',
        typecode: p.typecode || '',
      });
    }

    sendJson(res, 200, { results });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    sendJson(res, aborted ? 504 : 502, {
      results: [],
      error: aborted ? '高德超时' : '高德不可达',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/health —— 前端据此决定「免 Key 代理」还是「用户自带 Key」 */
function handleHealth(res, cfg) {
  sendJson(res, 200, {
    proxy: Boolean(cfg.DEEPSEEK_API_KEY),
    geo: Boolean(cfg.AMAP_KEY),
    model: cfg.DEEPSEEK_MODEL,
    limits: {
      chatPerHour: cfg.RL_CHAT_PER_HOUR,
      geoPerHour: cfg.RL_GEO_PER_HOUR,
    },
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, root) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  /* 防目录穿越 */
  const target = path.normalize(path.join(root, pathname));
  if (!target.startsWith(path.normalize(root + path.sep)) && target !== path.normalize(root)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      /* SPA 兜底：找不到的路径交给 index.html */
      const fallback = path.join(root, 'index.html');
      return fs.readFile(fallback, (e2, buf) => {
        if (e2) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      });
    }

    const ext = path.extname(target).toLowerCase();
    /* 带 hash 的产物长缓存，index.html 不缓存 */
    const hashed = /-[A-Za-z0-9_]{8,}\.(js|css|woff2|png|svg|webp)$/.test(target);
    const cacheControl = hashed ? 'public, max-age=31536000, immutable' : 'no-cache';

    if (GZIP_EXT.has(ext) && st.size > 1024 && acceptsGzip(req)) {
      try {
        const gz = gzipFor(target, st.mtimeMs);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': gz.length,
          Vary: 'Accept-Encoding',
          'Cache-Control': cacheControl,
        });
        res.end(gz);
        return;
      } catch {
        /* 压缩失败就退回原文件，不能因为省流量把页面搞挂 */
      }
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 创建请求处理器。
 * @param {{root?: string, env?: Record<string,string>, apiOnly?: boolean}} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createHandler(options = {}) {
  const cfg = { ...DEFAULTS, ...(options.env || {}) };
  for (const k of Object.keys(DEFAULTS)) {
    if (cfg[k] === undefined || cfg[k] === '') cfg[k] = DEFAULTS[k];
  }
  for (const k of ['RL_CHAT_PER_HOUR', 'RL_GEO_PER_HOUR', 'RL_CHAT_PER_DAY', 'RL_GEO_PER_DAY']) {
    cfg[k] = Number(cfg[k]) || DEFAULTS[k];
  }

  const root = path.resolve(options.root || path.join(process.cwd(), 'dist'));
  const self = fileURLToPath(import.meta.url);

  return function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'bad url' });
    }

    const p = url.pathname;

    if (p === '/api/health') return handleHealth(res, cfg);
    if (p === '/api/chat') return void handleChat(req, res, cfg);
    if (p === '/api/geo') return void handleGeo(req, res, cfg, url.searchParams);
    if (p === '/api/search') return void handleSearch(req, res, cfg, url.searchParams);

    /* 开发期由 vite 中间件接管静态资源，这里只兜 API */
    if (options.apiOnly) return sendJson(res, 404, { error: 'not found' });

    return serveStatic(req, res, root);
  };
}

/* ------------------------------------------------------------------ */
/* 静态资源压缩                                                        */
/* ------------------------------------------------------------------ */

/* MapLibre 一个包 1 MB，不压缩首屏要等 1.5 秒；gzip 后 285 KB。
   文本类才压，图片/字体本身已压缩，再压只是浪费 CPU */
const GZIP_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.map']);
const gzipCache = new Map();
const GZIP_CACHE_MAX = 40;

function gzipFor(file, mtimeMs) {
  const key = file + '|' + mtimeMs;
  const hit = gzipCache.get(key);
  if (hit) return hit;

  const buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
  /* 简单 LRU：超过上限丢最早的一条，够用且不会无限涨 */
  if (gzipCache.size >= GZIP_CACHE_MAX) {
    gzipCache.delete(gzipCache.keys().next().value);
  }
  gzipCache.set(key, buf);
  return buf;
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
}

/** 读取 .env（不引第三方库，简单够用） */
export function loadEnv(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}
