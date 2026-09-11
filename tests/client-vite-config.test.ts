/**
 * vite dev proxy 配置回归（M1 浏览器验收发现的 bug A）——
 * 前缀式的 '/api' 会把客户端源模块 /api.ts 也劫持给后端 → 白屏。
 * 必须用正则锚定 `^/api/`。build:client 不走 proxy，故只有本测试能守住这条。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('vite.config.ts（dev proxy）', () => {
  it('proxy 键必须是锚定正则，不得用裸前缀 /api（否则劫持 /api.ts 白屏）', () => {
    const src = readFileSync(path.join(root, 'vite.config.ts'), 'utf8')
    expect(src).toContain("'^/api/'")
    expect(src).toContain("'^/ws/'")
    // 裸前缀键（行首引号后直接 /api）不得再出现
    expect(src).not.toMatch(/['"]\/api['"]\s*:/)
    expect(src).not.toMatch(/['"]\/ws['"]\s*:/)
  })
})
