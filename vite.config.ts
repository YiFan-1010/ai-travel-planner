import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createHandler, loadEnv } from './server/app.mjs';

/**
 * 开发期就把 /api 代理接起来，和线上走同一份 handler。
 * 这样「免 Key 模式」在本地就能完整验证，不用等部署完才发现问题。
 */
export default defineConfig(() => {
  const fileEnv = loadEnv(fileURLToPath(new URL('./.env', import.meta.url)));
  const env = { ...fileEnv, ...process.env };

  return {
    // 相对路径产物，可以直接丢到任意静态托管（Vercel / Cloudflare Pages / 对象存储）
    base: './',
    server: {
      port: 5173,
      host: '127.0.0.1',
      open: false
    },
    plugins: [
      {
        name: 'local-api-proxy',
        configureServer(server) {
          const handler = createHandler({ apiOnly: true, env, root: 'dist' });
          server.middlewares.use((req, res, next) => {
            const url = req.url || '';
            if (!url.startsWith('/api/')) return next();
            handler(req, res);
          });
        }
      }
    ],
    build: {
      outDir: 'dist',
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          // MapLibre 单独拆包，首屏可以并行下载
          manualChunks: {
            maplibre: ['maplibre-gl']
          }
        }
      }
    }
  };
});
