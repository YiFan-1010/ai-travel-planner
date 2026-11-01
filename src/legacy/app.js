/* =========================================================================
   旅游行程规划 · 开源地图版
   地图：MapLibre GL JS + OpenFreeMap（OSM 数据，免 Key）
   大模型：DeepSeek / 任意 OpenAI 兼容端点
   坐标：LLM 直出 WGS-84 为主，Nominatim 精修可选
   连线：顺序直线 / OSRM 演示服务可选
   ========================================================================= */

/* ---------------- 常量 ---------------- */
var MAP_STYLES = {
  positron: { label: '浅色', url: 'https://tiles.openfreemap.org/styles/positron' },
  liberty:  { label: '标准', url: 'https://tiles.openfreemap.org/styles/liberty' },
  bright:   { label: '明亮', url: 'https://tiles.openfreemap.org/styles/bright' },
  fiord:    { label: '冷调', url: 'https://tiles.openfreemap.org/styles/fiord' },
  dark:     { label: '深色', url: 'https://tiles.openfreemap.org/styles/dark' }
};
var CESIUM_VERSION = '1.120.0';
var CESIUM_BASE = 'https://cdn.jsdelivr.net/npm/cesium@' + CESIUM_VERSION + '/Build/Cesium/';
var WORLD_TOPO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

var CATEGORIES = {
  sight:    { label: '景点 自然',   color: '#2563EB', short: '景点',   ink: '#FFFFFF' },
  food:     { label: '美食',        color: '#E23D3D', short: '美食',   ink: '#FFFFFF' },
  culture:  { label: '文化 历史',   color: '#7C3AED', short: '文化',   ink: '#FFFFFF' },
  shopping: { label: '购物 夜生活', color: '#F59E0B', short: '夜生活', ink: '#1A1206' }
};

var DEFAULT_SETTINGS = {
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  // 高德 Web 服务 Key：配置后 Agent 走「工具定位」，坐标更准；
  // 留空则退回「模型坐标 + 路线校验」
  amapKey: '',
  intro: true,
  refine: false,
  routeMode: 'osrm',
  style: 'bright',
  pitch3d: false,
  theme: 'light',
  labels: true,
  satMode: 'macro'
};

// 总览时每天一种颜色（与分类色区分开）
var DAY_COLORS = ['#2563EB', '#7C3AED', '#E23D3D', '#F59E0B', '#0891B2', '#059669', '#DB2777', '#7C2D12', '#4F46E5', '#0D9488'];

var STORAGE_KEY = 'travel_planner_settings_v1';
var PREFS_KEY = 'travel_prefs_v1';
var PLAN_KEY = 'travel_plan_cache_v1';

// 把生成的行程存到本地，关掉页面再打开还在（也是离线可用的前提）
function savePlanCache(plan) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({ at: Date.now(), plan: plan }));
  } catch (e) {}
}

function readPlanCache() {
  try {
    var raw = localStorage.getItem(PLAN_KEY);
    if (!raw) return null;
    var o = JSON.parse(raw);
    if (!o || !o.plan || !o.plan.days || !o.plan.days.length) return null;
    return o.plan;
  } catch (e) { return null; }
}

var DEFAULT_PREFS = {
  companion: '朋友',
  pace: '适中',
  budget: '舒适',
  transport: '公共交通为主',
  perDay: '5',
  hotel: '',
  interests: ['历史文化', '美食', '自然风光'],
  must: '',
  avoid: ''
};

/* ---------------- 状态 ---------------- */
var state = {
  plan: null,
  activeDay: 1,
  map: null,
  markers: [],
  popup: null,
  currentRoute: null,
  settings: loadSettings(),
  landingIntro: null,
  globeMap: null,
  introPlayed: false,
  dayToken: 0,
  routeAnimToken: 0,
  offline: false,
  globePin: null,
  routeCache: {},
  itemObserver: null,
  ioFallback: 0,
  routeFlow: null,
  dragFrom: null,
  justDragged: false
};

/* =========================================================================
   图标库（内联 SVG · Lucide 风格 · 零外部依赖）
   ========================================================================= */
function svg(path, sw) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
    (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
}
var ICONS = {
  clock:  svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 2),
  timer:  svg('<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>', 2),
  wallet: svg('<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>', 1.9),
  pin:    svg('<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>', 1.9),
  check:  svg('<path d="M20 6 9 17l-5-5"/>', 2.4),
  alert:  svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>', 2),
  arrow:  svg('<path d="M5 12h14M12 5l7 7-7 7"/>', 2.2),
  cube:   svg('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>', 1.9),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 2),
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', 1.9),
  layers: svg('<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>', 1.9),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>', 1.9),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>', 1.9),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', 1.8),
  sparkles: svg('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/><path d="M5 3v4M19 17v4M3 5h4M17 19h4"/>', 1.9),
  grip: svg('<circle cx="9" cy="5" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="9" cy="19" r="1.2"/><circle cx="15" cy="5" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="15" cy="19" r="1.2"/>', 1.5),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>', 1.8)
};

/* ---------------- 动效引擎 ---------------- */
function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}

// 数字滚动（easeOutQuart）
function countUp(el, to, prefix, dur) {
  if (!el) return;
  to = Number(to) || 0;
  dur = dur || 820;
  prefix = prefix == null ? '' : prefix;
  var from = Number(el.getAttribute('data-v'));
  if (!isFinite(from)) from = 0;
  el.setAttribute('data-v', String(to));
  if (reducedMotion()) { el.textContent = prefix + to.toLocaleString(); return; }
  var t0 = performance.now();
  function frame(now) {
    var k = Math.min(1, (now - t0) / dur);
    var e = 1 - Math.pow(1 - k, 4);
    el.textContent = prefix + Math.round(from + (to - from) * e).toLocaleString();
    if (k < 1) requestAnimationFrame(frame);
    else el.textContent = prefix + to.toLocaleString();
  }
  requestAnimationFrame(frame);
}

// 形变换字：旧字 blur 上移淡出 → 新字 blur 下移淡入（Morph Transition）
function morphText(el, text) {
  if (!el) return;
  text = String(text == null ? '' : text);
  if (el.textContent === text) return;
  if (reducedMotion()) { el.textContent = text; return; }
  try {
    var out = el.animate(
      [{ opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
       { opacity: 0, transform: 'translateY(-7px)', filter: 'blur(5px)' }],
      { duration: 150, easing: 'cubic-bezier(.7,0,.84,0)', fill: 'forwards' }
    );
    out.onfinish = function () {
      el.textContent = text;
      out.cancel();
      el.animate(
        [{ opacity: 0, transform: 'translateY(7px)', filter: 'blur(5px)' },
         { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }],
        { duration: 340, easing: 'cubic-bezier(.16,1,.3,1)' }
      );
    };
  } catch (e) { el.textContent = text; }
}

// 卡片进入视口才播入场（IntersectionObserver，6s 兜底）
function observeItems() {
  var items = Array.prototype.slice.call(document.querySelectorAll('.tl-item:not(.in)'));
  if (!items.length) return;
  if (!('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  if (!state.itemObserver) {
    state.itemObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        state.itemObserver.unobserve(en.target);
      });
    }, { rootMargin: '180px 0px -6% 0px', threshold: 0.02 });
  }
  items.forEach(function (el) { state.itemObserver.observe(el); });
  clearTimeout(state.ioFallback);
  state.ioFallback = setTimeout(function () {
    document.querySelectorAll('.tl-item:not(.in)').forEach(function (el) { el.classList.add('in'); });
  }, 6000);
}

// 切天 FLIP：新卡片从旧卡片的几何位置"形变"到新位置（PPT Morph 感）
function applyFlip(tl, oldRects) {
  var cards = tl.querySelectorAll('.card');
  Array.prototype.forEach.call(cards, function (el, i) {
    var item = el.parentNode;
    if (item) {
      item.classList.add('in');
      item.style.animation = 'none';
      item.style.opacity = '1';
    }
    var o = oldRects[i];
    if (!o || reducedMotion()) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;

    var dx = o.left - r.left;
    var dy = o.top - r.top;
    var sx = o.w / r.width;
    var sy = o.h / r.height;
    if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5 &&
        Math.abs(sx - 1) < 0.015 && Math.abs(sy - 1) < 0.015) return;

    el.style.transformOrigin = 'top left';
    el.style.transition = 'none';
    el.style.transform = 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    el.style.opacity = '0.35';

    requestAnimationFrame(function () {
      el.style.transition = 'transform 520ms cubic-bezier(.16,1,.3,1),opacity 340ms cubic-bezier(.16,1,.3,1)';
      el.style.transform = 'none';
      el.style.opacity = '1';
      setTimeout(function () {
        el.style.transition = '';
        el.style.transform = '';
        el.style.opacity = '';
        el.style.transformOrigin = '';
      }, 560);
    });
  });
}

/* ---------------- 路线流动光点 ---------------- */
function stopRouteFlow() {
  var f = state.routeFlow;
  if (!f) return;
  if (f.raf) cancelAnimationFrame(f.raf);
  try { f.marker.remove(); } catch (e) {}
  state.routeFlow = null;
}

function startRouteFlow(feature) {
  stopRouteFlow();
  if (!feature || !state.map || reducedMotion()) return;
  var coords = feature.geometry && feature.geometry.coordinates;
  if (!coords || coords.length < 2) return;

  // 累计弧长，保证匀速（按经纬度近似）
  var cum = [0];
  for (var i = 1; i < coords.length; i++) {
    var dx = coords[i][0] - coords[i - 1][0];
    var dy = coords[i][1] - coords[i - 1][1];
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  var total = cum[cum.length - 1];
  if (!total || !isFinite(total)) return;

  var el = document.createElement('div');
  el.className = 'route-dot';
  var marker;
  try {
    marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(coords[0]).addTo(state.map);
  } catch (e) { return; }

  var SPEED = total / 7000; // 7 秒走完全程
  var t0 = performance.now();
  var raf = 0;

  function locate(d) {
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    return lo;
  }

  function frame(now) {
    if (!state.routeFlow) return;
    var d = ((now - t0) * SPEED) % total;
    var seg = locate(d);
    var segLen = (cum[seg + 1] - cum[seg]) || 1;
    var k = Math.max(0, Math.min(1, (d - cum[seg]) / segLen));
    var lng = coords[seg][0] + (coords[seg + 1][0] - coords[seg][0]) * k;
    var lat = coords[seg][1] + (coords[seg + 1][1] - coords[seg][1]) * k;
    marker.setLngLat([lng, lat]);
    raf = requestAnimationFrame(frame);
    state.routeFlow.raf = raf;
  }

  state.routeFlow = { marker: marker, raf: raf };
  raf = requestAnimationFrame(frame);
  state.routeFlow.raf = raf;
}

// 元素退场后执行回调（保证"消失动画"真的能看到）
function exitThen(el, ms, fn) {
  if (!el || reducedMotion()) { if (fn) fn(); return; }
  el.style.animation = 'exit-rise ' + ms + 'ms cubic-bezier(.7,0,.84,0) both';
  setTimeout(function () { if (fn) fn(); }, ms - 20);
}

/* ---------------- 工具 ---------------- */
function $(id) { return document.getElementById(id); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function toast(msg, isErr) {
  var t = $('toast');
  if (!t) return;
  t.innerHTML = (isErr ? ICONS.alert : ICONS.check) + '<span></span>';
  t.querySelector('span').textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(function () { t.className = 'toast'; }, 3400);
}

// 文案轻清洗：去结尾句号、去顿号、去省略号（保留逗号保证可读）
function tidyText(v) {
  if (v == null) return '';
  return String(v)
    .replace(/[。]+\s*$/g, '')
    .replace(/、/g, ' ')
    .replace(/…+|\.{3,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

function daysBetween(a, b) {
  var d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
  return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
}

function loadSettings() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return Object.assign({}, DEFAULT_SETTINGS);
    var obj = JSON.parse(raw);
    var merged = Object.assign({}, DEFAULT_SETTINGS, obj || {});
    // 旧版默认 Positron 观感偏素，升级后默认切到 Bright（仍可手动切回）
    if (!merged.styleVersion || merged.styleVersion < 3) {
      merged.style = 'bright';
      merged.styleVersion = 3;
    }
    // 旧版默认直线，升级后默认真实道路路线
    if (!merged.routeVersion) {
      merged.routeMode = 'osrm';
      merged.routeVersion = 2;
    }
    return merged;
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); } catch (e) {}
}

function updateApiHint() {
  var has = !!(state.settings.apiKey && state.settings.apiKey.trim());
  var box = $('apiHint');
  var txt = $('apiHintText');
  var btn = $('apiHintBtn');
  if (has) {
    box.className = 'api-hint ok';
    txt.textContent = '已配置 ' + (state.settings.model || 'deepseek-chat') + '  ' + state.settings.apiBase;
    btn.textContent = '修改';
  } else {
    box.className = 'api-hint';
    txt.textContent = '尚未配置大模型 API Key 生成前请先完成设置';
    btn.textContent = '去设置';
  }
  var sb = $('settingsBtn');
  if (has) sb.className = 'settings-btn ok'; else sb.className = 'settings-btn';
}

/* =========================================================================
   旅行偏好
   ========================================================================= */
function loadPrefs() {
  try {
    var raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return Object.assign({}, DEFAULT_PREFS);
    return Object.assign({}, DEFAULT_PREFS, JSON.parse(raw));
  } catch (e) {
    return Object.assign({}, DEFAULT_PREFS);
  }
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
}

function readPrefs() {
  var interests = [];
  document.querySelectorAll('#pInterests button.on').forEach(function (b) {
    interests.push(b.getAttribute('data-v'));
  });
  return {
    companion: $('pCompanion').value,
    pace: $('pPace').value,
    budget: $('pBudget').value,
    transport: $('pTransport').value,
    perDay: $('pPerDay').value,
    hotel: $('pHotel').value.trim(),
    interests: interests,
    must: $('pMust').value.trim(),
    avoid: $('pAvoid').value.trim()
  };
}

function renderPrefs(p) {
  $('pCompanion').value = p.companion;
  $('pPace').value = p.pace;
  $('pBudget').value = p.budget;
  $('pTransport').value = p.transport;
  $('pPerDay').value = p.perDay;
  $('pHotel').value = p.hotel || '';
  $('pMust').value = p.must || '';
  $('pAvoid').value = p.avoid || '';
  var set = {};
  (p.interests || []).forEach(function (v) { set[v] = true; });
  document.querySelectorAll('#pInterests button').forEach(function (b) {
    b.classList.toggle('on', !!set[b.getAttribute('data-v')]);
  });
}

function buildPrefsBlock(p) {
  var lines = ['【旅行者偏好】'];
  lines.push('- 同行人：' + p.companion);
  lines.push('- 节奏：' + p.pace);
  lines.push('- 预算档位：' + p.budget);
  lines.push('- 交通方式：' + p.transport);
  lines.push('- 每天 POI 数量：' + p.perDay + ' 个（严格遵守）');
  if (p.interests && p.interests.length) lines.push('- 兴趣偏好：' + p.interests.join('、'));
  if (p.must) lines.push('- 必去 / 必吃：' + p.must);
  if (p.avoid) lines.push('- 明确不想要：' + p.avoid);
  if (p.hotel) lines.push('- 住宿区域：' + p.hotel);
  lines.push('取舍优先级：必去/必吃 > 兴趣偏好 > 节奏 > 预算；「明确不想要」的项目一律不要安排。');
  return lines.join('\n');
}

/* =========================================================================
   设置弹窗
   ========================================================================= */
function openSettings() {
  $('sApiBase').value = state.settings.apiBase || '';
  $('sApiKey').value = state.settings.apiKey || '';
  $('sAmapKey').value = state.settings.amapKey || '';
  $('sModel').value = state.settings.model || '';
  $('sRouteMode').value = state.settings.routeMode || 'straight';
  $('sIntro').checked = !!state.settings.intro;
  $('sRefine').checked = !!state.settings.refine;
  $('sLabels').checked = state.settings.labels !== false;
  if ($('sSatMode')) $('sSatMode').value = state.settings.satMode || 'macro';

  var modal = $('settingsModal');
  modal.classList.add('show');

  // 弹窗内部依次浮入（错落 26ms）
  var card = modal.querySelector('.modal-card');
  if (card && !reducedMotion()) {
    Array.prototype.slice.call(card.children).forEach(function (el, i) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = 'enter-rise 400ms var(--e-out) both';
      el.style.animationDelay = (50 + i * 26) + 'ms';
    });
  }
  setTimeout(function () { try { $('sApiKey').focus({ preventScroll: true }); } catch (e) {} }, 140);
}

function closeSettings() {
  $('settingsModal').classList.remove('show');
}

function applySettingsFromForm() {
  var base = $('sApiBase').value.trim() || DEFAULT_SETTINGS.apiBase;
  if (!/^https?:\/\//i.test(base)) { toast('API Base 需以 http(s):// 开头', true); return; }
  state.settings.apiBase = base.replace(/\/+$/, '');
  state.settings.apiKey = $('sApiKey').value.trim();
  state.settings.amapKey = $('sAmapKey').value.trim();
  state.settings.model = $('sModel').value.trim() || DEFAULT_SETTINGS.model;
  state.settings.routeMode = $('sRouteMode').value;
  state.settings.intro = $('sIntro').checked;
  state.settings.refine = $('sRefine').checked;
  state.settings.labels = $('sLabels').checked;
  if ($('sSatMode')) state.settings.satMode = $('sSatMode').value;
  saveSettings();
  updateApiHint();
  closeSettings();
  toast('设置已保存');

  // 卫星模式可能变化：重建卫星层状态与 3D 建筑配色
  [state.map, state.globeMap].forEach(function (m) {
    if (!m) return;
    try { ensureSatellite(m); updateSatellite(m); } catch (e) {}
    try {
      if (m.getLayer('custom-3d-buildings')) {
        m.removeLayer('custom-3d-buildings');
        addCustomBuildings(m);
        raiseOverSat(m);
      }
    } catch (e) {}
  });

  if (state.plan) renderDay(); // 连线方式可能变化
}

/* =========================================================================
   DeepSeek / OpenAI 兼容调用
   ========================================================================= */
var SYS_PROMPT = [
  '你是专业中文旅行规划师。根据用户提供的城市与天数，生成详细、真实、可落地的多日行程。',
  '必须只返回一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块标记。结构如下：',
  '{',
  '  "title": "行程总标题（含城市与天数）",',
  '  "city": "城市名",',
  '  "summary": "一句话行程亮点",',
  '  "center": { "lat": 30.5728, "lng": 104.0668 },',
  '  "days": [',
  '    {',
  '      "day": 1,',
  '      "theme": "当天主题",',
  '      "pois": [',
  '        {',
  '          "name": "地点名",',
  '          "type": "sight|food|culture|shopping",',
  '          "time": "09:00",',
  '          "address": "具体地址（必须包含城市名）",',
  '          "duration": "约2小时",',
  '          "cost": 50,',
  '          "desc": "一句话亮点介绍",',
  '          "lat": 30.6442,',
  '          "lng": 104.0439',
  '        }',
  '      ]',
  '    }',
  '  ]',
  '}',
  '要求：',
  '1) type 取值：sight=景点/自然风光，food=美食，culture=文化/历史，shopping=购物/夜生活（夜市、酒吧街归入此类）。',
  '2) 每天 POI 数量严格按用户指定（未指定则 5 个），POI 的 time 必须按时间升序排列。',
  '3) lat/lng 必须是 WGS-84（GPS 原始坐标），保留 6 位小数；严禁使用 GCJ-02 或 BD-09 偏移坐标。',
  '4) address 必须真实存在、可被地图定位，并包含城市名。',
  '5) cost 为单人预估花费（元），整数；免费填 0。',
  '6) 优先满足用户兴趣、必去/必吃与同行人特点；用户未指定兴趣时，再兼顾历史文化、美食、自然风光与夜生活。',
  '7) center 为该城市中心点的 WGS-84 坐标。',
  '8) 用户明确「不想要」的项目一律不要安排；预算档位影响餐厅、门票与住宿建议的价位。'
].join('\n');

async function callLLM(place, start, end, n, prefs, onProgress) {
  var s = state.settings;
  if (!s.apiKey) throw new Error('请先在「设置」中填写 API Key');

  var url = s.apiBase.replace(/\/+$/, '') + '/chat/completions';
  var userPrompt = '请为「' + place + '」规划 ' + n + ' 天行程' +
    (start && end ? '（' + start + ' 至 ' + end + '）' : '') + '。\n\n' +
    buildPrefsBlock(prefs || DEFAULT_PREFS);

  var body = {
    model: s.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.75,
    // 按天数给量：固定 8192 会让模型在结尾拖着写，整体耗时翻倍
    max_tokens: Math.min(8192, 1200 + n * 1000),
    response_format: { type: 'json_object' },
    stream: true
  };

  // 超时改成两段式：见到第一个字节给 60s，之后每来一块重置 90s。
  // 原来是一刀切 180s，3 天行程经常卡在最后几秒被砍断。
  var ctrl = new AbortController();
  var idleTimer = 0;
  function arm(ms) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { ctrl.abort(); }, ms);
  }
  function disarm() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
  }
  arm(60000);

  var res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    disarm();
    if (e && e.name === 'AbortError') throw new Error('连接超时 60 秒 请检查网络或接口地址');
    throw new Error('网络或跨域错误：' + (e && e.message ? e.message : '请求失败'));
  }

  if (!res.ok) {
    disarm();
    var txt = '';
    try { txt = await res.text(); } catch (e) {}
    var hint = '';
    if (res.status === 401) hint = 'API Key 无效';
    else if (res.status === 402) hint = '账户余额不足';
    else if (res.status === 429) hint = '请求过于频繁';
    else if (res.status >= 500) hint = '服务端错误';
    throw new Error('HTTP ' + res.status + (hint ? '（' + hint + '）' : '') + '：' + txt.slice(0, 180));
  }

  var ctype = (res.headers.get('content-type') || '').toLowerCase();
  var content = '';

  if (res.body && res.body.getReader && ctype.indexOf('event-stream') >= 0) {
    // ---- 流式：边收边刷进度，用户第一秒就知道在动 ----
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', lastPaint = 0, finished = false;
    arm(90000);
    try {
      while (!finished) {
        var step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        var pos;
        while ((pos = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, pos).trim();
          buf = buf.slice(pos + 1);
          if (!line || line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === '[DONE]') { finished = true; break; }
          try {
            var j = JSON.parse(payload);
            var piece = j.choices && j.choices[0] && j.choices[0].delta
              && j.choices[0].delta.content;
            if (piece) content += piece;
          } catch (e) {}
        }
        var now = Date.now();
        if (content && now - lastPaint > 160) {
          lastPaint = now;
          arm(90000);
          if (onProgress) onProgress(content.length, content);
        }
      }
    } catch (e) {
      disarm();
      if (e && e.name === 'AbortError') throw new Error('生成中断 90 秒没有新内容 请重试');
      throw new Error('读取流失败：' + (e && e.message ? e.message : e));
    }
    disarm();
    if (finished) { try { reader.cancel(); } catch (e) {} }
    if (content && onProgress) onProgress(content.length, content);
  } else {
    // ---- 端点不支持流式：退回整体解析 ----
    disarm();
    var data = await res.json();
    content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
  }

  if (!content) throw new Error('模型返回为空');
  return parsePlan(content, place, n);
}

