/**
 * TournamentScheduler 单测（plan-M4/S3）：pump 建局时序（scheduled 先落盘）、
 * settle 同步回填、开局驱动（全员就绪 start / 有界补发 / 超界落 errors）、
 * maxConcurrent=1、瞬时拒绝延期、启动恢复三态、双故障窗 pair 采纳。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TournamentScheduler } from '../src/server/tournament/scheduler.js'
import { TournamentStore } from '../src/server/tournament/store.js'
import { RoomPoolExhaustedError } from '../src/server/pool.js'
import type { MatchMachine } from '../src/server/match/machine.js'
import type { TournamentParticipant } from '../src/server/tournament/types.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 极简 MatchMachine 桩：只需 id/players/phase/start/state。 */
function mkMachine(id: string, seatIds: string[], opts: { codes?: Record<string, boolean>; phase?: 'creating' | 'running' | 'settled' } = {}): MatchMachine {
  const players = seatIds.map((seatId) => ({
    seatId,
    username: `u_${seatId}`,
    ready: false,
    ...(opts.codes?.[seatId] ? { code: { main: 'x' } } : {}),
  }))
  const machine = {
    id,
    players,
    phase: opts.phase ?? 'creating',
    config: { seats: 2, roundMs: 1000, roundBreakTimeoutMs: 1000, maxRounds: 2 },
    state: { id, createdAt: 0, phase: opts.phase ?? 'creating', config: {}, players: [], roundIndex: 0, errors: [] },
    started: false,
    start() {
      if (players.some((p) => !p.code)) throw new Error(`match ${id}: cannot start, seats without committed code: ${players.filter((p) => !p.code).map((p) => p.seatId).join(', ')}`)
      machine.started = true
      machine.phase = 'running'
      machine.state.phase = 'running'
    },
  }
  return machine as unknown as MatchMachine
}

interface Harness {
  scheduler: TournamentScheduler
  store: TournamentStore
  machines: Map<string, MatchMachine>
  prompts: Array<{ seatId: string; matchId: string }>
  journal: Array<{ id: string; players: string[] }>
  history: Map<string, { winner: unknown; scores: Record<string, number> | null; settledAt: number | null }>
  failCreateWith?: Error
}

function mkHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tsched-'))
  dirs.push(dir)
  const store = new TournamentStore(join(dir, 'tournaments'))
  const h: Harness = {
    store,
    machines: new Map(),
    prompts: [],
    journal: [],
    history: new Map(),
    scheduler: undefined as unknown as TournamentScheduler,
  }
  h.scheduler = new TournamentScheduler({
    store,
    createMatch: (players, config) => {
      if (h.failCreateWith) throw h.failCreateWith
      const id = `match${h.machines.size + 1}`
      const m = mkMachine(id, players.map((p) => p.seatId))
      h.machines.set(id, m)
      return m
    },
    getMachine: (id) => h.machines.get(id),
    journalEntries: () => [...h.journal],
    historyGet: (id) => h.history.get(id),
    historyFindByPair: (pair) => {
      const want = [...pair].sort()
      for (const [id, rec] of h.history) {
        const s = id // history 记录无 players 字段——测试里用 id 编码 pair：'pA+sB'
        const ids = s.replace(/^p/, '').split('+').sort()
        if (ids[0] === want[0] && ids[1] === want[1]) return { id, ...rec }
      }
      return undefined
    },
    initialPrompt: (seatId, matchId) => {
      h.prompts.push({ seatId, matchId })
    },
    log: () => {},
  })
  return h
}

const P4: TournamentParticipant[] = ['a', 'b', 'c', 'd'].map((s) => ({ seatId: s, username: `u_${s}` }))

describe('TournamentScheduler.create', () => {
  it('校验：人数/去重/username/seats 固定', () => {
    const h = mkHarness()
    expect(() => h.scheduler.create({ participants: [P4[0]!] })).toThrow(/2\.\.8/)
    expect(() => h.scheduler.create({ participants: [P4[0]!, P4[0]!] })).toThrow(/duplicate/)
    expect(() => h.scheduler.create({ participants: [{ seatId: 'a', username: '' }, P4[1]!] })).toThrow(/username/)
    expect(() => h.scheduler.create({ participants: P4.slice(0, 2), matchConfig: { seats: 3 } })).toThrow(/fixed to 2/)
    expect(() => h.scheduler.create({ participants: P4.slice(0, 2), matchConfig: { roundMs: 1 } })).not.toThrow()
  })

  it('创建即触发 pump（stub 同步 → 建局+回填+首发 prompt 一次到位）', () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    expect(t.matches).toHaveLength(1)
    expect(t.matches[0]!.status).toBe('created')
    expect(t.matches[0]!.matchId).toBe('match1')
    expect(h.prompts.map((p) => p.seatId).sort()).toEqual(['a', 'b'])
  })
})

