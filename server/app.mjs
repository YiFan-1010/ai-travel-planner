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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
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

    /* 开发期由 vite 中间件接管静态资源，这里只兜 API */
    if (options.apiOnly) return sendJson(res, 404, { error: 'not found' });

    return serveStatic(req, res, root);
  };
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
