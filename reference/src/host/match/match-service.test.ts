import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScreepsWorldSnapshot, ScreepsService } from '../service.ts'
import { MatchService } from './match-service.ts'
import { buildMatchResult, toResultHash, type MatchResult } from '../history/model.ts'
import type { MatchState, SettlementJournal } from './model.ts'
import type { SettlementDrivers } from './lifecycle.ts'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-msvc-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function snapshot(): ScreepsWorldSnapshot {
  return { ok: true, gameTime: 42, users: [] }
}

function fakeScreeps(): ScreepsService {
  return {
    ensureRunning: async () => ({ port: 1, baseUrl: 'http://x' }),
    system: async () => ({}),
    createUser: async (input: { username: string }) => ({ username: input.username, id: `uid-${input.username}` }),
    restart: async () => {},
    getWorld: async () => snapshot(),
    eventLog: async () => ({ events: [], cursor: 0, bound: true }),
  } as unknown as ScreepsService
}

function fullDrivers(): SettlementDrivers {
  return {
    replay: async (match: MatchState) => ({
      receipt: { resultId: match.id, payloadHash: 'rep-hash', replayId: 'rep-1' },
      completeness: 'complete' as const,
      gapReasons: [],
    }),
    history: async (m: MatchState, j: SettlementJournal) => {
      const r = buildMatchResult(m, j)
      return { resultId: m.id, resultHash: toResultHash(r) }
    },
    tournament: {
      applyResult: async (matchId: string, result: MatchResult) => ({
        resultId: matchId,
        resultHash: toResultHash(result),
        outcome: 'won' as const,
        slotRevision: 1,
      }),
    },
  }
}

async function runningMatch(matches: MatchService, tournament = false): Promise<string> {
  const m = await matches.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'u1' })
  await matches.join(m.id, { sessionId: 's2', username: 'u2' })
  await matches.store.update(m.id, s => {
    s.phase = 'running'
    if (tournament) {
      s.tournamentId = 't1'
      s.tournamentSlotId = 'r1s0'
      s.attempt = 0
      s.players.forEach((p, i) => {
        p.participantId = `p${i}`
        p.userId = `uid-${p.username}`
      })
    }
  })
  return m.id
}

describe('MatchService — settle dispose branches (M4-B)', () => {
  it('ordinary settle: onSettled hook receives the committed state and cleanup is committed', async () => {
    const hook = vi.fn(async (_state: MatchState) => {})
    const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, { onSettled: hook })
    const id = await runningMatch(matches)
    const settled = await matches.settle(id, 'manual')
    expect(settled.phase).toBe('settled')
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]![0]).toMatchObject({ id, phase: 'settled' })
    // cleanup marker 在 settle 返回后由收尾写盘 → 从 store 重读最新
    const latest = (await matches.store.get(id))!
    expect(latest.settlement?.cleanup.status).toBe('committed')
  })

  it('ordinary settle with a failing hook: committed result stands, cleanup marked unknown with error', async () => {
    const hook = vi.fn(async (_state: MatchState) => {
      throw new Error('dispose boom')
    })
    const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, { onSettled: hook })
    const id = await runningMatch(matches)
    const settled = await matches.settle(id, 'manual')
    expect(settled.phase).toBe('settled') // 不回滚已 committed
    const latest = (await matches.store.get(id))!
    expect(latest.settlement?.cleanup.status).toBe('unknown')
    expect(latest.settlement?.cleanup.error).toContain('dispose boom')
  })

  it('tournament settle: hook is still forwarded (orchestrator notify) and cleanup stays not-applicable', async () => {
    const hook = vi.fn(async (_state: MatchState) => {})
    const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, { onSettled: hook }, fullDrivers())
    const id = await runningMatch(matches, true)
    const settled = await matches.settle(id, 'manual')
    expect(settled.phase).toBe('settled')
    expect(hook).toHaveBeenCalledTimes(1)
    expect(settled.settlement?.cleanup.status).toBe('not-applicable')
    expect(settled.settlement?.tournament.status).toBe('committed')
    expect(settled.settlement?.tournament.receipt?.storeRevision).toBe(1)
  })

  it('a settled tournament-owned match keeps its journal (history receipt present) and is never ordinary-deleted', async () => {
    const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, {}, fullDrivers())
    const id = await runningMatch(matches, true)
    await matches.settle(id, 'manual')
    const state = await matches.store.get(id)
    expect(state!.phase).toBe('settled')
    expect(state!.tournamentId).toBe('t1')
    expect(state!.settlement?.history.receipt?.resultId).toBe(id)
    expect(state!.settlement?.replay.receipt?.replayId).toBe('rep-1')
  })
})
