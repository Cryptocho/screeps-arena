import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdmissionStore } from './admission/store.ts'
import type { ScreepsWorldSnapshot } from './service.ts'
import type { ScreepsService } from './service.ts'
import { configFromPreset } from './match/model.ts'
import { MatchService } from './match/match-service.ts'
import { TournamentStore } from './tournament/store.ts'
import { RecoveryCoordinator, type RecoveryReport } from './recovery-coordinator.ts'
import { buildInitialSlots, defaultTournamentConfig } from './tournament/model.ts'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-recovery-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function snapshot(gameTime: number): ScreepsWorldSnapshot {
  return { ok: true, gameTime, users: [] }
}

function fakeScreeps(initial: ScreepsWorldSnapshot): ScreepsService {
  let world = initial
  return {
    ensureRunning: async () => ({ port: 1, baseUrl: 'http://x' }),
    system: async () => ({}),
    createUser: async (input: { username: string }) => ({ username: input.username, id: `uid-${input.username}` }),
    restart: async () => {},
    getWorld: async () => world,
    eventLog: async () => ({ events: [], cursor: 0, bound: true }),
  } as unknown as ScreepsService
}

function makeMatches(): MatchService {
  const screeps = fakeScreeps(snapshot(1))
  return new MatchService(screeps, path.join(base, 'data'), () => {}, {}, {})
}

async function newRunningMatch(matches: MatchService, tournamentId?: string): Promise<string> {
  const m = await matches.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'u1' })
  await matches.join(m.id, { sessionId: 's2', username: 'u2' })
  await matches.store.update(m.id, s => {
    s.phase = 'running'
    if (tournamentId) {
      s.tournamentId = tournamentId
      s.tournamentSlotId = 'r1s0'
      s.attempt = 0
      s.players[0]!.participantId = 'p0'
      s.players[1]!.participantId = 'p1'
    }
  })
  return m.id
}

async function beginSettling(matches: MatchService, opts: { tournamentId?: string; modes: 'na' | 'enabled' }): Promise<string> {
  const id = await newRunningMatch(matches, opts.tournamentId)
  const state = (await matches.store.get(id))!
  const mapping = opts.tournamentId
    ? [
        { sessionId: 's1', username: 'u1', participantId: 'p0', displayName: 'Agent 1' },
        { sessionId: 's2', username: 'u2', participantId: 'p1', displayName: 'Agent 2' },
      ]
    : [
        { sessionId: 's1', username: 'u1' },
        { sessionId: 's2', username: 'u2' },
      ]
  const modes =
    opts.modes === 'na'
      ? ({ replay: 'na', history: 'na', tournament: 'na' } as const)
      : ({ replay: 'enabled', history: 'enabled', tournament: 'enabled' } as const)
  await matches.store.beginSettlement(
    id,
    {
      reason: 'manual',
      winner: { kind: 'session', id: 's1' },
      scores: { s1: 1, s2: 0 },
      kills: {},
      losses: {},
      endTick: 10,
      participantMapping: mapping,
    },
    modes,
    state.revision,
  )
  return id
}

async function runningTournament(store: TournamentStore): Promise<{ id: string; revision: number }> {
  const created = await store.createRecruiting('req-1', defaultTournamentConfig(4))
  const participants = ['p0', 'p1', 'p2', 'p3'].map((pid, i) => ({
    participantId: pid,
    sessionId: `s${i}`,
    displayName: `Agent ${i + 1}`,
    seed: i,
  }))
  let s = await store.update(created.state.id, 0, st => {
    st.phase = 'ready'
    st.participants = participants
  })
  const slots = buildInitialSlots(participants)
  s = await store.update(created.state.id, s.revision, st => {
    st.phase = 'running'
    st.currentSlotId = 'r1s0'
    st.slots = slots.map(slot => ({
      ...slot,
      phase: 'running',
      attempts: [{ attempt: 0 as const, matchId: `match-${slot.index}`, phase: 'running' as const }],
    }))
  })
  return { id: created.state.id, revision: s.revision }
}

