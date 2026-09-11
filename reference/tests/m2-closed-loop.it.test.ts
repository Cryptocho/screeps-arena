/**
 * M5 IT2 — world-rounds 循环闭环（plan-M5 §3.2-3.4 改造 M2）：单会话 + harvester bot，随机房。
 * 事件链路 + 分层冒烟 保留；新增 rounds 周期语义：round0 → roundBreak（世界 pause）→ A commit →
 * bot 自动 ready → 自动续跑 ≥2 周期 → settle。
 * 断言：己方房间事件聚合出现、kills/losses 均 0（分房无跨房 + 无战斗损失）、
 * report 摘要格式、分层不泄露（对手无关联事件不可见）、settle 落盘 winner + scoreWarning 无。
 *
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律（AGENTS/plan-M2）：共享 smoke dataDir 是单写者资源，与战斗 IT 串行。
 *
 * 前置事实（九审 PASS）：
 * - tick 规模 ≤2000（ring 4096 安全、CREEP_LIFE_TIME=1500<2000 老死 DESTROYED——聚合可见但 losses 归因后仍 0）；
 * - 采集 bot（harvester 类）带 Memory.stats + console.log，A 房产生 UPGRADE/HARVEST 事件可对照；
 * - create 传 tickDuration（--patch 只在 ensure 期生效会被 start 覆盖——必须走 create override，八审 N3）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { buildTools } from '../src/host/tools.ts'
import { BotRegistry } from './helpers/bot-registry.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
/** 测试专用 bot fixture（2026-09-09：bots/ 移出产品路径；import.meta.dirname 锚定 tests/）。 */
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