function parsePlan(content, place, n) {
  var txt = String(content).trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  var obj = null;
  try { obj = JSON.parse(txt); } catch (e) {
    var s = txt.indexOf('{'), e2 = txt.lastIndexOf('}');
    if (s >= 0 && e2 > s) {
      try { obj = JSON.parse(txt.slice(s, e2 + 1)); } catch (e3) {}
    }
  }
  // 有些模型会多包一层 {"plan":{...}}，剥掉再验
  if (obj && !Array.isArray(obj.days) && obj.plan && Array.isArray(obj.plan.days)) {
    obj = obj.plan;
  }
  if (!obj || !Array.isArray(obj.days) || !obj.days.length) {
    throw new Error('模型返回的不是合法行程 JSON');
  }

  obj.city = obj.city || place;
  obj.title = obj.title || (obj.city + ' ' + obj.days.length + '日游');
  obj.days.forEach(function (d, i) {
    d.day = d.day || (i + 1);
    if (!Array.isArray(d.pois)) d.pois = [];
    d.pois.forEach(function (p) {
      p.type = CATEGORIES[p.type] ? p.type : 'sight';
      p.cost = Number(p.cost) || 0;
      p.lat = normalizeCoord(p.lat, 'lat');
      p.lng = normalizeCoord(p.lng, 'lng');
      p.id = p.id || ('p_' + Math.random().toString(36).slice(2, 9));
    });
  });
  if (obj.days.length > n) obj.days = obj.days.slice(0, n);
  return obj;
}

function normalizeCoord(v, kind) {
  var num = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof num !== 'number' || !isFinite(num)) return null;
  if (kind === 'lat' && (num < -90 || num > 90)) return null;
  if (kind === 'lng' && (num < -180 || num > 180)) return null;
  return num;
}

/* =========================================================================
   坐标精修（Nominatim，可选）
   ========================================================================= */
async function refineCoords(plan) {
  if (!state.settings.refine) return;
  var list = [];
  plan.days.forEach(function (d) { d.pois.forEach(function (p) { if (p.address || p.name) list.push(p); }); });
  if (!list.length) return;

  var fails = 0, okCount = 0;
  for (var i = 0; i < list.length; i++) {
    if (fails >= 2) break;
    var p = list[i];
    try {
      var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
        encodeURIComponent(p.address || (plan.city + p.name));
      let ctrl = new AbortController();
      let t = setTimeout(function () { ctrl.abort(); }, 2500);
      var r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(t);
      if (!r.ok) throw new Error('http ' + r.status);
      var arr = await r.json();
      if (arr && arr[0]) {
        var lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
        if (isFinite(lat) && isFinite(lng)) {
          p.lat = lat; p.lng = lng; okCount++;
        }
      }
      fails = 0;
      $('ovTxt').textContent = '坐标精修中 ' + (i + 1) + ' / ' + list.length;
    } catch (e) {
      fails++;
    }
    await delay(1100);
  }
  if (fails >= 2) toast('Nominatim 不可达 已关闭本次坐标精修', true);
  else if (okCount) toast('坐标精修完成：' + okCount + ' 个点位');
}

/* =========================================================================
   Cesium 开场
   ========================================================================= */
var cesiumPromise = null;

function loadCesium() {
  if (window.Cesium) return Promise.resolve();
  if (cesiumPromise) return cesiumPromise;

  cesiumPromise = new Promise(function (resolve, reject) {
    window.CESIUM_BASE_URL = CESIUM_BASE;

    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CESIUM_BASE + 'Widgets/widgets.css';
    document.head.appendChild(link);

    var s = document.createElement('script');
    s.src = CESIUM_BASE + 'Cesium.js';
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('Cesium 加载失败')); };
    document.head.appendChild(s);
  });
  return cesiumPromise;
}

function decodeTopoArcs(topo) {
  var t = topo.transform;
  var sx = t ? t.scale[0] : 1, sy = t ? t.scale[1] : 1;
  var tx = t ? t.translate[0] : 0, ty = t ? t.translate[1] : 0;
  return topo.arcs.map(function (arc) {
    var x = 0, y = 0;
    return arc.map(function (p) {
      x += p[0]; y += p[1];
      return [x * sx + tx, y * sy + ty];
    });
  });
}

function stitchRing(ring, arcs) {
  var out = [];
  for (var i = 0; i < ring.length; i++) {
    var idx = ring[i];
    var rev = idx < 0;
    var a = arcs[rev ? (~idx) : idx];
    var seg = rev ? a.slice().reverse() : a;
    var start = out.length ? 1 : 0;
    for (var j = start; j < seg.length; j++) out.push(seg[j]);
  }

  // 清洗：去掉连续重复点 + 保证闭合，否则 Cesium 三角化会抛
  // "EllipsoidRhumbLine must have distinct start and end set"
  var clean = [];
  for (var k = 0; k < out.length; k++) {
    var p = out[k];
    // 极地所有经度映射到同一 Cartesian3，会触发 Cesium 退化错误，纬度夹到 ±89.5
    var lon = p[0];
    var lat = Math.max(-89.5, Math.min(89.5, p[1]));
    var last = clean[clean.length - 1];
    if (!last || Math.abs(last[0] - lon) > 1e-9 || Math.abs(last[1] - lat) > 1e-9) {
      clean.push([lon, lat]);
    }
  }
  if (clean.length >= 3) {
    var a0 = clean[0], b0 = clean[clean.length - 1];
    if (a0[0] !== b0[0] || a0[1] !== b0[1]) clean.push([a0[0], a0[1]]);
  }
  if (clean.length < 4) return [];

  // 丢弃零面积/退化环（尖刺、重复边），同样会让三角化失败
  var area = 0;
  for (var m = 0; m < clean.length - 1; m++) {
    area += clean[m][0] * clean[m + 1][1] - clean[m + 1][0] * clean[m][1];
  }
  if (Math.abs(area) < 1e-8) return [];

  return clean;
}

function addGraticule(viewer) {
  var color = Cesium.Color.fromCssColorString('#33578c').withAlpha(0.32);
  var lon, lat, positions;
  for (lon = -180; lon < 180; lon += 15) {
    positions = [];
    for (lat = -85; lat <= 85; lat += 5) positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, 800));
    viewer.entities.add({ polyline: { positions: positions, width: 0.7, material: color, arcType: Cesium.ArcType.GEODESIC } });
  }
  for (lat = -75; lat <= 75; lat += 15) {
    if (lat === 0) continue;
    positions = [];
    for (lon = -180; lon <= 180; lon += 5) positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, 800));
    viewer.entities.add({ polyline: { positions: positions, width: 0.7, material: color, arcType: Cesium.ArcType.GEODESIC } });
  }
}

function setupCesiumScene(viewer) {
  var scene = viewer.scene;

  scene.globe.baseColor = Cesium.Color.fromCssColorString('#16305a');
  scene.backgroundColor = Cesium.Color.fromCssColorString('#060b16');
  scene.skyBox.show = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.skyAtmosphere.show = true;
  scene.skyAtmosphere.hueShift = -0.05;
  scene.skyAtmosphere.brightnessShift = 0.18;
  scene.skyAtmosphere.saturationShift = 0.12;
  scene.fog.enabled = false;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.enableLighting = false;

  // 最高画质：更细的瓦片误差、预加载、FXAA、高清渲染
  try {
    scene.globe.maximumScreenSpaceError = 1.5;
    scene.globe.preloadAncestors = true;
    scene.globe.preloadSiblings = true;
    scene.postProcessStages.fxaa.enabled = true;
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
    scene.screenSpaceCameraController.minimumZoomDistance = 80;
    scene.screenSpaceCameraController.maximumZoomDistance = 60000000;
  } catch (e) {}

  if (viewer.cesiumWidget && viewer.cesiumWidget.creditContainer) {
    viewer.cesiumWidget.creditContainer.style.display = 'none';
  }

  // NASA GIBS Blue Marble 真实地球影像（公有领域、免 Key、CORS 开放）
  try {
    var gibs = new Cesium.WebMapTileServiceImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{TileMatrix}/{TileRow}/{TileCol}.jpeg',
      layer: 'BlueMarble_ShadedRelief_Bathymetry',
      style: 'default',
      tileMatrixSetID: 'GoogleMapsCompatible_Level8',
      format: 'image/jpeg',
      maximumLevel: 8,
      credit: 'NASA GIBS · Blue Marble'
    });
    viewer.imageryLayers.addImageryProvider(gibs);
  } catch (e) {
    console.warn('[cesium] imagery unavailable', e);
  }

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(104, 31, 22000000)
  });

  addGraticule(viewer);

  // 国界用折线绘制（不做多边形三角化，规避复杂/极地多边形的
  // "EllipsoidRhumbLine must have distinct start and end set" 渲染崩溃）
  fetch(WORLD_TOPO_URL)
    .then(function (r) { return r.json(); })
    .then(function (topo) {
      var arcs = decodeTopoArcs(topo);
      var obj = topo.objects.countries;
      var geoms = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
      var color = Cesium.Color.fromCssColorString('#7b9ad0').withAlpha(0.95);

      geoms.forEach(function (g) {
        var polys = g.type === 'Polygon' ? [g.arcs] : (g.type === 'MultiPolygon' ? g.arcs : []);
        polys.forEach(function (poly) {
          poly.forEach(function (ring) {
            var pts = stitchRing(ring, arcs);
            if (pts.length < 4) return;
            var positions = pts.map(function (p) {
              return Cesium.Cartesian3.fromDegrees(p[0], p[1], 1000);
            });
            viewer.entities.add({
              polyline: {
                positions: positions,
                width: 1.1,
                material: color,
                arcType: Cesium.ArcType.GEODESIC
              }
            });
          });
        });
      });
      viewer.scene.requestRender();
    })
    .catch(function () {});
}

function createCesiumViewer(containerId) {
  var viewer = new Cesium.Viewer(containerId || 'cesiumContainer', {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity
  });
  setupCesiumScene(viewer);
  return viewer;
}

/* =========================================================================
   离线示意地图
   外部瓦片不可达时，用 Canvas 按经纬度画点位关系，保证页面不白屏
   ========================================================================= */
function showOfflineMap() {
  var box = $('offlineMap');
  if (box) box.classList.remove('hidden');
}

function hideOfflineMap() {
  var box = $('offlineMap');
  if (box) box.classList.add('hidden');
}

function renderOfflineMap(day) {
  var box = $('offlineMap');
  var cv = $('offlineCanvas');
  var host = $('map');
  if (!box || !cv || !host) return;
  if (!state.plan) { hideOfflineMap(); return; }

  var d = day || state.plan.days[(state.activeDay || 1) - 1];
  if (!d) { hideOfflineMap(); return; }

  var pois = d.pois.slice().sort(function (a, b) {
    return String(a.time || '').localeCompare(String(b.time || ''));
  }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); });

  showOfflineMap();

  var rect = host.getBoundingClientRect();
  var W = Math.max(240, Math.round(rect.width));
  var H = Math.max(180, Math.round(rect.height));
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = '100%';
  cv.style.height = '100%';

  var ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  var cs = getComputedStyle(document.documentElement);
  function v(name, fb) { return (cs.getPropertyValue(name) || fb).trim(); }
  var paper = v('--paper', '#FFFFFF');
  var ink3 = v('--ink-3', '#6A7385');
  var dots = document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'rgba(255,255,255,.055)' : 'rgba(10,13,20,.07)';

  // 底：纸质 + 点阵，和整体设计语言一致
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = dots;
  for (var gy = 16; gy < H; gy += 22) {
    for (var gx = 16; gx < W; gx += 22) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (!pois.length) {
    ctx.fillStyle = ink3;
    ctx.font = '600 13px system-ui, -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('当天暂无坐标', W / 2, H / 2);
    return;
  }

  // 等距投影（城市尺度下与 Web Mercator 差异可忽略）
  var lats = [], lngs = [];
  pois.forEach(function (p) { lats.push(p.lat); lngs.push(p.lng); });
  var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
  var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
  var spanLat = Math.max(maxLat - minLat, 0.0035);
  var spanLng = Math.max(maxLng - minLng, 0.0035);
  var padX = Math.max(58, W * 0.15);
  var padY = Math.max(58, H * 0.17);
  var scale = Math.min((W - padX * 2) / spanLng, (H - padY * 2) / spanLat);
  var offX = (W - spanLng * scale) / 2;
  var offY = (H - spanLat * scale) / 2;

  function toXY(p) {
    return [offX + (p.lng - minLng) * scale, H - offY - (p.lat - minLat) * scale];
  }

  var pts = pois.map(toXY);

  // 连线：白色描边打底 + 蓝色主线，在点阵背景上也能看清晰
  if (pts.length > 1) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach(function (pt, i) { i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]); });
    ctx.strokeStyle = paper;
    ctx.lineWidth = 6.5;
    ctx.stroke();
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  // 圆点 + 编号 + 名称（名称带简单防重叠）
  var placed = pts.map(function (pt) { return { x: pt[0] - 14, y: pt[1] - 14, w: 28, h: 28 }; });
  pois.forEach(function (p, i) {
    var c = CATEGORIES[p.type] || CATEGORIES.sight;
    var pt = pts[i];

    ctx.beginPath();
    ctx.arc(pt[0], pt[1], 13, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = paper;
    ctx.stroke();

    ctx.fillStyle = c.ink || '#FFFFFF';
    ctx.font = '800 12px system-ui, -apple-system, "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), pt[0], pt[1] + 0.5);

    var name = String(p.name || '');
    if (name.length > 11) name = name.slice(0, 11);
    if (!name) return;

    ctx.font = '700 11px system-ui, -apple-system, "Microsoft YaHei", sans-serif';
    var tw = ctx.measureText(name).width;
    var bw = tw + 12, bh = 19;
    var bx = Math.min(Math.max(pt[0] - bw / 2, 6), W - bw - 6);
    var by = pt[1] + 19;

    // 与已放置的标签/圆点冲突时向下顺延，最多尝试 5 次
    for (var guard = 0; guard < 5; guard++) {
      var hit = false;
      for (var k = 0; k < placed.length; k++) {
        var b = placed[k];
        if (!(bx + bw < b.x || bx > b.x + b.w || by + bh < b.y || by > b.y + b.h)) { hit = true; break; }
      }
      if (!hit) break;
      by += bh + 4;
    }
    if (by + bh > H - 6) by = Math.max(6, by - (bh + 4) * 2);
    placed.push({ x: bx, y: by, w: bw, h: bh });

    ctx.beginPath();
    ctx.moveTo(bx + 5, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, 5);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, 5);
    ctx.arcTo(bx, by + bh, bx, by, 5);
    ctx.arcTo(bx, by, bx + bw, by, 5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(10,13,20,.84)';
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, bx + bw / 2, by + bh / 2 + 0.5);
  });
}

/* =========================================================================
   卫星底图（双源 · 全部免 Key）
   低缩放：NASA GIBS Blue Marble —— 公有领域 全球真实地球
   城市级：Esri World Imagery    —— 免 Key 全球 0.3~1m 可看清屋顶（需署名）
   三档：macro 宏观卫星→放大切矢量3D / city 全程真实影像 / off 纯矢量
   ========================================================================= */
var SAT_LOW_TILES = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
  'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
var SAT_HIGH_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
  'World_Imagery/MapServer/tile/{z}/{y}/{x}';

function satMode() {
  var m = state.settings && state.settings.satMode;
  if (m === 'off' || m === 'city') return m;
  return 'macro';
}

// 低清卫星：city 档 z6 开始交棒，macro 档 z5 开始淡出，都在 z8 归零
function satLowOpacityAt(z) {
  var mode = satMode();
  if (mode === 'off') return 0;
  if (!isFinite(z)) return 1;
  var from = mode === 'city' ? 6 : 5;
  if (z <= from) return 1;
  if (z >= 8) return 0;
  return 1 - (z - from) / (8 - from);
}

// 高清卫星：只有 city 档启用，z6 → z8 淡入后常驻
// Esri 影像原生最高到 z18 左右，再往上会返回 "Map data not yet available" 的灰底提示图
// 所以 z16.5 之后逐步淡出，把画面交回矢量 3D，避免看到空白瓦片
var SAT_DETAIL_FULL_Z = 16.5;   // 到此级别仍是满不透明
var SAT_DETAIL_END_Z = 18.2;    // 到此级别完全透明

function satHighOpacityAt(z) {
  if (!isFinite(z)) return 0;
  // 搜索飞行期间：矢量瓦片在连续缩放时会被回收导致白屏，
  // 用卫星影像垫底（raster 会保留父级瓦片拉伸显示，不会整屏空白）
  // 用户明确关掉卫星时不强塞
  if (state.globeFlying && satMode() !== 'off') {
    if (z < 6.5) return Math.max(0, (z - 5) / 1.5);
    return 1;
  }
  if (satMode() !== 'city') return satFadeTo(0);
  if (z <= 6) return satFadeTo(0);
  if (z < 8) return satFadeTo((z - 6) / 2);
  if (z <= SAT_DETAIL_FULL_Z) return satFadeTo(1);
  if (z >= SAT_DETAIL_END_Z) return satFadeTo(0);
  return satFadeTo(1 - (z - SAT_DETAIL_FULL_Z) / (SAT_DETAIL_END_Z - SAT_DETAIL_FULL_Z));
}

// 飞行结束时影像层如果瞬间归零，画面会硬切一下。
// 用 760ms 把「飞行态的满不透明」平滑交回该级别应有的值。
function satFadeTo(normal) {
  if (!state.satFadeStart) return normal;
  var k = (performance.now() - state.satFadeStart) / 760;
  if (k >= 1) { state.satFadeStart = 0; return normal; }
  return 1 * (1 - k) + normal * k;
}

// 卫星影像上不该出现的矢量符号：POI 图标、单行道箭头、公路编号牌
var SAT_NOISE_LAYERS = [
  'poi_r20', 'poi_r7', 'poi_r1', 'poi_transit',
  'road_oneway', 'road_oneway_opposite',
  'highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us'
];

// 三态控制：
//   矢量模式        → 全部符号显示
//   低缩放卫星      → 全部隐藏（否则国家名会从球体边缘漏到深空）
//   城市级卫星      → 只隐藏 POI/路牌，保留地名与路名
function syncSatLayers(map) {
  if (!map) return;
  var z = map.getZoom();
  var low = satLowOpacityAt(z) > 0.35;
  var high = satHighOpacityAt(z) > 0.35;
  var stateKey = (low ? 'low' : (high ? 'high' : 'vec')) + '|' + satMode();
  if (map.__satKey === stateKey) return;
  map.__satKey = stateKey;

  var layers;
  try { layers = map.getStyle().layers || []; } catch (e) { return; }
  for (var i = 0; i < layers.length; i++) {
    var l = layers[i];
    if (l.type !== 'symbol') continue;
    var visible = true;
    if (low) visible = false;
    else if (high) visible = SAT_NOISE_LAYERS.indexOf(l.id) < 0;
    try { map.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none'); } catch (e) {}
  }
}

// 把路线 / 3D 建筑 / 文字重新提到影像之上（保持原有相对顺序）
function raiseOverSat(map) {
  if (!map) return;
  ['custom-3d-buildings', 'route-glow', 'route-casing', 'route-line', 'route-links-line'].forEach(function (id) {
    try { if (map.getLayer(id)) map.moveLayer(id); } catch (e) {}
  });
  var layers;
  try { layers = map.getStyle().layers || []; } catch (e) { return; }
  for (var i = 0; i < layers.length; i++) {
    if (layers[i].type !== 'symbol') continue;
    if (layers[i].id === 'sat-globe' || layers[i].id === 'sat-detail') continue;
    try { map.moveLayer(layers[i].id); } catch (e) {}
  }
}

function ensureSatellite(map) {
  if (!map) return;
  try {
    if (!map.getSource('sat-low')) {
      map.addSource('sat-low', {
        type: 'raster',
        tiles: [SAT_LOW_TILES],
        tileSize: 256,
        maxzoom: 8,
        attribution: 'NASA GIBS · Blue Marble'
      });
    }
    if (!map.getSource('sat-high')) {
      map.addSource('sat-high', {
        type: 'raster',
        tiles: [SAT_HIGH_TILES],
        tileSize: 256,
        minzoom: 6,
        maxzoom: 18,
        attribution: 'Imagery © Esri · Maxar · Earthstar Geographics'
      });
    }

    map.__satKey = undefined;

    if (!map.getLayer('sat-globe')) {
      map.addLayer({
        id: 'sat-globe',
        type: 'raster',
        source: 'sat-low',
        layout: { visibility: satLowOpacityAt(map.getZoom()) > 0.004 ? 'visible' : 'none' },
        paint: {
          'raster-opacity': satLowOpacityAt(map.getZoom()),
          'raster-fade-duration': 160,
          'raster-resampling': 'linear'
        }
      });
    }
    if (!map.getLayer('sat-detail')) {
      map.addLayer({
        id: 'sat-detail',
        type: 'raster',
        source: 'sat-high',
        layout: { visibility: satHighOpacityAt(map.getZoom()) > 0.004 ? 'visible' : 'none' },
        paint: {
          'raster-opacity': satHighOpacityAt(map.getZoom()),
          'raster-opacity-transition': { duration: 520, delay: 0 },
          'raster-fade-duration': 160,
          'raster-resampling': 'linear'
        }
      });
    }

    try { map.moveLayer('sat-globe'); } catch (e) {}
    try { map.moveLayer('sat-detail'); } catch (e) {}
    syncSatLayers(map);
    raiseOverSat(map);
  } catch (e) {}
}

// 逐帧推进 zoom 时 updateSatellite 会被每帧调用，
// 这里用 rAF 合并成「一帧最多算一次」，避免重复遍历 style.layers
var satRaf = 0, satRafMap = null, satHeavyAt = 0;
function updateSatellite(map) {
  if (!map) return;
  satRafMap = map;
  if (satRaf) return;
  satRaf = requestAnimationFrame(function () {
    satRaf = 0;
    applySatellite(satRafMap);
  });
}

function applySatellite(map) {
  if (!map) return;
  try {
    var z = map.getZoom();
    var lo = satLowOpacityAt(z);
    var hi = satHighOpacityAt(z);

    // 写入前先比较：setPaintProperty 每次都会触发 style 重算，
    // 逐帧推进时若不判重，光这一句就能吃掉一帧的时间
    if (map.getLayer('sat-globe')) {
      var oldLo = map.__satLo;
      if (oldLo == null || Math.abs(oldLo - lo) > 0.004) {
        map.__satLo = lo;
        map.setPaintProperty('sat-globe', 'raster-opacity', lo);
      }
      // 完全透明时直接隐藏，省掉无意义的瓦片请求与绘制
      var loVis = lo > 0.004 ? 'visible' : 'none';
      if (map.getLayoutProperty('sat-globe', 'visibility') !== loVis) {
        map.setLayoutProperty('sat-globe', 'visibility', loVis);
      }
    }
    if (map.getLayer('sat-detail')) {
      var oldHi = map.__satHi;
      if (oldHi == null || Math.abs(oldHi - hi) > 0.004) {
        map.__satHi = hi;
        map.setPaintProperty('sat-detail', 'raster-opacity', hi);
      }
      var hiVis = hi > 0.004 ? 'visible' : 'none';
      if (map.getLayoutProperty('sat-detail', 'visibility') !== hiVis) {
        map.setLayoutProperty('sat-detail', 'visibility', hiVis);
      }
    }

    // 建筑配色跟随「影像是否真的可见」：有影像时冷灰半透（透屋顶），
    // 影像淡出后回到矢量模式的米色实体，避免放大后整屏灰块
    if (map.getLayer('custom-3d-buildings')) {
      var onSat = hi > 0.15 || lo > 0.15;
      if (map.__bldOnSat !== onSat) {
        map.__bldOnSat = onSat;
        map.setPaintProperty('custom-3d-buildings', 'fill-extrusion-color', onSat ? '#C2C8D4' : '#d9d2c6');
        map.setPaintProperty('custom-3d-buildings', 'fill-extrusion-opacity', onSat ? 0.72 : 0.88);
      }
    }
  } catch (e) {}
  syncSatLayers(map);
  // 保险：路线若被影像盖住，重新抬到顶层。这个操作要遍历全部图层，
  // 每 500ms 最多查一次，真的错序了才动
  var now = performance.now();
  if (now - satHeavyAt < 500) return;
  satHeavyAt = now;
  try {
    var layers = map.getStyle().layers;
    var si = -1, ri = -1;
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].id === 'sat-detail' || layers[i].id === 'sat-globe') si = i;
      if (layers[i].id === 'route-line') ri = i;
    }
    if (ri >= 0 && si >= 0 && ri < si) raiseOverSat(map);
  } catch (e) {}
}

