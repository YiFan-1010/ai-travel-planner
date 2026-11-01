/**
 * 应用入口
 *
 * 当前架构：v1 的全部实现仍集中在 legacy/app.js（约 5000 行，原生 JS），
 * 这里只负责挂载全局依赖与样式，随后加载 legacy。
 *
 * 后续迭代会把 legacy 按领域逐块迁出：
 *   src/ai/*     大模型客户端、工具层、Agent 循环（新写，严格 TS）
 *   src/map/*    地图、路线、图钉、卫星层
 *   src/data/*   地理编码、行程模型、持久化
 *   src/ui/*     渲染、弹窗、主题、导出
 */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';

import { tools } from './ai/tools';
import { generatePlan } from './ai/agent';

// legacy 内部直接使用全局 maplibregl，挂到 window 上即可零改动复用
(window as unknown as { maplibregl: typeof maplibregl }).maplibregl = maplibregl;

// AI 能力统一出口，legacy 通过 window.__AI__ 调用
(window as unknown as { __AI__: unknown }).__AI__ = { generatePlan, tools };

// 动态 import 保证上面的全局挂载先生效（静态 import 会被提升到赋值之前）
// @ts-expect-error legacy 是无类型的原始实现，随迁移逐步补类型
import('./legacy/app.js');
