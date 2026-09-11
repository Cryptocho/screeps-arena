import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryError, HistoryStore } from './store.ts'
import { toResultHash, type MatchResult } from './model.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-hist-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeResult(matchId: string, opts: { winnerPid?: string; aborted?: boolean; scoreOf?: Record<string, number> } = {}): MatchResult {
  const pids = ['pa', 'pb']
  const scoreOf = opts.scoreOf ?? { pa: 10, pb: 0 }
  const winner = opts.winnerPid === undefined ? { kind: 'draw' as const } : { kind: 'participant' as const, participantId: opts.winnerPid }
  return {
    resultId: matchId,
    tournamentId: 't1',
    attempt: 0,
    preset: 'arena-blitz',
    phase: 'settled',
    winner,
    scores: scoreOf,
    participantSnapshot: pids.map(pid => ({ participantId: pid, displayName: pid })),
    kills: {},
    losses: {},
    endTick: 100,
    createdAt: 1,
    diagnostics: opts.aborted ? 'settlement-aborted' : undefined,
  }
}

describe('HistoryStore', () => {
  it('puts a result immutably and returns its canonical resultHash', async () => {
    const store = new HistoryStore(path.join(dir, 'history'))
    const r = makeResult('m1', { winnerPid: 'pa' })
    const out = await store.put(r)
    expect(out.kind).toBe('ok')
    expect(out.resultHash).toBe(toResultHash(r))
    expect(out.resultHash).toMatch(/^[0-9a-f]{64}$/)
    expect((await store.get('m1'))?.resultId).toBe('m1')
  })

  it('is idempotent for the same result and corrupt on same id different hash (never overwrites)', async () => {
    const store = new HistoryStore(path.join(dir, 'history'))
    await store.put(makeResult('m1', { winnerPid: 'pa' }))
    const again = await store.put(makeResult('m1', { winnerPid: 'pa' }))
    expect(again.kind).toBe('idempotent')
    await expect(store.put(makeResult('m1', { winnerPid: 'pb' }))).rejects.toMatchObject({ code: 'corrupt' })
    const got = await store.get('m1')
    expect(got?.winner).toEqual({ kind: 'participant', participantId: 'pa' })
  })

  it('markDiagnostics keeps the resultHash stable (diagnostics not in the hash field set)', async () => {
    const store = new HistoryStore(path.join(dir, 'history'))
    const r = makeResult('m1', { winnerPid: 'pa' })
    await store.put(r)
    await store.markDiagnostics('m1', 'settlement-aborted')
    const got = await store.get('m1')
    expect(got?.diagnostics).toBe('settlement-aborted')
    expect(toResultHash(got!)).toBe(toResultHash(r))
    await expect(store.markDiagnostics('nope', 'settlement-aborted')).rejects.toMatchObject({ code: 'notFound' })
  })

  it('leaderboard excludes aborted orphans and ordinary (no participantId) results', async () => {
    const store = new HistoryStore(path.join(dir, 'history'))
    await store.put(makeResult('m1', { winnerPid: 'pa' }))
    await store.put(makeResult('m2', { winnerPid: 'pb', aborted: true }))
    await store.put({
      resultId: 'm9',
      preset: 'arena-blitz',
      phase: 'settled',
      winner: { kind: 'session', sessionId: 'sess-1' },
      scores: { 'sess-1': 5 },
      participantSnapshot: [{ sessionId: 'sess-1', username: 'u1' }],
      kills: {},
      losses: {},
      endTick: 1,
      createdAt: 1,
    })
    const page = await store.leaderboard({ tournamentId: 't1' })
    const pids = page.rows.map(r => r.participantId)
    expect(pids).toContain('pa') // winner 进榜
    expect(pids).toContain('pb') // m1 的 loser 进榜
    expect(pids).not.toContain('sess-1')
  })

  it('scanDiagnostics reports corrupt files without breaking list()', async () => {
    const store = new HistoryStore(path.join(dir, 'history'))
    await store.put(makeResult('m1', { winnerPid: 'pa' }))
    writeFileSync(path.join(dir, 'history', 'bad.json'), '{oops')
    expect((await store.list()).map(x => x.resultId)).toEqual(['m1'])
    const diags = await store.scanDiagnostics()
    expect(diags.some(d => d.id === 'bad')).toBe(true)
  })
})