function bindSatellite(map) {
  if (!map) return;
  var raf = 0;
  map.on('zoom', function () {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; updateSatellite(map); });
  });
  map.on('style.load', function () { ensureSatellite(map); });
  ensureSatellite(map);
}

/* =========================================================================
   世界模型搜索：Photon（Komoot，基于 OpenStreetMap）地理编码
   带 Origin 时服务端返回 Access-Control-Allow-Origin: *，浏览器可直连
   ========================================================================= */
var GS_KIND = {
  university: '学校', college: '学校', school: '学校', kindergarten: '幼儿园',
  city: '城市', town: '城镇', village: '村庄', state: '省', county: '区县',
  district: '区', house: '地址', street: '街道', locality: '地名',
  region: '地区', country: '国家', station: '车站', halt: '站点',
  aerodrome: '机场', airport: '机场', hotel: '酒店', hostel: '住宿',
  restaurant: '餐厅', cafe: '咖啡', bar: '酒吧', fast_food: '快餐',
  mall: '商场', supermarket: '超市', convenience: '便利店',
  hospital: '医院', clinic: '诊所', pharmacy: '药店',
  park: '公园', garden: '花园', museum: '博物馆', attraction: '景点',
  viewpoint: '观景点', theme_park: '乐园', zoo: '动物园',
  bus_stop: '公交站', subway_entrance: '地铁口', peak: '山峰',
  water: '水域', river: '河流', lake: '湖泊', residential: '住宅区',
  commercial: '商圈', industrial: '园区', stadium: '体育场', sports_centre: '运动场',
  music: '场馆', theatre: '剧场', cinema: '影院', library: '图书馆',
  pitch: '球场', swimming_pool: '泳池', gym: '健身房', dojo: '场馆',
  dormitory: '宿舍', bank: '银行', post_office: '邮局', police: '警局',
  fire_station: '消防', townhall: '政府', place_of_worship: '寺庙教堂',
  marketplace: '市场', bakery: '面包店', pub: '酒吧', food_court: '餐饮',
  playground: '游乐场', nature_reserve: '保护区', forest: '林地',
  bridge: '桥梁', tunnel: '隧道', ferry_terminal: '码头'
};

var gsState = { results: [], active: -1, timer: 0, seq: 0, searching: false, picked: false };
var gsLoadingShown = false;
// 地名 → { at, results }。Photon 从本机往返要 5-10 秒，落盘缓存后第二次秒出
var GS_CACHE_KEY = 'gs_geo_cache_v5';
var gsCache = (function () {
  try {
    var raw = localStorage.getItem(GS_CACHE_KEY);
    return (raw && JSON.parse(raw)) || {};
  } catch (e) { return {}; }
})();

function gsCachePut(q, results) {
  gsCache[q] = { at: Date.now(), results: results };
  try {
    var keys = Object.keys(gsCache);
    if (keys.length > 40) {
      keys.sort(function (a, b) { return (gsCache[a].at || 0) - (gsCache[b].at || 0); })
        .slice(0, keys.length - 40)
        .forEach(function (k) { delete gsCache[k]; });
    }
    localStorage.setItem(GS_CACHE_KEY, JSON.stringify(gsCache));
  } catch (e) {}
}

function gsKind(p) {
  return GS_KIND[p && p.osm_value] || '';
}

function initGlobeSearch() {
  var input = $('globeSearchInput');
  if (!input || input.__bound) return;
  input.__bound = true;

  input.addEventListener('input', function () {
    var q = this.value.trim();
    var clr = $('globeSearchClear');
    if (clr) clr.style.display = q ? 'flex' : 'none';
    clearTimeout(gsState.timer);
    if (!q) { closeGsPanel(); return; }
    gsState.timer = setTimeout(function () { globeGeocode(q); }, 260);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var pick = gsState.results[gsState.active >= 0 ? gsState.active : 0];
      if (pick) globeGoTo(pick);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!gsState.results.length) return;
      e.preventDefault();
      var n = gsState.results.length;
      gsState.active = (e.key === 'ArrowDown')
        ? (gsState.active + 1 + n) % n
        : (gsState.active - 1 + n) % n;
      paintGsActive();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      if ($('globeSearchPanel') && $('globeSearchPanel').style.display !== 'none') {
        closeGsPanel();
      } else {
        closeGlobeView();
      }
    }
  });

  var clr = $('globeSearchClear');
  if (clr) {
    clr.addEventListener('click', function () {
      input.value = '';
      this.style.display = 'none';
      closeGsPanel();
      input.focus();
    });
  }

  var host = $('globeContainer');
  if (host) host.addEventListener('click', function () { closeGsPanel(); });
}

function closeGsPanel() {
  var p = $('globeSearchPanel');
  if (p) p.style.display = 'none';
  gsState.active = -1;
}

function paintGsActive() {
  var list = $('globeSearchList');
  if (!list) return;
  Array.prototype.forEach.call(list.querySelectorAll('.gs-item'), function (el, i) {
    el.classList.toggle('active', i === gsState.active);
  });
  var act = list.querySelector('.gs-item.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
}

function paintGsMessage(title, sub) {
  var panel = $('globeSearchPanel');
  var list = $('globeSearchList');
  var foot = $('globeSearchFoot');
  if (!panel || !list) return;
  panel.style.display = 'block';
  list.innerHTML = '';
  var box = document.createElement('div');
  box.className = 'gs-empty';
  if (title) {
    var b = document.createElement('b');
    b.textContent = title;
    box.appendChild(b);
  }
  if (sub) box.appendChild(document.createTextNode(sub));
  list.appendChild(box);
  if (foot) foot.textContent = 'OpenStreetMap · Photon + Nominatim';
}

function paintGsLoading() {
  var panel = $('globeSearchPanel');
  var list = $('globeSearchList');
  var foot = $('globeSearchFoot');
  if (!panel || !list) return;
  panel.style.display = 'block';
  list.innerHTML = '<div class="gs-loading"><i></i><i></i><i></i></div>';
  if (foot) foot.textContent = '正在搜索';
}

function paintGsList() {
  var panel = $('globeSearchPanel');
  var list = $('globeSearchList');
  var foot = $('globeSearchFoot');
  if (!panel || !list) return;
  // 用户已经点走了，后台迟到的结果不要再把面板弹回来
  if (gsState.picked) { panel.style.display = 'none'; return; }

  list.innerHTML = '';
  gsState.results.forEach(function (r, i) {
    var el = document.createElement('div');
    el.className = 'gs-item' + (i === gsState.active ? ' active' : '');

    var pin = document.createElement('span');
    pin.className = 'gs-pin';
    pin.innerHTML = ICONS.pin;

    var txt = document.createElement('div');
    txt.className = 'gs-txt';
    var nm = document.createElement('div');
    nm.className = 'gs-name';
    nm.textContent = r.name;
    txt.appendChild(nm);
    if (r.sub) {
      var sb = document.createElement('div');
      sb.className = 'gs-sub';
      sb.textContent = r.sub;
      txt.appendChild(sb);
    }

    el.appendChild(pin);
    el.appendChild(txt);

    if (r.kind) {
      var kd = document.createElement('span');
      kd.className = 'gs-kind';
      kd.textContent = r.kind;
      el.appendChild(kd);
    }

    el.addEventListener('click', function () { globeGoTo(r); });
    el.addEventListener('mouseenter', function () { gsState.active = i; paintGsActive(); });
    list.appendChild(el);
  });

  panel.style.display = 'block';
  if (foot) foot.textContent = 'OpenStreetMap · ' + gsState.results.length + ' 个结果';
}

/* ---------- 地理编码：Photon + Nominatim 双源并行，交叉校核 ----------
   Photon 快、中文覆盖一般；Nominatim 是 OSM 官方索引，行政区与 POI 更全。
   两源并行 → 按坐标去重 → 名称相似度 + 类型 + 是否有边界 打分排序。
   两个源都命中的地点会额外加分，因为相当于交叉验证过。
   ------------------------------------------------------------------- */
function gsNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\u00b7,，.。()（）\[\]【】'"`~!！?？:：;；/\\|+&@#-]/g, '')
    .replace(/(特别行政区|自治区|自治州|省|市|区|县|镇|乡|街道)$/g, '');
}

function gsDistM(a, b) {
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad;
  var dLng = (b.lng - a.lng) * rad;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

var GS_POI_KEYS = {
  amenity: 1, shop: 1, tourism: 1, leisure: 1, building: 1, office: 1,
  historic: 1, man_made: 1, railway: 1, aeroway: 1, healthcare: 1, education: 1
};
var GS_AREA_VALUES = {
  city: 1, town: 1, state: 1, county: 1, region: 1, country: 1, province: 1, district: 1
};

function gsFromPhoton(f) {
  if (!f || !f.geometry || !f.geometry.coordinates) return null;
  var p = f.properties || {};
  var c = f.geometry.coordinates;
  if (c.length < 2 || !isFinite(c[0]) || !isFinite(c[1])) return null;
  var name = p.name || p.street || p.city || p.state || p.country || '未命名地点';
  var sub = [p.district, p.city, p.county, p.state, p.country].filter(function (x, i, arr) {
    return x && x !== name && arr.indexOf(x) === i;
  }).join(' ');
  var ext = null;
  if (p.extent && p.extent.length === 4) {
    // Photon: [minLon, maxLat, maxLon, minLat] → 统一成 [w, s, e, n]
    ext = [Math.min(p.extent[0], p.extent[2]), Math.min(p.extent[1], p.extent[3]),
      Math.max(p.extent[0], p.extent[2]), Math.max(p.extent[1], p.extent[3])];
  }
  return {
    name: name, sub: sub, kind: GS_KIND[p.osm_value] || '',
    lng: c[0], lat: c[1], extent: ext,
    poi: !!(p.osm_key && GS_POI_KEYS[p.osm_key]) && !GS_AREA_VALUES[p.osm_value],
    addr: !!(p.housenumber || p.street),
    srcs: ['photon']
  };
}

function gsFromNominatim(x) {
  if (!x) return null;
  var lat = parseFloat(x.lat), lng = parseFloat(x.lon);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  var bb = x.boundingbox;
  var ext = null;
  if (bb && bb.length === 4) {
    // Nominatim: [south, north, west, east]
    var s = parseFloat(bb[0]), n = parseFloat(bb[1]);
    var w = parseFloat(bb[2]), e = parseFloat(bb[3]);
    if (isFinite(s) && isFinite(n) && isFinite(w) && isFinite(e)) {
      ext = [Math.min(w, e), Math.min(s, n), Math.max(w, e), Math.max(s, n)];
    }
  }
  var ad = x.address || {};
  var name = x.name ||
    (x.display_name ? String(x.display_name).split(',')[0].trim() : '') ||
    ad.city || ad.state || ad.country || '未命名地点';
  var parts = [ad.city_district, ad.suburb, ad.city, ad.county, ad.state, ad.country]
    .filter(function (v, i, arr) { return v && v !== name && arr.indexOf(v) === i; });
  if (!parts.length && x.display_name) {
    parts = String(x.display_name).split(',').slice(1, 4).map(function (s) { return s.trim(); });
  }
  return {
    name: name, sub: parts.join(' '),
    kind: GS_KIND[x.type] || GS_KIND[x.class] || '',
    lng: lng, lat: lat, extent: ext,
    poi: !!GS_POI_KEYS[x.class] && !GS_AREA_VALUES[x.type],
    addr: x.addresstype === 'house' || x.addresstype === 'building',
    srcs: ['nominatim']
  };
}

// 用户没提这些词时，别把酒店/餐厅顶到第一位
var GS_SERVICE_KINDS = ['酒店', '住宿', '餐厅', '咖啡', '酒吧', '快餐', '面包店',
  '商场', '超市', '便利店', '药房', '银行'];

function gsScore(r, q) {
  var nq = gsNorm(q), nn = gsNorm(r.name);
  var s = 0;
  if (nq && nn) {
    if (nn === nq) s += 36;
    else if (nn.indexOf(nq) >= 0) {
      s += 18;
      // 名称比查询长出很多的（搜「春熙路」命中「XX春熙路中心希尔顿花园酒店」）
      // 要压一压，否则具体 POI 会盖过地名本身
      var extra = nn.length - nq.length;
      if (extra > 5) s -= Math.min(14, (extra - 5) * 1.8);
    } else if (nq.indexOf(nn) >= 0 && nn.length >= Math.max(2, nq.length * 0.5)) {
      // 反过来：查询里包含结果名（「成都春熙路」里的「春熙路」），
      // 这通常正是用户想找的那一层地名
      s += 22;
    }
  }
  if (r.kind && GS_SERVICE_KINDS.indexOf(r.kind) >= 0 && nq.indexOf(r.kind) < 0) s -= 9;
  if (r.extent) s += 9;
  if (r.poi) s += 7;
  if (r.addr) s += 3;
  if (r.kind === '城市' || r.kind === '国家' || r.kind === '省' || r.kind === '地区') s -= 6;
  if (r.srcs && r.srcs.length > 1) s += 8;
  return s;
}

// 同名同地合并：名称一致且相距 800m 内视为同一个地点，
// 名称只是包含关系时收紧到 130m，避免把「广州塔」和「广州塔地铁站」揉成一条
function gsMerge(list) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i], hit = null;
    var na = gsNorm(r.name);
    for (var j = 0; j < out.length; j++) {
      var o = out[j];
      var nb = gsNorm(o.name);
      var same = na && nb && na === nb;
      var near = same || (na && nb && (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0));
      if (!near) continue;
      if (gsDistM(r, o) < (same ? 800 : 130)) { hit = o; break; }
    }
    if (!hit) { out.push(r); continue; }
    // 合并：source 并集，extent 取更精确的（更小的框），名称取更长的
    hit.srcs = (hit.srcs || []).concat(r.srcs || []).filter(function (v, k, arr) { return arr.indexOf(v) === k; });
    if (r.extent && (!hit.extent || gsBoxArea(r.extent) < gsBoxArea(hit.extent))) hit.extent = r.extent;
    if ((r.name || '').length > (hit.name || '').length) hit.name = r.name;
    if (!hit.sub && r.sub) hit.sub = r.sub;
    if (!hit.kind && r.kind) hit.kind = r.kind;
  }
  return out;
}

function gsBoxArea(e) {
  if (!e) return Infinity;
  return Math.abs(e[2] - e[0]) * Math.abs(e[3] - e[1]);
}

function gsFetchPhoton(q, extra) {
  var url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=10&lang=default' + (extra || '');
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 9000);
  return fetch(url, { signal: ctrl.signal })
    .then(function (r) { if (!r.ok) throw new Error('photon ' + r.status); return r.json(); })
    .then(function (d) {
      clearTimeout(timer);
      return (d.features || []).map(gsFromPhoton).filter(Boolean);
    })
    .catch(function () { clearTimeout(timer); return []; });
}

// Photon 的默认排序偏向商业 POI：搜「成都春熙路」会先给你一串酒店。
// 再发一次只查行政区 / 街道层的请求，让「春熙路」本身也能进候选。
var GS_LAYER_Q = '&layer=street&layer=locality&layer=district&layer=city&layer=county&layer=state';

function gsFetchPhotonAdmin(q) {
  return gsFetchPhoton(q, GS_LAYER_Q).then(function (list) {
    list.forEach(function (r) { r.admin = true; });
    return list;
  });
}

function gsFetchNominatim(q, timeout) {
  var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10' +
    '&accept-language=zh-CN,zh,en&addressdetails=1&q=' + encodeURIComponent(q);
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeout || 5000);
  return fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('nominatim ' + r.status); return r.json(); })
    .then(function (d) {
      clearTimeout(timer);
      return (Array.isArray(d) ? d : []).map(gsFromNominatim).filter(Boolean);
    })
    .catch(function () { clearTimeout(timer); return []; });
}

// 搜索采用「先到先显示」：Photon 一般 5-10 秒，Nominatim 更慢，
// 谁先回来就先渲染谁的，另一个回来再静默合并，绝不让用户干等
async function globeGeocode(q) {
  var seq = ++gsState.seq;
  gsState.active = -1;
  gsState.picked = false;

  // 命中缓存直接出结果
  var hit = gsCache[q];
  if (hit && Date.now() - hit.at < 604800000) {
    gsState.searching = false;
    gsState.results = hit.results.map(function (r) { r.q = q; return r; });
    gsState.active = 0;
    paintGsList();
    return;
  }

  gsState.searching = true;
  paintGsLoading();

  var photons = [], noms = [], shown = false;

  function commit() {
    if (gsState.picked) return false;
    var merged = gsMerge(noms.concat(photons));
    if (!merged.length) return false;
    merged.sort(function (a, b) { return gsScore(b, q) - gsScore(a, q); });
    merged = merged.slice(0, 8);
    // 记住搜索词，定位时用来判断「这条结果是不是真的就是你要找的地方」
    merged.forEach(function (r) { r.q = q; });

    // 首项没变就不重画：第二个源晚到时如果重排 DOM，
    // 用户正好要点的那个元素会凭空消失
    var oldTop = gsState.results[0] && gsState.results[0].name;
    if (shown && oldTop === merged[0].name) {
      gsState.results = merged;
      return true;
    }

    // 第二次合并时尽量保住用户当前选中的那一项，别让列表在鼠标底下换位
    var keep = gsState.results[gsState.active] && gsState.results[gsState.active].name;
    var keepIdx = -1;
    if (keep) merged.forEach(function (r, i) { if (r.name === keep && keepIdx < 0) keepIdx = i; });
    gsState.results = merged;
    gsState.active = keepIdx >= 0 ? keepIdx : 0;
    paintGsList();
    shown = true;
    return true;
  }

  var pP = gsFetchPhoton(q).then(function (r) {
    photons = photons.concat(r);
    if (seq === gsState.seq && !shown) shown = commit();
  });
  // 行政区 / 街道层单独查一次，跟主查询并行，不额外增加等待
  var pA = gsFetchPhotonAdmin(q).then(function (r) {
    photons = photons.concat(r);
    if (seq === gsState.seq) shown = commit() || shown;
  });

  await Promise.all([pP, pA]);
  if (seq !== gsState.seq) return;

  // Photon 结果太单薄（或干脆没有）时补一次 Nominatim：
  // 像「广州塔」这种地标，Photon 只给出一条「广州塔路」，得靠它补全
  if (photons.length < 3) {
    noms = await gsFetchNominatim(q, 5000);
    if (seq !== gsState.seq) return;
    if (!shown) shown = commit();
  }

  gsState.searching = false;
  if (!shown && !commit()) {
    if (!photons.length && !noms.length) {
      paintGsMessage('搜索服务不可达', '需要联网 稍后再试或检查网络');
    } else {
      paintGsMessage('没找到这个地点', '换个说法试试 比如加上城市名');
    }
    return;
  }
  gsCachePut(q, gsState.results);
}

/* ---------- 点击后：精修坐标 → 对准 → 平滑放大 ----------
   顺序严格按「先定位准，再放大」：
   1) 校准：Overpass 在附近找同名 OSM 要素，拿到比搜索索引更准的中心点
   2) 对准：相机平移到目标 + 中景 zoom，落点标记落在视口正中
   3) 放大：中心锁死不再移动，只推进 zoom，逐帧自适应速率
   ------------------------------------------------------------ */
function gsFitZoom(r, map) {
  var MAXZ = 16.4, MINZ = 12.5;
  var ext = r.extent;
  if (!ext || ext.length !== 4) return MAXZ;
  var w = Math.abs(ext[2] - ext[0]);
  var h = Math.abs(ext[3] - ext[1]);
  if (!(w > 1e-6) || !(h > 1e-6)) return MAXZ;
  var cv = map.getCanvas();
  var W = Math.max(320, (cv.clientWidth || 1000) - 150);
  var H = Math.max(240, (cv.clientHeight || 700) - 170);
  var zx = Math.log2(360 * W / (256 * w));
  var zy = Math.log2(360 * H / (256 * h));
  var zFit = Math.max(MINZ, Math.min(MAXZ, Math.min(zx, zy)));

  // 命中项的名称比搜索词长很多时，说明搜的是地名、拿到的是某个具体门店，
  // 视野要放宽一档，让人看到整片区域而不是盯着别人的招牌
  var q = r.q ? gsNorm(r.q) : '';
  if (q) {
    var extra = String(r.name || '').length - String(r.q).length;
    if (extra > 10) zFit = Math.min(zFit, 13.8);
    else if (extra > 6) zFit = Math.min(zFit, 14.6);
  }
  return zFit;
}

