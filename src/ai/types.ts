/**
 * 领域类型定义
 *
 * 与 legacy 的行程数据结构保持完全兼容，方便逐层替换。
 */

/** 地点类型，与 legacy 的 CATEGORIES 一一对应 */
export type PoiType = 'sight' | 'food' | 'culture' | 'shopping';

/** 单个行程点位 */
export interface Poi {
  id: string;
  name: string;
  type: PoiType;
  time: string;
  address: string;
  duration: string;
  cost: number;
  desc: string;
  lat: number;
  lng: number;
}

/** 一天的行程 */
export interface DayPlan {
  day: number;
  theme: string;
  pois: Poi[];
}

/** 完整行程 */
export interface Plan {
  title: string;
  city: string;
  summary: string;
  center: { lat: number; lng: number };
  days: DayPlan[];
}

/** 地理编码返回的候选地点 */
export interface PlaceCandidate {
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** Photon 的 osm_value，用来区分城市/街区/门牌 */
  kind: string;
  /** 命中评分，越高越可信 */
  score: number;
  source: 'photon' | 'nominatim' | 'amap';
}

/** 一段路线的统计 */
export interface RouteLeg {
  /** 米 */
  distance: number;
  /** 秒 */
  duration: number;
}

/** 用户的规划条件 */
export interface PlanRequest {
  destination: string;
  days: number;
  startDate?: string;
  endDate?: string;
  prefs: PlanPrefs;
}

/** 九维偏好 */
export interface PlanPrefs {
  party: string;
  pace: string;
  budget: string;
  transport: string;
  perDay: number;
  hotel: string;
  interests: string[];
  must: string;
  avoid: string;
}

/** Agent 执行过程中的一步，用于 UI 实时展示思考链路 */
export interface AgentStep {
  phase: 'plan' | 'geocode' | 'check' | 'refine' | 'done';
  message: string;
  detail?: string;
  /** 0-100，用于进度条 */
  progress?: number;
  at: number;
}

/** Agent 产出的诊断结论 */
export interface PlanIssue {
  level: 'warn' | 'error';
  day: number;
  message: string;
}

export type StepListener = (step: AgentStep) => void;
