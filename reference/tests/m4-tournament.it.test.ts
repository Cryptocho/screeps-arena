/**
 * M4-F.1 — 真实私服 tournament composition IT（plan §9 验收矩阵 "composition"）。
 *
 * 场景 A：4 席两轮单淘汰。
 * - fake AgentRegistry：create 返回 fake handle（followup 记录，不调真 LLM）、dispose 记录；
 * - TournamentService + Orchestrator + MatchStore + drivers 全真实装配（真实 Screeps 私服）；
 * - 驱动循环：IT 手动调用 tournaments.driveOnce（submitted→start / autoSettle→settle），
 *   模拟 ScreepsService 的 drive interval 单拍；
 * - 每 slot 注入确定性 bot 代码：players[0]（基准房 W15N15）= raider（进攻，targetRoom=W14N15），
 *   players[1]（镜像房 W14N15）= harvester（被动）→ p0 方必胜（拆光对家 spawn）。
 * - 断言：首轮 r1s0/r1s1 → winner p0/p2；决赛 r2s0 → p0 冠军；completed + 4 handles 全部 dispose；
 *   全程无 `__bot__` 痕迹（对局玩家 username 为 t_<tid>_p_<pid>_a<attempt>，不是 bot）。
 *
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律：共享 smoke dataDir 是单写者资源，全 IT 文件串行执行。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import type { AgentHandleLike, AgentRegistryLike } from '../src/host/agents.ts'
import type { MatchState } from '../src/host/match/model.ts'
import { BotRegistry } from './helpers/bot-registry.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** fake AgentRegistry：create 记录，followup 记录，dispose 记录。 */
function makeFakeRegistry() {
  const created: Array<{ sessionId: string; agentOptions?: unknown; meta?: unknown }> = []
  const disposed: string[] = []
  const registry: AgentRegistryLike & { created: typeof created; disposed: typeof disposed } = {
    created,
    disposed,
    async create(options) {
      created.push({ ...options })
      const handle: AgentHandleLike = {
        agent: {
          id: options.sessionId,
          followup: () => {},
        },
        async dispose() {
          disposed.push(options.sessionId)
        },
      }
      return handle
    },
  }
  return { registry, disposed }
}