// Overpass：两个公共实例并发，谁先返回就用谁；总上限 2.2 秒
// 之前是「一个超时再换下一个」，最坏 14 秒，用户会以为点了没反应
function gsOverpass(r, token) {
  var name = String(r.name || '').trim();
  if (!name || name === '未命名地点') return Promise.resolve(null);
  var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');
  var around = r.extent && gsBoxArea(r.extent) > 0.02 ? 60000 : 26000;
  var q = '[out:json][timeout:5];(' +
    'nwr["name"="' + esc + '"](around:' + around + ',' + r.lat + ',' + r.lng + ');' +
    'nwr["name:zh"="' + esc + '"](around:' + around + ',' + r.lat + ',' + r.lng + ');' +
    ');out center 12;';

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 2200);

  function ask(host) {
    return fetch(host, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    }).then(function (res) {
      if (!res.ok) throw new Error('overpass ' + res.status);
      return res.json();
    });
  }

  function pick(j) {
    var els = (j && j.elements) || [];
    var best = null, bestScore = -1;
    for (var k = 0; k < els.length; k++) {
      var el = els[k];
      var tg = el.tags || {};
      var lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      var lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      var s = 0;
      if (tg.name === name) s += 20;
      if (el.type === 'relation') s += 4;
      if (el.type === 'way') s += 3;
      if (tg.building || tg.amenity || tg.leisure || tg.tourism) s += 3;
      if (s > bestScore) {
        bestScore = s;
        best = { lat: lat, lng: lng, exact: tg.name === name, type: el.type, bounds: el.bounds || null };
      }
    }
    return best;
  }

  var jobs = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ].map(function (h) { return ask(h); });

  return Promise.any(jobs)
    .then(function (j) { return pick(j); })
    .catch(function () { return null; })
    .then(function (v) { clearTimeout(timer); return token === state.globeFlyToken ? v : null; });
}

// 校准：只有坐标可能不够精确时才查 Overpass
// 1) 城市/省这类大范围结果不精修，用户要的就是全景
// 2) extent 已经很小的（< 0.0004 平方度，约 2km 见方）说明 Photon 返回的
//    就是 OSM 里的那栋楼/那个校园要素，坐标准确，直接跳过，0 等待
function gsRefine(r, token) {
  if (r.extent) {
    var area = gsBoxArea(r.extent);
    if (area > 0.05) return Promise.resolve(null);
    if (area < 0.0004) return Promise.resolve(null);
  }
  return gsOverpass(r, token).then(function (fix) {
    if (!fix || !fix.exact) return null;
    // 偏差超过 40km 说明匹配到别处的同名地点，不采信
    if (gsDistM(r, fix) > 40000) return null;
    var ext = null;
    if (fix.bounds) {
      ext = [Math.min(fix.bounds.minlon, fix.bounds.maxlon), Math.min(fix.bounds.minlat, fix.bounds.maxlat),
        Math.max(fix.bounds.minlon, fix.bounds.maxlon), Math.max(fix.bounds.minlat, fix.bounds.maxlat)];
    } else {
      // 没有边界就给一个约 500m 的框，配合 gsFitZoom 会落到 z16 上限
      ext = [fix.lng - 0.0028, fix.lat - 0.0019, fix.lng + 0.0028, fix.lat + 0.0019];
    }
    return { lng: fix.lng, lat: fix.lat, extent: ext, type: fix.type };
  });
}

function ensureTileTemplate() {
  if (state.tileTemplate) return Promise.resolve(state.tileTemplate);
  var cached = null;
  try { cached = localStorage.getItem('ofm_tile_tpl'); } catch (e) {}
  if (cached) { state.tileTemplate = cached; return Promise.resolve(cached); }
  return fetch('https://tiles.openfreemap.org/planet/latest')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var t = (j.tiles || [])[0];
      if (t) {
        state.tileTemplate = t;
        try { localStorage.setItem('ofm_tile_tpl', t); } catch (e) {}
      }
      return t;
    })
    .catch(function () { return null; });
}

// 分级串行预取：一次只打一级（9 张），把近处和终点级别先拿到手，
// 避免几十个请求同时挤占带宽反而让动画更卡
function prefetchTiles(lng, lat, fromZ, toZ) {
  ensureTileTemplate().then(function (tpl) {
    if (!tpl) return;
    var maxZ = Math.min(14, Math.ceil(toZ));
    var first = Math.max(1, Math.floor(fromZ) + 1);
    var levels = [];
    for (var z = first; z <= maxZ; z++) levels.push(z);
    if (!levels.length) return;
    var picked = [];
    levels.slice(0, 3).forEach(function (v) { if (picked.indexOf(v) < 0) picked.push(v); });
    levels.slice(-2).forEach(function (v) { if (picked.indexOf(v) < 0) picked.push(v); });
    var idx = 0;
    (function next() {
      if (idx >= picked.length) return;
      var zz = picked[idx++];
      var n = Math.pow(2, zz);
      var x0 = Math.floor((lng + 180) / 360 * n);
      var rr = lat * Math.PI / 180;
      var y0 = Math.floor((1 - Math.log(Math.tan(rr) + 1 / Math.cos(rr)) / Math.PI) / 2 * n);
      var jobs = [];
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var u = tpl.replace('{z}', zz).replace('{x}', x0 + dx).replace('{y}', y0 + dy);
          jobs.push(fetch(u, { cache: 'force-cache' }).catch(function () {}));
        }
      }
      Promise.all(jobs).then(next);
    })();
  });
}

function gsLoading(on, text) {
  var el = $('gsStatus');
  if (!el) return;
  if (text) {
    var t = $('gsStatusText');
    if (t) t.textContent = text;
  }
  el.style.display = on ? 'inline-flex' : 'none';
}

// 逐帧推进 zoom：中心不动，速率随剩余距离衰减，掉帧时自动降速
// 相比「分段 easeTo + 定时静置」，这条曲线没有顿挫，也不会有哪一段突然冲刺
function gsRampZoom(map, toZ, token, done) {
  var last = performance.now();
  var base = 3.0;                       // 稳态 3 级/秒
  var rate = base * 0.55;               // 起步就给一半速度，避免开头肉一下
  var fails = 0;

  function frame(now) {
    if (token !== state.globeFlyToken) return;
    var dt = now - last;
    last = now;
    if (dt > 140) dt = 140;             // 切回标签页时不跳级
    var z = map.getZoom();
    var remain = toZ - z;
    if (remain <= 0.006) {
      try { map.jumpTo({ zoom: toZ }); } catch (e) {}
      done();
      return;
    }
    // 末段自然收束，越接近目标越慢，停下来不会顿一下
    var want = base * (0.18 + 0.82 * Math.min(1, remain / 3.4));
    // 掉帧保护：帧间隔变大说明渲染吃力，降速让瓦片追上，避免越卡越白
    if (dt > 44) want *= 0.66;
    if (dt > 85) want *= 0.6;
    rate += (want - rate) * Math.min(1, dt / 170);
    if (rate < 0.30) rate = 0.30;

    var dz = rate * dt / 1000;
    if (dz > remain) dz = remain;
    try {
      map.jumpTo({ zoom: z + dz });
      fails = 0;
    } catch (e) {
      // 地图正在重载 style 时 jumpTo 可能抛错，别让动画就此死掉
      if (++fails > 40) { done(); return; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function globeGoTo(r) {
  var map = state.globeMap;
  if (!map || !r) return;

  gsState.picked = true;
  closeGsPanel();
  var input = $('globeSearchInput');
  if (input) {
    input.value = r.name;
    input.blur();
  }
  var clr = $('globeSearchClear');
  if (clr) clr.style.display = 'flex';

  // 落点标记先挂上，位置稍后由校准结果修正
  if (state.globePin) {
    try { state.globePin.remove(); } catch (e) {}
    state.globePin = null;
  }
  var el = document.createElement('div');
  el.className = 'globe-pin';
  var dot = document.createElement('span');
  dot.className = 'gp-dot';
  var lab = document.createElement('span');
  lab.className = 'gp-label';
  lab.textContent = r.name;
  el.appendChild(dot);
  el.appendChild(lab);
  try {
    state.globePin = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([r.lng, r.lat])
      .addTo(map);
  } catch (e) {}

  var token = (state.globeFlyToken = (state.globeFlyToken || 0) + 1);
  try { map.stop(); } catch (e) {}
  state.globeFlying = true;
  try { ensureSatellite(map); updateSatellite(map); } catch (e) {}

  var target = { lng: r.lng, lat: r.lat };
  var wantZ = gsFitZoom(r, map);
  var fromZ = map.getZoom();

  // 校准请求在点击瞬间就发出去，跟对准动画并行，不额外占时间
  var refineP = gsRefine(r, token);

  // 兜底：任何一步卡住（网络抖动、地图重载）都不让状态条一直挂着
  if (state.globeFlyWatch) clearTimeout(state.globeFlyWatch);
  state.globeFlyWatch = setTimeout(function () {
    if (token === state.globeFlyToken) finish(true);
  }, 15000);

  function finish(landed) {
    if (token !== state.globeFlyToken) return;
    if (state.globeFlyWatch) { clearTimeout(state.globeFlyWatch); state.globeFlyWatch = 0; }
    state.globeFlying = false;
    state.satFadeStart = performance.now();
    gsLoading(false);
    try { updateSatellite(map); } catch (e) {}
    // 卫星层交接：飞行期间影像满铺，结束后 760ms 内平滑交回矢量，避免硬切
    var t0 = performance.now();
    (function fade() {
      if (performance.now() - t0 > 780) return;
      try { updateSatellite(map); } catch (e) {}
      requestAnimationFrame(fade);
    })();
    if (landed) {
      el.classList.add('gp-landed');
      setTimeout(function () { el.classList.remove('gp-landed'); }, 1100);
      toast('已定位 ' + r.name);
    }
  }

  function startRamp() {
    if (token !== state.globeFlyToken) return;
    gsLoading(true, '已定位 正在放大');
    var c = map.getCenter();
    try { map.jumpTo({ center: [c.lng, c.lat] }); } catch (e) {}
    // 收敛：抹平对准时的微小偏移，再开始推 zoom
    setTimeout(function () {
      if (token !== state.globeFlyToken) return;
      if (wantZ - map.getZoom() <= 0.02) { finish(true); return; }
      gsRampZoom(map, wantZ, token, function () { finish(true); });
    }, reducedMotion() ? 0 : 180);
  }

  // ---- 阶段一：对准（立刻开始，不等任何网络请求）----
  // 中景高度够看清周边街区，又不至于一步到位；中心在这里就落到目标上
  var midZ;
  if (fromZ > wantZ + 0.4) {
    midZ = wantZ;                                   // 当前比目标更近，先退到目标高度
  } else if (fromZ >= wantZ - 0.6) {
    midZ = fromZ;                                   // 差不多高度，纯平移
  } else {
    midZ = Math.max(fromZ + 1.6, Math.min(11.8, wantZ - 4.0));
    if (midZ > wantZ - 0.35) midZ = wantZ - 0.35;
  }

  gsLoading(true, '已定位 正在对准');
  prefetchTiles(target.lng, target.lat, fromZ, wantZ);

  // duration 为 0 时 easeTo 会同步走完并立刻派发 moveend，
  // 所以监听必须在调用之前挂上，否则「减少动效」模式下会收不到回调
  gsGlide(map, {
    center: [target.lng, target.lat],
    zoom: midZ,
    pitch: 0,
    bearing: 0,
    duration: reducedMotion() ? 0 : 820,
    easing: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    essential: true
  }, function () {
    if (token !== state.globeFlyToken) return;
    el.classList.add('gp-landed');

    // ---- 阶段二：校准（对准已完成，标记已在正中，这里最多再等 1.2s）----
    // 大多数结果 Photon 已经给了精确边界，校准是同步完成的，
    // 只在真的慢时才把文案切成「正在校准坐标」，避免闪一下
    var slowCal = setTimeout(function () {
      if (token === state.globeFlyToken) gsLoading(true, '正在校准坐标');
    }, 260);
    var cap = new Promise(function (res) { setTimeout(function () { res(null); }, 1200); });

    Promise.race([refineP, cap]).then(function (fix) {
      clearTimeout(slowCal);
      if (token !== state.globeFlyToken) return;
      var moved = fix && gsDistM(target, fix) > 25;
      if (moved) {
        target.lng = fix.lng;
        target.lat = fix.lat;
        if (fix.extent) r.extent = fix.extent;
        wantZ = gsFitZoom(r, map);
        try { state.globePin.setLngLat([target.lng, target.lat]); } catch (e) {}
        gsGlide(map, {
          center: [target.lng, target.lat],
          duration: reducedMotion() ? 0 : 380,
          easing: function (t) { return 1 - Math.pow(1 - t, 3); },
          essential: true
        }, startRamp);
      } else {
        startRamp();
      }
    });
  });

  toast('正在前往 ' + r.name);
}

// 平移/缩放的统一收尾：duration 为 0 时同步完成，必须先挂钩子再动相机
function gsGlide(map, opts, done) {
  if (!opts.duration) {
    try {
      map.jumpTo({ center: opts.center, zoom: opts.zoom, pitch: opts.pitch, bearing: opts.bearing });
    } catch (e) {}
    done();
    return;
  }
  map.once('moveend', done);
  map.easeTo(opts);
}



/* =========================================================================
   世界模型探索（MapLibre globe：缩小是球，放大无缝进入 3D 城市）
   ========================================================================= */
function showGlobeError(msg) {
  var box = $('globeError');
  if (!box) return;
  $('globeErrorBody').textContent = msg || '可能原因 当前环境限制了外部请求 网络无法访问 CDN 或浏览器禁用了 WebGL';
  box.style.display = 'block';
  var hud = $('globeHud');
  if (hud) hud.textContent = '世界模型加载失败';
}

function hideGlobeError() {
  var box = $('globeError');
  if (box) box.style.display = 'none';
}

// 探测底图服务是否可达
// 注意：不能用 HEAD + cache:'no-store' —— 会触发 CORS 预检 OPTIONS，
// 而 OpenFreeMap 的 OPTIONS 返回 405，导致探测必然失败（"每次打开都提示"的根因）
// 这里用最普通的 GET（简单请求，不预检），失败后再重试一次
function pingMapService(tries) {
  tries = (tries == null) ? 1 : tries;
  return fetch('https://tiles.openfreemap.org/styles/bright', { method: 'GET' })
    .then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    })
    .then(function () { return true; })
    .catch(function () {
      if (tries <= 1) return false;
      return new Promise(function (res) {
        setTimeout(function () { res(pingMapService(tries - 1)); }, 2400);
      });
    });
}

// 最近一次连通性结论：null 未知 / true 在线 / false 离线
var mapServiceOnline = null;

function checkEnv() {
  pingMapService(2).then(function (ok) {
    mapServiceOnline = ok;
    var el = $('envWarn');
    if (el) el.style.display = ok ? 'none' : 'flex';

    // 断网且已有行程 → 立刻切离线示意，不用等地图超时
    if (!ok && state.plan && !state.offline) {
      state.offline = true;
      renderOfflineMap();
    }
    if (ok && state.offline && !state.map) {
      state.offline = false;
      hideOfflineMap();
    }
  });
}

// 地图 move/zoom 一帧可能触发多次，这里合并到每帧最多写一次 DOM
var hudRaf = 0, hudTarget = null;
function updateGlobeHudMap(map) {
  if (!map) return;
  hudTarget = map;
  if (hudRaf) return;
  hudRaf = requestAnimationFrame(function () {
    hudRaf = 0;
    paintGlobeHud(hudTarget);
  });
}

function paintGlobeHud(map) {
  if (!map) return;
  var z = map.getZoom();
  var c = map.getCenter();
  var hud = $('globeHud');
  if (hud) {
    var txt = '缩放 z' + z.toFixed(1) + '  中心 ' + c.lat.toFixed(2) + '°N  ' + c.lng.toFixed(2) + '°E';
    if (hud.__txt !== txt) { hud.__txt = txt; hud.textContent = txt; }
  }
  var tip = $('globeTip');
  if (tip) {
    var tipTxt;
    if (satMode() === 'city' && z > SAT_DETAIL_FULL_Z) {
      tipTxt = '卫星影像已到上限 再放大自动切回矢量 3D';
    } else {
      tipTxt = z < 5
        ? '滚轮放大 拖拽旋转 缩小看地球 放大进城市'
        : (z < 12 ? '继续放大进入街区' : '拖拽旋转 滚轮继续放大');
    }
    if (tip.__txt !== tipTxt) { tip.__txt = tipTxt; tip.textContent = tipTxt; }
  }
  var btn = $('globe3d');
  if (btn) {
    var show = z >= 10 ? 'inline-flex' : 'none';
    if (btn.style.display !== show) btn.style.display = show;
    var lbl = map.getPitch() > 10 ? '关闭 3D 视角' : '开启 3D 视角';
    if (btn.textContent !== lbl) btn.textContent = lbl;
  }
}

function openGlobeView() {
  var el = $('globeView');
  if (!el) return;

  // 实例已经在：直接掀开，二次打开是瞬时的。
  // 不要去 remove 再重建 —— WebGL 上下文释放是异步的，
  // 关掉后马上重开会拿到一个半死状态，永远卡在「正在加载世界模型」。
  if (state.globeMap) {
    el.classList.remove('hidden', 'fade-out');
    state.globeCloseToken = (state.globeCloseToken || 0) + 1;
    hideGlobeError();
    setTimeout(function () {
      if (!state.globeMap) return;
      try { state.globeMap.resize(); } catch (e) {}
      try { updateSatellite(state.globeMap); } catch (e) {}
      updateGlobeHudMap(state.globeMap);
    }, 40);
    initGlobeSearch();
    return;
  }

  if (state.landingIntro) {
    try { state.landingIntro.close(); } catch (e) {}
    state.landingIntro = null;
  }

  el.classList.remove('hidden', 'fade-out');
  // 作废上一次关闭时排队的隐藏动作
  state.globeCloseToken = (state.globeCloseToken || 0) + 1;
  hideGlobeError();
  $('globeHud').textContent = '正在加载世界模型';
  initGlobeSearch();

  // 预热：搜索服务从本机握手要 1-2 秒，打开世界模型时就先把连接建好，
  // 瓦片模板也一起拿下来，用户真正搜索/定位时少等一截
  try {
    fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent('北京') + '&limit=1')
      .catch(function () {});
  } catch (e) {}
  ensureTileTemplate();

  if (!supportsWebGL()) {
    showGlobeError('当前浏览器不支持 WebGL 无法渲染 3D 地球 请换 Chrome 或 Edge 或在浏览器设置中开启硬件加速');
    return;
  }

  // 离线时世界模型没有瓦片可拉，直接给明确提示，避免黑屏
  if (state.offline || mapServiceOnline === false || typeof maplibregl === 'undefined') {
    showGlobeError('当前无法访问地图服务 世界模型需要在联网状态下使用 行程与卡片不受影响');
    return;
  }

  try {
    var c = planCenter(state.plan) || { lat: 30.657, lng: 104.0657 };
    var map = new maplibregl.Map({
      container: 'globeContainer',
      style: MAP_STYLES[state.settings.style] ? MAP_STYLES[state.settings.style].url : MAP_STYLES.bright.url,
      center: [c.lng, c.lat],
      zoom: 2.2,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      maxPitch: 85,
      maxZoom: 19,
      // 跨多级缩放时多留一些旧瓦片，避免父级被回收后整屏空白
      maxTileCacheSize: 300
    });
    state.globeMap = map;
    // 容器尺寸会随主题/布局变化（切换深色会重排整页），
    // 地图不跟着量就会被裁掉一块，交给 ResizeObserver 兜住
    if (window.ResizeObserver) {
      try {
        var gro = new ResizeObserver(function () {
          if (!state.globeMap) return;
          try { state.globeMap.resize(); } catch (e) {}
        });
        gro.observe(map.getContainer());
      } catch (e) {}
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    var applied = false;
    function applyGlobe() {
      if (applied) return;
      applied = true;
      try { map.setProjection({ type: 'globe' }); } catch (e) {}
      try {
        map.setSky({
          'sky-color': '#0b1a33',
          'sky-horizon-blend': 0.6,
          'horizon-color': '#2f5d8f',
          'horizon-fog-blend': 0.5,
          'fog-color': '#0b1a33',
          'fog-ground-blend': 0.9,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.7, 7, 0]
        });
      } catch (e) {}
      enableTerrain(map);
      addCustomBuildings(map);
      ensureSatellite(map);
      localizeLabels(map);
      setTimeout(function () { localizeLabels(map); }, 700);
      setTimeout(function () { ensureSatellite(map); updateSatellite(map); }, 700);
      updateGlobeHudMap(map);
    }

    map.on('style.load', applyGlobe);
    map.on('load', function () {
      if (!applied) applyGlobe();
      updateGlobeHudMap(map);
    });
    map.on('move', function () { updateGlobeHudMap(map); });

    // 用户一旦自己操作（滚轮/拖拽/触摸），立刻放弃搜索飞行动画
    function cancelGlobeFly() {
      if (!state.globeFlying) return;
      state.globeFlyToken = (state.globeFlyToken || 0) + 1;
      state.globeFlying = false;
      if (state.globeFlyWatch) { clearTimeout(state.globeFlyWatch); state.globeFlyWatch = 0; }
      gsLoading(false);
      try { updateSatellite(map); } catch (e) {}
    }
    map.on('wheel', cancelGlobeFly);
    map.on('dragstart', cancelGlobeFly);
    map.on('touchstart', cancelGlobeFly);
    bindSatellite(map);
    map.on('zoom', function () { updateGlobeHudMap(map); });
    setTimeout(applyGlobe, 6000);
  } catch (e) {
    showGlobeError('加载失败 ' + (e.message || e) + ' 请用 Chrome 或 Edge 直接打开本文件 并检查网络与硬件加速');
  }
}

function closeGlobeView() {
  var el = $('globeView');
  if (!el || el.classList.contains('hidden')) return;
  hideGlobeError();
  el.classList.add('fade-out');
  // 关闭动画期间用户可能又点开，用 token 作废这次隐藏
  var closeToken = (state.globeCloseToken = (state.globeCloseToken || 0) + 1);
  setTimeout(function () {
    if (closeToken !== state.globeCloseToken) return;
    el.classList.add('hidden');
    el.classList.remove('fade-out');
  }, 420);
  // 地图实例保留：下次打开瞬间可用，也避开了 WebGL 上下文回收的竞态。
  // 这里只需要把飞行/搜索状态复位，别让残留动画在后台跑。
  state.globeFlying = false;
  state.globeFlyToken = (state.globeFlyToken || 0) + 1;
  if (state.globeFlyWatch) { clearTimeout(state.globeFlyWatch); state.globeFlyWatch = 0; }
  gsLoading(false);
  if (state.globePin) {
    try { state.globePin.remove(); } catch (e) {}
    state.globePin = null;
  }
  closeGsPanel();
  var gsInput = $('globeSearchInput');
  if (gsInput) gsInput.value = '';
  var gsClr = $('globeSearchClear');
  if (gsClr) gsClr.style.display = 'none';
  gsState.results = [];
  gsState.active = -1;
  gsState.seq++;
  gsState.picked = false;
}

function toggleGlobe3D() {
  var map = state.globeMap;
  if (!map) return;
  if (map.getPitch() > 10) {
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  } else {
    enableTerrain(map);
    addCustomBuildings(map);
    map.easeTo({ pitch: 55, bearing: -20, duration: 900 });
  }
}

function planCenter(plan) {
  if (!plan) return null;
  if (plan.center && isFinite(plan.center.lat) && isFinite(plan.center.lng)) {
    return { lat: +plan.center.lat, lng: +plan.center.lng };
  }
  var lats = [], lngs = [];
  (plan.days || []).forEach(function (d) {
    (d.pois || []).forEach(function (p) {
      if (isFinite(p.lat) && isFinite(p.lng)) { lats.push(p.lat); lngs.push(p.lng); }
    });
  });
  if (!lats.length) return null;
  return {
    lat: lats.reduce(function (a, b) { return a + b; }, 0) / lats.length,
    lng: lngs.reduce(function (a, b) { return a + b; }, 0) / lngs.length
  };
}

function createIntro(landing) {
  var el = $('intro');
  el.classList.remove('hidden', 'fade-out');
  $('introCity').textContent = landing ? '准备出发' : '正在出发';
  $('introStatus').textContent = landing ? '输入目的地与日期 开始规划你的旅程' : '正在生成行程';
  $('introTip').textContent = landing ? '点击「开始规划」进入' : '点击右上角可跳过';
  $('introStart').style.display = landing ? 'inline-flex' : 'none';
  $('skipIntro').textContent = landing ? '直接进入' : '跳过开场';

  var map = null;
  var closed = false;
  var flightResolve = null;

  function fadeOut(duration) {
    return new Promise(function (resolve) {
      el.classList.add('fade-out');
      setTimeout(function () {
        el.classList.add('hidden');
        el.classList.remove('fade-out');
        resolve();
      }, duration || 720);
    });
  }

  function destroy() {
    if (!map) return;
    try { map.remove(); } catch (e) {}
    map = null;
  }

  function closeNow(quick) {
    if (closed) return;
    closed = true;
    if (flightResolve) { var r = flightResolve; flightResolve = null; r(); }
    fadeOut(quick ? 320 : 720).then(destroy);
  }

  $('skipIntro').onclick = function () { closeNow(true); };
  $('introStart').onclick = function () { closeNow(true); };

  // 开场用与「世界模型」同一个地图引擎，视觉与交互完全一致
  function initGlobe() {
    if (closed || map) return;
    try {
      map = new maplibregl.Map({
        container: 'introMap',
        style: (MAP_STYLES[state.settings.style] || MAP_STYLES.bright).url,
        center: [104, 31],
        zoom: 1.85,
        attributionControl: false,
        interactive: true,
        maxPitch: 60,
        dragRotate: true,
        pitchWithRotate: true
      });
    } catch (e) { return; }

    function toGlobe() {
      if (!map || closed) return;
      try { map.setProjection({ type: 'globe' }); } catch (e) {}
      try {
        map.setSky({
          'sky-color': '#0B1A33',
          'sky-horizon-blend': 0.55,
          'horizon-color': '#2F5D8F',
          'horizon-fog-blend': 0.5,
          'fog-color': '#0B1A33',
          'fog-ground-blend': 0.9,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.7, 7, 0]
        });
      } catch (e) {}
    }

    map.on('load', function () {
      try { map.setPadding({ top: 0, bottom: 190, left: 0, right: 0 }); } catch (e) {}
      toGlobe();
      ensureSatellite(map);
    });
    map.on('style.load', function () { toGlobe(); ensureSatellite(map); });
    bindSatellite(map);
    setTimeout(toGlobe, 800);
    setTimeout(toGlobe, 2000);
  }

  initGlobe();
  setTimeout(initGlobe, 120);

  return {
    setStatus: function (city, text) {
      if (city) $('introCity').textContent = city;
      if (text) $('introStatus').textContent = text;
    },

    flyTo: async function (plan) {
      if (closed) return;
      var c = planCenter(plan);
      if (!map || !c) { closeNow(true); return; }

      this.setStatus(plan.city || '目的地', '正在飞往目的地');

      try {
        var dot = document.createElement('div');
        dot.className = 'intro-dot';
        new maplibregl.Marker({ element: dot, anchor: 'center' })
          .setLngLat([c.lng, c.lat]).addTo(map);
      } catch (e) {}

      await new Promise(function (resolve) {
        var done = false;
        function fin() {
          if (done) return;
          done = true;
          flightResolve = null;
          resolve();
        }
        flightResolve = fin;
        $('skipIntro').onclick = function () {
          try { map.stop(); } catch (e) {}
          closeNow(true);
        };
        try {
          map.flyTo({
            center: [c.lng, c.lat],
            zoom: 11.2,
            duration: 2.6,
            essential: true
          });
        } catch (e) { fin(); }
        setTimeout(fin, 4200);
      });

      if (closed) return;
      this.setStatus(plan.city || '目的地', '正在进入 ' + (plan.city || '目的地'));
      await delay(280);
      closed = true;
      await fadeOut(720);
      destroy();
    },

    close: async function () {
      closed = true;
      await fadeOut(320);
      destroy();
    }
  };
}


