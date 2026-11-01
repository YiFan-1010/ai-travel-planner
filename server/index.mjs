#!/usr/bin/env node
/**
 * 线上入口：静态托管 dist + API 代理。
 *
 * 本地跑：npm run serve
 * 云端跑：容器里 node server/index.mjs
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler, loadEnv } from './app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');

/* .env 优先读项目根目录，其次读系统环境变量（云上直接用环境变量） */
const fileEnv = loadEnv(path.join(rootDir, '.env'));
const env = { ...fileEnv, ...process.env };

const port = Number(env.PORT) || 8080;
const handler = createHandler({ root: path.join(rootDir, 'dist'), env });

const dist = path.join(rootDir, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.warn('[warn] 未找到 dist/index.html，先执行 npm run build');
}

const server = http.createServer(handler);

server.listen(port, () => {
  const has = (k) => (env[k] ? '已配置' : '缺失');
  console.log(`服务已启动  http://127.0.0.1:${port}`);
  console.log(`  DEEPSEEK_API_KEY  ${has('DEEPSEEK_API_KEY')}`);
  console.log(`  AMAP_KEY          ${has('AMAP_KEY')}`);
  if (!env.DEEPSEEK_API_KEY && !env.AMAP_KEY) {
    console.log('  提示：两项都没配时，前端会要求用户自己填 Key（纯静态模式）');
  }
});

/* 云上会给 SIGTERM，收到后停止接新连接 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
