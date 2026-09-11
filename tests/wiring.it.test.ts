/**
 * S4 接线 IT（复审问题 3）——证明 createMatch → driver.watch + waker 在**真实运行路径**上成立：
 * 经 createArenaDevServices 创建对局后，真实时钟 tick 能推到 roundBreak 并唤醒席位。
 * 这是 dev-server 与任何真实组装共用的同一份代码路径。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MatchDriver } from '../src/server/http/driver.js'
import type { SeatWaker } from '../src/server/http/driver.js'
import { createArenaDevServices } from '../src/server/http/dev-services.js'

function spyWaker(): SeatWaker & { prompts: string[] } {
  const prompts: string[] = []
  return { prompts, prompt: async (_s, t) => { prompts.push(t) } }
}

const drivers: MatchDriver[] = []
afterEach(() => { for (const d of drivers) d.stop(); drivers.length = 0 })

describe('S4 接线（createMatch → watch + waker）', () => {
  it('经 createMatch 创建后，真实时钟 tick 推进到 roundBreak 并唤醒席位', async () => {
    const driver = new MatchDriver({ intervalMs: 10 })
    drivers.push(driver)
    const wakers: Record<string, ReturnType<typeof spyWaker>> = { a: spyWaker(), b: spyWaker() }
    const { services, machines } = createArenaDevServices({
      driver,
      makeWaker: (seatId) => wakers[seatId]!,
    })

    const m = services.createMatch({
      players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }],
      config: { roundMs: 20, roundBreakTimeoutMs: 60_000, maxRounds: 8 },
    })
    expect(machines.get(m.id)).toBe(m)

    // 全员提交 → start（start(now) 回拨避免等待）
    m.submitCode('a', { main: 'module.exports.loop=function(){}' })
    m.submitCode('b', { main: 'module.exports.loop=function(){}' })
    m.start(Date.now() - 100)

    // 真实时钟：不经任何手工 onEvent，只调 tick
    await driver.tick()
    expect(m.phase).toBe('roundBreak')
    // roundBreak 唤醒已由 onEvent 链触发（createMatch 的 onEvent → driver.onEvent）
    await new Promise((r) => setTimeout(r, 20))
    // started（开跑通知）+ round_break（战报唤醒）各一次
    expect(wakers.a!.prompts).toHaveLength(2)
    expect(wakers.b!.prompts).toHaveLength(2)
    expect(wakers.a!.prompts[0]).toContain('round 0 is starting')
    expect(wakers.a!.prompts[1]).toContain('round 0 has ended')
  })

  it('roundBreak 超时兜底：真实时钟下自动 ready 续跑（无 waker 也不卡死）', async () => {
    const driver = new MatchDriver({ intervalMs: 10 })
    drivers.push(driver)
    const { services } = createArenaDevServices({ driver })
    const m = services.createMatch({
      players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }],
      config: { roundMs: 20, roundBreakTimeoutMs: 30, maxRounds: 8 },
    })
    m.submitCode('a', { main: 'module.exports.loop=function(){}' })
    m.submitCode('b', { main: 'module.exports.loop=function(){}' })
    m.start(Date.now() - 100)
    await driver.tick() // → roundBreak
    expect(m.phase).toBe('roundBreak')
    // 人为把 roundBreakSince 回拨到超时前 → 下一次 tick 触发兜底续跑
    m.state.roundBreakSince = Date.now() - 1000
    await driver.tick()
    expect(m.phase).toBe('running')
    expect(m.state.roundIndex).toBe(1)
    expect(m.state.errors.some((e) => e.includes('auto-ready'))).toBe(true)
  })
})