var elapsedTimer = null;

function startLoading(text) {
  $('overlay').classList.add('show');
  $('ovTxt').textContent = text || '生成中';
  $('ovElapsed').textContent = '0s';
  var bar = $('ovBar');
  if (bar) { bar.style.width = '0'; }
  var wrap = $('ovBarWrap');
  if (wrap) wrap.classList.remove('on');
  var t0 = Date.now();
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(function () {
    $('ovElapsed').textContent = Math.round((Date.now() - t0) / 1000) + 's';
  }, 500);
}

// 流式进度：收到第一块就亮条，按预估字符数算百分比
function setOvBar(pct) {
  var bar = $('ovBar');
  var wrap = $('ovBarWrap');
  if (!bar) return;
  var w = Math.max(0, Math.min(97, pct));
  bar.style.width = w + '%';
  if (wrap) wrap.classList.add('on');
}

function stopLoading() {
  $('overlay').classList.remove('show');
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  // 只收起进度条，不清宽度：淡出的这 240ms 里别让它往回缩
  var wrap = $('ovBarWrap');
  if (wrap) wrap.classList.remove('on');
}

/* =========================================================================
   行程生成：优先走新的 Agent 编排（规划 → 工具查坐标 → 校验 → 修正），
   任何一环失败都自动回退到 v1 的一次性调用，保证功能不中断。
   ========================================================================= */
function simpleStreamProgress(len, text) {
  var pois = (text.match(/"lat"\s*:/g) || []).length;
  var days = (text.match(/"day"\s*:/g) || []).length;
  var label = pois
    ? '已规划 ' + Math.max(days, 1) + ' 天 · ' + pois + ' 个地点'
    : '已写 ' + (len >= 1000 ? (len / 1000).toFixed(1) + 'k' : len) + ' 字';
  var t = $('ovTxt');
  if (t) t.textContent = label;
  var d = $('ovDetail');
  if (d) d.textContent = '兼容模式';
}

async function callAgent(place, start, end, n, prefs, intro) {
  var s = state.settings;
  var ai = window.__AI__;

  if (!ai || typeof ai.generatePlan !== 'function') {
    return await callLLM(place, start, end, n, prefs, simpleStreamProgress);
  }

  /* 把高德 Key 交给工具层：配了就走「工具定位」，没配走「模型坐标」 */
  try {
    if (ai.tools && ai.tools.setGeoConfig) {
      ai.tools.setGeoConfig({ amapKey: (s.amapKey || '').trim() });
    }
  } catch (e) {}

  var lastStatus = '';

  try {
    var res = await ai.generatePlan({
      request: {
        destination: place,
        days: n,
        startDate: start || undefined,
        endDate: end || undefined,
        prefs: prefs
      },
      config: {
        baseUrl: s.apiBase,
        apiKey: s.apiKey,
        model: s.model
      },
      onStep: function (step) {
        if (step.message && step.message !== lastStatus) {
          lastStatus = step.message;
          var t = $('ovTxt');
          if (t) t.textContent = step.message;
          if (intro) { try { intro.setStatus(step.message, step.detail || ''); } catch (e) {} }
        }
        if (step.detail) {
          var d = $('ovDetail');
          if (d) d.textContent = step.detail;
        }
        if (typeof step.progress === 'number') setOvBar(step.progress);
      }
    });

    state.aiIssues = res.issues || [];
    state.aiStats = res.stats || null;

    /* 有提醒但没阻断，用 toast 点一下，别让用户以为一切完美 */
    var warns = (res.issues || []).filter(function (i) { return i.level === 'warn'; });
    if (warns.length) {
      setTimeout(function () { toast('行程有 ' + warns.length + ' 处可以再优化'); }, 900);
    }

    return res.plan;
  } catch (e) {
    console.warn('[agent] 编排失败，回退到兼容模式', e);
    var t2 = $('ovTxt');
    if (t2) t2.textContent = 'AI 正在生成行程';
    var d2 = $('ovDetail');
    if (d2) d2.textContent = '已切换回兼容模式';
    return await callLLM(place, start, end, n, prefs, simpleStreamProgress);
  }
}

/* =========================================================================
   多方案对比：同一目的地生成不同节奏的行程，横向切换比较
   ========================================================================= */
var VARIANT_LABELS = { budget: '穷游', comfort: '舒适', family: '带娃', culture: '文艺' };

function ensureVariants() {
  if (!Array.isArray(state.variants)) state.variants = [];
  if (typeof state.activeVariant !== 'number') state.activeVariant = 0;
}

function resetVariants(label, plan) {
  state.variants = [{ label: label || '默认', plan: plan }];
  state.activeVariant = 0;
  renderVariantBar();
}

function addVariant(label, plan) {
  ensureVariants();
  state.variants.push({ label: label, plan: plan });
  state.activeVariant = state.variants.length - 1;
  renderVariantBar();
}

function renderVariantBar() {
  ensureVariants();
  var bar = $('variantBar');
  var chips = $('variantChips');
  if (!bar || !chips) return;

  /* 只有一个方案时不显示这一行，免得占地方 */
  if (state.variants.length < 2) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  chips.innerHTML = state.variants.map(function (v, i) {
    return '<button class="variant-chip' + (i === state.activeVariant ? ' on' : '') +
      '" data-i="' + i + '" type="button">' + escapeHtml(v.label) + '</button>';
  }).join('');
}

async function switchVariant(i) {
  ensureVariants();
  if (i === state.activeVariant || !state.variants[i]) return;

  /* 切走之前把当前编辑结果存回原方案，拖拽排序和 AI 调整才不会丢 */
  if (state.plan) state.variants[state.activeVariant].plan = state.plan;

  state.activeVariant = i;
  renderVariantBar();
  await loadPlan(state.variants[i].plan);
  toast('已切换到「' + state.variants[i].label + '」');
}

async function generateVariant(style) {
  var label = VARIANT_LABELS[style] || '备选';
  var place = $('place').value.trim();
  var start = $('start').value;
  var end = $('end').value;

  if (!place) { toast('请先填写目的地', true); return; }

  var s = state.settings;
  if (!s.apiKey) { openSettings(); toast('请先配置 API Key', true); return; }
  if (!window.__AI__ || typeof window.__AI__.generatePlan !== 'function') {
    toast('AI 模块未就绪', true);
    return;
  }

  var n = (start && end) ? daysBetween(start, end) : 3;
  if (n > 10) n = 10;
  var prefs = readPrefs();

  var btn = $('variantAdd');
  if (btn) btn.disabled = true;

  startLoading('正在生成「' + label + '」方案');
  var det = $('ovDetail');
  if (det) det.textContent = '同一目的地 换一种节奏';

  try {
    if (window.__AI__.tools && window.__AI__.tools.setGeoConfig) {
      window.__AI__.tools.setGeoConfig({ amapKey: (s.amapKey || '').trim() });
    }

    var res = await window.__AI__.generatePlan({
      request: {
        destination: place,
        days: n,
        startDate: start || undefined,
        endDate: end || undefined,
        prefs: prefs
      },
      config: { baseUrl: s.apiBase, apiKey: s.apiKey, model: s.model },
      style: style,
      onStep: function (step) {
        var t = $('ovTxt');
        if (t && step.message) t.textContent = step.message;
        var d = $('ovDetail');
        if (d && step.detail) d.textContent = step.detail;
        if (typeof step.progress === 'number') setOvBar(step.progress);
      }
    });

    stopLoading();
    state.aiStats = res.stats || null;
    state.aiIssues = res.issues || [];

    addVariant(label, res.plan);
    await loadPlan(res.plan);
    toast('「' + label + '」方案已生成');
  } catch (e) {
    stopLoading();
    console.error('[variant]', e);
    toast('生成失败 ' + (e && e.message ? e.message : ''), true);
  } finally {
    if (btn) btn.disabled = false;
    var styles = $('variantStyles');
    if (styles) styles.classList.remove('on');
  }
}

async function generatePlan() {
  var place = $('place').value.trim();
  var start = $('start').value, end = $('end').value;
  if (!place) { toast('请先填写目的地', true); return; }

  var n = (start && end) ? daysBetween(start, end) : 3;
  if (n > 10) { n = 10; toast('已限制最多 10 天'); }

  var prefs = readPrefs();
  savePrefs(prefs);

  if (!state.settings.apiKey) {
    openSettings();
    toast('请先配置 API Key', true);
    return;
  }

  var genBtn = $('genBtn');
  genBtn.disabled = true;
  genBtn.classList.add('loading');

  startLoading('AI 正在生成 ' + n + ' 天行程');

  // 流式进度：按"已出几天 / 几个地点"显示，比单纯转圈有底
  var expectChars = 1000 + n * 900;
  function onStream(len, text) {
    var pois = (text.match(/"lat"\s*:/g) || []).length;
    var days = (text.match(/"day"\s*:/g) || []).length;
    var label = pois
      ? '已规划 ' + Math.max(days, 1) + ' 天 · ' + pois + ' 个地点'
      : '已写 ' + (len >= 1000 ? (len / 1000).toFixed(1) + 'k' : len) + ' 字';
    $('ovTxt').textContent = label;
    if (intro) intro.setStatus('正在生成', label);
    setOvBar(len / expectChars * 100);
  }

  var intro = null;
  if (state.settings.intro && !state.introPlayed && supportsWebGL()) {
    if (state.landingIntro) {
      try { await state.landingIntro.close(); } catch (e) {}
      state.landingIntro = null;
    }
    intro = createIntro();
    intro.setStatus('正在出发', '正在生成 ' + n + ' 天行程');
  }

  var plan;
  try {
    plan = await callAgent(place, start, end, n, prefs, intro);

    if (intro) intro.setStatus(plan.city || place, '正在整理行程');
    else if (!state.aiStats) $('ovTxt').textContent = '正在解析坐标';
    setOvBar(100);

    if (state.settings.refine) await refineCoords(plan);

    await loadPlan(plan);
    resetVariants('默认', plan);
    stopLoading();

    if (intro) {
      await intro.flyTo(plan);
      state.introPlayed = true;
    }
    toast('行程已生成');
  } catch (err) {
    stopLoading();
    if (intro) await intro.close();
    console.error(err);
    toast('生成失败 ' + (err && err.message ? err.message : '未知错误'), true);
  } finally {
    genBtn.disabled = false;
    genBtn.classList.remove('loading');
  }
}

function supportsWebGL() {
  try {
    var c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

/* =========================================================================
   载入与渲染
   ========================================================================= */
async function loadPlan(plan) {
  state.plan = plan;
  state.activeDay = 1;
  state.routeCache = {};
  savePlanCache(plan);

  var emptyEl = $('empty');
  if (emptyEl && emptyEl.style.display !== 'none') {
    exitThen(emptyEl, 200, function () { emptyEl.style.display = 'none'; });
  }
  $('grid').style.display = 'grid';

  renderBanner();
  renderTabs();

  await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });

  await ensureMap(planCenter(plan) || { lat: 30.5728, lng: 104.0668 });
  renderDay();
}

function renderBanner() {
  var p = state.plan;
  morphText($('title'), p.title || '我的行程');
  var totalPois = 0, totalBudget = 0;
  p.days.forEach(function (d) {
    totalPois += d.pois.length;
    d.pois.forEach(function (o) { totalBudget += (o.cost || 0); });
  });
  countUp($('bDays'), p.days.length, '', 680);
  countUp($('bPois'), totalPois, '', 780);
  countUp($('bBudget'), totalBudget, '¥', 900);
  ['badgeDays', 'badgePois', 'badgeBudget'].forEach(function (id, i) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('pulse');
    void el.offsetWidth;
    setTimeout(function () { el.classList.add('pulse'); }, 60 + i * 90);
  });
  $('subtitle').textContent = tidyText(p.summary) ||
    ('共 ' + p.days.length + ' 天 ' + totalPois + ' 个精选点 预估总预算 ¥' + totalBudget.toLocaleString());
}

function renderTabs() {
  var t = $('tabs');
  if (!t) return;
  Array.prototype.slice.call(t.querySelectorAll('.tab')).forEach(function (b) { b.remove(); });

  var defs = [{ label: '全部', day: 0 }];
  state.plan.days.forEach(function (d, i) { defs.push({ label: 'DAY ' + (i + 1), day: i + 1 }); });

  defs.forEach(function (def, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (def.day === state.activeDay ? ' active' : '');
    b.innerHTML = '<span>' + def.label + '</span>';
    b.style.animation = 'enter-fade 320ms var(--e-out) both';
    b.style.animationDelay = (i * 42) + 'ms';
    b.onclick = function () { switchDay(def.day); };
    t.appendChild(b);
  });
  requestAnimationFrame(moveTabIndicator);
  setTimeout(moveTabIndicator, 380);
}

function moveTabIndicator() {
  var t = $('tabs');
  var ind = $('tabIndicator');
  if (!t || !ind) return;
  var act = t.querySelector('.tab.active');
  if (!act) { ind.style.opacity = '0'; ind.style.width = '0px'; return; }
  ind.style.opacity = '1';
  ind.style.width = act.offsetWidth + 'px';
  ind.style.transform = 'translateX(' + (act.offsetLeft - 4) + 'px)';
}

// 切天：旧内容退场 → 新内容错落入场
function switchDay(n) {
  if (!state.plan || n === state.activeDay) return;
  if (n !== 0 && !state.plan.days[n - 1]) return;
  state.activeDay = n;
  renderTabs();
  renderDay(true);
  if (state.map) {
    try { state.map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 0 }); } catch (e) {}
  }
}

async function renderDay(animate) {
  if (!state.plan) return;
  if (state.activeDay === 0) return renderOverview(animate);

  var d = state.plan.days[state.activeDay - 1];
  if (!d) return;

  closePopup();
  document.querySelectorAll('.pin.active').forEach(function (el) { el.classList.remove('active'); });

  var pois = d.pois.slice().sort(function (a, b) {
    return String(a.time || '').localeCompare(String(b.time || ''));
  });

  var tl = $('timeline');

  // 旧卡片先退场，同时记录几何位置供 FLIP 使用
  var oldRects = null;
  if (animate && tl && tl.children.length) {
    oldRects = Array.prototype.map.call(tl.querySelectorAll('.card'), function (el) {
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    });
    tl.classList.add('switching');
    await delay(150);
    tl.classList.remove('switching');
  }

  morphText($('dayTitle'), 'DAY ' + d.day);
  morphText($('dayTheme'), tidyText(d.theme));
  var cnt = $('dayCount');
  if (cnt) cnt.textContent = pois.length + ' 个点位';
  setDayRouteInfo(0);

  tl.innerHTML = '';

  pois.forEach(function (p, idx) {
    if (!p.id) p.id = 'p_' + Math.random().toString(36).slice(2, 9);
    var c = CATEGORIES[p.type] || CATEGORIES.sight;
    var item = document.createElement('div');
    item.className = 'tl-item';
    item.style.setProperty('--i', idx);
    item.innerHTML =
      '<span class="tl-dot" style="background:' + c.color + '"></span>' +
      '<div class="card" data-id="' + p.id + '" data-day="' + d.day + '" style="--c:' + c.color + ';color:' + (c.ink || '#fff') + '">' +
        '<div class="time">' + ICONS.clock + escapeHtml(p.time || '') + '</div>' +
        '<div class="head"><span class="name">' + escapeHtml(p.name || '') + '</span>' +
          '<span class="chip" style="background:' + c.color + ';color:' + (c.ink || '#fff') + '">' + c.short + '</span></div>' +
        '<span class="drag-handle" title="拖动调整顺序">' + ICONS.grip + '</span>' +
        '<div class="desc">' + escapeHtml(tidyText(p.desc)) + '</div>' +
        '<div class="meta">' +
          '<span>' + ICONS.timer + '<b>' + escapeHtml(p.duration || '—') + '</b></span>' +
          '<span>' + ICONS.wallet + '<b>¥' + (p.cost || 0) + '</b></span>' +
          (p.address ? '<span>' + ICONS.pin + escapeHtml(p.address) + '</span>' : '') +
        '</div>' +
      '</div>';

    var card = item.querySelector('.card');
    card.draggable = true;

    card.onclick = function () {
      if (state.justDragged) return;
      flyToPoi(p);
    };

    card.addEventListener('dragstart', function (e) {
      state.dragFrom = idx;
      state.justDragged = true;
      card.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
      } catch (er) {}
    });

    card.addEventListener('dragend', function () {
      card.classList.remove('dragging');
      Array.prototype.forEach.call(document.querySelectorAll('.tl-item'), function (el) {
        el.classList.remove('drop-before', 'drop-after');
      });
      setTimeout(function () { state.justDragged = false; }, 320);
    });

    card.addEventListener('dragover', function (e) {
      if (state.dragFrom == null || state.dragFrom === idx) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (er) {}
      var r = card.getBoundingClientRect();
      var after = (e.clientY - r.top) > r.height / 2;
      item.classList.toggle('drop-after', after);
      item.classList.toggle('drop-before', !after);
    });

    card.addEventListener('dragleave', function () {
      item.classList.remove('drop-before', 'drop-after');
    });

    card.addEventListener('drop', function (e) {
      e.preventDefault();
      var after = item.classList.contains('drop-after');
      item.classList.remove('drop-before', 'drop-after');
      var from = state.dragFrom;
      state.dragFrom = null;
      if (from == null || from === idx) return;
      var to = idx + (after ? 1 : 0);
      state.justDragged = true;
      setTimeout(function () { state.justDragged = false; }, 360);
      reorderDay(from, to);
    });

    // 光斑跟随（rAF 节流，避免高频重排）
    var raf = 0;
    card.addEventListener('mousemove', function (e) {
      if (raf) return;
      var self = this, cx = e.clientX;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var r = self.getBoundingClientRect();
        self.style.setProperty('--mx', (((cx - r.left) / r.width) * 100) + '%');
      });
    });

    // 点击涟漪
    card.addEventListener('pointerdown', function (e) {
      if (reducedMotion()) return;
      var r = this.getBoundingClientRect();
      var d = Math.max(r.width, r.height) * 1.15;
      var sp = document.createElement('span');
      sp.className = 'ripple';
      sp.style.width = d + 'px';
      sp.style.height = d + 'px';
      sp.style.left = (e.clientX - r.left - d / 2) + 'px';
      sp.style.top = (e.clientY - r.top - d / 2) + 'px';
      this.appendChild(sp);
      setTimeout(function () { if (sp.parentNode) sp.remove(); }, 640);
    });
    tl.appendChild(item);
  });

  if (oldRects && oldRects.length) applyFlip(tl, oldRects);
  else observeItems();

  updateMapForDay(d);
}

