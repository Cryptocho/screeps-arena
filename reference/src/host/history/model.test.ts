import { describe, expect, it } from 'vitest'
import { hashV1 } from '../canonical.ts'
import {
  aggregateLeaderboard,
  toResultHash,
  type LeaderboardRow,
  type MatchResult,
} from './model.ts'

function result(over: Partial<MatchResult> & { resultId: string }): MatchResult {
  return {
    preset: 'arena-blitz',
    phase: 'settled',
    winner: { kind: 'draw' },
    scores: {},
    participantSnapshot: [],
    kills: {},
    losses: {},
    endTick: 1000,
    createdAt: 1,
    ...over,
  }
}

function tournamentResult(opts: {
  resultId: string
  tournamentId: string
  pids: string[] // [winner, loser]；空 = draw 双方
  attempt?: 0 | 1
  scoreOf: Record<string, number>
  killsOf?: Record<string, number>
  lossesOf?: Record<string, number>
  aborted?: boolean
}): MatchResult {
  const names = new Map(opts.pids.map((pid, i) => [pid, `Agent ${i + 1}`]))
  const pids = opts.pids.length === 0 ? Object.keys(opts.scoreOf) : opts.pids
  const participantSnapshot = pids.map(pid => ({ participantId: pid, displayName: names.get(pid) ?? pid, username: `u_${pid}` }))
  const winner = opts.pids.length === 0 ? ({ kind: 'draw' } as const) : ({ kind: 'participant', participantId: opts.pids[0]! } as const)
  const scores: Record<string, number> = {}
  const kills: Record<string, number> = {}
  const losses: Record<string, number> = {}
  for (const pid of pids) {
    scores[pid] = opts.scoreOf[pid] ?? 0
    kills[pid] = opts.killsOf?.[pid] ?? 0
    losses[pid] = opts.lossesOf?.[pid] ?? 0
  }
  return result({
    resultId: opts.resultId,
    tournamentId: opts.tournamentId,
    attempt: opts.attempt,
    winner,
    scores,
    participantSnapshot,
    kills,
    losses,
    diagnostics: opts.aborted ? 'settlement-aborted' : undefined,
  })
}

describe('toResultHash (canonical resultHash, hashVersion=1)', () => {
  it('is deterministic and changes when any fixed field changes', () => {
    const r = tournamentResult({ resultId: 'm1', tournamentId: 't1', pids: ['pa', 'pb'], scoreOf: { pa: 10, pb: 0 } })
    expect(toResultHash(r)).toMatch(/^[0-9a-f]{64}$/)
    expect(toResultHash(r)).toBe(toResultHash(JSON.parse(JSON.stringify(r)) as MatchResult))
    expect(toResultHash(r)).not.toBe(toResultHash({ ...r, endTick: 1001 }))
    expect(toResultHash(r)).not.toBe(toResultHash({ ...r, attempt: 1 }))
    expect(toResultHash(r)).not.toBe(toResultHash({ ...r, winner: { kind: 'draw' } }))
  })

  it('matches manual hashV1 of the fixed field set (resultId/preset/phase/winner/scores/snapshot/kills/losses/endTick)', () => {
    const r = tournamentResult({ resultId: 'm1', tournamentId: 't1', pids: ['pa', 'pb'], scoreOf: { pa: 5, pb: 3 } })
    const manual = hashV1({
      resultId: 'm1',
      tournamentId: 't1',
      preset: 'arena-blitz',
      phase: 'settled',
      winner: { kind: 'participant', participantId: 'pa' },
      scores: { pa: 5, pb: 3 },
      participantSnapshot: [
        { participantId: 'pa', displayName: 'Agent 1', username: 'u_pa' },
        { participantId: 'pb', displayName: 'Agent 2', username: 'u_pb' },
      ],
      kills: { pa: 0, pb: 0 },
      losses: { pa: 0, pb: 0 },
      endTick: 1000,
    })
    expect(toResultHash(r)).toBe(manual)
  })
})

