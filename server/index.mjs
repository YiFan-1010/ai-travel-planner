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

/* 部署包用 web/ 装产物（避免被托管平台当成构建产物排除），本地开发用 dist/ */
function pickWebRoot() {
  for (const name of ['web', 'dist']) {
    const p = path.join(rootDir, name);
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return path.join(rootDir, 'dist');
}

const webRoot = pickWebRoot();
const handler = createHandler({ root: webRoot, env });

if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
  console.warn('[warn] 未找到静态产物，先执行 npm run build');
}

const server = http.createServer(handler);

/* 显式绑 0.0.0.0：容器/托管平台都通过反代访问，绑 127.0.0.1 会连不上 */
server.listen(port, '0.0.0.0', () => {
  const has = (k) => (env[k] ? '已配置' : '缺失');
  console.log(`服务已启动  http://0.0.0.0:${port}`);
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
