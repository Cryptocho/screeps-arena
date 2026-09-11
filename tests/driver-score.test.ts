/**
 * M2/S1 roundsExhausted 真实结算注入（driver tick 路径）——plan-M2 复审 B1 钉死项：
 * roundBreak 相位机器在 advance 前 await 快照 → computeOutcome → 透传 private resume
 * → settle('roundsExhausted')。快照抛错 → M0 降级，驱动循环不中断。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MatchDriver } from '../src/server/http/driver.js'
import { createArenaDevServices } from '../src/server/http/dev-services.js'
import type { MatchMachine } from '../src/server/match/machine.js'
import type { SeatScoreInput } from '../src/server/match/score.js'

const drivers: MatchDriver[] = []
afterEach(() => {
  for (const d of drivers) d.stop()
  drivers.length = 0
})

const s = (spawns: number, creeps: number): SeatScoreInput => ({ spawns, creeps, rooms: 1, rclTotal: 1 })

async function matchAtRoundBreak(snap?: Record<string, SeatScoreInput>, fail = false): Promise<MatchMachine> {
  let calls = 0
  const driver = new MatchDriver({
    intervalMs: 10,
    ...(snap || fail
      ? {
          scoreSnapshot: async () => {
            calls++
            if (fail) throw new Error('world down')
            return snap
          },
        }
      : {}),
    log: (m) => console.log('[driver]', m),
  })
  drivers.push(driver)
  const { services, machines } = createArenaDevServices({ driver })
  const m = services.createMatch({
    players: [
      { seatId: 'a', username: 'ua' },
      { seatId: 'b', username: 'ub' },
    ],
    config: { roundMs: 20, roundBreakTimeoutMs: 60_000, maxRounds: 1 },
  })
  m.submitCode('a', { main: 'module.exports.loop=function(){}' })
  m.submitCode('b', { main: 'module.exports.loop=function(){}' })
  m.start(Date.now() - 100)
  await driver.tick() // running → roundBreak（此拍 phase 尚 running，不取分）
  expect(m.phase).toBe('roundBreak')
  const callsBefore = calls
  await driver.tick() // roundBreak 相位：先取分 → advance → resume → roundsExhausted
  m.state.roundBreakSince = Date.now() - 61_000 // 兑底窗口回拨（timeoutMs=60s），确保下一拍必触发
  await driver.tick()
  expect(calls).toBeGreaterThanOrEqual(callsBefore + (snap || fail ? 1 : 0))
  void machines
  return m
}

describe('driver tick 计分快照注入（M2/S1）', () => {
  it('roundBreak 相位取分 → roundsExhausted settle 带真实 winner/scores', async () => {
    const m = await matchAtRoundBreak({ a: s(2, 7), b: s(0, 0) })
    expect(m.phase).toBe('settled')
    expect(m.state.settleReason).toBe('roundsExhausted')
    expect(m.state.winner).toEqual({ kind: 'seat', seatId: 'a' })
    expect(m.state.scores!.a).toBe(2 * 100 + 7)
  })

  it('快照抛错 → 降级 M0 全 0 draw，驱动循环不中断', async () => {
    const m = await matchAtRoundBreak(undefined, true)
    expect(m.phase).toBe('settled')
    expect(m.state.settleReason).toBe('roundsExhausted')
    expect(m.state.winner).toEqual({ kind: 'draw' })
    expect(m.state.scores).toEqual({ a: 0, b: 0 })
  })

  it('无 scoreSnapshot → 维持 M0 行为（73 测基线不破）', async () => {
    const m = await matchAtRoundBreak()
    expect(m.phase).toBe('settled')
    expect(m.state.winner).toEqual({ kind: 'draw' })
    expect(m.state.scores).toEqual({ a: 0, b: 0 })
  })
})

// spy 校验：vi 未用会 lint 抱怨的项目里没有 lint，此处保留显式 import 以便后续扩展
void vi
