import { defineConfig } from 'tsdown'

/**
 * 服务端产物（M2/S3：compose 镜像前提）。entry = main.ts（统一组装入口）。
 * dependencies external（pi-coding-agent / fastify 等走 node_modules，bundle 只收仓库源码）。
 * arena-mod.cjs 是运行时附件（非 bundle），从 <cwd>/src/server/screeps/ 读——见 main.ts 头注释。
 */
export default defineConfig({
  entry: ['src/server/main.ts'],
  outDir: 'dist/server',
  format: 'esm',
  platform: 'node',
  target: 'node22',
})
