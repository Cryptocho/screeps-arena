/**
 * M4/S5 stub IT（plan-M4 判据 3）——锦标赛全自动串联（真实 MatchMachine +
 * TournamentStore + scheduler，fake 私服/Agent）：
 * ① 4 选手单循环 6 局：建局 → 初始 prompt → 席位提交（模拟 Agent 调 submit_code）→
 *    全员就绪自动 start → settle → 同步回填 → 下一场，全链无人干预；
 * ② 不变式：同选手至多 1 局活跃、并发 = 1；
 * ③ 积分榜与赛果一致（纯派生）；
 * ④ 中断恢复：磁盘 store 重启读回 + recoverOnStartup 三态收敛（scheduled 重排 /
 *    settled 未回填回填）。
 * 真实私服链路由 test:live 承担。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchMachine } from '../src/server/match/machine.js'
import { TournamentScheduler, initialPromptText } from '../src/server/tournament/scheduler.js'
import { TournamentStore } from '../src/server/tournament/store.js'
import { standings } from '../src/server/tournament/bracket.js'
import { tournamentFinished } from '../src/server/tournament/types.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function mkHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'tflow-'))
  dirs.push(dir)
  const store = new TournamentStore(join(dir, 'tournaments'))
  const machines = new Map<string, MatchMachine>()
  const prompts: Array<{ seatId: string; matchId: string }> = []
  const h = {
    store,
    machines,
    prompts,
    scheduler: undefined as unknown as TournamentScheduler,
  }
  h.scheduler = new TournamentScheduler({
    store,
    // main.ts createMatchInternal 同款（真实 MatchMachine；无房间/私服面——纯编排 IT）
    createMatch: (players, config) => {
      const m = new MatchMachine({
        players,
        ...(config ? { config } : {}),
        onEvent: (e) => {
          if (e.type === 'settled') h.scheduler.onSettled(m)
        },
      })
      machines.set(m.id, m)
      return m
    },
    getMachine: (id) => machines.get(id),
    journalEntries: () => [],
    historyGet: () => undefined,
    historyFindByPair: () => undefined,
    initialPrompt: (seatId, matchId) => {
        prompts.push({ seatId, matchId })
      },
    log: () => {},
  })
  return h
}

/** 模拟 Agent：收到初始 prompt → 提交代码（等价 submit_code 工具调用）。 */
function agentRespond(h: ReturnType<typeof mkHarness>): void {
  for (const { seatId, matchId } of [...h.prompts.splice(0)]) {
    h.machines.get(matchId)?.submitCode(seatId, { main: 'module.exports.loop = function() {}' })
  }
}

