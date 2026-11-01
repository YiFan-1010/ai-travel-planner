/**
 * Agent 提示词
 *
 * 与 v1 最大的区别：不再要求模型输出经纬度。
 * 模型负责「选什么地点、怎么排、为什么」，坐标由工具查真实值。
 */
import type { PlanPrefs, PlanRequest } from './types';

export const PLAN_SYSTEM = [
  '你是专业中文旅行规划师。根据用户需求生成可落地的多日行程。',
  '',
  '【重要】你不需要提供经纬度。系统会为每个地点查询真实坐标，',
  '你只需要给出在地图上能准确搜到的正式地点名称。',
  '',
  '只返回一个 JSON 对象，不要解释文字，不要 Markdown 代码块。结构：',
  '{',
  '  "title": "行程总标题（含城市与天数）",',
  '  "city": "城市名",',
  '  "summary": "一句话行程亮点",',
  '  "days": [',
  '    {',
  '      "day": 1,',
  '      "theme": "当天主题",',
  '      "pois": [',
  '        {',
  '          "name": "地点正式名称",',
  '          "type": "sight|food|culture|shopping",',
  '          "time": "09:00",',
  '          "duration": "约2小时",',
  '          "cost": 50,',
  '          "desc": "一句话亮点，不超过20字"',
  '        }',
  '      ]',
  '    }',
  '  ]',
  '}',
  '',
  '要求：',
  '1) **name 必须是真实存在、可被地图检索到的正式名称**。',
  '   好的例子：「成都大熊猫繁育研究基地」「宽窄巷子」「小龙坎火锅春熙路店」',
  '   禁止出现的写法：「当地特色小吃街」「某网红餐厅」「市区某公园」「XX火锅店」',
  '2) type 取值：sight=景点/自然风光，food=美食，culture=文化/历史，shopping=购物/夜生活。',
  '3) 每天地点数量按用户要求（未指定则 5 个），time 必须按时间升序。',
  '4) cost 为单人预估花费（元，整数），免费填 0。',
  '5) 同一天的地点要在地理上靠拢，不要出现上午城东、下午城西的奔波安排。',
  '6) 优先满足用户兴趣、必去/必吃与同行人特点。',
  '7) 用户明确「不想要」的项目一律不要安排。',
].join('\n');

/** 修正轮的系统提示：只改问题部分 */
export const REFINE_SYSTEM = [
  '你是行程校对员。用户会给你一份行程和一份问题清单。',
  '只修正问题清单里指出的部分，其余原样保留。',
  '严格返回与输入相同的 JSON 结构，不要解释，不要 Markdown 代码块。',
  '',
  '再次强调：**不要输出经纬度**，只给真实存在、地图可检索的正式地点名称。',
].join('\n');

/**
 * 降级模式：没有可用的地理编码服务时，只能让模型直接给坐标。
 *
 * 触发条件：未配置高德 Key，且 Photon 已熔断（国内 DNS 被污染）。
 * 这条路径下坐标精度依赖模型，所以后端必须再用 OSRM 校验一次。
 */
export const PLAN_SYSTEM_WITH_COORDS = [
  '你是专业中文旅行规划师。根据用户需求生成可落地的多日行程。',
  '',
  '只返回一个 JSON 对象，不要解释文字，不要 Markdown 代码块。结构：',
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
  '          "name": "地点正式名称",',
  '          "type": "sight|food|culture|shopping",',
  '          "time": "09:00",',
  '          "duration": "约2小时",',
  '          "cost": 50,',
  '          "desc": "一句话亮点，不超过20字",',
  '          "lat": 30.6442,',
  '          "lng": 104.0439',
  '        }',
  '      ]',
  '    }',
  '  ]',
  '}',
  '',
  '要求：',
  '1) name 必须是真实存在、可被地图检索到的正式名称，',
  '   禁止「当地特色小吃街」「某网红餐厅」这类模糊写法。',
  '2) lat/lng 必须是 WGS-84（GPS 原始坐标），保留 6 位小数，',
  '   严禁使用 GCJ-02 或 BD-09 偏移坐标。',
  '3) 每天地点数量按用户要求（未指定则 5 个），time 必须按时间升序。',
  '4) cost 为单人预估花费（元，整数），免费填 0。',
  '5) 同一天的地点要在地理上靠拢，不要出现上午城东、下午城西的奔波安排。',
  '6) center 为该城市中心的 WGS-84 坐标。',
  '7) 优先满足用户兴趣、必去/必吃与同行人特点；「不想要」的项目一律不排。',
].join('\n');