/* =========================================================================
   全部行程总览
   ========================================================================= */
function buildOverviewItem(p, idx, di) {
  var cat = CATEGORIES[p.type] || CATEGORIES.sight;
  var dayColor = DAY_COLORS[di % DAY_COLORS.length];
  var item = document.createElement('div');
  item.className = 'tl-item in';
  item.style.setProperty('--i', idx);
  item.innerHTML =
    '<span class="tl-dot" style="background:' + dayColor + '"></span>' +
    '<div class="card" data-id="' + escapeHtml(p.id) + '" data-day="' + (di + 1) + '" style="--c:' + dayColor + '">' +
      '<div class="time">' + ICONS.clock + escapeHtml(p.time || '') + '</div>' +
      '<div class="head"><span class="name">' + escapeHtml(p.name || '') + '</span>' +
        '<span class="chip" style="background:' + cat.color + ';color:' + (cat.ink || '#fff') + '">' + cat.short + '</span></div>' +
      '<div class="desc">' + escapeHtml(tidyText(p.desc)) + '</div>' +
      '<div class="meta">' +
        '<span>' + ICONS.timer + '<b>' + escapeHtml(p.duration || '—') + '</b></span>' +
        '<span>' + ICONS.wallet + '<b>¥' + (p.cost || 0) + '</b></span>' +
        (p.address ? '<span>' + ICONS.pin + escapeHtml(p.address) + '</span>' : '') +
      '</div>' +
    '</div>';

  var card = item.querySelector('.card');
  card.onclick = function () {
    state.activeDay = di + 1;
    renderTabs();
    renderDay(true);
    setTimeout(function () { flyToPoi(p); }, 430);
  };
  return item;
}

async function renderOverview(animate) {
  closePopup();
  document.querySelectorAll('.pin.active').forEach(function (el) { el.classList.remove('active'); });

  var tl = $('timeline');
  var oldRects = null;
  if (animate && tl && tl.children.length) {
    oldRects = Array.prototype.map.call(tl.querySelectorAll('.card'), function (el) {
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    });
    tl.classList.add('switching');
    await delay(150);
    tl.classList.remove('switching');
  }

  var total = 0;
  state.plan.days.forEach(function (d) { total += d.pois.length; });

  morphText($('dayTitle'), '全部行程');
  morphText($('dayTheme'), state.plan.days.length + ' 天 ' + total + ' 个点位 按天分色');
  var cnt = $('dayCount');
  if (cnt) cnt.textContent = total + ' 个点位';
  setDayRouteInfo(0);

  tl.innerHTML = '';

  var flatIndex = 0;
  state.plan.days.forEach(function (d, di) {
    var color = DAY_COLORS[di % DAY_COLORS.length];
    var pois = d.pois.slice().sort(byTime);

    var group = document.createElement('div');
    group.className = 'ov-day';

    var head = document.createElement('div');
    head.className = 'ov-head';
    head.innerHTML =
      '<span class="ov-badge" style="--c:' + color + '">DAY ' + (di + 1) + '</span>' +
      '<span class="ov-theme">' + escapeHtml(tidyText(d.theme) || '') + '</span>';
    group.appendChild(head);

    var wrap = document.createElement('div');
    wrap.className = 'timeline';

    pois.forEach(function (p) {
      if (!p.id) p.id = 'p_' + Math.random().toString(36).slice(2, 9);
      wrap.appendChild(buildOverviewItem(p, flatIndex, di));
      flatIndex++;
    });

    group.appendChild(wrap);
    tl.appendChild(group);
  });

  if (oldRects && oldRects.length) {
    Array.prototype.forEach.call(tl.querySelectorAll('.tl-item'), function (el) {
      el.style.animation = 'enter-rise 480ms var(--e-out) both';
      el.style.animationDelay = (Number(el.style.getPropertyValue('--i') || 0) * 45) + 'ms';
    });
  }

  updateMapOverview();
}

async function updateMapOverview() {
  if (!state.map) return;

  var token = ++state.dayToken;
  state.routeAnimToken++;
  stopRouteFlow();
  clearMarkers();
  ensureRouteLayer();
  // 先清掉上一种视图的轨迹：切到「全部」时 OSRM 还在路上，
  // 画面会短暂留着单天视图的线，看起来像"点位飘在轨迹外面"
  setRouteData(null);
  setRouteStatus('', '');

  var days = state.plan.days;
  var profile = currentOsrmProfile();
  var profileLabel = profile === 'driving' ? '驾车' : '步行';
  var allCoords = [];
  var pinIdx = 0;
  var jobs = [];
  var loneDays = 0;   // 只有 1 个地点的天，画不出路线，单独说明

  days.forEach(function (d, di) {
    var color = DAY_COLORS[di % DAY_COLORS.length];
    var pois = d.pois.slice().sort(byTime);
    var coords = [];

    pois.forEach(function (p) {
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      coords.push([p.lng, p.lat]);
      allCoords.push([p.lng, p.lat]);
      var marker = new maplibregl.Marker({ element: makePin(p, pinIdx, color), anchor: 'center' })
        .setLngLat([p.lng, p.lat]).addTo(state.map);
      state.markers.push(marker);
      pinIdx++;
    });

    if (coords.length > 1) {
      jobs.push({
        color: color,
        coords: coords,
        key: 'd' + d.day + '_' + profile + '_' + coords.map(function (c) {
          return c[0].toFixed(4) + ',' + c[1].toFixed(4);
        }).join('|')
      });
    } else if (coords.length === 1) {
      loneDays++;
    }
  });
  dropPins();
  state.markers.forEach(function (m) {
    var el;
    try { el = m.getElement(); } catch (e) { return; }
    if (el) el.classList.add('compact');
  });

  if (!allCoords.length) {
    setRouteData(null);
    setRouteStatus('暂无坐标', 'warn');
    return;
  }

  // 先用直线把每天的骨架画出来
  setRouteData({
    type: 'FeatureCollection',
    features: jobs.map(function (j) {
      return {
        type: 'Feature',
        properties: { color: j.color },
        geometry: { type: 'LineString', coordinates: j.coords }
      };
    })
  });
  setRouteStatus('全部 ' + days.length + ' 天' + (loneDays ? ' · ' + loneDays + ' 天只有 1 个地点' : ''), '');

  var b = new maplibregl.LngLatBounds(allCoords[0], allCoords[0]);
  allCoords.forEach(function (c) { b.extend(c); });
  state.map.fitBounds(b, {
    padding: { top: 78, bottom: 78, left: 78, right: 78 },
    maxZoom: 13,
    duration: reducedMotion() ? 0 : 820
  });

  if (state.settings.routeMode !== 'osrm') return;

  // 并发补真实道路
  var results = await Promise.all(jobs.map(function (j) {
    if (state.routeCache[j.key]) return Promise.resolve({ color: j.color, geo: state.routeCache[j.key], coords: j.coords });
    return fetchOsrm(j.coords, profile).then(function (geo) {
      state.routeCache[j.key] = geo;
      return { color: j.color, geo: geo, coords: j.coords };
    }).catch(function () { return null; });
  }));

  if (token !== state.dayToken) return;

  var feats = [];
  var failed = 0;
  var farCount = 0;
  var totalDist = 0;
  var totalDur = 0;
  results.forEach(function (r, i) {
    if (r && r.geo && r.geo.geometry) {
      totalDist += (r.geo.properties && r.geo.properties.distance) || 0;
      totalDur += (r.geo.properties && r.geo.properties.duration) || 0;
      (r.geo._snap || []).forEach(function (sp) { if (sp && sp.dist > 150) farCount++; });
      feats.push({
        type: 'Feature',
        properties: {
          color: r.color,
          links: buildLinks(r.coords || (jobs[i] && jobs[i].coords), r.geo._snap)
        },
        geometry: r.geo.geometry
      });
      return;
    }
    // 这一天的真实路线没拿到：用直线兜底。
    // 原来直接跳过，那一天的轨迹会整段消失，看起来像"点位飘在线外"
    failed++;
    if (jobs[i]) {
      feats.push({
        type: 'Feature',
        properties: { color: jobs[i].color },
        geometry: { type: 'LineString', coordinates: jobs[i].coords }
      });
    }
  });

  if (feats.length) {
    setRouteData({ type: 'FeatureCollection', features: feats });
    var notes = ['全部 ' + days.length + ' 天'];
    if (!failed) notes.push('真实路线');
    if (failed) notes.push(failed + ' 天路网未取到 已用直线代替');
    if (farCount) notes.push(farCount + ' 个地点离路较远 已用虚线接驳');
    setRouteStatus(notes.join(' · '), failed ? 'warn' : 'ok');
    setDayRouteInfo(totalDist, totalDur, 'total');
  }
}

/* =========================================================================
   MapLibre 地图
   ========================================================================= */
function ensureMap(center) {
  if (state.map) {
    try { state.map.resize(); } catch (e) {}
    return Promise.resolve();
  }

  // 已知断网／服务探测失败／上次已降级：不再创建地图，直接画离线示意
  if (state.offline || navigator.onLine === false || mapServiceOnline === false) {
    state.offline = true;
    renderOfflineMap();
    return Promise.resolve();
  }

  // MapLibre 本身来自 CDN，断网时未定义，直接用离线示意兜住
  if (typeof maplibregl === 'undefined') {
    state.offline = true;
    renderOfflineMap();
    return Promise.resolve();
  }

  return new Promise(function (resolve) {
    state.map = new maplibregl.Map({
      container: 'map',
      style: MAP_STYLES[state.settings.style] ? MAP_STYLES[state.settings.style].url : MAP_STYLES.positron.url,
      center: [center.lng, center.lat],
      zoom: 11,
      attributionControl: false,
      maxZoom: 19
    });

    state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    state.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    var done = false;
    function ready() {
      if (done) return;
      done = true;
      try { state.map.resize(); } catch (e) {}
      resolve();
    }

    state.map.on('style.load', function () {
      // 样式能解析不代表瓦片能拉下来（JS/CSS 可能来自缓存），
      // 所以只有服务探测明确在线时才退出离线态
      if (mapServiceOnline !== false) {
        state.offline = false;
        state.mapNetFail = 0;
        hideOfflineMap();
      }
      ensureRouteLayer();
      ensureSatellite(state.map);
      setRouteData(state.currentRoute);
      localizeLabels();
      setTimeout(function () {
        localizeLabels();
        ensureSatellite(state.map);
        ensureRouteLayer();
      }, 700);
      if (state.settings.pitch3d) {
        enableTerrain(state.map);
        addCustomBuildings(state.map);
        try { state.map.easeTo({ pitch: 60, bearing: -20, duration: 0 }); } catch (e) {}
      }
      ready();
    });

    // 切换底图时 MapLibre 可能在新样式应用后再次清空图层，做幂等兜底
    var labelRaf = 0;
    state.map.on('zoom', function () {
      if (labelRaf) return;
      labelRaf = requestAnimationFrame(function () {
        labelRaf = 0;
        syncPinLabels();
        updateSatellite(state.map);
      });
    });

    state.map.on('styledata', function () { ensureRouteLayer(); ensureSatellite(state.map); });
    // idle 在瓦片/精灵全部就绪后触发，确保初始样式下也能补上路线图层
    state.map.on('idle', function () { ensureRouteLayer(); ensureSatellite(state.map); });

    // 底线兜底：连续多个网络类错误就把地图判定为不可用，切离线示意
    state.map.on('error', function (e) {
      if (!e || !e.error) return;
      var msg = String(e.error.message || e.error);
      console.warn('[map]', msg);
      if (!/Failed to fetch|NetworkError|Load failed|ERR_|aborted|timeout|ECONN/i.test(msg)) return;
      state.mapNetFail = (state.mapNetFail || 0) + 1;
      if (state.mapNetFail >= 6 && !state.offline) {
        state.offline = true;
        renderOfflineMap();
      }
    });

    setTimeout(function () {
      if (done) return;
      state.offline = true;
      renderOfflineMap();
      toast('底图暂不可达 已切换离线示意', true);
      ready();
    }, 9000);
  });
}

function ensureRouteLayer() {
  if (!state.map) return;
  try {
    // 注意：不能用 isStyleLoaded() 判断，它会等所有瓦片/精灵加载完，
    // 初始样式下可能长期为 false，导致图层永远加不上。
    if (!state.map.getStyle()) return;
    addRouteLayer();
    // 新样式重建 source 后默认是空数据，这里自动回填当前路线（含接驳虚线）
    if (state.currentRoute) setRouteData(state.currentRoute, true);
  } catch (e) {}
}

function addRouteLayer() {
  var map = state.map;
  if (!map) return;
  if (!map.getSource('route')) {
    map.addSource('route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} }
    });
  }
  // 1) 外辉光：让路线从底图里"浮"出来
  if (!map.getLayer('route-glow')) {
    map.addLayer({
      id: 'route-glow',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#2563EB',
        'line-width': 18,
        'line-opacity': 0.12,
        'line-blur': 8
      }
    });
  }
  // 2) 白色描边：保证在任何底图上都清晰
  if (!map.getLayer('route-casing')) {
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 11, 8, 14, 9],
        'line-opacity': 0.96
      }
    });
  }
  // 3) 蓝色主线
  if (!map.getLayer('route-line')) {
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], state.settings.style === 'dark' ? '#7FA8FF' : '#2563EB'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 11, 4, 14, 5],
        'line-opacity': 0.98
      }
    });
  }
  // 4) 接驳虚线：OSRM 会把坐标吸附到最近道路，偏远地点能差 300m 以上，
  //    不画这一段的话就成了「点在这儿、线在那儿」，看着像定位错了
  if (!map.getSource('route-links')) {
    map.addSource('route-links', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }
  if (!map.getLayer('route-links-line')) {
    map.addLayer({
      id: 'route-links-line',
      type: 'line',
      source: 'route-links',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], state.settings.style === 'dark' ? '#8FB4FF' : '#3B78F0'],
        // 缩小时也要看得见，否则低 zoom 下这段接驳会缩成一个点
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.8, 12, 2.2, 16, 1.8],
        'line-opacity': 0.9,
        'line-dasharray': [1.6, 1.8]
      }
    });
  }
}

// 把「点位真实坐标」和「OSRM 吸附点」配对成接驳线段
function buildLinks(coords, snaps) {
  if (!coords || !snaps || !snaps.length) return [];
  var out = [];
  for (var i = 0; i < coords.length && i < snaps.length; i++) {
    var s = snaps[i];
    if (!s || !s.loc) continue;
    var a = coords[i], b = s.loc;
    // 相差不到 3 米就不画了，避免每个点都拖一根小尾巴
    if (Math.abs(a[0] - b[0]) < 3e-5 && Math.abs(a[1] - b[1]) < 3e-5) continue;
    out.push([a, b]);
  }
  return out;
}

var EMPTY_LINE = { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} };

function setRouteData(geo, silent) {
  if (!silent) state.currentRoute = geo || null;
  var map = state.map;
  if (!map) return;
  var src = map.getSource('route');
  if (src) src.setData(geo || EMPTY_LINE);

  // 同步接驳虚线
  var ls = map.getSource('route-links');
  if (!ls) return;
  var feats = [];
  var list = geo ? (geo.type === 'FeatureCollection' ? geo.features : [geo]) : [];
  (list || []).forEach(function (f) {
    var props = (f && f.properties) || {};
    var links = props.links;
    if (!links || !links.length) return;
    var c = props.color || (state.settings.style === 'dark' ? '#8FB4FF' : '#3B78F0');
    links.forEach(function (pair) {
      feats.push({
        type: 'Feature',
        properties: { color: c },
        geometry: { type: 'LineString', coordinates: pair }
      });
    });
  });
  try { ls.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {}
}

// 路线生长动画：从起点沿道路"画"到终点
function animateRoute(feature) {
  if (!feature || !state.map) { setRouteData(feature); return; }
  var coords = feature.geometry && feature.geometry.coordinates;
  if (!coords || coords.length < 2 || reducedMotion()) { setRouteData(feature); startRouteFlow(feature); return; }
  var total = coords.length;
  var dur = Math.min(1150, 380 + total * 1.5);
  var token = ++state.routeAnimToken;
  var t0 = performance.now();
  function frame(now) {
    if (token !== state.routeAnimToken) return;
    var k = Math.min(1, (now - t0) / dur);
    var e = 1 - Math.pow(1 - k, 3);
    var n = Math.max(2, Math.round(total * e));
    setRouteData({
      type: 'Feature',
      // 保留 properties，接驳虚线才不会在生长过程中闪掉
      properties: feature.properties || {},
      geometry: { type: 'LineString', coordinates: coords.slice(0, n) }
    }, true);
    if (k < 1) requestAnimationFrame(frame);
    else { setRouteData(feature); startRouteFlow(feature); }
  }
  requestAnimationFrame(frame);
}

function clearMarkers() {
  stopRouteFlow();
  state.markers.forEach(function (m) {
    try { m.remove(); } catch (e) {}
  });
  state.markers = [];
}

function makePin(p, index, colorOverride) {
  var c = CATEGORIES[p.type] || CATEGORIES.sight;
  var pinColor = colorOverride || c.color;
  var wrap = document.createElement('div');
  var _z = state.map ? state.map.getZoom() : 14;
  wrap.className = 'pin-wrap' + (state.settings.labels !== false && _z >= 11 ? ' labels' : '');
  wrap.style.setProperty('--c', pinColor);
  wrap.innerHTML =
    '<div class="pin" data-id="' + escapeHtml(p.id) + '" style="--c:' + pinColor + ';color:' + (c.ink || '#fff') + '">' +
      '<span>' + (index + 1) + '</span>' +
    '</div>' +
    '<div class="pin-tip">' + escapeHtml(p.name || '') + '</div>';

  var pin = wrap.querySelector('.pin');
  pin.addEventListener('click', function (ev) {
    ev.stopPropagation();
    openPopup(p);
    highlightCard(p.id);
    highlightPin(p.id);
  });
  pin.addEventListener('mouseenter', function () { linkCard(p.id, true); });
  pin.addEventListener('mouseleave', function () { linkCard(p.id, false); });
  return wrap;
}

// 低缩放级别隐藏名称标签，避免密集重叠
function syncPinLabels() {
  if (!state.map) return;
  var show = state.settings.labels !== false && state.map.getZoom() >= 11;
  Array.prototype.forEach.call(document.querySelectorAll('.pin-wrap'), function (w) {
    w.classList.toggle('labels', show);
  });
}

// 图钉依次落下（stagger）
function dropPins() {
  state.markers.forEach(function (m, i) {
    var el;
    try { el = m.getElement(); } catch (e) { return; }
    if (!el) return;
    var pin = el.querySelector('.pin');
    if (!pin) return;
    setTimeout(function () { pin.classList.add('in'); }, 90 + i * 68);
  });
  setTimeout(syncPinLabels, 320);
}

/* 当日真实里程：OSRM 的 distance/duration，没取到就留空 */
function fmtDistance(m) {
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
}
function fmtDuration(sec) {
  var min = Math.round(sec / 60);
  return min < 60 ? min + ' 分钟' : (min / 60).toFixed(1) + ' 小时';
}
function setDayRouteInfo(dist, dur, profile) {
  var el = $('dayRoute');
  if (!el) return;
  if (!dist || dist <= 0) { el.textContent = ''; return; }

  /* 全部视图是三天加起来，报一个步行时长会被误读成一天 */
  if (profile === 'total') {
    el.textContent = fmtDistance(dist) + ' · 全程合计';
    return;
  }

  /* OSRM 公共服务的 foot/bike 其实都按 car 引擎算，
     三种 profile 返回的 duration 完全一样（实测 3967m / 301s）。
     距离可信，时长对步行没有参考意义，按 4.5km/h 自己估。 */
  var seconds;
  if (profile === 'driving') {
    seconds = dur || Math.round((dist / 1000 / 30) * 3600);
  } else {
    seconds = Math.round((dist / 1000 / 4.5) * 3600);
  }

  el.textContent = fmtDistance(dist) + ' · ' +
    (profile === 'driving' ? '驾车 ' : '步行约 ') + fmtDuration(seconds);
}

function setRouteStatus(text, cls) {
  var el = $('routeStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'route-status' + (cls ? ' ' + cls : '');
}

// 按交通方式选择 OSRM 出行方式：自驾/打车 -> driving，其余 -> foot
function currentOsrmProfile() {
  var t = $('pTransport') ? $('pTransport').value : '';
  if (t.indexOf('自驾') >= 0 || t.indexOf('打车') >= 0) return 'driving';
  return 'foot';
}

// 地图标签中文优先，去掉「英文 + 中文」拼接造成的拥挤
function localizeLabels(map) {
  map = map || state.map;
  if (!map || !map.getStyle()) return;
  var layers = map.getStyle().layers || [];
  layers.forEach(function (l) {
    if (l.type !== 'symbol') return;
    var tf = l.layout && l.layout['text-field'];
    if (!tf) return;
    if (JSON.stringify(tf).indexOf('name') === -1) return;
    try {
      map.setLayoutProperty(l.id, 'text-field', [
        'coalesce',
        ['get', 'name:nonlatin'],
        ['get', 'name'],
        ['get', 'name_en'],
        ['get', 'name:latin']
      ]);
    } catch (e) {}
  });
}

// 3D 真实地形（AWS Terrain Tiles / Mapzen，terrarium 编码，免 Key）
function enableTerrain(map) {
  map = map || state.map;
  if (!map) return;
  try {
    if (!map.getSource('terrain-dem')) {
      map.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
        attribution: 'Terrain: Mapzen / AWS'
      });
    }
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.35 });
  } catch (e) {
    console.warn('[terrain]', e);
  }
}

