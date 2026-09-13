/**
 * 锦标赛公平红线负向断言（plan-M4 验收判据 4，可执行化）：
 * ① 编排层 import 面不含 src/agent/*（调度器不得接触工具构造面）；
 * ② buildSeatTools 调用点数量不变（防编排层绕道注册工具）；
 * ③ 初始 prompt 文案只含本局语义，不含跨局信息（积分/榜/对手战绩字样）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initialPromptText } from '../src/server/tournament/scheduler.js'

const root = join(fileURLToPath(import.meta.url), '..', '..')

function listTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listTs(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('锦标赛公平红线（验收判据 4）', () => {
  it('tournament 模块 import 面不含 src/agent/*', () => {
    for (const file of listTs(join(root, 'src', 'server', 'tournament'))) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} 不得 import agent 面`).not.toMatch(/from\s+['"].*\/agent\//)
      expect(src, `${file} 不得 import tools 构造`).not.toMatch(/buildSeatTools|AgentRunner/)
    }
  })

  it('buildSeatTools 全仓调用点数量不变（main.ts 1 处 + 测试/装置）', () => {
    const mainSrc = readFileSync(join(root, 'src', 'server', 'main.ts'), 'utf8')
    expect(mainSrc.match(/buildSeatTools\(/g)?.length).toBe(1)
    // dev-services / 装置侧不新增
    for (const file of listTs(join(root, 'src', 'server', 'http'))) {
      expect(readFileSync(file, 'utf8'), `${file} 不得注册工具`).not.toMatch(/buildSeatTools/)
    }
  })

  it('初始 prompt 文案不含跨局信息', () => {
    const text = initialPromptText('m123')
    expect(text).toContain('submit_code')
    expect(text).toContain('m123')
    for (const banned of ['standing', '积分', 'rank', 'score', 'tournament table', 'record', '战绩', 'leaderboard']) {
      expect(text.toLowerCase()).not.toContain(banned)
    }
  })
})
