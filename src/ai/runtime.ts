/**
 * 运行时能力探测
 *
 * 应用有两种运行形态：
 *   ① 有服务端（线上部署 / npm run serve）→ 代理可用，用户免填 Key
 *   ② 纯静态（file:// 或没有 API 的静态托管）→ 必须用户自带 Key
 *
 * 启动时探一次 /api/health 就能区分，之后全局读缓存。
 */

export interface RuntimeInfo {
  /** 服务端持有大模型 Key，可代发请求 */
  proxy: boolean;
  /** 服务端持有高德 Key，可代查坐标 */
  geo: boolean;
  /** 服务端默认模型 */
  model: string;
  /** 单 IP 每小时对话次数上限，用于提示文案 */
  chatPerHour: number;
  /** 是否已经探测过 */
  checked: boolean;
}

let info: RuntimeInfo = {
  proxy: false,
  geo: false,
  model: 'deepseek-chat',
  chatPerHour: 0,
  checked: false,
};

/** 当前运行时能力 */
export function runtime(): RuntimeInfo {
  return info;
}

/** 是否走服务端代理发对话 */
export function useLlmProxy(): boolean {
  return info.proxy;
}

/** 是否走服务端代理查坐标 */
export function useGeoProxy(): boolean {
  return info.geo;
}

export function setRuntime(patch: Partial<RuntimeInfo>): void {
  info = { ...info, ...patch, checked: true };
}

/**
 * 探测服务端能力。
 * 超时 2.5 秒就放弃——静态托管上这个请求必然失败，
 * 不能让用户干等。
 */
export async function detectRuntime(): Promise<RuntimeInfo> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('/api/health', {
      cache: 'no-store',
      signal: ctrl.signal,
      /* 必须带同源 cookie：托管平台靠它鉴权，omit 会拿到 403 */
      credentials: 'same-origin',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('no proxy');
    const j = (await res.json()) as {
      proxy?: boolean;
      geo?: boolean;
      model?: string;
      limits?: { chatPerHour?: number };
    };
    setRuntime({
      proxy: j.proxy === true,
      geo: j.geo === true,
      model: typeof j.model === 'string' && j.model ? j.model : 'deepseek-chat',
      chatPerHour: j.limits?.chatPerHour ?? 0,
    });
  } catch {
    setRuntime({ proxy: false, geo: false });
  }
  return info;
}