function disableTerrain(map) {
  map = map || state.map;
  if (map) {
    try { map.setTerrain(null); } catch (e) {}
  }
}

// Bright 等样式没有建筑挤出，补一层；已有 fill-extrusion 的样式（Liberty）跳过
function addCustomBuildings(map) {
  if (!map) return;
  try {
    var style = map.getStyle();
    if (!style) return;
    if (map.getLayer('custom-3d-buildings')) return;

    var hasExtrusion = (style.layers || []).some(function (l) { return l.type === 'fill-extrusion'; });
    if (hasExtrusion) return;

    var srcName = null;
    (style.layers || []).some(function (l) {
      if (l['source-layer'] === 'building') { srcName = l.source; return true; }
      return false;
    });
    if (!srcName) return;

    var onSat = satMode() === 'city';
    map.addLayer({
      id: 'custom-3d-buildings',
      type: 'fill-extrusion',
      source: srcName,
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        // 卫星底图上用冷灰 + 半透明，让屋顶纹理透出来；矢量底图保留米色实体感
        'fill-extrusion-color': onSat ? '#C2C8D4' : '#d9d2c6',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': onSat ? 0.72 : 0.88,
        'fill-extrusion-vertical-gradient': true
      }
    });
  } catch (e) {
    console.warn('[buildings]', e);
  }
}


async function updateMapForDay(d) {
  if (state.offline) { renderOfflineMap(d); return; }
  if (!state.map) return;

  var token = ++state.dayToken;
  state.routeAnimToken++;
  stopRouteFlow();
  clearMarkers();
  ensureRouteLayer();
  // 先清掉上一种视图的轨迹：切到「全部」时 OSRM 还在路上，
  // 画面会短暂留着单天视图的线，看起来像"点位飘在轨迹外面"
  setRouteData(null);
  setRouteStatus('', '');

  var pois = d.pois.slice().sort(function (a, b) {
    return String(a.time || '').localeCompare(String(b.time || ''));
  });

  var coords = [];
  var placed = 0;
  pois.forEach(function (p) {
    if (!isFinite(p.lat) || !isFinite(p.lng)) return;
    coords.push([p.lng, p.lat]);

    var marker = new maplibregl.Marker({ element: makePin(p, placed), anchor: 'center' })
      .setLngLat([p.lng, p.lat])
      .addTo(state.map);
    state.markers.push(marker);
    placed++;
  });
  dropPins();

  if (!coords.length) {
    setRouteData(null);
    setRouteStatus('暂无坐标', 'warn');
    return;
  }

  var bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach(function (c) { bounds.extend(c); });
  state.map.fitBounds(bounds, {
    padding: { top: 76, bottom: 76, left: 76, right: 76 },
    maxZoom: 14,
    duration: reducedMotion() ? 0 : 820
  });

  var profile = currentOsrmProfile();
  var profileLabel = profile === 'driving' ? '驾车' : '步行';
  var dayKey = 'd' + d.day + '_' + profile + '_' + coords.map(function (c) {
    return c[0].toFixed(4) + ',' + c[1].toFixed(4);
  }).join('|');

  var dayColor = DAY_COLORS[((d.day || 1) - 1 + DAY_COLORS.length) % DAY_COLORS.length];
  var plain = {
    type: 'Feature',
    properties: { color: dayColor },
    geometry: { type: 'LineString', coordinates: coords }
  };

  if (state.settings.routeMode === 'osrm' && coords.length > 1) {
    if (state.routeCache[dayKey]) {
      var cached = state.routeCache[dayKey];
      cached.properties = Object.assign({}, cached.properties || {}, {
        color: dayColor,
        links: buildLinks(coords, cached._snap)
      });
      setRouteStatus('真实路线', 'ok');
      setDayRouteInfo(cached.properties.distance, cached.properties.duration, profile);
      animateRoute(cached);
      return;
    }
    setRouteData(plain);
    setRouteStatus('规划路线中', 'loading');
    try {
      var geo = await fetchOsrm(coords, profile);
      if (token !== state.dayToken) return;
      state.routeCache[dayKey] = geo;
      geo.properties = Object.assign({}, geo.properties || {}, {
        color: dayColor,
        links: buildLinks(coords, geo._snap)
      });
      setDayRouteInfo(geo.properties.distance, geo.properties.duration, profile);
      var far = maxSnap(geo._snap);
      setRouteStatus(
        '真实路线' +
        (far > 800 ? ' · 坐标可能不准' : (far > 150 ? ' · 部分地点离路较远' : '')),
        far > 800 ? 'warn' : 'ok'
      );
      animateRoute(geo);
    } catch (e) {
      if (token === state.dayToken) {
        setRouteStatus('已回退直线', 'warn');
        animateRoute(plain);
        toast('路线服务未响应 已回退直线', true);
      }
    }
  } else {
    setRouteStatus('直线示意', '');
    animateRoute(plain);
  }
}

async function fetchOsrm(coords, profile) {
  var path = coords.map(function (c) { return c[0] + ',' + c[1]; }).join(';');
  var url = 'https://router.project-osrm.org/route/v1/' + (profile || 'driving') + '/' + path +
    '?overview=full&geometries=geojson';
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 8000);
  var r;
  try {
    r = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error('OSRM ' + r.status);
  var d = await r.json();
  if (!d.routes || !d.routes[0] || !d.routes[0].geometry) throw new Error('no route');
  // waypoints 里带着每个点被吸附到路网后的真实落点，
  // 用来补「点位 → 道路」的接驳虚线
  var snaps = (d.waypoints || []).map(function (w) {
    return {
      loc: w && w.location ? [w.location[0], w.location[1]] : null,
      dist: Math.round((w && w.distance) || 0)
    };
  });
  var route0 = d.routes[0];
  return {
    type: 'Feature',
    properties: {
      distance: Math.round(route0.distance || 0),
      duration: Math.round(route0.duration || 0)
    },
    geometry: route0.geometry,
    _snap: snaps
  };
}

function maxSnap(snaps) {
  var m = 0;
  (snaps || []).forEach(function (s) { if (s && s.dist > m) m = s.dist; });
  return m;
}

function flyToPoi(p) {
  if (!state.map || !isFinite(p.lat) || !isFinite(p.lng)) {
    toast('该地点暂无坐标', true);
    return;
  }
  state.map.flyTo({
    center: [p.lng, p.lat],
    zoom: Math.max(state.map.getZoom(), 14),
    duration: 900,
    essential: true
  });
  setTimeout(function () { openPopup(p); }, 950);
  highlightPin(p.id);
  highlightCard(p.id);
}

function closePopup() {
  if (state.popup) {
    try { state.popup.remove(); } catch (e) {}
    state.popup = null;
  }
}

function openPopup(p) {
  if (!state.map) return;
  closePopup();
  var c = CATEGORIES[p.type] || CATEGORIES.sight;
  var html = '<div class="pop">' +
    '<div class="pop-name">' + escapeHtml(p.name) + '</div>' +
    '<div class="pop-row">' +
      '<span class="chip" style="background:' + c.color + ';color:' + (c.ink || '#fff') + '">' + c.short + '</span>' +
      '<span class="pop-time">' + escapeHtml(p.time || '') + '</span>' +
    '</div>' +
    (p.desc ? '<div class="pop-desc">' + escapeHtml(tidyText(p.desc)) + '</div>' : '') +
    '<div class="pop-meta">' +
      '<span>' + ICONS.wallet + '¥' + (p.cost || 0) + '</span>' +
      '<span>' + ICONS.timer + escapeHtml(p.duration || '—') + '</span>' +
    '</div>' +
    (p.address ? '<div class="pop-addr">' + ICONS.pin + '<span>' + escapeHtml(p.address) + '</span></div>' : '') +
    '</div>';

  state.popup = new maplibregl.Popup({ offset: 22, closeButton: true, maxWidth: '310px' })
    .setLngLat([p.lng, p.lat])
    .setHTML(html)
    .addTo(state.map);
}

// 拖拽重排：新顺序继承原有时间槽，保证卡片仍按时间升序
function reorderDay(from, to) {
  if (!state.plan) return;
  var d = state.plan.days[state.activeDay - 1];
  if (!d) return;
  var sorted = d.pois.slice().sort(byTime);
  if (from < 0 || from >= sorted.length) return;

  var times = sorted.map(function (x) { return x.time; });
  var moved = sorted.splice(from, 1)[0];
  if (to > from) to -= 1;
  to = Math.max(0, Math.min(sorted.length, to));
  sorted.splice(to, 0, moved);
  sorted.forEach(function (x, i) { x.time = times[i]; });

  d.pois = sorted;
  state.routeCache = {};
  renderDay(true);
  toast('已调整 ' + (moved.name || '点位') + ' 到第 ' + (to + 1) + ' 位');
}

// 图钉 hover → 卡片同步高亮（不滚动页面）
function linkCard(id, on) {
  var sel = '.card[data-id="' + String(id).replace(/"/g, '\\"') + '"]';
  var el = document.querySelector(sel);
  if (el) el.classList.toggle('flash', !!on);
}

function highlightCard(id) {
  document.querySelectorAll('.card').forEach(function (el) {
    el.classList.toggle('flash', el.getAttribute('data-id') === String(id));
  });
  var el = document.querySelector('.card[data-id="' + String(id).replace(/"/g, '\\"') + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function highlightPin(id) {
  document.querySelectorAll('.pin').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-id') === String(id));
  });
}

/* =========================================================================
   AI 调整行程（局部重排，不推翻整份）
   ========================================================================= */
var aiState = { busy: false };

function aiAppend(role, text) {
  var log = $('aiLog');
  if (!log) return null;
  var el = document.createElement('div');
  el.className = 'ai-msg ' + role;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function aiTyping(on) {
  var log = $('aiLog');
  if (!log) return;
  var ex = log.querySelector('.ai-typing');
  if (on && !ex) {
    var el = document.createElement('div');
    el.className = 'ai-typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  } else if (!on && ex) {
    ex.remove();
  }
}

function openAiPanel() {
  var p = $('aiPanel');
  if (!p) return;
  p.classList.add('show');
  setTimeout(function () {
    try { $('aiInput').focus({ preventScroll: true }); } catch (e) {}
  }, 200);
}

function closeAiPanel() {
  var p = $('aiPanel');
  if (p) p.classList.remove('show');
}

function planPayload(plan) {
  return {
    title: plan.title,
    city: plan.city,
    summary: plan.summary,
    center: plan.center,
    days: plan.days.map(function (d) {
      return {
        day: d.day,
        theme: d.theme,
        pois: d.pois.map(function (p) {
          return {
            name: p.name, type: p.type, time: p.time, address: p.address,
            duration: p.duration, cost: p.cost, desc: p.desc, lat: p.lat, lng: p.lng
          };
        })
      };
    })
  };
}

function diffDays(a, b) {
  var out = [];
  var max = Math.max(a.days.length, b.days.length);
  for (var i = 0; i < max; i++) {
    var da = a.days[i], db = b.days[i];
    if (!da || !db) { out.push(i + 1); continue; }
    var sa = da.pois.map(function (p) { return p.name + '|' + p.time; }).sort().join('~');
    var sb = db.pois.map(function (p) { return p.name + '|' + p.time; }).sort().join('~');
    if (sa !== sb || (da.theme || '') !== (db.theme || '')) out.push(i + 1);
  }
  return out;
}

function applyAiPlan(newPlan, changed) {
  newPlan.center = newPlan.center || state.plan.center;
  newPlan.city = newPlan.city || state.plan.city;
  state.plan = newPlan;
  state.routeCache = {};
  if (state.activeDay > newPlan.days.length) state.activeDay = newPlan.days.length;

  renderBanner();
  renderTabs();
  renderDay(false);

  setTimeout(function () {
    changed.forEach(function (day) {
      Array.prototype.forEach.call(
        document.querySelectorAll('.card[data-day="' + day + '"]'),
        function (el) {
          el.classList.add('updated');
          setTimeout(function () { el.classList.remove('updated'); }, 2600);
        }
      );
    });
  }, 420);
}

async function aiAdjust(text) {
  if (aiState.busy) return;
  var s = state.settings;
  if (!s.apiKey) { openSettings(); toast('请先配置 API Key', true); return; }
  if (!state.plan) { toast('先生成或载入一份行程', true); return; }

  aiState.busy = true;
  $('aiSend').disabled = true;
  $('aiInput').value = '';
  aiAppend('user', text);
  aiTyping(true);

  var sys = [
    '你是专业中文旅行规划编辑助手。',
    '用户会给你当前行程 JSON 和一条修改要求。',
    '只返回一个 JSON 对象，格式：{"summary":"一句话说明改了什么","plan":{完整行程}}',
    '不要 markdown 代码块，不要任何解释。',
    '规则：',
    '1) 只修改与要求相关的部分，其余原样保留；',
    '2) 每天 POI 保持 4-7 个；',
    '3) 每个 POI 的 time 必须按升序；',
    '4) 每个 POI 必须有真实 WGS-84 坐标 lat/lng；',
    '5) type 只能是 sight / food / culture / shopping；',
    '6) 如果要求无法执行，返回原 plan 不变，summary 说明原因。'
  ].join('\n');

  var body = {
    model: s.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: '当前行程：\n' + JSON.stringify(planPayload(state.plan)) + '\n\n修改要求：' + text
      }
    ],
    temperature: 0.4,
    // 要回吐整份行程，token 必须给够，否则会被截断成半截 JSON
    max_tokens: 8192,
    response_format: { type: 'json_object' }
  };

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 150000);
  var res, data;

  try {
    res = await fetch(s.apiBase.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      var errText = await res.text();
      throw new Error('HTTP ' + res.status + ' ' + String(errText).slice(0, 100));
    }
    data = await res.json();
  } catch (e) {
    clearTimeout(timer);
    aiTyping(false);
    aiState.busy = false;
    $('aiSend').disabled = false;
    aiAppend('err', '调整失败 ' + (e.name === 'AbortError' ? '请求超时' : (e.message || e)));
    return;
  }
  clearTimeout(timer);

  aiTyping(false);
  aiState.busy = false;
  $('aiSend').disabled = false;

  var content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!content) { aiAppend('err', '模型没有返回内容'); return; }

  var raw = String(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  var obj = null;
  try { obj = JSON.parse(raw); } catch (e) {}
  if (!obj) {
    var a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) { try { obj = JSON.parse(raw.slice(a, b + 1)); } catch (e2) {} }
  }
  if (!obj || !obj.plan) { aiAppend('err', '模型返回格式不对 请再试一次'); return; }

  var newPlan;
  try {
    newPlan = parsePlan(JSON.stringify(obj.plan), state.plan.city, state.plan.days.length);
  } catch (e3) {
    aiAppend('err', '返回的行程不合法 请换个说法');
    return;
  }

  var changed = diffDays(state.plan, newPlan);
  var summary = tidyText(obj.summary);

  if (!changed.length) {
    aiAppend('bot', summary || '这次没有需要改动的地方');
    return;
  }

  applyAiPlan(newPlan, changed);
  aiAppend('bot', (summary || '已更新行程') + ' 涉及 DAY ' + changed.join('、'));
  setTimeout(function () { switchDay(changed[0]); }, 280);
}

/* =========================================================================
   导出行程长图（Canvas 手绘，零依赖）
   ========================================================================= */
