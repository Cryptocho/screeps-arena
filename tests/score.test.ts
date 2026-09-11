/**
 * M2/S1 真实计分单测——computeOutcome 纯函数表驱动 + routes settle 快照注入两路径
 * （manual 走 handleArenaRequest；roundsExhausted 走 driver tick，见 driver-score.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import { computeOutcome, displayScore, isDefeated, tiebreakCompare } from '../src/server/match/score.js'
import type { SeatScoreInput } from '../src/server/match/score.js'
import { MatchMachine } from '../src/server/match/machine.js'
import { handleArenaRequest } from '../src/server/http/routes.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'

const s = (spawns: number, creeps: number, rooms = 1, rclTotal = 1): SeatScoreInput => ({ spawns, creeps, rooms, rclTotal })

describe('computeOutcome（M2/S1，world 形态）', () => {
  it('双活 → draw，scores 保留真实计数（非全 0）', () => {
    const out = computeOutcome({ a: s(1, 5), b: s(1, 3) })
    expect(out.winner).toEqual({ kind: 'draw' })
    expect(out.scores).toEqual({ a: displayScore(s(1, 5)), b: displayScore(s(1, 3)) })
    expect(out.scores.a).toBeGreaterThan(0)
  })

  it('一方 world 出局（spawns==0 且 creeps==0）→ 对方胜', () => {
    const out = computeOutcome({ a: s(1, 2), b: s(0, 0) })
    expect(out.winner).toEqual({ kind: 'seat', seatId: 'a' })
  })

  it('arena 形态：spawns==0 即出局（creeps 仍活也出局）', () => {
    expect(isDefeated(s(0, 9), 'arena')).toBe(true)
    expect(isDefeated(s(0, 9), 'world')).toBe(false)
    const out = computeOutcome({ a: s(1, 0), b: s(0, 9) }, { form: 'arena' })
    expect(out.winner).toEqual({ kind: 'seat', seatId: 'a' })
  })

  it('同轮双出局 → tiebreak；全平 → draw', () => {
    // world 形态全出局（spawns=0 且 creeps=0）：creeps 全 0 → rooms 分胜负
    expect(computeOutcome({ a: s(0, 0, 2), b: s(0, 0, 1) }).winner).toEqual({ kind: 'seat', seatId: 'a' })
    // rooms 平 → rclTotal 分
    expect(computeOutcome({ a: s(0, 0, 1, 5), b: s(0, 0, 1, 2) }).winner).toEqual({ kind: 'seat', seatId: 'a' })
    // 全平 → draw
    expect(computeOutcome({ a: s(0, 0, 1, 2), b: s(0, 0, 1, 2) }).winner).toEqual({ kind: 'draw' })
    // arena 形态（spawns=0 即出局）：creeps 仍参与 tiebreak 分胜负
    expect(computeOutcome({ a: s(0, 4), b: s(0, 2) }, { form: 'arena' }).winner).toEqual({ kind: 'seat', seatId: 'a' })
    expect(tiebreakCompare(s(0, 1), s(0, 2))).toBeGreaterThan(0) // a 弱 → 正数
  })

  it('快照缺席位 = 全 0 = 出局；空快照 → draw', () => {
    expect(computeOutcome({ a: s(1, 1) }).winner).toEqual({ kind: 'seat', seatId: 'a' })
    expect(computeOutcome({})).toEqual({ scores: {}, winner: { kind: 'draw' } })
  })
})

describe('routes settle 快照注入（manual 路径）', () => {
  function machineWithPlayers(): MatchMachine {
    const m = new MatchMachine({
      players: [
        { seatId: 'a', username: 'ua' },
        { seatId: 'b', username: 'ub' },
      ],
    })
    m.submitCode('a', { main: 'module.exports.loop=function(){}' })
    m.submitCode('b', { main: 'module.exports.loop=function(){}' })
    m.start(Date.now())
    return m
  }

  function servicesWith(m: MatchMachine, snap?: Record<string, SeatScoreInput>): ArenaHttpServices {
    return {
      matches: () => [m],
      match: () => m,
      createMatch: () => m,
      getWorld: async () => ({}),
      getTerrain: async () => ({ terrain: {} }),
      consoleSince: async () => ({ lines: [], cursor: 0, bound: true }),
      ...(snap ? { getScoreSnapshot: async () => snap } : {}),
    }
  }

  it('快照在位 → settle 带真实 winner/scores', async () => {
    const m = machineWithPlayers()
    const res = await handleArenaRequest(servicesWith(m, { a: s(1, 4), b: s(0, 0) }), {
      method: 'POST',
      pathname: `/api/matches/${m.id}/settle`,
    })
    expect(res.status).toBe(200)
    expect(m.phase).toBe('settled')
    expect(m.state.settleReason).toBe('manual')
    expect(m.state.winner).toEqual({ kind: 'seat', seatId: 'a' })
    expect(m.state.scores!.a).toBe(displayScore(s(1, 4)))
  })

  it('快照缺席/抛错 → 降级 M0 全 0 draw（不卡结算）', async () => {
    const m1 = machineWithPlayers()
    await handleArenaRequest(servicesWith(m1), { method: 'POST', pathname: `/api/matches/${m1.id}/settle` })
    expect(m1.state.winner).toEqual({ kind: 'draw' })
    expect(m1.state.scores).toEqual({ a: 0, b: 0 })

    const m2 = machineWithPlayers()
    const failing = servicesWith(m2, {})
    failing.getScoreSnapshot = async () => {
      throw new Error('world down')
    }
    await handleArenaRequest(failing, { method: 'POST', pathname: `/api/matches/${m2.id}/settle` })
    expect(m2.phase).toBe('settled')
    expect(m2.state.winner).toEqual({ kind: 'draw' })
  })
})
