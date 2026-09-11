import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // 必须用正则锚定 `^/api/`：前缀式的 '/api' 会把客户端源模块 /api.ts 也劫持给
      // 后端（404 → 白屏）。dev 运行时不被 build 覆盖，此坑只在浏览器里可见。
      '^/api/': 'http://127.0.0.1:8787',
      '^/ws/': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { outDir: '../../dist/client', emptyOutDir: true },
})