/** 可对比的方案风格。key 与 UI 上的按钮一一对应 */
export const STYLE_HINTS: Record<string, { label: string; hint: string }> = {
  budget: {
    label: '穷游',
    hint:
      '【风格：穷游】预算优先。多安排免费景点、公园、老街、大学校园；' +
      '餐厅选本地平价小馆（人均 30 元内）；交通以步行和公交为主，不安排高消费项目。',
  },
  comfort: {
    label: '舒适',
    hint:
      '【风格：舒适】体验优先。每天地点精简到 3-4 个，留足休息时间；' +
      '餐厅选口碑好、环境舒适的（人均 80-150）；可安排下午茶、温泉或按摩这类放松项目。',
  },
  family: {
    label: '带娃',
    hint:
      '【风格：带娃】亲子优先。每天不超过 3 个地点，节奏慢；' +
      '优先科技馆、动物园、乐园、水族馆这类有互动的场所；避免长时间步行、爬山和夜间活动。',
  },
  culture: {
    label: '文艺',
    hint:
      '【风格：文艺】文化优先。以博物馆、美术馆、老建筑、独立书店、咖啡馆为主；' +
      '避开人挤人的网红打卡点；节奏舒缓，留时间慢慢逛。',
  },
};

function prefsBlock(p: PlanPrefs): string {
  const lines: string[] = [];
  if (p.party) lines.push(`- 同行：${p.party}`);
  if (p.pace) lines.push(`- 节奏：${p.pace}`);
  if (p.budget) lines.push(`- 预算：${p.budget}`);
  if (p.transport) lines.push(`- 交通：${p.transport}`);
  if (p.perDay > 0) lines.push(`- 每天地点数：${p.perDay}`);
  if (p.hotel) lines.push(`- 住宿偏好：${p.hotel}`);
  if (p.interests && p.interests.length) lines.push(`- 兴趣：${p.interests.join('、')}`);
  if (p.must) lines.push(`- 必去/必吃：${p.must}`);
  if (p.avoid) lines.push(`- 不想要：${p.avoid}`);
  return lines.length ? '用户偏好：\n' + lines.join('\n') : '用户未填写偏好，按通用节奏安排。';
}

/** 首轮：生成行程骨架 */
export function buildPlanPrompt(
  req: PlanRequest,
  needCoords: boolean,
  style?: string
): string {
  const datePart =
    req.startDate && req.endDate ? `（${req.startDate} 至 ${req.endDate}）` : '';
  const tail = needCoords
    ? '请务必给出每个地点的 WGS-84 经纬度。'
    : '记住：只写地点名称，不要写坐标。';

  const styleHint = style && STYLE_HINTS[style] ? STYLE_HINTS[style].hint : '';

  return [
    `请为「${req.destination}」规划 ${req.days} 天行程${datePart}。`,
    '',
    prefsBlock(req.prefs),
    ...(styleHint ? ['', styleHint] : []),
    '',
    tail,
  ].join('\n');
}

/** 修正轮：把问题清单喂回去 */
export function buildRefinePrompt(
  destination: string,
  days: number,
  skeletonJson: string,
  issues: string[]
): string {
  return [
    `目的地「${destination}」，共 ${days} 天。`,
    '',
    '当前行程：',
    skeletonJson,
    '',
    '问题清单：',
    issues.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    '',
    '请修正以上问题，返回完整行程 JSON（结构不变，未涉及的天保持原样）。',
  ].join('\n');
}
