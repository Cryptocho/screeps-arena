/**
 * test:smoke lane 配置——只跑真实 LLM 冒烟 IT（默认 config 把它 exclude 掉）。
 * 为什么独立文件：vitest CLI 的 --exclude 是追加语义，无法撤销主 config 的 exclude。
 */
import base from './vitest.config.js'

export default {
  ...base,
  test: {
    ...base.test,
    include: ['tests/llm-smoke.it.test.ts'],
    exclude: ['**/node_modules/**', '**/reference/**'],
  },
}