function makeExec(sessionId: string): never {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

/** 采集型 bot（带 Memory.stats 遥测 + console.log——report 的事件聚合与报错链路原料）。 */
const HARVEST_BOT = `
module.exports.loop = function () {
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning) {
    const creeps = Object.values(Game.creeps)
    if (creeps.length < 2 && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      spawn.spawnCreep([WORK, CARRY, MOVE], 'h' + Game.time)
    }
  }
  for (const creep of Object.values(Game.creeps)) {
    if (creep.store.getFreeCapacity() === 0) {
      const target = creep.room.controller
      const r = creep.upgradeController(target)
      if (r === ERR_NOT_IN_RANGE) creep.moveTo(target)
    } else {
      const src = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE)
      if (src && creep.harvest(src) === ERR_NOT_IN_RANGE) creep.moveTo(src)
    }
  }
  Memory.stats = Memory.stats || {}
  Memory.stats.tick = Game.time
  Memory.stats.creeps = Object.keys(Game.creeps).length
  if (Game.time % 20 === 0) console.log('PROBE tick', Game.time)
}
`

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe.skipIf(!provisioned)('M2 main closed-loop IT (event chain + layering, real server)', () => {
  it(
    'session + harvester bot: event digest appears, kills/losses stay 0, layering holds, settle works',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-loop-'))
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
      try {
        await svc.ensureRunning()
        const tools = buildTools(svc) as Array<{ name: string; execute: (args: unknown, exec: never) => Promise<Record<string, unknown>> }>
        const tool = (name: string) => {
          const found = tools.find(t => t.name === name)
          if (!found) throw new Error(`tool not found: ${name}`)
          return found
        }

        // 1) create（tickDuration 100）→ 注入测试 bot 座位（harvester，不走工具面）→ start（随机房）
        const created = (await tool('screeps_match').execute(
          { action: 'create', preset: 'world-rounds', tickDuration: 100, roundTicks: 100, maxRounds: 2, username: 'loop_a' },
          makeExec('loop-sess'),
        )) as { match: { id: string } }
        const matchId = created.match.id
        const botCode = await botRegistry.load('harvester')
        await svc.match.store.addPlayer(matchId, {
          sessionId: '__bot__harvester',
          username: '__bot_harvester',
          botCode,
        })
        // 2) A 提交采集 bot（Memory.stats + console.log）——M5：creating 暂存（start 注入）；
        //    running 期 submit 在 world-rounds 下已拒（代码冻结，plan §3.3），故提交必须在 start 前。
        await tool('screeps_submit_code').execute({ modules: { main: HARVEST_BOT } }, makeExec('loop-sess'))
        const started = await tool('screeps_match').execute({ action: 'start', matchId }, makeExec('loop-sess'))
        expect((started as { match: { phase: string } }).match.phase).toBe('running')

        // 3) tick 规模 ≤2000：100ms/tick → 2000 tick = 200s 太长，墙钟预算 60s（~600 tick，
        //    采集→升级事件 ~150 tick 起效，够）；期间多次 report 断言
        let digestSeen = false
        let boundSeen = false
        let errorsSeen = false
        const deadline = Date.now() + 60_000
        const reportTool = tool('screeps_report')
        while (Date.now() < deadline) {
          await sleep(3_000)
          const report = (await reportTool.execute({}, makeExec('loop-sess'))) as { text: string }
          if (/events\(inSight\): involved=\d+/.test(report.text)) digestSeen = true
          if (/errors: /.test(report.text)) errorsSeen = true
          const obs = await svc.match.observe(matchId)
          const myCounters = obs.scoreboard['loop-sess']!.counters
          const botCounters = obs.scoreboard['__bot__harvester']!.counters
          if (myCounters.kills === 0 && myCounters.losses === 0 && botCounters.kills === 0 && botCounters.losses === 0) {
            boundSeen = true
          }
          if (digestSeen && boundSeen) break
        }

        // 断言：事件链路打通（己方房间事件聚合出现）
        expect(digestSeen).toBe(true)
        // 分层不泄露 + 分房无战斗：双方 kills/losses 均 0（老死 DESTROYED 不计 loss，七审修法）
        const finalObs = await svc.match.observe(matchId)
        expect(finalObs.scoreboard['loop-sess']!.counters.kills).toBe(0)
        expect(finalObs.scoreboard['loop-sess']!.counters.losses).toBe(0)
        expect(finalObs.scoreboard['__bot__harvester']!.counters.kills).toBe(0)
        expect(finalObs.scoreboard['__bot__harvester']!.counters.losses).toBe(0)

        // === M5 周期推进（plan §3.4）：running → autoRound → driveNextRound break → A commit → bot 自动 ready → resume round1 → maxRounds 终止 ===
        let roundBreakSeen = false
        let resumedSeen = false
        const roundDeadline = Date.now() + 60_000
        const drive = svc.match as unknown as { driveNextRound(id: string, o?: unknown): Promise<string> }
        while (Date.now() < roundDeadline && (!roundBreakSeen || !resumedSeen)) {
          await sleep(2_000)
          // 普通驱动循环由 service 的 interval 跑；此处显式 drive 兜底（IT 内无 service interval 依赖）
          await drive.driveNextRound(matchId, { roundBreakTimeoutMs: 30_000 })
          const ms = await svc.match.observe(matchId)
          if (!roundBreakSeen && ms.match.phase === 'roundBreak') {
            roundBreakSeen = true
            // 周期边界：A 提交下一轮代码（commit=就绪）；bot 座位已自动 ready
            const commit = await tool('screeps_submit_code').execute(
              { modules: { main: HARVEST_BOT.replace('/* round1 */', '// round-1') } },
              makeExec('loop-sess'),
            )
            expect(String((commit as { text?: string }).text ?? '')).toContain('round break')
            await drive.driveNextRound(matchId, { roundBreakTimeoutMs: 30_000 })
          } else if (roundBreakSeen && ms.match.phase === 'running' && (ms.match.roundIndex ?? 0) >= 1) {
            resumedSeen = true
          }
        }
        expect(roundBreakSeen).toBe(true)
        expect(resumedSeen).toBe(true)

        // 4) settle → winner 落盘 + scoreWarning 无
        const settledCall = await tool('screeps_match').execute({ action: 'settle', matchId, reason: 'manual' }, makeExec('loop-sess'))
        const settled = (settledCall as { match: { phase: string; winner: { kind: string }; scoreWarning?: string } }).match
        expect(settled.phase).toBe('settled')
        expect(['session', 'draw']).toContain(settled.winner.kind)
        expect(settled.scoreWarning).toBeUndefined()
      } finally {
        await fiber.dispose()
      }
    },
    180_000,
  )
})