describe('RecoveryCoordinator', () => {
  it('acquires and releases the recovery reservation; interrupts ordinary active matches', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    const active = await newRunningMatch(matches)
    const coordinator = new RecoveryCoordinator({ admission, matches })
    const report = await coordinator.run()
    expect(report.lockAcquired).toBe(true)
    expect(report.interruptedOrdinary).toContain(active)
    expect((await matches.store.get(active))!.phase).toBe('interrupted')
    // 锁已释放 → 新 admission 可 acquire
    expect(await admission.currentLock()).toBeNull()
    await admission.acquire('legacy-spawn', 'op-1', 'x')
  })

  it('reconciles ordinary settling matches to settled (never recomputes candidate)', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    const settling = await beginSettling(matches, { modes: 'na' })
    const coordinator = new RecoveryCoordinator({ admission, matches })
    const report = await coordinator.run()
    expect(report.reconciled).toContain(settling)
    expect((await matches.store.get(settling))!.phase).toBe('settled')
    expect((await matches.store.get(settling))!.settlement?.candidateHash).toBeTruthy()
    // 对照：另一个实例的普通 running 局被中断
    const admission2 = new AdmissionStore(path.join(base, 'admission2'))
    const matches2 = makeMatches()
    const active = await newRunningMatch(matches2)
    await new RecoveryCoordinator({ admission: admission2, matches: matches2 }).run()
    expect((await matches2.store.get(active))!.phase).toBe('interrupted')
  })

  it('cascades a running tournament with no handles: owned attempt matches interrupted, tournament interrupted', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    const tournaments = new TournamentStore(path.join(base, 'tournaments'))
    const { id: tid } = await runningTournament(tournaments)
    const ownedMatch = await newRunningMatch(matches, tid)
    const coordinator = new RecoveryCoordinator({ admission, matches, tournaments })
    const report = await coordinator.run()
    // owned attempt → interrupted（级联）；普通 active 也中断
    expect((await matches.store.get(ownedMatch))!.phase).toBe('interrupted')
    expect(report.tournamentCascade).toContainEqual({ tournamentId: tid, matches: [ownedMatch] })
    // tournament → interrupted + cleanupUnknown（单活跃席位释放）
    const t = (await tournaments.get(tid))!
    expect(t.phase).toBe('interrupted')
    expect(t.cleanupUnknown).toBeTruthy()
    expect(await admission.currentLock()).toBeNull()
  })

  it('interrupts a recruiting tournament with no handles without inventing a resume', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    const tournaments = new TournamentStore(path.join(base, 'tournaments'))
    const created = await tournaments.createRecruiting('req-9', defaultTournamentConfig(8))
    const coordinator = new RecoveryCoordinator({ admission, matches, tournaments })
    const report = await coordinator.run()
    const t = (await tournaments.get(created.state.id))!
    expect(t.phase).toBe('interrupted')
    expect(report.tournamentInterrupted).toContain(created.state.id)
    // 不自动 resume
    expect(report.tournamentCascade).toEqual([])
  })

  it('aborts a tournament settling match whose markers cannot be reconciled (no drivers after restart)', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    const tournaments = new TournamentStore(path.join(base, 'tournaments'))
    const { id: tid } = await runningTournament(tournaments)
    // tournament-owned settling with enabled markers but NO drivers → reconcile fails → abort
    const settling = await beginSettling(matches, { tournamentId: tid, modes: 'enabled' })
    const coordinator = new RecoveryCoordinator({ admission, matches, tournaments })
    const report = await coordinator.run()
    expect((await matches.store.get(settling))!.phase).toBe('interrupted')
    expect(report.tournamentAborted).toContain(settling)
    expect((await matches.store.get(settling))!.settlement?.error).toContain('recovery')
    const t = (await tournaments.get(tid))!
    expect(t.phase).toBe('interrupted')
  })

  it('is idempotent: a second run is a no-op on already-terminal state', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    const tournaments = new TournamentStore(path.join(base, 'tournaments'))
    const { id: tid } = await runningTournament(tournaments)
    const ownedMatch = await newRunningMatch(matches, tid)
    const coordinator = new RecoveryCoordinator({ admission, matches, tournaments })
    await coordinator.run()
    const report2 = await coordinator.run()
    expect(report2.interruptedOrdinary).toEqual([])
    expect(report2.tournamentCascade).toEqual([])
    expect((await matches.store.get(ownedMatch))!.phase).toBe('interrupted')
    expect((await tournaments.get(tid))!.phase).toBe('interrupted')
  })

  it('collects diagnostics without hiding corrupt state', async () => {
    const admission = new AdmissionStore(path.join(base, 'admission'))
    const matches = makeMatches()
    // 造一个坏 match 目录
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(path.join(base, 'data', 'matches', 'zzz-bad'), { recursive: true })
    writeFileSync(path.join(base, 'data', 'matches', 'zzz-bad', 'state.json'), '{oops')
    const coordinator = new RecoveryCoordinator({ admission, matches })
    const report: RecoveryReport = await coordinator.run()
    expect(report.diagnostics.some(d => d.scope === 'match' && d.id === 'zzz-bad')).toBe(true)
  })
})