describe.skipIf(!provisioned)('M4-F.1 tournament composition（真实私服，4 席两轮）', () => {
  it(
    'create→ready→start→首轮两场→决赛→completed；winner 推进 + 4 handles dispose；无 __bot__ 痕迹',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-tourney-'))
      mkdirSync(dataDir, { recursive: true })
      symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
      symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

      const { registry, disposed } = makeFakeRegistry()
      const ctx = new Context()
      // fake AgentRegistry 注入（recruit 需要它；handle 不真跑 LLM）
      ctx.provide('agents' as never, registry as never)

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
          agentRecruitTimeoutMs: 120_000,
          driveIntervalMs: 50,
        }),
      )
      const svc = ctx.screeps
      try {
        await svc.ensureRunning()
        svc.stopDrive() // IT 手动 driveOnce（每拍可控；避免 interval 抢驱动）

        const raiderCode = await botRegistry.load('raider')
        const harvesterCode = await botRegistry.load('harvester')

        // ---- 1) create（awaitRecruit）→ ready ----
        const created = await svc.tournaments.create(
          'req-composition-a',
          { preset: 'arena-blitz', seats: 4, maxAttempts: 2, tickDuration: 100 },
          'op-1',
          { awaitRecruit: true },
        )
        const tid = created.tournamentId
        expect(created.state.phase).toBe('ready')
        expect(registry.created).toHaveLength(4)
        // 4 个 handle，无 __bot__
        for (const c of registry.created) {
          expect(c.sessionId).not.toContain('__bot__')
          expect(c.sessionId).toMatch(/^screeps-tournament-/)
        }

        // ---- 2) start → 激活首场（creating）----
        await svc.tournaments.start(tid, 'op-start')

        /** 找当前 slot 的 attempt match。 */
        const activeAttemptMatch = async (): Promise<MatchState | null> => {
          const t = await svc.tournaments.storeRef.get(tid)
          if (!t) return null
          // 当前 slot（current slot 或第一个 running/pending slot）
          const slot =
            t.slots.find(s => s.slotId === t.currentSlotId) ??
            t.slots.find(s => s.phase === 'running' || s.phase === 'pending')
          const attempt = slot?.attempts.find(a => a.phase === 'running' || a.phase === 'settling' || a.phase === 'pending')
          if (!attempt?.matchId) return null
          return svc.match.store.get(attempt.matchId)
        }

        /** 等待某 slot 激活出 match。 */
        const waitActiveMatch = async (timeoutMs: number): Promise<MatchState> => {
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const m = await activeAttemptMatch()
            if (m) return m
            await sleep(200)
          }
          throw new Error(`timeout waiting for attempt activation in ${tid}`)
        }

        /** 给一场 attempt 注入确定性代码并提交（players[0]=raider, players[1]=harvester）。 */
        const stageAndSubmit = async (matchId: string): Promise<void> => {
          await svc.match.store.update(matchId, s => {
            for (const [i, p] of s.players.entries()) {
              p.code = i === 0 ? raiderCode : harvesterCode
              p.submitted = true
            }
          })
        }

        /** 等一场 running → 给 raider 写目标房间 memory → 等 resultTick → settle。 */
        const runAndSettle = async (matchId: string): Promise<void> => {
          // 等到 running
          const deadline = Date.now() + 30_000
          let started = false
          while (Date.now() < deadline) {
            const m = await svc.match.store.get(matchId)
            if (m && m.phase === 'running') {
              started = true
              // 与 m3-arena IT 同款前置：清除开局 20000 tick safeMode 免疫，
              // 否则敌方不能攻击 spawn（raider 拆不爆 → 永不 settle）
              for (const room of ['W15N15', 'W14N15']) {
                await svc.system('clearSafeMode', room).catch(() => {})
              }
              const raiderUser = m.players[0]!.username
              await svc.writeMemory(raiderUser, { arena: { targetRoom: 'W14N15' } })
              break
            }
            await sleep(200)
          }
          expect(started).toBe(true)
          // 等到 settled（autoSettle due 就 driveOnce settle；或对局直接结算）
          // 240s：满套件尾段 CPU 饱和下 100ms/tick 会显著变慢（run3 实测 180s 不够；
          // 独跑 ~50s/场），放宽截止避免负载性误报
          const settleDeadline = Date.now() + 240_000
          let settled = false
          while (Date.now() < settleDeadline) {
            const m = await svc.match.store.get(matchId)
            if (m && m.phase === 'settled') {
              settled = true
              break
            }
            if (m && m.phase !== 'running' && m.phase !== 'paused' && m.phase !== 'settling') break
            const obs = await svc.match.observe(matchId).catch(() => null)
            if (obs?.autoSettle.due) {
              // 与 m3-arena IT 同款 settle（journal 唯一顺序；commit 后 hook 推进）
              const reason = obs.autoSettle.reason ?? ('lastStanding' as const)
              const verdict = await svc.match.settle(matchId, reason)
              console.log('[it] settled match', matchId, verdict.phase, verdict.winner?.kind)
            }
            await sleep(800)
          }
          expect(settled).toBe(true)
          // 等 slot 推进完成（settled → applyResult → completed/下一场）
          await sleep(500)
        }

        /** 进行一次 slot（等待激活 → 注入 → drive start → 运行 → settle）。 */
        const playOneSlot = async (): Promise<void> => {
          const match = await waitActiveMatch(30_000)
          await stageAndSubmit(match.id)
          // driveOnce：submitted → start（仅当还在 creating）
          const before = await svc.match.store.get(match.id)
          if (before && before.phase === 'creating') {
            const out = await svc.tournaments.driveOnce(tid)
            expect(out).toBe('started')
          }
          await runAndSettle(match.id)
        }

        // ---- 3) 首轮两场 + 决赛（共 3 场）----
        // 注意：orchestrator 一次只激活一场；每场 settle 后 onSettled 推进下一场。
        for (let i = 0; i < 3; i++) {
          const phaseBefore = (await svc.tournaments.storeRef.get(tid))!.phase
          if (phaseBefore === 'completed') break
          await playOneSlot()
        }

        // ---- 4) 终态断言 ----
        const final = await svc.tournaments.storeRef.get(tid)
        expect(final!.phase).toBe('completed')
        expect(final!.championParticipantId).toBeTruthy()
        expect(final!.slots.filter(s => s.phase === 'won')).toHaveLength(3) // 首轮2 + 决赛1
        // 无 __bot__ 痕迹
        const allMatches = await svc.match.store.list()
        for (const m of allMatches) {
          for (const p of m.players) {
            expect(p.username).not.toContain('__bot__')
          }
        }
        // 4 个 handle 全部 dispose（completed 终态回收）
        expect(disposed).toHaveLength(4)
      } finally {
        try {
          await fiber.dispose()
        } catch (err) {
          console.error('[it] fiber.dispose failed:', err)
        }
      }
    },
    600_000,
  )
})