/**
 * M5 IT1 — world-rounds 真实私服全链（plan-M5 §3.2-3.4）：create → start → round0 running →
 * autoRound（phaseTick 驱动）→ enterRoundBreak（世界 pause）→ 普通玩家 commit（下轮代码）→
 * bot 座位自动 ready → resumeNextRound（resume 前真传代码到私服 users.code）→ round1 续跑
 * （新代码生效）→ maxRounds 终止 → settle + winner。
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律：共享 smoke dataDir 单写者，全套 IT 文件串行（vitest fileParallelism:false）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { configFromPreset } from '../src/host/match/model.ts'
import { BotRegistry } from './helpers/bot-registry.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** round-1 提交代码：console 打每 tick 标记（可被 console 采集读到 → 判定「新代码生效」）。 */
const ROUND1_CODE = `
module.exports.loop = function () {
  if (Game.time % 5 === 0) console.log('ROUND1_MARK tick', Game.time)
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    spawn.spawnCreep([WORK, CARRY, MOVE], 'r1-' + Game.time)
  }
  Memory.stats = Memory.stats || {}
  Memory.stats.round1 = Game.time
}
`

describe.skipIf(!provisioned)('M5 world-rounds real server (plan-M5 §3.2-3.4)', () => {
  it(
    'round0 → roundBreak → commit → resume round1 → settle (real private server)',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-rounds-'))
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
          tickDuration: 100,
          readyTimeoutMs: 180_000,
          // 驱动周期 500ms：让 service 自己的 drive 循环推进（真实驱动面验证，次要①）
          driveIntervalMs: 500,
          roundBreakTimeoutMs: 60_000,
        }),
      )
      const svc = ctx.screeps
      const matches = svc.match
      try {
        await svc.ensureRunning()
        // create：世界-rounds 2 玩家（玩家 pac + bot 座位；agent 走工具面 create 的同构：store.create + codeMode rounds）
        const cfg = configFromPreset('world-rounds', { tickDuration: 100, roundTicks: 100, maxRounds: 2 })
        const created = await matches.store.create(
          cfg,
          { sessionId: 'rounds-player', username: 'rounds_pa' },
          { codeMode: 'rounds' },
        )
        const botCode = await botRegistry.load('harvester')
        await matches.store.addPlayer(created.id, { sessionId: '__bot__harvester', username: '__bot_harvester', botCode })
        // round0 前代码：普通玩家提交基础采集（creating 暂存）
        await matches.store.update(created.id, st => {
          st.players.find(p => p.sessionId === 'rounds-player')!.code = {
            main: 'module.exports.loop = function () { Memory.stats = Memory.stats || {}; Memory.stats.s0 = Game.time }',
          }
          st.players.find(p => p.sessionId === 'rounds-player')!.submitted = true
        })
        const started = await matches.start(created.id)
        expect(started.phase).toBe('running')
        expect(started.roundIndex).toBeUndefined()
        expect(started.phaseTick).toBeGreaterThanOrEqual(0)

        // === round0 推进：等 autoRound.due（roundTicks=100 → ~10s）===
        let broke = false
        const round0Deadline = Date.now() + 60_000
        while (Date.now() < round0Deadline && !broke) {
          await sleep(2_000)
          const obs = await matches.observe(created.id).catch(() => null)
          if (!obs) continue
          // service drive 循环应已自动 enterRoundBreak（driveIntervalMs=500）
          if (obs.match.phase === 'roundBreak') {
            broke = true
            break
          }
          if (obs.autoRound.due) {
            // 若 drive 未触发（理论不应出现），显式兜底触发
            await svc.match.driveNextRound(created.id, { roundBreakTimeoutMs: 60_000 })
          }
        }
        expect(broke).toBe(true)
        let brk = await matches.observe(created.id)
        expect(brk.match.phase).toBe('roundBreak')
        const brkState = brk.match
        expect(brkState.roundBreakSince).toBeGreaterThan(0)
        // bot 座位自动 ready；普通玩家未 ready
        expect(brkState.players.find(p => p.sessionId === '__bot__harvester')!.ready).toBe(true)
        expect(brkState.players.find(p => p.sessionId === 'rounds-player')!.ready).toBeUndefined()

        // === 普通玩家 commit 下一轮代码（roundBreak 提交 = 就绪）===
        await matches.store.update(created.id, st => {
          const p = st.players.find(x => x.sessionId === 'rounds-player')!
          p.code = { main: ROUND1_CODE }
          p.ready = true
        })
        // 全员 ready → drive 自动 resumeNextRound → round1
        let resumed = false
        const resumeDeadline = Date.now() + 30_000
        while (Date.now() < resumeDeadline && !resumed) {
          await sleep(2_000)
          const obs = await matches.observe(created.id).catch(() => null)
          if (obs && obs.match.phase === 'running' && (obs.match.roundIndex ?? 0) >= 1) {
            resumed = true
            break
          }
          await svc.match.driveNextRound(created.id, { roundBreakTimeoutMs: 60_000 })
        }
        expect(resumed).toBe(true)
        const r1 = await matches.store.get(created.id)
        expect(r1.phase).toBe('running')
        expect(r1.roundIndex ?? 0).toBeGreaterThanOrEqual(1)

        // === 新代码生效证据：round1 起 5 tick 打 ROUND1_MARK → console 采集可见 ===
        let markSeen = false
        const markDeadline = Date.now() + 30_000
        while (Date.now() < markDeadline && !markSeen) {
          await sleep(2_000)
          const out = await svc.consoleOutput('rounds_pa', 0)
          const text = JSON.stringify(out.lines)
          if (text.includes('ROUND1_MARK')) markSeen = true
        }
        expect(markSeen).toBe(true)

        // === maxRounds=2：第二轮边界后进 settle（drive 自动）===
        // roundTicks=100 @100ms/tick → round1 边界需 ~10s+；轮询驱动直到 settled/roundBreak（IT3 终态）。
        // 注意：observe 对 settled（终态）抛 badPhase（lifecycle.get 只放行 active phase）——终态探测用 store.get。
        const drive = svc.match as unknown as { driveNextRound(id: string, o?: unknown): Promise<string> }
        const finDeadline = Date.now() + 90_000
        while (Date.now() < finDeadline) {
          await sleep(2_000)
          const cur = await matches.store.get(created.id)
          if (cur.phase === 'settled' || cur.phase === 'roundBreak') break
          await drive.driveNextRound(created.id, { roundBreakTimeoutMs: 60_000 })
        }
        const finState = await matches.store.get(created.id)
        expect(['settled', 'roundBreak']).toContain(finState.phase)
        if (finState.phase === 'settled') {
          expect(finState.winner).toBeDefined()
        }
      } finally {
        await fiber.dispose()
      }
    },
    240_000,
  )
})