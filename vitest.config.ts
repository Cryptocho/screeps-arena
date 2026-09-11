import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * TS（NodeNext/ESM）相对导入按规范写 `.js` 后缀；vite 不原生把 `.js` 解析回 `.ts`，
 * 这里补一个解析插件（若 vite 未来原生支持则本插件静默无操作）。
 */
const tsJsExtension: Plugin = {
  name: 'ts-js-extension',
  async resolveId(source, importer, options) {
    if (source.endsWith('.js') && importer?.endsWith('.ts')) {
      return await this.resolve(`${source.slice(0, -3)}.ts`, importer, { ...options, skipSelf: true })
    }
    return null
  },
}

export default defineConfig({
  plugins: [tsJsExtension],
  test: {
    // 白名单式 include：绝不允许默认 glob 扫到 reference/（旧仓库 100+ 测试文件，依赖不可用）
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // live/smoke 独立 lane：默认 npm test 不跑（真实私服安装 ≈6 分钟 + 需 OPENROUTER_API_KEY）
    exclude: ['**/node_modules/**', '**/reference/**', 'tests/*.live.it.test.ts', 'tests/*.smoke.it.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
