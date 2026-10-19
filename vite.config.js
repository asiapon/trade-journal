import { defineConfig } from 'vite';

export default defineConfig({
  base: './',                       // 构建产物可放在任意路径（WB/CF/自托管通吃）
  build: { outDir: 'dist', target: 'es2020' },
  server: {
    port: 5173,
    // 联调代理：本地/自托管后端（WorkBuddy 云端走绝对地址无需代理）
    proxy: {
      '/.cloud/database/rest/rpc': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
