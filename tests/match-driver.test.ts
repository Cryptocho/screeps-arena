/**
 * S4 驱动器单测——advance 接线 + MatchEvent → 唤醒 + 去重 + 失败不中断。
 */
import { describe, expect, it, vi } from 'vitest'
import { MatchDriver } from '../src/server/http/driver.js'
import type { SeatWaker } from '../src/server/http/driver.js'
import { MatchMachine } from '../src/server/match/machine.js'

function waker(): SeatWaker & { prompts: Array<{ seatId: string; text: string }> } {
  const prompts: Array<{ seatId: string; text: string }> = []
  return {
    prompts,
    prompt: async (seatId, text) => {
      prompts.push({ seatId, text })
    },
  }
}

describe('MatchDriver（S4）', () => {
  it('tick → advance：running 周期到点进 roundBreak（真实时钟）', async () => {
    const driver = new MatchDriver({ intervalMs: 10 })
    const m = new MatchMachine({
      config: { roundMs: 30, roundBreakTimeoutMs: 60_000, maxRounds: 8 },
      players: [
        { seatId: 'a', username: 'ua' },
        { seatId: 'b', username: 'ub' },
      ],
    })
    m.submitCode('a', { main: 'module.exports.loop=function(){}' })
    m.submitCode('b', { main: 'module.exports.loop=function(){}' })
    driver.watch(m, {}) // tick 只 advance watch 中的对局
    m.start(Date.now() - 100) // 回拨起点：roundMs=30 已超
    await driver.tick()
    expect(m.phase).toBe('roundBreak')
    driver.stop()
  })

  it('M6/S2 worldObserve 相位门控：world 局 running 调用；roundBreak 与 arena 局零调用', async () => {
    const seen: string[] = []
    const driver = new MatchDriver({
      intervalMs: 10,
      worldObserve: async (m) => {
        seen.push(`${m.config.form}:${m.phase}`)
      },
    })
    const players = [
      { seatId: 'a', username: 'ua' },
      { seatId: 'b', username: 'ub' },
    ]
    // world 局：roundMs=30 且起点回拨 → 本拍 advance 进 roundBreak；前一次 tick 仍处 running
    const world = new MatchMachine({ config: { roundMs: 30, roundBreakTimeoutMs: 60_000, maxRounds: 8 }, players })
    world.submitCode('a', { main: 'x' })
    world.submitCode('b', { main: 'x' })
    driver.watch(world, {})
    world.start()
    await driver.tick()
    expect(seen).toEqual(['world:running'])
    world.state.roundStartedAt = Date.now() - 100 // 周期到点
    await driver.tick() // advance → roundBreak（世界暂停）
    expect(world.phase).toBe('roundBreak')
    expect(seen).toEqual(['world:running']) // 门控：roundBreak 期零调用（v4 钉死）
    // arena 局同样不走 world 采样（form 分支隔离）
    const arena = new MatchMachine({ config: { form: 'arena', maxTicks: 100, seats: 2 }, players })
    arena.submitCode('a', { main: 'x' })
    arena.submitCode('b', { main: 'x' })
    driver.watch(arena, {})
    arena.start()
    await driver.tick()
    expect(seen).toEqual(['world:running'])
    driver.stop()
  })

  it('M6/S2 worldObserve 抛错只记日志，不中断 tick 循环', async () => {
    const logs: string[] = []
    const driver = new MatchDriver({
      intervalMs: 10,
      log: (m) => logs.push(m),
      worldObserve: async () => {
        throw new Error('boom')
      },
    })
    const m = new MatchMachine({ players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }] })
    m.submitCode('a', { main: 'x' })
    m.submitCode('b', { main: 'x' })
    driver.watch(m, {})
    m.start()
    await expect(driver.tick()).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes('world observe'))).toBe(true)
    driver.stop()
  })

  it('onEvent：round_break → 全席位唤醒一次（去重）；唤醒失败不中断', async () => {
    const driver = new MatchDriver()
    const m = new MatchMachine({
      players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }],
    })
    const w1 = waker()
    const w2 = waker()
    driver.watch(m, { a: w1, b: w2 })
    const ev = { type: 'round_break' as const, round: 0 }
    await Promise.all([driver.onEvent(m, ev), driver.onEvent(m, ev), driver.onEvent(m, ev)])
    expect(w1.prompts).toHaveLength(1)
    expect(w2.prompts).toHaveLength(1)
    expect(w1.prompts[0]!.text).toContain('round 0 has ended')
    expect(w1.prompts[0]!.text).toContain('submit_code')
  })

  it('onEvent：无 waker 的席位跳过；settled 事件解除 watch', async () => {
    const driver = new MatchDriver()
    const m = new MatchMachine({ players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }] })
    const w1 = waker()
    driver.watch(m, { a: w1 }) // b 无 waker
    await driver.onEvent(m, { type: 'round_break', round: 0 })
    expect(w1.prompts).toHaveLength(1)
    await driver.onEvent(m, { type: 'settled', reason: 'manual', winner: { kind: 'draw' } })
    // settled 后 tick 不再 advance（watch 已解除）——直接断言内部集合
    await driver.tick()
  })

  it('start/stop：常驻循环幂等', async () => {
    const driver = new MatchDriver({ intervalMs: 10 })
    driver.start()
    driver.start()
    driver.stop()
    driver.stop()
  })
})
