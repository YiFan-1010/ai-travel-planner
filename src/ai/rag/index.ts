/**
 * 检索层
 *
 * 为什么不用向量检索：DeepSeek 没有 embedding 接口，引入本地 embedding 模型
 * 要多下载几十 MB 且首屏变慢。语料规模只有几十条，BM25 这类词频检索
 * 在这个量级上召回质量完全够用，而且是零依赖、零网络。
 *
 * 中文分词用 bigram（两字滑窗）：不依赖词典，对地名和人名友好。
 * 「兵马俑」→ 兵马 / 马俑，查询同样切分，能对上。
 */
import { docsForCity, GENERIC_CITY, type Doc, type DocTag } from './corpus';

export interface Hit {
  doc: Doc;
  score: number;
  /** 命中的词，用于向用户解释「为什么召回了这条」 */
  matched: string[];
}

const K1 = 1.5;
const B = 0.75;

/** 通用条目的分数权重，低于 1 表示让位给本城市条目 */
const GENERIC_WEIGHT = 0.7;

/** 没有任何本地条目时的补足顺序：先讲怎么排，再讲避什么，再讲看什么 */
const FILL_ORDER: DocTag[] = ['move', 'rhythm', 'avoid', 'sight', 'food', 'stay', 'season'];

/**
 * 按标签补充的通用检索词。
 *
 * 语料正文里不会出现「避坑」这种用户说法（写的是「商业化重、本地人不去」），
 * 不补的话用户说「避坑」就召不回避雷条目。
 * 每条都只在建索引时参与召回，不影响正文展示。
 */
const TAG_HINTS: Record<DocTag, string> = {
  sight: '景点 逛 玩 打卡 看 值得',
  food: '吃 美食 餐厅 小吃 好吃 本地',
  avoid: '避坑 别去 不值得 踩雷 坑 人多 商业化',
  stay: '住 住宿 酒店 民宿 住哪 方便',
  move: '交通 怎么走 距离 通勤 路线 远',
  season: '季节 什么时候 天气 几月 适合',
  rhythm: '节奏 几天 累 赶 轻松 慢',
};

/** 中文 bigram + 英文数字按词切 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = String(text || '').toLowerCase();

  for (const seg of norm.split(/[^\u4e00-\u9fa5a-z0-9]+/)) {
    if (!seg) continue;

    const cjk = seg.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const run of cjk) {
      if (run.length === 1) {
        out.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
      }
    }

    const words = seg.match(/[a-z0-9]+/g) || [];
    out.push(...words);
  }
  return out;
}

interface Indexed {
  doc: Doc;
  tf: Map<string, number>;
  len: number;
}

interface CityIndex {
  docs: Indexed[];
  df: Map<string, number>;
  avgLen: number;
}

const indexCache = new Map<string, CityIndex>();

function buildIndex(city: string): CityIndex {
  const raw = docsForCity(city);
  const docs: Indexed[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of raw) {
    /* 别名也进索引：用户说「泡馍」要能召回回民街那条 */
    const bag = tokenize(doc.text + ' ' + (doc.aliases || []).join(' ') + ' ' + TAG_HINTS[doc.tag]);
    const tf = new Map<string, number>();
    for (const t of bag) tf.set(t, (tf.get(t) || 0) + 1);

    docs.push({ doc, tf, len: bag.length });
    totalLen += bag.length;

    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }

  const index: CityIndex = {
    docs,
    df,
    avgLen: docs.length ? totalLen / docs.length : 0,
  };
  indexCache.set(city, index);
  return index;
}

function getIndex(city: string): CityIndex | null {
  const hit = indexCache.get(city);
  if (hit) return hit;
  const built = buildIndex(city);
  return built.docs.length ? built : null;
}

/**
 * 在指定城市的语料里检索。
 * @param query 用户输入的目的地 + 偏好关键词
 * @param city  城市名，用于圈定语料范围
 * @param k     返回条数
 */
