import { describe, expect, it } from 'vitest'
import { canTransition, computeScore, configFromPreset, DEFAULT_SCORING, isActivePhase, isMatchConfig, newMatchId, PRESETS } from './model.ts'

describe('match state machine', () => {
  it('walks the happy path creating → placing → running ⇄ paused → settling → settled (M4-B journal)', () => {
    expect(canTransition('creating', 'placing')).toBe(true)
    expect(canTransition('placing', 'running')).toBe(true)
    expect(canTransition('running', 'paused')).toBe(true)
    expect(canTransition('paused', 'running')).toBe(true)
    expect(canTransition('running', 'settling')).toBe(true)
    expect(canTransition('paused', 'settling')).toBe(true)
    expect(canTransition('settling', 'settled')).toBe(true)
    // M4-B：settled 只能经 settlement journal（begin → commit）；settling 不可被通用 interrupted 覆盖
    expect(canTransition('running', 'settled')).toBe(false)
    expect(canTransition('settling', 'interrupted')).toBe(false)
  })

  it('allows interrupted from every pre-settlement active phase and nothing out of terminal phases; settling is active', () => {
    for (const phase of ['creating', 'placing', 'running', 'paused'] as const) {
      expect(canTransition(phase, 'interrupted'), `${phase} → interrupted`).toBe(true)
      expect(isActivePhase(phase)).toBe(true)
    }
    // settling 属于 active（占用单活跃席位），但不允许通用 → interrupted
    expect(isActivePhase('settling')).toBe(true)
    for (const phase of ['settled', 'interrupted'] as const) {
      expect(canTransition(phase, 'running')).toBe(false)
      expect(canTransition(phase, 'interrupted')).toBe(false)
      expect(isActivePhase(phase)).toBe(false)
    }
  })

  it('forbids skipping the pipeline', () => {
    expect(canTransition('creating', 'running')).toBe(false)
    expect(canTransition('placing', 'settling')).toBe(false)
    expect(canTransition('creating', 'settled')).toBe(false)
    expect(canTransition('creating', 'settling')).toBe(false)
  })
})

describe('scoring v1', () => {
  it('computes territory×w1 + rcl×w2 + kills×w3 − losses×w4 + energy×w5', () => {
    expect(computeScore({ territory: 2, rclTotal: 7, kills: 300, losses: 100, energy: 0 }, DEFAULT_SCORING)).toBe(2 * 100 + 7 * 50 + 300 - 100)
  })

  it('energy scoring stays off by default (anti-turtle incentive is opt-in)', () => {
    expect(DEFAULT_SCORING.energy).toBe(0)
    const counters = { territory: 0, rclTotal: 0, kills: 0, losses: 0, energy: 99_999 }
    expect(computeScore(counters, DEFAULT_SCORING)).toBe(0)
  })

  it('arena-blitz zeroes territory/rcl so only kills decide', () => {
    const w = PRESETS['arena-blitz'].scoring
    expect(computeScore({ territory: 1, rclTotal: 8, kills: 50, losses: 0, energy: 0 }, w)).toBe(50)
  })
})

describe('presets & config guard', () => {
  it('freezes code only in world-frozen', () => {
    expect(PRESETS['world-rounds'].frozenCode).toBe(false)
    expect(PRESETS['world-frozen'].frozenCode).toBe(true)
    expect(PRESETS['arena-blitz'].frozenCode).toBe(false)
  })

  it('seats: arena 1v1, world up to 4 by default', () => {
    expect(PRESETS['arena-blitz'].seats).toBe(2)
    expect(PRESETS['world-rounds'].seats).toBe(4)
  })

  it('isMatchConfig accepts preset-derived configs and rejects junk', () => {
    expect(isMatchConfig(configFromPreset('arena-blitz'))).toBe(true)
    expect(isMatchConfig(configFromPreset('world-rounds', { tickDuration: 200 }))).toBe(true)
    expect(isMatchConfig({ form: 'world' })).toBe(false)
    expect(isMatchConfig(null)).toBe(false)
    expect(isMatchConfig(configFromPreset('arena-blitz', { seats: 1 }))).toBe(false)
  })

  it('newMatchId is unique and sortable-ish', () => {
    const a = newMatchId()
    const b = newMatchId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^m[a-z0-9]+$/)
  })
})
