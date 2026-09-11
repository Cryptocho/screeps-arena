/**
 * 对局状态机单测（M0/S3，plan-M0 §4）。
 *
 * 边界路径（done 判据）：
 *   ① roundBreak 超时到点、席位未提交 → 沿用上轮代码自动 ready 并续跑；
 *   ② running 期 submit_code → 拒绝（语义对照旧 tools.ts frozen 分支）；
 *   ③ roundBreak 提交 → 暂存 + ready；resume 清 ready、roundIndex+1；
 *   ④ maxRounds 到顶 → settle(roundsExhausted)；
 *   ⑤ start 门槛：未全员暂存代码拒开。
 * 时间显式注入（now），零真实等待。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MATCH_CONFIG, newMatchId, type MatchConfig } from '../src/server/match/model.js'
import { FROZEN_DURING_ROUND, MatchMachine, type MatchEvent } from '../src/server/match/machine.js'

const CODE = (v: string) => ({ main: `module.exports.loop = function () { /* ${v} */ }` })

function makeMachine(opts: { config?: Partial<MatchConfig>; onEvent?: (e: MatchEvent) => void } = {}) {
  return new MatchMachine({
    players: [
      { seatId: 'seat-a', username: 'userA' },
      { seatId: 'seat-b', username: 'userB' },
    ],
    config: opts.config,
    onEvent: opts.onEvent,
  })
}

/** 便捷开局：双席位暂存 + start。 */
function startMatch(m: MatchMachine, now = 1000): void {
  m.submitCode('seat-a', CODE('a'), now)
  m.submitCode('seat-b', CODE('b'), now)
  m.start(now)
}

describe('状态机：creating → running', () => {
  it('start 门槛：未全员暂存代码拒开（creating→running 不发生）', () => {
    const m = makeMachine()
    m.submitCode('seat-a', CODE('a'))
    expect(() => m.start()).toThrow(/seats without committed code/)
    expect(m.phase).toBe('creating')
  })

  it('全员暂存后 start：phase=running、roundIndex=0、started 事件', () => {
    const events: MatchEvent[] = []
    const m = makeMachine({ onEvent: (e) => events.push(e) })
    startMatch(m, 1000)
    expect(m.phase).toBe('running')
    expect(m.state.roundIndex).toBe(0)
    expect(events).toContainEqual({ type: 'started', round: 0 })
  })
})

describe('状态机：running 期提交（边界②）', () => {
  it('running 期 submit_code → 拒绝，文案对照旧 tools.ts frozen 分支', () => {
    const m = makeMachine()
    startMatch(m)
    expect(() => m.submitCode('seat-a', CODE('late'))).toThrow(FROZEN_DURING_ROUND)
    // 拒绝的提交不落位
    expect(m.players.find((p) => p.seatId === 'seat-a')?.code?.main).toContain('/* a */')
  })

  it('running 周期到点 → roundBreak（round_break 事件、ready 清 false）', () => {
    const events: MatchEvent[] = []
    const m = makeMachine({ onEvent: (e) => events.push(e) })
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    expect(m.phase).toBe('roundBreak')
    expect(m.state.roundBreakSince).toBe(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    expect(events).toContainEqual({ type: 'round_break', round: 0 })
  })

  it('running 未到点 advance 无操作（幂等）', () => {
    const m = makeMachine()
    startMatch(m, 1000)
    m.advance(1000 + 1)
    expect(m.phase).toBe('running')
  })
})

describe('状态机：roundBreak 提交与 resume（边界③）', () => {
  it('roundBreak 期提交 → 暂存新 code + ready=true', () => {
    const m = makeMachine()
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    m.submitCode('seat-a', CODE('a2'), 2000)
    const a = m.players.find((p) => p.seatId === 'seat-a')!
    expect(a.ready).toBe(true)
    expect(a.code?.main).toContain('/* a2 */')
  })

  it('全员 ready → resume：roundIndex+1、ready 清 false、round_resume 事件', () => {
    const events: MatchEvent[] = []
    const m = makeMachine({ onEvent: (e) => events.push(e) })
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    m.submitCode('seat-a', CODE('a2'), 2000)
    m.submitCode('seat-b', CODE('b2'), 2000)
    m.advance(2100)
    expect(m.phase).toBe('running')
    expect(m.state.roundIndex).toBe(1)
    expect(m.players.every((p) => !p.ready)).toBe(true)
    expect(events).toContainEqual({ type: 'round_resume', round: 1, autoReadySeats: [] })
  })

  it('roundBreak 期 advance 未到超时且未全员 ready → 保持 roundBreak', () => {
    const m = makeMachine()
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    m.submitCode('seat-a', CODE('a2'), 2000) // 只有 A 提交
    m.advance(2000 + DEFAULT_MATCH_CONFIG.roundBreakTimeoutMs - 1)
    expect(m.phase).toBe('roundBreak')
  })
})

describe('状态机：超时兜底（边界①）', () => {
  it('超时到点未提交席位 → 沿用上轮代码自动 ready + error 落盘 + 续跑', () => {
    const events: MatchEvent[] = []
    const m = makeMachine({ onEvent: (e) => events.push(e) })
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs) // roundBreak
    m.submitCode('seat-a', CODE('a2'), 2000) // B 不提交
    const breakAt = m.state.roundBreakSince!
    m.advance(breakAt + DEFAULT_MATCH_CONFIG.roundBreakTimeoutMs)

    expect(m.phase).toBe('running')
    expect(m.state.roundIndex).toBe(1)
    const b = m.players.find((p) => p.seatId === 'seat-b')!
    // resume 消费本轮 commit（含超时兜底的自动 ready），ready 归位 false——
    // 兜底的可见结果 = autoReady 标记 + error 落盘 + 续跑，不是 ready 残留
    expect(b.ready).toBe(false)
    expect(b.autoReady).toEqual({ round: 0, reason: 'timeout' })
    expect(b.code?.main).toContain('/* b */') // 沿用上轮代码
    expect(m.state.errors.some((e) => e.includes('seat seat-b') && e.includes('timeout'))).toBe(true)
    expect(events).toContainEqual({ type: 'round_resume', round: 1, autoReadySeats: ['seat-b'] })
  })

  it('超时兜底后已提交席位的新代码保留（下轮生效）', () => {
    const m = makeMachine()
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    m.submitCode('seat-a', CODE('a2'), 2000)
    m.advance(m.state.roundBreakSince! + DEFAULT_MATCH_CONFIG.roundBreakTimeoutMs)
    const a = m.players.find((p) => p.seatId === 'seat-a')!
    expect(a.autoReady).toBeUndefined()
    expect(a.code?.main).toContain('/* a2 */')
  })
})

describe('状态机：maxRounds 与 settle（边界④）', () => {
  it('maxRounds=1：roundBreak 全员 ready → resume 超出 → settle(roundsExhausted)', () => {
    const events: MatchEvent[] = []
    const m = makeMachine({ config: { maxRounds: 1 }, onEvent: (e) => events.push(e) })
    startMatch(m, 1000)
    m.advance(1000 + DEFAULT_MATCH_CONFIG.roundMs)
    m.submitCode('seat-a', CODE('a2'), 2000)
    m.submitCode('seat-b', CODE('b2'), 2000)
    m.advance(2100)
    expect(m.phase).toBe('settled')
    expect(m.state.settleReason).toBe('roundsExhausted')
    expect(m.state.winner).toEqual({ kind: 'draw' })
    expect(events[events.length - 1]).toEqual({ type: 'settled', reason: 'roundsExhausted', winner: { kind: 'draw' } })
  })

  it('手动 settle：running/roundBreak 均可，scores 全 0（M0 无计数器来源）', () => {
    const m = makeMachine()
    startMatch(m)
    m.settle('manual')
    expect(m.phase).toBe('settled')
    expect(m.state.scores).toEqual({ 'seat-a': 0, 'seat-b': 0 })
  })

  it('settled 后 submit_code 拒绝；settled 无出边', () => {
    const m = makeMachine()
    startMatch(m)
    m.settle('manual')
    expect(() => m.submitCode('seat-a', CODE('x'))).toThrow(/already settled/)
    expect(() => m.start()).toThrow(/not allowed/)
  })
})

describe('状态机：杂项', () => {
  it('席位数与 config.seats 不符 → 构造即抛', () => {
    expect(() => makeMachine({ config: { seats: 3 } })).toThrow(/expected 3 seats/)
  })

  it('非玩家席位 submit → 拒绝', () => {
    const m = makeMachine()
    expect(() => m.submitCode('seat-x', CODE('x'))).toThrow(/not a player/)
  })

  it('newMatchId 形状：m 前缀 + base36 时间 + 随机尾', () => {
    const id = newMatchId(1700000000000)
    expect(id).toMatch(/^m[0-9a-z]+[0-9a-z]{2,8}$/)
    expect(id.startsWith('m')).toBe(true)
  })
})
