import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径产物，可以直接丢到任意静态托管（Vercel / Cloudflare Pages / 对象存储）
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
    open: false
  },
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
});
