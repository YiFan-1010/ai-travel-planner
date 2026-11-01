/**
 * 行程骨架的解析、校验与修复
 *
 * 模型只产出「地名 + 时间 + 描述」，坐标由工具补齐。
 * 这里负责把不稳定的模型输出变成稳定的结构，并找出需要修正的问题。
 */
import type { DayPlan, PlaceCandidate, Plan, PlanIssue, Poi, PoiType } from './types';
import { haversine } from './tools';

export interface SkeletonPoi {
  name: string;
  type: PoiType;
  time: string;
  duration: string;
  cost: number;
  desc: string;
  /** 降级模式下模型自带的坐标（无地理编码服务时使用） */
  lat?: number;
  lng?: number;
}

export interface SkeletonDay {
  day: number;
  theme: string;
  pois: SkeletonPoi[];
}

export interface Skeleton {
  title: string;
  city: string;
  summary: string;
  days: SkeletonDay[];
}

const VALID_TYPES: PoiType[] = ['sight', 'food', 'culture', 'shopping'];

function normalizeType(v: unknown): PoiType {
  const s = String(v ?? '').trim().toLowerCase();
  return (VALID_TYPES as string[]).includes(s) ? (s as PoiType) : 'sight';
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 从模型输出里抠出 JSON 对象，容忍代码块包裹和前后闲聊 */
function extractJson(raw: string): unknown {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试截取 */
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 解析成骨架。缺字段就补默认值，不抛异常——
 * 宁可产出一份可修正的残品，也不要在最后一步整个失败。
 */
export function parseSkeleton(raw: string, fallbackCity: string): Skeleton {
  const obj = extractJson(raw) as Record<string, unknown> | null;
  if (!obj || !Array.isArray(obj.days) || obj.days.length === 0) {
    throw new Error('模型没有返回合法行程结构');
  }

  const days: SkeletonDay[] = [];
  for (const [i, d] of (obj.days as unknown[]).entries()) {
    if (!d || typeof d !== 'object') continue;
    const day = d as Record<string, unknown>;
    const poisRaw = Array.isArray(day.pois) ? day.pois : [];
    const pois: SkeletonPoi[] = [];

    for (const p of poisRaw) {
      if (!p || typeof p !== 'object') continue;
      const poi = p as Record<string, unknown>;
      const name = asString(poi.name);
      if (!name) continue;
      const lat = asNumber(poi.lat, NaN);
      const lng = asNumber(poi.lng, NaN);
      const hasCoord =
        Number.isFinite(lat) && Number.isFinite(lng) &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

      pois.push({
        name,
        type: normalizeType(poi.type),
        time: asString(poi.time, '09:00'),
        duration: asString(poi.duration, '约 1 小时'),
        cost: Math.max(0, Math.round(asNumber(poi.cost, 0))),
        desc: asString(poi.desc),
        ...(hasCoord ? { lat, lng } : {}),
      });
    }

    if (pois.length === 0) continue;
    days.push({
      day: asNumber(day.day, i + 1),
      theme: asString(day.theme, `第 ${i + 1} 天`),
      pois,
    });
  }

  if (days.length === 0) throw new Error('模型返回的行程里没有可用地点');

  return {
    title: asString(obj.title, `${fallbackCity} ${days.length} 日游`),
    city: asString(obj.city, fallbackCity),
    summary: asString(obj.summary),
    days,
  };
}

/** 按 HH:mm 排序 */
function byTime(a: { time: string }, b: { time: string }): number {
  return String(a.time).localeCompare(String(b.time));
}

/**
 * 把骨架 + 真实坐标合成最终行程。
 * 查不到坐标的点直接丢弃（保留会让地图出现 NaN 崩溃）。
 */
export function assemblePlan(
  skeleton: Skeleton,
  hits: Map<string, PlaceCandidate>,
  fallbackCity: string
): Plan {
  const days: DayPlan[] = [];
  let sumLat = 0;
  let sumLng = 0;
  let coordCount = 0;

  for (const [di, d] of skeleton.days.entries()) {
    const pois: Poi[] = [];

    for (const [pi, p] of d.pois.slice().sort(byTime).entries()) {
      const hit = hits.get(p.name);

      /* 工具查到的优先；没有工具结果时退回模型自带的坐标 */
      const lat = hit ? hit.lat : p.lat;
      const lng = hit ? hit.lng : p.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      pois.push({
        id: `ai-${di + 1}-${pi + 1}`,
        name: p.name,
        type: p.type,
        time: p.time,
        address: hit?.address || skeleton.city,
        duration: p.duration,
        cost: p.cost,
        desc: p.desc,
        lat: lat as number,
        lng: lng as number,
      });
      sumLat += lat as number;
      sumLng += lng as number;
      coordCount += 1;
    }

    if (pois.length === 0) continue;
    days.push({ day: d.day, theme: d.theme, pois });
  }

  if (days.length === 0) {
    throw new Error('所有地点都没能定位到坐标 请换个说法重试');
  }

  return {
    title: skeleton.title || `${fallbackCity} ${days.length} 日游`,
    city: skeleton.city || fallbackCity,
    summary: skeleton.summary,
    center: coordCount
      ? { lat: sumLat / coordCount, lng: sumLng / coordCount }
      : { lat: 0, lng: 0 },
    days,
  };
}

/** 单日跨度超过这个值就认为太奔波 */
export const SPAN_WARN_KM = 35;
/** 单日跨度超过这个值直接算硬伤 */
export const SPAN_ERROR_KM = 90;

/**
 * 体检。返回的问题会决定是否需要再问一轮模型。
 */
export function validatePlan(plan: Plan, missedNames: string[]): PlanIssue[] {
  const issues: PlanIssue[] = [];

  for (const name of missedNames) {
    issues.push({
      level: 'error',
      day: 0,
      message: `「${name}」在地图上找不到，请换一个真实存在、名称更正式的地点`,
    });
  }

  plan.days.forEach((d, i) => {
    const dayNo = d.day || i + 1;

    if (d.pois.length < 2) {
      issues.push({
        level: 'warn',
        day: dayNo,
        message: `第 ${dayNo} 天只有 ${d.pois.length} 个地点，行程偏空`,
      });
    }

    let maxSpan = 0;
    let pair = '';
    for (let a = 0; a < d.pois.length; a += 1) {
      for (let b = a + 1; b < d.pois.length; b += 1) {
        const dist = haversine(
          [d.pois[a].lng, d.pois[a].lat],
          [d.pois[b].lng, d.pois[b].lat]
        );
        if (dist > maxSpan) {
          maxSpan = dist;
          pair = `${d.pois[a].name} 到 ${d.pois[b].name}`;
        }
      }
    }

    if (maxSpan > SPAN_ERROR_KM * 1000) {
      issues.push({
        level: 'error',
        day: dayNo,
        message: `第 ${dayNo} 天最远两点相距 ${Math.round(maxSpan / 1000)} 公里（${pair}），当天跑不完，请把这些地点拆到不同天或换成距离更近的`,
      });
    } else if (maxSpan > SPAN_WARN_KM * 1000) {
      issues.push({
        level: 'warn',
        day: dayNo,
        message: `第 ${dayNo} 天跨度 ${Math.round(maxSpan / 1000)} 公里（${pair}），路上耗时较多`,
      });
    }
  });

  return issues;
}

/** 组装给模型看的骨架 JSON（去掉坐标，避免它照抄） */
export function skeletonForPrompt(plan: Plan): string {
  return JSON.stringify(
    {
      title: plan.title,
      city: plan.city,
      summary: plan.summary,
      days: plan.days.map((d) => ({
        day: d.day,
        theme: d.theme,
        pois: d.pois.map((p) => ({
          name: p.name,
          type: p.type,
          time: p.time,
          duration: p.duration,
          cost: p.cost,
          desc: p.desc,
        })),
      })),
    },
    null,
    1
  );
}
