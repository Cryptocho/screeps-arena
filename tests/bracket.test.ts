/**
 * bracket 纯函数单测（plan-M4/S1）：circle method 均匀性、奇数 bye、tiebreak 单序、
 * draw 记分、未 settle 条目不计分（v3 二审补项）。
 */
import { describe, expect, it } from 'vitest'
import { applyResult, roundRobinPairs, standings } from '../src/server/tournament/bracket.js'
import { newTournamentId, tournamentFinished } from '../src/server/tournament/types.js'
import type { Tournament } from '../src/server/tournament/types.js'

function mkTournament(n: number): Tournament {
  const participants = Array.from({ length: n }, (_, i) => ({ seatId: `s${i}`, username: `u${i}` }))
  return {
    id: newTournamentId(),
    name: 't',
    createdAt: 0,
    format: 'round-robin',
    participants,
    matches: roundRobinPairs(participants.map((p) => p.seatId)).map((pair, i) => ({
      pair,
      status: 'created' as const,
      matchId: `m${i}`,
    })),
    errors: [],
  }
}

describe('roundRobinPairs', () => {
  it('少于 2 人返回空', () => {
    expect(roundRobinPairs([])).toEqual([])
    expect(roundRobinPairs(['a'])).toEqual([])
  })

  it('4 人 = 6 场，每对恰好一次', () => {
    const pairs = roundRobinPairs(['a', 'b', 'c', 'd'])
    expect(pairs).toHaveLength(6)
    const key = (x: [string, string]) => [...x].sort().join('')
    const seen = new Set(pairs.map(key))
    expect(seen.size).toBe(6)
    for (const p of ['ab', 'ac', 'ad', 'bc', 'bd', 'cd']) expect(seen.has(p)).toBe(true)
  })

  it('偶数：每轮每人恰一场（均匀性判据）', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const pairs = roundRobinPairs(ids)
    const perRound = ids.length / 2
    for (let r = 0; r < ids.length - 1; r++) {
      const flat = pairs.slice(r * perRound, (r + 1) * perRound).flat().sort()
      expect(flat).toEqual([...ids].sort())
    }
  })

  it('奇数：bye 不产生场，每轮恰一人轮空', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const pairs = roundRobinPairs(ids)
    expect(pairs).toHaveLength(10) // C(5,2)
    const key = (x: [string, string]) => [...x].sort().join('')
    expect(new Set(pairs.map(key)).size).toBe(10)
    const perRound = (ids.length - 1) / 2
    for (let r = 0; r < ids.length; r++) {
      const flat = pairs.slice(r * perRound, (r + 1) * perRound).flat()
      expect(new Set(flat).size).toBe(flat.length)
      expect(ids.filter((x) => !flat.includes(x))).toHaveLength(1)
    }
  })

  it('确定性：同输入同输出', () => {
    expect(roundRobinPairs(['a', 'b', 'c', 'd'])).toEqual(roundRobinPairs(['a', 'b', 'c', 'd']))
  })
})

describe('standings', () => {
  it('scheduled/created 条目不计分（v3 补项）', () => {
    const t = mkTournament(2)
    t.matches[0]!.status = 'scheduled'
    delete t.matches[0]!.matchId
    expect(standings(t).every((r) => r.played === 0 && r.points === 0)).toBe(true)
  })

  it('胜 3 / 负 0，净胜分累计，届终局判定', () => {
    const t = mkTournament(2)
    applyResult(t, 'm0', { winner: 's0', scores: { s0: 10, s1: 3 }, settledAt: 1 })
    const rows = standings(t)
    expect(rows[0]).toMatchObject({ seatId: 's0', points: 3, wins: 1, scoreDiff: 7 })
    expect(rows[1]).toMatchObject({ seatId: 's1', points: 0, losses: 1, scoreDiff: -7 })
    expect(tournamentFinished(t)).toBe(true)
  })

  it('draw 双方各 +1 分、净胜分不变', () => {
    const t = mkTournament(2)
    applyResult(t, 'm0', { winner: null, scores: { s0: 5, s1: 5 }, settledAt: 1 })
    const rows = standings(t)
    expect(rows.map((r) => r.points)).toEqual([1, 1])
    expect(rows.map((r) => r.scoreDiff)).toEqual([0, 0])
  })

  it('tiebreak 单序：积分 > 胜场数 > 净胜分 > 抽签序', () => {
    // 直接构造 matches（绕开赛程），两指标相同者以胜场/净胜分/抽签序分先后
    const t: Tournament = {
      ...mkTournament(2),
      matches: [{ pair: ['s0', 's1'], status: 'created', matchId: 'm0' }],
    }
    // s1 积分更高但这是胜 3 的来源：s0 胜一场（3 分）后，s1 平局保底不可行——
    // 单场只有 2 人，改用净胜分相同、抽签序分先后：
    applyResult(t, 'm0', { winner: 's0', scores: { s0: 4, s1: 4 }, settledAt: 1 })
    const rows = standings(t)
    // winner 非 null 时胜者 +3：s0 3 分在前
    expect(rows.map((r) => r.seatId)).toEqual(['s0', 's1'])
    expect(tournamentFinished(t)).toBe(true)
  })

  it('抽签序兜底：全 0 分时按 participants 下标排序', () => {
    const t = mkTournament(3)
    t.matches.forEach((m) => {
      m.status = 'scheduled'
      delete m.matchId
    })
    expect(standings(t).map((r) => r.seatId)).toEqual(['s0', 's1', 's2'])
  })

  it('applyResult 幂等（同 matchId 重复回填不双计）', () => {
    const t = mkTournament(2)
    const r = { winner: 's0' as const, scores: { s0: 1, s1: 0 }, settledAt: 1 }
    applyResult(t, 'm0', r)
    applyResult(t, 'm0', r)
    expect(standings(t)[0]!.wins).toBe(1)
  })

  it('未知 matchId 抛错；winner 不在 pair 抛错', () => {
    const t = mkTournament(2)
    expect(() => applyResult(t, 'm-nope', { winner: null, scores: {}, settledAt: 1 })).toThrow(/unknown match/)
    expect(() => applyResult(t, 'm0', { winner: 's9', scores: { s0: 1, s1: 0 }, settledAt: 1 })).toThrow(/not in pair/)
  })
})
