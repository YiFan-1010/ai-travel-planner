/**
 * 行程生成 Agent
 *
 * 区别于 v1 的一次性调用，这里是一条带反馈的流水线：
 *
 *   ① 规划   模型产出每天的主题和地点
 *   ② 落地   有地理编码服务时，把地名换成工具查到的真实坐标；
 *             没有时退回模型自带坐标，并用路线校验兜底
 *   ③ 体检   检查跨度、缺口、点位密度
 *   ④ 修正   把问题清单回喂给模型，让它只改有问题的部分
 *   ↓
 *   输出可上地图的行程
 *
 * 每一步都会通过 onStep 把状态推给 UI，用户能看到 AI 在干什么。
 */
import { chat, type LlmConfig } from './client';
import {
  PLAN_SYSTEM,
  PLAN_SYSTEM_WITH_COORDS,
  REFINE_SYSTEM,
  buildPlanPrompt,
  buildRefinePrompt,
} from './prompts';
import {
  assemblePlan,
  parseSkeleton,
  skeletonForPrompt,
  validatePlan,
  type Skeleton,
} from './schema';
import { geocodeAll, getGeoConfig } from './tools';
import type {
  AgentStep,
  PlaceCandidate,
  Plan,
  PlanIssue,
  PlanRequest,
  StepListener,
} from './types';

export interface GenerateOptions {
  request: PlanRequest;
  config: LlmConfig;
  onStep?: StepListener;
  signal?: AbortSignal;
}

export interface GenerateResult {
  plan: Plan;
  issues: PlanIssue[];
  stats: {
    geoHit: number;
    geoTotal: number;
    /** tool = 坐标来自地理编码；model = 坐标来自模型本身 */
    mode: 'tool' | 'model';
    elapsedMs: number;
  };
}

interface LocateOutcome {
  plan: Plan;
  missed: string[];
  hits: Map<string, PlaceCandidate>;
}

/**
 * 把骨架落地成带坐标的行程。
 * 有地理编码服务时，模型说了不算，一切以工具查到的为准。
 */
async function locate(
  skeleton: Skeleton,
  fallbackCity: string,
  emit: (s: Omit<AgentStep, 'at'>) => void
): Promise<LocateOutcome> {
  const names = skeleton.days.flatMap((d) => d.pois.map((p) => p.name));
  const total = names.length;
  let done = 0;

  emit({
    phase: 'geocode',
    message: '正在核对地点坐标',
    detail: `${total} 个地点待查询`,
    progress: 32,
  });

  const hits = await geocodeAll(
    names,
    skeleton.city || fallbackCity,
    (name, hit) => {
      done += 1;
      emit({
        phase: 'geocode',
        message: '正在核对地点坐标',
        detail: `${hit ? '✓' : '✗'} ${name}　${done}/${total}`,
        progress: 32 + Math.round((done / Math.max(1, total)) * 40),
      });
    },
    2
  );

  const missed = Array.from(new Set(names.filter((n) => !hits.has(n))));
  const plan = assemblePlan(skeleton, hits, fallbackCity);

  return { plan, missed, hits };
}

/**
 * 生成一份行程。
 * 任何一步失败都会抛出带中文说明的错误，交给 UI 直接展示。
 */
