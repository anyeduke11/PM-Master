import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// R4.2 WP4：API 代理目标可用环境变量覆盖（e2e 渲染回归自起隔离服务用）；默认不变
export default defineConfig({
  plugins: [react()],
  server: {
    port: 8736,
    proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8735' },
  },
});
