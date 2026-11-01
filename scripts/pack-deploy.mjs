#!/usr/bin/env node
/**
 * 生成部署包。
 *
 * Cloud Run 的源码构建会把整个目录打上去，而 node_modules 有 100MB+。
 * 这里只装运行必需的东西（dist + server），体积压到 1.5MB 左右，
 * 云端也不用再跑 npm install 和 vite build。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, 'deploy');

/* 逐项删除：某些环境里 fs.rmSync 会被回收站钩子接管并失败 */
function rm(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) rm(path.join(target, name));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/* 1. 必须有构建产物 */
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('未找到 dist/index.html，先执行 npm run build');
  process.exit(1);
}

/* 2. 组装。产物目录叫 web 而不是 dist ——
      托管平台常把 dist 当成构建产物排除掉，改名才不会被跳过 */
rm(out);
copyDir(dist, path.join(out, 'web'));
copyDir(path.join(root, 'server'), path.join(out, 'server'));

fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'ai-travel-planner',
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'AI 旅行路线规划器 · 运行时',
      scripts: { start: 'node server/index.mjs' },
      engines: { node: '>=18' },
    },
    null,
    2
  ) + '\n'
);

fs.writeFileSync(
  path.join(out, 'Dockerfile'),
  `# 运行镜像：产物已在本地构建好，云端不再装依赖
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY web ./web
COPY server ./server
COPY package.json ./

EXPOSE 8080
CMD ["node", "server/index.mjs"]
`
);

fs.writeFileSync(
  path.join(out, '.dockerignore'),
  'node_modules\n*.log\n'
);

/* 4. 带上 .env（如果存在）：托管平台只注入 PORT，其余变量只能随包走。
      deploy/ 已在 .gitignore 里，不会进仓库。 */
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  const lines = fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    /* PORT 由平台注入，写死会冲突 */
    .filter((l) => !/^\s*PORT\s*=/.test(l));
  fs.writeFileSync(path.join(out, '.env'), lines.join('\n') + '\n');
  console.log('  已附带 .env（剔除 PORT）');
}

/* 3. 统计 */
let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      files += 1;
      bytes += fs.statSync(p).size;
    }
  }
})(out);

console.log(`部署包已生成  deploy/  ${files} 个文件  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