describe('aggregateLeaderboard', () => {
  const t1 = 't1'

  it('counts wins/losses/matches and aggregates score/kills/losses', () => {
    const results = [
      tournamentResult({ resultId: 'm1', tournamentId: t1, pids: ['pa', 'pb'], scoreOf: { pa: 10, pb: 0 }, killsOf: { pa: 2 }, lossesOf: { pb: 1 } }),
      tournamentResult({ resultId: 'm2', tournamentId: t1, pids: ['pc', 'pd'], scoreOf: { pc: 8, pd: 1 }, killsOf: { pc: 1 }, lossesOf: { pd: 1 } }),
    ]
    const { rows } = aggregateLeaderboard(results)
    const byId = new Map(rows.map(r => [r.participantId, r]))
    expect(byId.get('pa')).toMatchObject({ wins: 1, losses: 0, matches: 1, scoreTotal: 10, kills: 2 })
    expect(byId.get('pb')).toMatchObject({ wins: 0, losses: 1, matches: 1, scoreTotal: 0, lossesTaken: 1 })
    expect(byId.get('pc')).toMatchObject({ wins: 1, matches: 1, scoreTotal: 8 })
    expect(rows).toHaveLength(4)
  })

  it('rematch attempts count separately (two attempts → matches=2 per participant)', () => {
    const results = [
      tournamentResult({ resultId: 'm1a', tournamentId: t1, pids: ['pa', 'pb'], scoreOf: { pa: 5, pb: 0 } }),
      tournamentResult({ resultId: 'm1b', tournamentId: t1, attempt: 1, pids: ['pb', 'pa'], scoreOf: { pa: 0, pb: 6 } }),
    ]
    const { rows } = aggregateLeaderboard(results)
    const pa = rows.find(r => r.participantId === 'pa')!
    const pb = rows.find(r => r.participantId === 'pb')!
    expect(pa).toMatchObject({ wins: 1, losses: 1, matches: 2, scoreTotal: 5 })
    expect(pb).toMatchObject({ wins: 1, losses: 1, matches: 2, scoreTotal: 6 })
  })

  it('draws add matches/draws but not wins/losses', () => {
    const results = [
      tournamentResult({ resultId: 'm1', tournamentId: t1, pids: [], scoreOf: { pa: 5, pb: 5 } }),
    ]
    const { rows } = aggregateLeaderboard(results)
    expect(rows.find(r => r.participantId === 'pa')).toMatchObject({ wins: 0, losses: 0, draws: 1, matches: 1 })
    expect(rows.find(r => r.participantId === 'pb')).toMatchObject({ draws: 1, matches: 1 })
  })

  it('excludes ordinary M3 results (no participantId) and aborted orphans', () => {
    const ordinary = result({
      resultId: 'm9',
      winner: { kind: 'session', sessionId: 'sess-1' },
      scores: { 'sess-1': 10 },
      participantSnapshot: [{ sessionId: 'sess-1', username: 'u1' }],
    })
    const aborted = tournamentResult({ resultId: 'm8', tournamentId: t1, pids: ['pa', 'pb'], scoreOf: { pa: 1, pb: 0 }, aborted: true })
    const { rows } = aggregateLeaderboard([ordinary, aborted, tournamentResult({ resultId: 'm1', tournamentId: t1, pids: ['pa', 'pb'], scoreOf: { pa: 1, pb: 0 } })])
    expect(rows.some(r => r.participantId === 'sess-1')).toBe(false)
    expect(rows.find(r => r.participantId === 'pa')!.matches).toBe(1) // 只有未 abort 的一场
  })

  it('sorts by scoreTotal desc, wins desc, participantId asc', () => {
    const results = [
      tournamentResult({ resultId: 'm1', tournamentId: t1, pids: ['za', 'zb'], scoreOf: { za: 20, zb: 0 } }),
      tournamentResult({ resultId: 'm2', tournamentId: t1, pids: ['ya', 'yb'], scoreOf: { ya: 30, yb: 0 } }),
      tournamentResult({ resultId: 'm3', tournamentId: t1, pids: ['xa', 'xb'], scoreOf: { xa: 20, xb: 0 } }),
    ]
    const ids = aggregateLeaderboard(results).rows.map(r => r.participantId)
    expect(ids[0]).toBe('ya')
    // 20 分组：xa < za（pid asc）；0 分组：xb < yb < zb
    expect(ids).toEqual(['ya', 'xa', 'za', 'xb', 'yb', 'zb'])
  })

  it('shares rank within a tie and keeps tied groups whole under limit (hasMore)', () => {
    const results = [
      tournamentResult({ resultId: 'm1', tournamentId: t1, pids: ['pa', 'pb'], scoreOf: { pa: 10, pb: 0 } }),
      tournamentResult({ resultId: 'm2', tournamentId: t1, pids: ['pc', 'pd'], scoreOf: { pc: 10, pd: 0 } }),
      tournamentResult({ resultId: 'm3', tournamentId: t1, pids: ['pe', 'pf'], scoreOf: { pe: 5, pf: 0 } }),
    ]
    const page = aggregateLeaderboard(results, { limit: 2 })
    // pa/pc 同 10 分共享 rank1（tie 组整保留 = 2 行）；pe 不同分在组外 → 截断 + hasMore
    expect(page.rows).toHaveLength(2)
    expect(page.rows[0]).toMatchObject({ participantId: 'pa', rank: 1 })
    expect(page.rows[1]).toMatchObject({ participantId: 'pc', rank: 1 })
    expect(page.hasMore).toBe(true)
    // 3 人 tie 组 + limit=1：并列组不拦腰截断 → 3 行全保留
    const tied = aggregateLeaderboard(
      [
        tournamentResult({ resultId: 'm1', tournamentId: t1, pids: ['pa', 'pd'], scoreOf: { pa: 10, pd: 0 } }),
        tournamentResult({ resultId: 'm2', tournamentId: t1, pids: ['pb', 'pe'], scoreOf: { pb: 10, pe: 0 } }),
        tournamentResult({ resultId: 'm3', tournamentId: t1, pids: ['pc', 'pf'], scoreOf: { pc: 10, pf: 0 } }),
      ],
      { limit: 1 },
    )
    expect(tied.rows).toHaveLength(3)
    expect(tied.rows.every(r => r.rank === 1)).toBe(true)
    expect(tied.hasMore).toBe(true)
    // 无 limit 全量
    const full = aggregateLeaderboard(results)
    expect(full.rows).toHaveLength(6)
    expect(full.hasMore).toBe(false)
  })

  it('filters by tournamentId when requested', () => {
    const t2 = 't2'
    const results = [
      tournamentResult({ resultId: 'm1', tournamentId: t1, pids: ['pa', 'pb'], scoreOf: { pa: 1, pb: 0 } }),
      tournamentResult({ resultId: 'm2', tournamentId: t2, pids: ['qa', 'qb'], scoreOf: { qa: 99, qb: 0 } }),
    ]
    const rows = aggregateLeaderboard(results, { tournamentId: t1 }).rows as LeaderboardRow[]
    expect(rows.every(r => r.participantId.startsWith('p'))).toBe(true)
    expect(rows.some(r => r.participantId === 'qa')).toBe(false)
  })
})