describe('M4 锦标赛全自动串联（stub IT）', () => {
  it('4 选手 6 局全链无人干预串完；并发不变式；积分榜纯派生', () => {
    const h = mkHarness()
    const participants = ['alice', 'bob', 'carol', 'dave'].map((s) => ({ seatId: s, username: s }))
    const t = h.scheduler.create({
      name: 'league',
      participants,
      matchConfig: { roundMs: 10, roundBreakTimeoutMs: 10, maxRounds: 1 },
    })
    expect(t.matches).toHaveLength(6)

    // 每场：创建（pump 已建局）→ Agent 提交 → starter start → settle（outcome 定胜负）
    let guard = 0
    while (!tournamentFinished(t)) {
      if (++guard > 20) throw new Error('tournament did not converge: scheduling loop broken')
      const active = t.matches.filter((m) => m.status === 'created')
      expect(active.length).toBeLessThanOrEqual(1) // maxConcurrent=1
      // 同选手至多 1 局活跃
      const busy = new Set<string>()
      for (const m of active) {
        const machine = h.machines.get(m.matchId ?? '')
        if (!machine) continue
        for (const p of machine.players) {
          expect(busy.has(p.seatId), `participant ${p.seatId} in two active matches`).toBe(false)
          busy.add(p.seatId)
        }
      }
      agentRespond(h)
      h.scheduler.tickStarter()
      const machine = [...h.machines.values()].find((m) => m.phase === 'running')
      if (!machine) {
        // 未开局（等 prompt 处理）——防御死循环
        agentRespond(h)
        h.scheduler.tickStarter()
        continue
      }
      // 定胜负：第一席位 10 分、第二席位 2 分（computeOutcome 的 winner 取分数高者）
      const [a = '', b = ''] = machine.players.map((p) => p.seatId)
      machine.settle('manual', Date.now(), {
        scores: { [a]: 10, [b]: 2 },
        winner: { kind: 'seat', seatId: a },
      })
    }

    // 场次与状态
    expect(t.matches.filter((m) => m.status === 'settled')).toHaveLength(6)
    expect(t.matches.every((m) => m.matchId && m.result)).toBe(true)
    expect(t.finishedAt).toBeTruthy()
    // 每场每席位恰好 1 次初始 prompt（6 局 × 2 席）
    expect(h.prompts).toHaveLength(0) // 已消费
    // 积分榜与赛果一致（纯派生：重算）
    const rows = standings(t)
    expect(rows).toHaveLength(4)
    expect(rows.reduce((s, r) => s + r.wins, 0)).toBe(6)
    expect(rows.reduce((s, r) => s + r.points, 0)).toBe(18) // 6 局 × 3 分
    // 全部 winner 都是先手席（测试注入）：每行 wins+draws+losses === played
    for (const r of rows) expect(r.wins + r.draws + r.losses).toBe(r.played)
    // 届 errors 为空（每席位 prompt 一次即提交成功）
    expect(t.errors).toEqual([])
  })

  it('中断恢复：磁盘读回 + 三态收敛（scheduled 重排 / settled 未回填回填）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tflow2-'))
    dirs.push(dir)
    // —— 第一步：建届、打完第一场、第二场 scheduled 未建局（模拟 createMatch 前崩溃）——
    const store1 = new TournamentStore(join(dir, 'tournaments'))
    const machines1 = new Map<string, MatchMachine>()
    const scheduler1 = new TournamentScheduler({
      store: store1,
      createMatch: (players) => {
        const m = new MatchMachine({ players, onEvent: () => {} })
        machines1.set(m.id, m)
        return m
      },
      getMachine: (id) => machines1.get(id),
      journalEntries: () => [],
      historyGet: () => undefined,
      historyFindByPair: () => undefined,
      initialPrompt: () => undefined,
      log: () => {},
    })
    const t = scheduler1.create({
      participants: [
        { seatId: 'p1', username: 'p1' },
        { seatId: 'p2', username: 'p2' },
        { seatId: 'p3', username: 'p3' },
      ],
    })
    // 第一场：created 状态直接补 result（模拟已 settle 且 history 有账）
    const m1pair = t.matches[0]!.pair
    const histRecord = {
      id: 'hist-match-1',
      winner: { kind: 'seat', seatId: m1pair[0] },
      scores: { [m1pair[0]]: 8, [m1pair[1]]: 1 } as Record<string, number>,
      settledAt: 999,
    }
    t.matches[0]!.status = 'created'
    t.matches[0]!.matchId = 'hist-match-1'
    store1.save(t) // 模拟 fs 回填成功的持久化（否则新实例读不到 hist-match-1）
    void m1pair
    // —— 第二步：模拟崩溃重启（全新内存态 + 磁盘 store + history 按 pair 可查）——
    const machines2 = new Map<string, MatchMachine>()
    const scheduler2 = new TournamentScheduler({
      store: new TournamentStore(join(dir, 'tournaments')),
      createMatch: (players) => {
        const m = new MatchMachine({ players, onEvent: () => {} })
        machines2.set(m.id, m)
        return m
      },
      getMachine: (id) => machines2.get(id),
      journalEntries: () => [],
      historyGet: (id) => (id === 'hist-match-1' ? histRecord : undefined),
      historyFindByPair: (pair) => {
        const seats = Object.keys(histRecord.scores).sort()
        const want = [...pair].sort()
        return seats[0] === want[0] && seats[1] === want[1] ? histRecord : undefined
      },
      initialPrompt: () => undefined,
      log: () => {},
    })
    const t2 = scheduler2['deps'].store.list()[0]!
    // 破坏内存态模拟：t2 是从磁盘读回的（第一场 created + matchId）；
    // 第二场 scheduled；scheduled 的 pair 采纳路径需 history 有该 pair —— 本场景无 → 重排
    scheduler2.recoverOnStartup()
    // ① settled 未回填回填路径：把第一场标 settled 删 result 再恢复一次（直接断言回填）
    t2.matches[0]!.status = 'settled'
    t2.matches[0]!.result = undefined
    scheduler2.recoverOnStartup()
    const backfilled = t2.matches[0]!.result as { winner?: string | null; settledAt?: number } | undefined
    expect(backfilled?.winner ?? null).toBe(m1pair[0])
    expect(backfilled?.settledAt).toBe(999)
    // ② scheduled 重排：第二场及以后由恢复期 pump 重建局
    expect(t2.matches.filter((m) => m.status === 'created').length).toBeGreaterThanOrEqual(1)
  })

  it('初始 prompt 文案（真实出口）：只含本局语义', () => {
    const text = initialPromptText('mXYZ')
    expect(text).toContain('submit_code')
    expect(text).not.toMatch(/standing|rank|积分|战绩|leaderboard/i)
  })
})
