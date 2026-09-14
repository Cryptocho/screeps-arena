/**
 * M5/S1 单测（plan-M5 D1/D4）：preset 表与 configFromPreset 校验、MatchMachine 的
 * arena 语义（running 期热更 / advance no-op / world 负向保持）。
 */
import { describe, expect, it } from 'vitest'
import { MatchMachine, FROZEN_DURING_ROUND } from '../src/server/match/machine.js'
import { PRESETS, configFromPreset, DEFAULT_MATCH_CONFIG } from '../src/server/match/model.js'
import type { MatchPreset } from '../src/server/match/model.js'

describe('M5/D1 preset 表', () => {
  it('arena-blitz = 旧表原值；world-rounds = 现网裁剪值', () => {
    expect(PRESETS['arena-blitz']).toEqual({ form: 'arena', tickDuration: 150, maxTicks: 2000, seats: 2 })
    expect(PRESETS['world-rounds']).toEqual({ form: 'world', tickDuration: 200, maxTicks: 0, seats: 2 })
  })

  it('configFromPreset：预设展开 + 显式覆盖', () => {
    const c = configFromPreset('arena-blitz')
    expect(c.form).toBe('arena')
    expect(c.maxTicks).toBe(2000)
    expect(c.seats).toBe(2)
    // round 系字段对 arena 无意义但保持 DEFAULT 形状（D1 决策：不参数化 scoring）
    expect(c.roundMs).toBe(DEFAULT_MATCH_CONFIG.roundMs)
    const o = configFromPreset('arena-blitz', { maxTicks: 100 })
    expect(o.maxTicks).toBe(100)
    const w = configFromPreset('world-rounds')
    expect(w).toEqual({ ...DEFAULT_MATCH_CONFIG, form: 'world', maxTicks: 0 })
  })

  it('未知 preset 抛错', () => {
    expect(() => configFromPreset('nope' as MatchPreset)).toThrow(/unknown preset/)
  })

  it('DEFAULT_MATCH_CONFIG 回归：world/0（现行为零改动）', () => {
    expect(DEFAULT_MATCH_CONFIG.form).toBe('world')
    expect(DEFAULT_MATCH_CONFIG.maxTicks).toBe(0)
  })
})

describe('M5/D4 arena 语义（machine）', () => {
  const mk = (form: 'world' | 'arena'): MatchMachine =>
    new MatchMachine({
      players: [
        { seatId: 'a', username: 'ua' },
        { seatId: 'b', username: 'ub' },
      ],
      config: { form },
    })

  it('world：running 期提交拒绝（FROZEN 负向，回归钉住）', () => {
    const m = mk('world')
    m.submitCode('a', { main: 'x' })
    m.submitCode('b', { main: 'x' })
    m.start()
    expect(() => m.submitCode('a', { main: 'y' })).toThrow(FROZEN_DURING_ROUND)
  })

  it('arena：running 期热更——更新 code/submittedAt、不动 ready、不触发事件', () => {
    const m = mk('arena')
    m.submitCode('a', { main: 'v1' })
    m.submitCode('b', { main: 'v1' })
    m.start()
    const events: string[] = []
    // 重新挂 onEvent 不可行（readonly）——以 phase 不变 + code 更新断言代替
    m.submitCode('a', { main: 'v2' }, 12345)
    expect(m.phase).toBe('running')
    expect(m.players[0]!.code).toEqual({ main: 'v2' })
    expect(m.players[0]!.submittedAt).toBe(12345)
    expect(m.players[0]!.ready).toBe(true) // start 时置位后不再被热更扰动
    expect(events).toEqual([])
  })

  it('arena：advance no-op——running 满一个 roundMs 不进 roundBreak', () => {
    const m = mk('arena')
    m.submitCode('a', { main: 'x' })
    m.submitCode('b', { main: 'x' })
    m.start(0)
    m.advance(60_000 + 1) // 远超 roundMs=60s
    expect(m.phase).toBe('running')
    expect(m.state.roundIndex).toBe(0)
  })

  it('world：advance 周期到点进 roundBreak（回归保护）', () => {
    const m = mk('world')
    m.submitCode('a', { main: 'x' })
    m.submitCode('b', { main: 'x' })
    m.start(0)
    m.advance(60_000)
    expect(m.phase).toBe('roundBreak')
  })

  it('restore 旧 journal（无 form/maxTicks 字段）→ world/0 默认（向后兼容）', () => {
    const m = MatchMachine.restore({
      id: 'mold',
      config: { seats: 2, roundMs: 1000, roundBreakTimeoutMs: 2000, maxRounds: 4 } as never,
      players: [
        { seatId: 'a', username: 'ua', ready: true, code: { main: 'x' } },
        { seatId: 'b', username: 'ub', ready: true, code: { main: 'x' } },
      ],
      state: { createdAt: 1, phase: 'running', roundIndex: 0, errors: [] },
    })
    expect(m.config.form).toBe('world')
    expect(m.config.maxTicks).toBe(0)
  })
})