/**
 * 查询归一化。
 * BM25 只认字面重合：「三天」和 tag 提示词里的「几天」是两串不同的字，
 * 不归一就永远匹配不上，用户说天数时召回不到节奏类条目。
 */
function normalizeQuery(query: string): string {
  return String(query || '').replace(/[一二两三四五六七八九十\d]+\s*[天日]/g, '几天');
}

export function retrieve(query: string, city: string, k = 5): Hit[] {
  const idx = getIndex(city);
  if (!idx) return [];

  const qTokens = Array.from(new Set(tokenize(normalizeQuery(query))));
  if (!qTokens.length) return [];

  const N = idx.docs.length;
  const scored: Hit[] = [];

  for (const item of idx.docs) {
    let score = 0;
    const matched: string[] = [];

    for (const t of qTokens) {
      const tf = item.tf.get(t);
      if (!tf) continue;

      const df = idx.df.get(t) || 0;
      /* 出现在所有文档里的词没有区分度（比如「的」），idf 自然趋近 0 */
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const denom = tf + K1 * (1 - B + (B * item.len) / (idx.avgLen || 1));
      score += idf * ((tf * (K1 + 1)) / denom);
      matched.push(t);
    }

    if (score > 0) {
      /* 通用条目降权：同分时本城市的条目必须排在前面，
         否则「随便哪个城市都适用的建议」会挤掉「这座城市的具体情况」 */
      const adjusted = item.doc.city === GENERIC_CITY ? score * GENERIC_WEIGHT : score;
      scored.push({ doc: item.doc, score: adjusted, matched });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  /* 本地条目够多时，通用条目只留一条做补充。
     全塞进去会把提示词撑满正确的废话 */
  const localHits = scored.filter((h) => h.doc.city !== GENERIC_CITY).length;
  const genericCap = localHits >= 3 ? 1 : k;

  /* 同类最多取两条，避免 5 条全是「避雷」或全是「景点」 */
  const perTag = new Map<DocTag, number>();
  const out: Hit[] = [];
  let genericUsed = 0;

  for (const hit of scored) {
    const isGeneric = hit.doc.city === GENERIC_CITY;
    if (isGeneric && genericUsed >= genericCap) continue;

    const n = perTag.get(hit.doc.tag) || 0;
    if (n >= 2) continue;

    perTag.set(hit.doc.tag, n + 1);
    if (isGeneric) genericUsed += 1;
    out.push(hit);
    if (out.length >= k) break;
  }

  /* 这座城市没有收录时，上面的打分很可能一条都召不回——
     用户搜「洛阳」跟语料一个字都不重合，BM25 得分就是 0。
     此时按类别补齐通用建议，保证任何目的地都有可用的规划依据。 */
  const hasLocal = out.some((h) => h.doc.city !== GENERIC_CITY);
  if (!hasLocal) {
    const want = Math.min(k, 4);
    const usedTags = new Set(out.map((h) => h.doc.tag));
    for (const tag of FILL_ORDER) {
      if (out.length >= want) break;
      if (usedTags.has(tag)) continue;
      const doc = idx.docs.find((d) => d.doc.city === GENERIC_CITY && d.doc.tag === tag);
      if (!doc) continue;
      out.push({ doc: doc.doc, score: 0, matched: [] });
      usedTags.add(tag);
    }
  }

  return out;
}

/** 把检索结果拼成给模型看的知识块 */
export function formatKnowledge(hits: Hit[]): string {
  if (!hits.length) return '';
  const lines = hits.map((h, i) => `${i + 1}. [${h.doc.tag}] ${h.doc.text}`);
  return [
    '以下是规划这份行程时值得参考的实际情况；',
    '与你安排的地点相关时用上，不相关就忽略，不要硬套：',
    ...lines,
  ].join('\n');
}

/** 清空索引缓存（语料热更新时用） */
export function resetIndex(): void {
  indexCache.clear();
}