describe('开局驱动（D5/RB1）', () => {
  it('全员 code 就位 → tickStarter 自动 start', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    await new Promise((r) => setTimeout(r, 0))
    const m = h.machines.get(t.matches[0]!.matchId!)!
    m.players.forEach((p) => {
      ;(p as { code?: unknown }).code = { main: 'x' }
    })
    expect(h.scheduler.tickStarter()).toBe(false)
    expect(m.phase).toBe('running')
  })

  it('code 缺席 → 有界补发（per-seat ≤3），超界落 errors 不再发', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    // pump 同步：a/b 各已收 1 次首发。b 提交、a 从不提交。
    const m = h.machines.get(t.matches[0]!.matchId!)!
    m.players.find((p) => p.seatId === 'b')!.code = { main: 'x' }
    h.scheduler.tickStarter() // a: 第 2 次
    h.scheduler.tickStarter() // a: 第 3 次
    expect(h.prompts.filter((p) => p.seatId === 'a').length).toBe(3)
    h.scheduler.tickStarter() // a 超界：不再发，落 errors
    expect(h.prompts.filter((p) => p.seatId === 'a').length).toBe(3)
    expect(t.errors.some((e) => /initial prompt exceeded/.test(e))).toBe(true)
    // b 侧不受 a 超界影响（per-seat 计数）：b 未提交时仍会补发——用新对局验证隔离
  })

  it('maxConcurrent=1：本届有活跃 created 对局时不排下一场', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4 })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.matches.filter((m) => m.status === 'created')).toHaveLength(1)
    // settle 第一场 → 回填 + 排下一场
    const m = h.machines.get(t.matches[0]!.matchId!)!
    ;(m.state as { winner?: unknown; scores?: unknown }).winner = { kind: 'seat', seatId: 'a' }
    ;(m.state as { scores?: unknown }).scores = { a: 5, b: 1 }
    ;(m.state as { settledAt?: number }).settledAt = 123
    h.scheduler.onSettled(m)
    await new Promise((r) => setTimeout(r, 0))
    expect(t.matches[0]!.status).toBe('settled')
    expect(t.matches[0]!.result?.winner).toBe('a')
    expect(t.matches.filter((x) => x.status === 'created')).toHaveLength(1)
    expect(t.matches.filter((x) => x.status === 'scheduled')).toHaveLength(4) // 6 场 - 1 settled - 1 created
  })
})

describe('瞬时拒绝（D3）', () => {
  it('RoomPoolExhaustedError → 留 scheduled 不重试，下次 pump 再排', async () => {
    const h = mkHarness()
    h.failCreateWith = new RoomPoolExhaustedError(2, [], ['E5N5', 'E7N5'])
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.matches[0]!.status).toBe('scheduled')
    expect(t.matches[0]!.matchId).toBeUndefined()
    h.failCreateWith = undefined
    await h.scheduler.pump(t.id)
    expect(t.matches[0]!.status).toBe('created')
  })
})

describe('启动恢复（D3-③ 三态 + RN1 采纳）', () => {
  it('settled 未回填 → history 按 matchId 回填', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    await new Promise((r) => setTimeout(r, 0))
    const mid = t.matches[0]!.matchId!
    h.machines.clear()
    h.history.set(mid, { winner: { kind: 'seat', seatId: 'b' }, scores: { a: 1, b: 9 }, settledAt: 42 })
    ;(t.matches[0]! as { status: string }).status = 'settled'
    delete (t.matches[0]! as { result?: unknown }).result
    h.scheduler.recoverOnStartup()
    expect(t.matches[0]!.result?.winner).toBe('b')
    expect(t.matches[0]!.result?.settledAt).toBe(42)
  })

  it('created 丢失（不在 machines/journal）→ 重排 scheduled 并重建局', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    const oldMatchId = t.matches[0]!.matchId!
    h.machines.clear() // 对局全失
    h.scheduler.recoverOnStartup()
    // 恢复后：原 created 重排 + pump 重建局（stub 同步）
    expect(t.matches[0]!.status).toBe('created')
    expect(t.matches[0]!.matchId).toBeTruthy()
    // 重排局重新走开局驱动（初始 prompt 重发）
    expect(h.prompts.length).toBeGreaterThanOrEqual(4)
    void oldMatchId
  })

  it('created 且在 journal → 保留（由 journal 恢复接管）', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    await new Promise((r) => setTimeout(r, 0))
    const mid = t.matches[0]!.matchId!
    h.machines.clear()
    h.journal.push({ id: mid, players: ['a', 'b'] })
    h.scheduler.recoverOnStartup()
    expect(t.matches[0]!.matchId).toBe(mid)
    expect(t.matches[0]!.status).toBe('created')
  })

  it('scheduled 双故障窗：journal 中 pair 已有对局 → 采纳 matchId（RN1）', async () => {
    const h = mkHarness()
    const t = h.scheduler.create({ participants: P4.slice(0, 2) })
    h.machines.clear()
    // scheduled 落盘后 createMatch 前崩溃 + fs 回填失败：届停 scheduled，但 journal 已有该 pair 局
    ;(t.matches[0]! as { status: string }).status = 'scheduled'
    delete (t.matches[0]! as { matchId?: string }).matchId
    h.journal.push({ id: 'ghost1', players: ['b', 'a'] })
    h.scheduler.recoverOnStartup()
    expect(t.matches[0]!.matchId).toBe('ghost1')
    expect(t.matches[0]!.status).toBe('created')
  })
})