export async function generatePlan(opts: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();
  const { request, config, onStep, signal } = opts;
  const fallbackCity = request.destination;

  /* 只有配了高德 Key 才算「有地理编码能力」——
     Photon 在国内 DNS 被污染，不能作为依赖 */
  const geoReady = Boolean(getGeoConfig().amapKey);

  let lastPlanEmit = 0;
  const emit = (s: Omit<AgentStep, 'at'>): void => {
    if (s.phase === 'plan') {
      const now = Date.now();
      if (now - lastPlanEmit < 140) return;
      lastPlanEmit = now;
    }
    onStep?.({ ...s, at: Date.now() });
  };

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error('已取消');
  };

  /* ---------------- ① 规划 ---------------- */
  emit({
    phase: 'plan',
    message: 'AI 正在规划行程',
    detail: geoReady ? '先定主题和地点 坐标随后核对' : '先定主题和地点',
    progress: 4,
  });

  let written = 0;
  const firstMsg = await chat(config, {
    messages: [
      { role: 'system', content: geoReady ? PLAN_SYSTEM : PLAN_SYSTEM_WITH_COORDS },
      { role: 'user', content: buildPlanPrompt(request, !geoReady) },
    ],
    temperature: 0.8,
    maxTokens: Math.min(6000, 1200 + request.days * 700),
    signal,
    onDelta: (piece) => {
      written += piece.length;
      emit({
        phase: 'plan',
        message: 'AI 正在规划行程',
        detail: `已写 ${written} 字`,
        progress: Math.min(28, 4 + written / 90),
      });
    },
  });

  throwIfAborted();

  let skeleton = parseSkeleton(firstMsg.content, fallbackCity);
  const geoTotal = skeleton.days.reduce((n, d) => n + d.pois.length, 0);

  /* ---------------- ② 落地 ---------------- */
  let outcome: LocateOutcome;

  if (geoReady) {
    outcome = await locate(skeleton, fallbackCity, emit);
  } else {
    /* 降级：没有地理编码服务，直接用模型给的坐标 */
    emit({
      phase: 'geocode',
      message: '当前无地理编码服务',
      detail: '改用模型坐标 稍后会校验路线合理性',
      progress: 60,
    });
    const empty = new Map<string, PlaceCandidate>();
    outcome = {
      plan: assemblePlan(skeleton, empty, fallbackCity),
      missed: [],
      hits: empty,
    };
  }

  throwIfAborted();

  /* ---------------- ③ 体检 ---------------- */
  emit({ phase: 'check', message: '正在检查行程合理性', detail: '看跨度、看缺口', progress: 76 });
  let issues = validatePlan(outcome.plan, outcome.missed);
  const blocking = issues.filter((i) => i.level === 'error');

  /* ---------------- ④ 修正（最多一轮） ---------------- */
  if (blocking.length > 0) {
    emit({
      phase: 'refine',
      message: '发现行程问题 正在调整',
      detail: blocking[0].message,
      progress: 80,
    });

    try {
      const fixedMsg = await chat(config, {
        messages: [
          { role: 'system', content: REFINE_SYSTEM },
          {
            role: 'user',
            content: buildRefinePrompt(
              skeleton.city || fallbackCity,
              skeleton.days.length,
              skeletonForPrompt(outcome.plan),
              blocking.map((i) => i.message)
            ),
          },
        ],
        temperature: 0.45,
        maxTokens: Math.min(6000, 1200 + request.days * 700),
        signal,
      });

      throwIfAborted();

      const fixedSkeleton = parseSkeleton(fixedMsg.content, fallbackCity);
      const retry: LocateOutcome = geoReady
        ? await locate(fixedSkeleton, fallbackCity, emit)
        : {
            plan: assemblePlan(fixedSkeleton, new Map(), fallbackCity),
            missed: [],
            hits: outcome.hits,
          };

      /* 修正版更好才采纳：定位到（或带坐标）的地点不能变少 */
      const before = outcome.plan.days.reduce((n, d) => n + d.pois.length, 0);
      const after = retry.plan.days.reduce((n, d) => n + d.pois.length, 0);

      if (after >= before) {
        skeleton = fixedSkeleton;
        outcome = retry;
        issues = validatePlan(outcome.plan, outcome.missed);
      } else {
        issues = [
          ...issues,
          {
            level: 'warn',
            day: 0,
            message: '调整后的方案可用地点更少，已保留原方案',
          },
        ];
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues = [...issues, { level: 'warn', day: 0, message: `自动修正未生效：${msg}` }];
    }
  }

  const plan = outcome.plan;
  const located = plan.days.reduce((n, d) => n + d.pois.length, 0);

  /* 真正由工具定位到的点才算数：配了 Key 但全部失败时仍应显示「模型坐标」 */
  const toolHits = outcome.hits.size;
  const usedTool = toolHits > 0;
  const coordLabel = usedTool
    ? toolHits === located
      ? `工具定位 ${toolHits}`
      : `工具定位 ${toolHits} · 模型补齐 ${located - toolHits}`
    : '模型坐标';

  emit({
    phase: 'done',
    message: '行程已生成',
    detail: `${plan.days.length} 天 · ${located} 个地点 · ${coordLabel}`,
    progress: 100,
  });

  return {
    plan,
    issues,
    stats: {
      geoHit: toolHits,
      geoTotal,
      mode: usedTool ? 'tool' : 'model',
      elapsedMs: Date.now() - started,
    },
  };
}
