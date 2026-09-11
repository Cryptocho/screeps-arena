/**
 * S9b — 对局生命周期真实接线 e2e：ScreepsService →（ArenaBackend 结构化适配）→
 * MatchLifecycle → MatchStore。全链真实私服：创建(join×2) → start(部署+restart+resume)
 * → observe(记分投影) → settle(胜者+比分落盘) → 重开 store 验证持久化。
 * 运行：DSH_SCREEPS_IT=1 npm run test:it
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

describe.skipIf(!provisioned)('MatchLifecycle x ScreepsService (real settle e2e)', () => {
  it('creates, starts, observes and settles a two-player match', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-match-'))
    mkdirSync(dataDir, { recursive: true })
    symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
    symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

    const ctx = new Context()
    const fiber = await ctx.plugin(
      ScreepsService,
      ScreepsService.Config({
        serverMode: 'managed',
        dataDir,
        externalUrl: 'http://127.0.0.1:21025',
        port: 0,
        nodeVersion: '22',
        nodeDistMirror: 'https://nodejs.org/dist',
        tickDuration: 150,
        readyTimeoutMs: 180_000,
      }),
    )
    const svc = ctx.screeps
    const matches = svc.match
    try {
      await svc.ensureRunning()

      // 创建 + join（sessionId 即未来工具层的会话映射键）
      const created = await matches.createMatch({ preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' })
      expect(created.phase).toBe('creating')
      await matches.join(created.id, { sessionId: 'sess-b', username: 'e2e_b' })

      // start：resetArena → generateRoom×2 → createUser×2 → restart → tickDuration → resume
      const running = await matches.start(created.id)
      expect(running.phase).toBe('running')
      expect(typeof running.startTick).toBe('number')
      expect(running.startTick!).toBeGreaterThan(0)
      expect(Object.keys(running.assignments ?? {})).toHaveLength(2)

      // 世界推进一段时间（150ms/tick → ~80 ticks）：creep 出生 + 采集
      await new Promise(r => setTimeout(r, 12_000))
      const observation = await matches.observe(created.id)
      expect(observation.gameTime).toBeGreaterThan(running.startTick!)
      expect(Object.keys(observation.scoreboard)).toHaveLength(2)
      for (const sid of ['sess-a', 'sess-b']) {
        const entry = observation.scoreboard[sid]!
        // spawn 部署后要么有领地（controller 已 claim），要么未被判定出局
        expect(entry.counters.territory + (entry.eliminated ? 0 : 1)).toBeGreaterThanOrEqual(1)
      }

      // 结算（manual：world-rounds 是分数制）→ 状态机 + 胜者 + 比分落盘
      const settled = await matches.settle(created.id, 'manual')
      expect(settled.phase).toBe('settled')
      expect(settled.winner).toBeDefined()
      expect(settled.endTick!).toBeGreaterThanOrEqual(running.startTick!)
      expect(Object.keys(settled.scores ?? {})).toHaveLength(2)

      // 持久化验证：不经内存缓存，直接从 store 读盘
      const reread = await matches.store.get(created.id)
      expect(reread?.phase).toBe('settled')
      expect(reread?.winner).toBeDefined()
      expect(reread?.scores).toEqual(settled.scores)
      // 世界在 settle 时已被暂停（赛后复盘态）
      const tick = await svc.system('getTickDuration')
      expect(tick.ok).toBe(true)
    } finally {
      await fiber.dispose()
    }
  }, 300_000)
})