function exportPlanImage() {
  if (!state.plan) { toast('还没有行程', true); return; }
  var p = state.plan;

  var W = 1080;
  var PAD = 64;
  var TOP = 250;
  var CW = W - PAD * 2;

  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,sans-serif';
  var C = {
    paper: '#FFFFFF',
    bg: '#F8F9FC',
    ink: '#0A0D14',
    ink2: '#4B5364',
    ink3: '#8B92A3',
    line: '#E7EAF1',
    primary: '#2563EB',
    primarySoft: '#EBF1FF'
  };

  var sortedDays = p.days.map(function (d) {
    return { day: d, pois: d.pois.slice().sort(byTime) };
  });

  function cardH(poi) { return poi.desc ? 96 : 76; }

  // ---- 高度计算 ----
  var H = TOP;
  sortedDays.forEach(function (item) {
    H += 54;
    item.pois.forEach(function (poi) { H += cardH(poi) + 14; });
    H += 30;
  });
  H += 96;

  var scale = 2;
  var canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  var ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function ellipsis(text, maxW) {
    text = String(text || '');
    if (ctx.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawChip(text, x, y, color, ink) {
    ctx.font = '700 12px ' + FONT;
    var w = ctx.measureText(text).width + 18;
    roundRect(x, y, w, 22, 11);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 9, y + 12);
    ctx.textBaseline = 'alphabetic';
    return w;
  }

  // ---- 背景 ----
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // 顶部渐变（蓝 → 透明）
  var g = ctx.createLinearGradient(0, 0, 0, 260);
  g.addColorStop(0, 'rgba(37,99,235,.10)');
  g.addColorStop(1, 'rgba(37,99,235,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 260);

  // 顶部细蓝线
  ctx.fillStyle = C.primary;
  ctx.fillRect(0, 0, W, 3);

  // ---- 头部 ----
  var stats = { days: sortedDays.length, pois: 0, budget: 0 };
  sortedDays.forEach(function (it) {
    stats.pois += it.pois.length;
    it.pois.forEach(function (poi) { stats.budget += (poi.cost || 0); });
  });

  ctx.fillStyle = C.ink3;
  ctx.font = '700 11px ' + FONT;
  ctx.fillText('T R A V E L   I T I N E R A R Y', PAD, 62);

  ctx.fillStyle = C.ink;
  ctx.font = '800 40px ' + FONT;
  ctx.fillText(ellipsis(tidyText(p.title) || (p.city || '我的行程'), CW - 10), PAD, 116);

  ctx.fillStyle = C.ink2;
  ctx.font = '400 15px ' + FONT;
  ctx.fillText(ellipsis(tidyText(p.summary) || 'AI 生成的行程规划', CW - 10), PAD, 148);

  // 统计
  var sx = PAD;
  var sy = 186;
  [['DAYS', String(stats.days), ''], ['PLACES', String(stats.pois), ''], ['BUDGET', '¥' + stats.budget.toLocaleString(), '']].forEach(function (row, i) {
    ctx.fillStyle = C.ink;
    ctx.font = '800 30px ' + FONT;
    ctx.fillText(row[1], sx, sy);
    ctx.fillStyle = C.ink3;
    ctx.font = '700 10px ' + FONT;
    ctx.fillText(row[0], sx, sy + 22);
    sx += 140;
  });

  // 分隔线
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, 222);
  ctx.lineTo(W - PAD, 222);
  ctx.stroke();

  // ---- 每天 ----
  var y = TOP;
  sortedDays.forEach(function (item, di) {
    var d = item.day;

    // 天标题
    ctx.fillStyle = C.primary;
    roundRect(PAD, y - 4, 62, 26, 7);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '800 12px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.fillText('DAY ' + (di + 1), PAD + 11, y + 9);

    ctx.fillStyle = C.ink;
    ctx.font = '800 19px ' + FONT;
    ctx.fillText(ellipsis(tidyText(d.theme) || '', CW - 90), PAD + 76, y + 10);
    ctx.textBaseline = 'alphabetic';

    y += 46;

    // 时间轴
    var axisX = PAD + 9;
    var listX = PAD + 34;
    var cardW = W - PAD - listX;

    item.pois.forEach(function (poi, pi) {
      var cat = CATEGORIES[poi.type] || CATEGORIES.sight;
      var ch = cardH(poi);

      // 卡片
      roundRect(listX, y, cardW, ch, 14);
      ctx.fillStyle = C.paper;
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.stroke();

      // 左侧色条
      ctx.save();
      roundRect(listX, y, cardW, ch, 14);
      ctx.clip();
      ctx.fillStyle = cat.color;
      ctx.fillRect(listX, y, 4, ch);
      ctx.restore();

      // 时间轴点 + 连线
      ctx.fillStyle = cat.color;
      ctx.beginPath();
      ctx.arc(axisX, y + 26, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.bg;
      ctx.lineWidth = 3;
      ctx.stroke();

      if (pi < item.pois.length - 1) {
        ctx.strokeStyle = '#DCE2EC';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(axisX, y + 36);
        ctx.lineTo(axisX, y + ch + 14 + 26);
        ctx.stroke();
      }

      // 时间
      ctx.fillStyle = C.ink3;
      ctx.font = '700 12px ' + FONT;
      ctx.fillText(poi.time || '', listX + 18, y + 24);

      // 名称
      var nameX = listX + 18;
      ctx.fillStyle = C.ink;
      ctx.font = '800 17px ' + FONT;
      var nameText = ellipsis(poi.name || '', cardW - 150);
      var nameW = ctx.measureText(nameText).width;
      ctx.fillText(nameText, nameX, y + 44);

      drawChip(cat.short, Math.min(nameX + nameW + 10, listX + cardW - 78), y + 31, cat.color, cat.ink || '#fff');

      // 描述
      if (poi.desc) {
        ctx.fillStyle = C.ink2;
        ctx.font = '400 13px ' + FONT;
        ctx.fillText(ellipsis(tidyText(poi.desc), cardW - 36), listX + 18, y + 65);
      }

      // 元信息
      ctx.fillStyle = C.ink3;
      ctx.font = '600 11.5px ' + FONT;
      var meta = (poi.duration || '—') + '     ¥' + (poi.cost || 0);
      if (poi.address) meta += '     ' + poi.address;
      ctx.fillText(ellipsis(meta, cardW - 36), listX + 18, y + ch - 12);

      y += ch + 14;
    });

    y += 30;
  });

  // ---- 底部 ----
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 76);
  ctx.lineTo(W - PAD, H - 76);
  ctx.stroke();

  ctx.fillStyle = C.ink3;
  ctx.font = '600 11px ' + FONT;
  ctx.fillText('由 AI 生成 · 行程规划', PAD, H - 48);

  var now = new Date();
  var stamp = now.getFullYear() + '.' + String(now.getMonth() + 1).padStart(2, '0') + '.' + String(now.getDate()).padStart(2, '0');
  ctx.textAlign = 'right';
  ctx.fillText(stamp, W - PAD, H - 48);
  ctx.textAlign = 'left';

  // ---- 导出（toDataURL 同步生成，兼容性最好）----
  window.__lastExportCanvas = canvas;
  var dataUrl;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (e) {
    toast('导出失败 ' + (e.message || ''), true);
    return;
  }
  var a = document.createElement('a');
  a.href = dataUrl;
  a.download = (p.city || '行程') + ' ' + p.days.length + ' 日 行程.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('长图已导出 ' + W + ' × ' + Math.round(H));
}

/* =========================================================================
   命令面板（⌘K / Ctrl+K）
   ========================================================================= */
var cmdkState = { open: false, all: [], items: [], active: 0 };

function byTime(a, b) {
  return String(a.time || '').localeCompare(String(b.time || ''));
}

function buildCommands() {
  var list = [];
  var p = state.plan;

  if (p) {
    p.days.forEach(function (d, i) {
      d.pois.slice().sort(byTime).forEach(function (poi) {
        list.push({
          icon: 'pin',
          title: poi.name,
          sub: 'DAY ' + (i + 1) + '  ' + (poi.time || ''),
          run: function () {
            closeCmdk();
            state.activeDay = i + 1;
            renderTabs();
            renderDay(true);
            setTimeout(function () { flyToPoi(poi); }, 460);
          }
        });
      });
    });
    p.days.forEach(function (d, i) {
      list.push({
        icon: 'calendar',
        title: '切换到 DAY ' + (i + 1),
        sub: tidyText(d.theme) || '',
        run: function () { closeCmdk(); switchDay(i + 1); }
      });
    });
  }

  list.push({
    icon: document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon',
    title: document.documentElement.getAttribute('data-theme') === 'dark' ? '切换到浅色主题' : '切换到深色主题',
    sub: '外观', run: function () { closeCmdk(); toggleTheme(); }
  });
  list.push({
    icon: 'cube',
    title: state.settings.pitch3d ? '关闭 3D 视角' : '开启 3D 视角',
    sub: '地图', run: function () { closeCmdk(); toggle3D(); }
  });
  list.push({
    icon: 'sparkles', title: '用 AI 调整行程', sub: '局部重排',
    run: function () { closeCmdk(); openAiPanel(); }
  });
  list.push({
    icon: 'download', title: '导出行程长图', sub: 'PNG',
    run: function () { closeCmdk(); exportPlanImage(); }
  });

  Object.keys(MAP_STYLES).forEach(function (k) {
    list.push({
      icon: 'layers',
      title: '底图 ' + MAP_STYLES[k].label,
      sub: state.settings.style === k ? '当前' : '',
      run: function () { closeCmdk(); applyStyle(k); }
    });
  });
  if (p) {
    list.push({
      icon: 'map', title: '查看全部行程总览', sub: '按天分色',
      run: function () { closeCmdk(); switchDay(0); }
    });
  }
  list.push({
    icon: 'globe', title: '打开世界模型', sub: '',
    run: function () { closeCmdk(); openGlobeView(); }
  });
  list.push({
    icon: 'gear', title: '打开设置', sub: '',
    run: function () { closeCmdk(); openSettings(); }
  });
  list.push({
    icon: 'sparkles', title: '载入示例 成都 3 日', sub: '',
    run: function () { closeCmdk(); loadSample(); }
  });

  return list;
}

function renderCmdk(q) {
  var list = $('cmdkList');
  q = (q || '').trim().toLowerCase();
  cmdkState.items = cmdkState.all.filter(function (c) {
    if (!q) return true;
    return (c.title + ' ' + (c.sub || '')).toLowerCase().indexOf(q) >= 0;
  });
  cmdkState.active = 0;

  if (!cmdkState.items.length) {
    list.innerHTML = '<div class="cmdk-empty">没有匹配项</div>';
    return;
  }
  list.innerHTML = cmdkState.items.map(function (c, i) {
    return '<div class="cmdk-item' + (i === 0 ? ' active' : '') + '" data-i="' + i + '">' +
      ICONS[c.icon || 'pin'] +
      '<span class="t">' + escapeHtml(c.title) + '</span>' +
      (c.sub ? '<span class="s">' + escapeHtml(c.sub) + '</span>' : '') +
      '</div>';
  }).join('');
}

function syncCmdkActive() {
  var nodes = $('cmdkList').querySelectorAll('.cmdk-item');
  Array.prototype.forEach.call(nodes, function (el, i) {
    var on = i === cmdkState.active;
    el.classList.toggle('active', on);
    if (on) {
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
  });
}

function openCmdk() {
  var el = $('cmdk');
  if (!el) return;
  cmdkState.all = buildCommands();
  $('cmdkInput').value = '';
  renderCmdk('');
  el.classList.add('show');
  cmdkState.open = true;
  setTimeout(function () {
    try { $('cmdkInput').focus({ preventScroll: true }); } catch (e) {}
  }, 70);
}

function closeCmdk() {
  var el = $('cmdk');
  if (!el) return;
  el.classList.remove('show');
  cmdkState.open = false;
  try { $('cmdkInput').blur(); } catch (e) {}
}

function runCmdkActive() {
  var it = cmdkState.items[cmdkState.active];
  if (it) it.run();
}

// 缩放到全部天的范围
function fitAllDays() {
  if (!state.plan || !state.map) return;
  var all = [];
  state.plan.days.forEach(function (d) {
    d.pois.forEach(function (poi) {
      if (isFinite(poi.lat) && isFinite(poi.lng)) all.push([poi.lng, poi.lat]);
    });
  });
  if (!all.length) return;
  var b = new maplibregl.LngLatBounds(all[0], all[0]);
  all.forEach(function (c) { b.extend(c); });
  state.map.fitBounds(b, { padding: 90, maxZoom: 13, duration: 900 });
  toast('已缩放到全行程范围');
}

/* =========================================================================
   深浅色主题
   ========================================================================= */
function syncCategoryColors() {
  var cs;
  try { cs = getComputedStyle(document.documentElement); } catch (e) { return; }
  ['sight', 'food', 'culture', 'shopping'].forEach(function (k) {
    var v = cs.getPropertyValue('--' + k).trim();
    if (v) CATEGORIES[k].color = v;
  });
}

function applyTheme(t, silent) {
  t = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  state.settings.theme = t;
  if (!silent) saveSettings();

  syncCategoryColors();

  // 底图跟随：深色用 dark，浅色恢复上一次的浅色样式
  if (t === 'dark') {
    if (state.settings.style !== 'dark') {
      state.lastLightStyle = state.settings.style || 'bright';
      if (state.map) { try { state.map.setStyle(MAP_STYLES.dark.url); state.settings.style = 'dark'; updateStyleButtons(); } catch (e) {} }
    }
  } else if (state.settings.style === 'dark') {
    var back = state.lastLightStyle || 'bright';
    state.settings.style = back;
    if (state.map) { try { state.map.setStyle(MAP_STYLES[back].url); } catch (e) {} }
    updateStyleButtons();
  }

  // 世界模型同样跟随
  if (state.globeMap) {
    try {
      var k = t === 'dark' ? 'dark' : (state.lastLightStyle || 'bright');
      var gm = state.globeMap;
      gm.setStyle(MAP_STYLES[k].url);
      // setStyle 会清空所有图层，applyGlobe 只跑过一次不会再补，
      // 这里手动把卫星层和 3D 建筑接回来，并重新量一次尺寸
      setTimeout(function () {
        try { ensureSatellite(gm); updateSatellite(gm); } catch (e) {}
        try { addCustomBuildings(gm); } catch (e) {}
        try { localizeLabels(gm); } catch (e) {}
        try { gm.resize(); } catch (e) {}
        updateGlobeHudMap(gm);
      }, 600);
    } catch (e) {}
  }
  if (!silent && state.plan) {
    renderTabs();
    renderDay(true);
  }
}

function toggleTheme(e) {
  var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  var x = e && e.clientX ? e.clientX : window.innerWidth - 80;
  var y = e && e.clientY ? e.clientY : 40;
  document.documentElement.style.setProperty('--tx', x + 'px');
  document.documentElement.style.setProperty('--ty', y + 'px');

  if (document.startViewTransition && !reducedMotion()) {
    document.startViewTransition(function () { applyTheme(next); });
  } else {
    applyTheme(next);
  }
}

/* =========================================================================
   底图样式切换
   ========================================================================= */
function updateStyleButtons() {
  document.querySelectorAll('#styleSwitch button').forEach(function (b) {
    if (b.hasAttribute('data-3d')) {
      b.classList.toggle('active', !!state.settings.pitch3d);
    } else {
      b.classList.toggle('active', b.getAttribute('data-style') === state.settings.style);
    }
  });
}

function toggle3D() {
  state.settings.pitch3d = !state.settings.pitch3d;
  saveSettings();
  updateStyleButtons();
  if (!state.map) return;

  if (state.settings.pitch3d) {
    enableTerrain(state.map);
    addCustomBuildings(state.map);
    state.map.easeTo({ pitch: 60, bearing: -20, duration: 900 });
    toast('已开启 3D 地形与建筑');
  } else {
    disableTerrain(state.map);
    try {
      if (state.map.getLayer('custom-3d-buildings')) state.map.removeLayer('custom-3d-buildings');
    } catch (e) {}
    state.map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  }
}

function applyStyle(key) {
  if (!MAP_STYLES[key]) return;
  state.settings.style = key;
  saveSettings();
  updateStyleButtons();
  if (state.map) {
    state.map.setStyle(MAP_STYLES[key].url);
    setTimeout(ensureRouteLayer, 900);
    try { state.map.once('idle', ensureRouteLayer); } catch (e) {}
  }
}

/* =========================================================================
   内置示例（成都 3 日，WGS-84 近似坐标）
   ========================================================================= */
function loadSample() {
  var sample = {
    title: '成都 3 日 · 巴适慢游',
    city: '成都',
    summary: '历史人文 市井美食 熊猫自然与锦江夜生活的松弛组合',
    center: { lat: 30.6570, lng: 104.0657 },
    days: [
      {
        day: 1, theme: '古都文化与市井烟火',
        pois: [
          { id: 's1', name: '武侯祠', type: 'culture', time: '09:00', address: '成都市武侯区武侯祠大街231号', duration: '约 2 小时', cost: 50, desc: '三国蜀汉文化圣地 红墙竹影极出片', lat: 30.6450, lng: 104.0430 },
          { id: 's2', name: '锦里古街', type: 'shopping', time: '11:30', address: '成都市武侯区武侯祠大街231号附1号', duration: '约 1.5 小时', cost: 0, desc: '川西民居小吃街 白天逛吃 夜里灯笼', lat: 30.6430, lng: 104.0455 },
          { id: 's3', name: '宽窄巷子', type: 'culture', time: '14:00', address: '成都市青羊区金河路口宽窄巷子', duration: '约 2 小时', cost: 0, desc: '老成都院落文化 喝茶掏耳朵', lat: 30.6695, lng: 104.0555 },
          { id: 's4', name: '奎星楼街', type: 'food', time: '17:30', address: '成都市青羊区奎星楼街', duration: '约 1.5 小时', cost: 80, desc: '本地人爱的串串与苍蝇馆子聚集地', lat: 30.6700, lng: 104.0605 },
          { id: 's5', name: '九眼桥酒吧街', type: 'shopping', time: '20:30', address: '成都市武侯区九眼桥', duration: '约 2 小时', cost: 120, desc: '锦江畔夜生活地标 江风配小酒', lat: 30.6395, lng: 104.0825 }
        ]
      },
      {
        day: 2, theme: '熊猫自然与舌尖盛宴',
        pois: [
          { id: 's6', name: '成都大熊猫繁育研究基地', type: 'sight', time: '08:00', address: '成都市成华区熊猫大道1375号', duration: '约 3 小时', cost: 55, desc: '看顶流花花 清晨最活跃', lat: 30.7330, lng: 104.1450 },
          { id: 's7', name: '杜甫草堂', type: 'culture', time: '12:30', address: '成都市青羊区青华路37号', duration: '约 1.5 小时', cost: 50, desc: '诗圣故居 竹林溪桥清幽', lat: 30.6600, lng: 104.0270 },
          { id: 's8', name: '春熙路 / 太古里', type: 'shopping', time: '15:00', address: '成都市锦江区中纱帽街8号', duration: '约 2 小时', cost: 0, desc: '潮牌地标与裸眼 3D 大屏', lat: 30.6560, lng: 104.0800 },
          { id: 's9', name: '小龙坎火锅', type: 'food', time: '18:30', address: '成都市锦江区春熙路附近', duration: '约 1.5 小时', cost: 130, desc: '成都火锅代表，麻辣过瘾。', lat: 30.6550, lng: 104.0805 }
        ]
      },
      {
        day: 3, theme: '山水自然与古镇闲游',
        pois: [
          { id: 's10', name: '青城山（前山）', type: 'sight', time: '09:00', address: '成都市都江堰市青城山镇', duration: '约 4 小时', cost: 90, desc: '道教名山，幽静避暑。', lat: 30.9000, lng: 103.5670 },
          { id: 's11', name: '都江堰景区', type: 'culture', time: '14:00', address: '成都市都江堰市公园路', duration: '约 2.5 小时', cost: 80, desc: '两千年不朽的水利奇迹。', lat: 30.9980, lng: 103.6160 },
          { id: 's12', name: '南桥夜市', type: 'shopping', time: '19:00', address: '成都市都江堰市南桥', duration: '约 1.5 小时', cost: 60, desc: '蓝眼泪廊桥，夜市小吃收尾。', lat: 30.9970, lng: 103.6175 }
        ]
      }
    ]
  };

  loadPlan(sample).then(function () { toast('已载入示例 成都 3 日'); });
}

/* =========================================================================
   事件绑定与初始化
   ========================================================================= */
function init() {
  var today = new Date();
  var plus2 = new Date(Date.now() + 2 * 86400000);
  function fmt(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  $('start').value = fmt(today);
  $('end').value = fmt(plus2);

  updateApiHint();
  updateStyleButtons();
  renderPrefs(loadPrefs());

  $('prefsToggle').onclick = function () {
    var body = $('prefsBody');
    var btn = $('prefsToggle');
    var collapsed = body.classList.toggle('collapsed');
    btn.classList.toggle('collapsed', collapsed);
    btn.childNodes[0].nodeValue = collapsed ? '展开 ' : '收起 ';
    if (!collapsed) {
      // 展开时让内容逐个浮入
      Array.prototype.slice.call(body.querySelectorAll('.field, .chips button')).forEach(function (el, i) {
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = 'enter-fade 340ms var(--e-out) both';
        el.style.animationDelay = (i * 18) + 'ms';
      });
    }
  };

  $('pInterests').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]');
    if (!b) return;
    b.classList.toggle('on');
    savePrefs(readPrefs());
  });

  $('prefsBody').addEventListener('change', function () {
    savePrefs(readPrefs());
  });

  // 交通方式变化会影响驾车/步行路线，已有行程时立即重算
  $('pTransport').addEventListener('change', function () {
    if (state.plan) renderDay();
  });

  // 首次打开先展示地球开场（不依赖 API Key）
  var introSeen = false;
  try { introSeen = sessionStorage.getItem('travel_intro_seen') === '1'; } catch (e) {}
  if (state.settings.intro && supportsWebGL() && !introSeen) {
    try {
      state.landingIntro = createIntro(true);
      try { sessionStorage.setItem('travel_intro_seen', '1'); } catch (e) {}
    } catch (e) {}
  }

  applyTheme(state.settings.theme || 'light', true);
  var tb = $('themeBtn');
  if (tb) tb.onclick = toggleTheme;

  $('settingsBtn').onclick = openSettings;
  $('apiHintBtn').onclick = openSettings;
  $('globeBtn').onclick = openGlobeView;
  $('globeClose').onclick = closeGlobeView;
  $('globe3d').onclick = toggleGlobe3D;
  $('globeRetry').onclick = function () {
    hideGlobeError();
    if (state.globeMap) { try { state.globeMap.remove(); } catch (e) {} state.globeMap = null; }
    openGlobeView();
  };
  $('globeBack').onclick = closeGlobeView;
  $('envWarnClose').onclick = function () { $('envWarn').style.display = 'none'; };
  window.addEventListener('online', function () { checkEnv(); });
  setTimeout(checkEnv, 1500);

  // 上次的行程还在本地就自动恢复：关掉再打开不用重新生成，离线也能看
  var cachedPlan = readPlanCache();
  if (cachedPlan) {
    setTimeout(function () {
      if (state.plan) return;
      loadPlan(cachedPlan).then(function () {
        toast('已恢复上次的行程');
      }).catch(function () {});
    }, state.settings.intro ? 1200 : 400);
  }
  $('cancelSettings').onclick = closeSettings;
  $('saveSettings').onclick = applySettingsFromForm;
  $('clearKeyBtn').onclick = function () {
    $('sApiKey').value = '';
    $('sAmapKey').value = '';
    state.settings.apiKey = '';
    saveSettings();
    updateApiHint();
    toast('已清除保存的 Key');
  };

  $('replayIntro').onclick = async function () {
    closeSettings();
    if (state.landingIntro) {
      try { await state.landingIntro.close(); } catch (e) {}
      state.landingIntro = null;
    }
    try { sessionStorage.removeItem('travel_intro_seen'); } catch (e) {}
    await delay(220);
    state.landingIntro = createIntro(true);
  };

  $('settingsModal').addEventListener('click', function (e) {
    if (e.target === $('settingsModal')) closeSettings();
  });

  $('genBtn').onclick = generatePlan;

  var vAdd = $('variantAdd');
  if (vAdd) {
    vAdd.onclick = function () {
      var el = $('variantStyles');
      if (el) el.classList.toggle('on');
    };
  }
  var vStyles = $('variantStyles');
  if (vStyles) {
    vStyles.onclick = function (e) {
      var b = e.target.closest('button[data-style]');
      if (!b || b.disabled) return;
      generateVariant(b.getAttribute('data-style'));
    };
  }
  var vChips = $('variantChips');
  if (vChips) {
    vChips.onclick = function (e) {
      var b = e.target.closest('.variant-chip');
      if (!b) return;
      switchVariant(Number(b.getAttribute('data-i')));
    };
  }
  $('demoBtn').onclick = loadSample;

  $('styleSwitch').addEventListener('click', function (e) {
    var b3 = e.target.closest('button[data-3d]');
    if (b3) { toggle3D(); return; }
    var b = e.target.closest('button[data-style]');
    if (b) applyStyle(b.getAttribute('data-style'));
  });

  // 顶部滚动进度
  (function initScrollProgress() {
    var sp = $('scrollProgress');
    if (!sp) return;
    var ticking = false;
    function update() {
      ticking = false;
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var p = max > 0 ? window.scrollY / max : 0;
      sp.style.transform = 'scaleX(' + Math.min(1, Math.max(0, p)).toFixed(4) + ')';
    }
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', update);
    update();
  })();

  var _rz;
  window.addEventListener('resize', function () {
    clearTimeout(_rz);
    _rz = setTimeout(function () {
      moveTabIndicator();
      if (state.map) { try { state.map.resize(); } catch (e) {} }
      if (state.globeMap) { try { state.globeMap.resize(); } catch (e) {} }
    }, 140);
  });

  // AI 调整
  var fab = $('aiFab');
  if (fab) fab.onclick = function () {
    if ($('aiPanel').classList.contains('show')) closeAiPanel(); else openAiPanel();
  };
  var aiCloseBtn = $('aiClose');
  if (aiCloseBtn) aiCloseBtn.onclick = closeAiPanel;
  var aiSendBtn = $('aiSend');
  if (aiSendBtn) aiSendBtn.onclick = function () {
    var v = $('aiInput').value.trim();
    if (v) aiAdjust(v);
  };
  var aiInputEl = $('aiInput');
  if (aiInputEl) aiInputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('aiSend').click(); }
  });
  var aiSuggestEl = $('aiSuggest');
  if (aiSuggestEl) aiSuggestEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-q]');
    if (b) aiAdjust(b.getAttribute('data-q'));
  });

  // 命令面板
  var cb = $('cmdkBtn');
  if (cb) cb.onclick = openCmdk;
  var ci = $('cmdkInput');
  if (ci) ci.addEventListener('input', function () { renderCmdk(this.value); });
  var cl = $('cmdkList');
  if (cl) cl.addEventListener('click', function (e) {
    var item = e.target.closest('.cmdk-item');
    if (!item) return;
    cmdkState.active = Number(item.getAttribute('data-i')) || 0;
    runCmdkActive();
  });
  var cw = $('cmdk');
  if (cw) cw.addEventListener('click', function (e) {
    if (e.target === cw) closeCmdk();
  });

  document.addEventListener('keydown', function (e) {
    // ⌘K / Ctrl+K 呼出命令面板
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (cmdkState.open) closeCmdk(); else openCmdk();
      return;
    }
    if (cmdkState.open) {
      if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var total = cmdkState.items.length;
        if (!total) return;
        cmdkState.active = (cmdkState.active + (e.key === 'ArrowDown' ? 1 : total - 1)) % total;
        syncCmdkActive();
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); runCmdkActive(); return; }
    }

    var tagName = (document.activeElement && document.activeElement.tagName) || '';
    var typing = /INPUT|SELECT|TEXTAREA/.test(tagName);
    if (!typing && state.plan) {
      if (e.key === 'ArrowRight' && state.activeDay < state.plan.days.length) { switchDay(state.activeDay + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft' && state.activeDay > 1) { switchDay(state.activeDay - 1); e.preventDefault(); }
    }
    // 弹窗内 Tab 焦点循环
    if (e.key === 'Tab' && $('settingsModal').classList.contains('show')) {
      var focusables = Array.prototype.filter.call(
        $('settingsModal').querySelectorAll('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])'),
        function (el) { return el.offsetParent !== null && !el.disabled; }
      );
      if (focusables.length) {
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    if (e.key === 'Escape') {
      if (!$('globeView').classList.contains('hidden')) closeGlobeView();
      else if ($('settingsModal').classList.contains('show')) closeSettings();
      else if (!$('intro').classList.contains('hidden')) {
        var sk = $('skipIntro');
        if (sk) sk.click();
      }
    }
  });
}

init();
