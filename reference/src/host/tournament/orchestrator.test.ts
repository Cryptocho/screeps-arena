import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../canonical.ts'
import type { ScreepsWorldSnapshot, ScreepsService } from '../service.ts'
import { MatchService } from '../match/match-service.ts'
import type { AgentHandleLike, AgentRegistryLike } from '../agents.ts'
import { buildRoundPrompt, TournamentOrchestrator } from './orchestrator.ts'
import { TournamentStore } from './store.ts'
import { defaultTournamentConfig } from './model.ts'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-orch-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function fakeScreeps(): ScreepsService {
  return {
    ensureRunning: async () => ({ port: 1, baseUrl: 'http://x' }),
    system: async () => ({}),
    createUser: async (input: { username: string }) => ({ username: input.username, id: `uid-${input.username}` }),
    restart: async () => {},
    getWorld: async (): Promise<ScreepsWorldSnapshot> => ({ ok: true, gameTime: 1, users: [] }),
    eventLog: async () => ({ events: [], cursor: 0, bound: true }),
  } as unknown as ScreepsService
}

interface FakeHandle extends AgentHandleLike {
  followups: unknown[]
}
interface FakeRegistry extends AgentRegistryLike {
  handles: FakeHandle[]
  created: string[]
}

function makeRegistry(): FakeRegistry {
  const handles: FakeHandle[] = []
  return {
    handles,
    created: [],
    async create(options) {
      this.created.push(options.sessionId)
      const h: FakeHandle = {
        followups: [],
        agent: { id: options.sessionId, followup: msg => h.followups.push(msg) },
        async dispose() {},
      }
      handles.push(h)
      return h
    },
  }
}

/** 用 sessions 构造 ready 赛事（participants 预置），返回 {store, tournamentId, orchestrator, matches, registry}。 */
async function readyTournament(sessions: string[]) {
  const tournamentStore = new TournamentStore(path.join(base, 'tournaments'))
  const matches = new MatchService(fakeScreeps(), path.join(base, 'data'), () => {}, {}, {})
  const registry = makeRegistry()
  const created = await tournamentStore.createRecruiting('req-1', defaultTournamentConfig(sessions.length as 4))
  const participants = sessions.map((sessionId, i) => ({
    participantId: `p${i}`,
    sessionId,
    displayName: `Agent ${i + 1}`,
    seed: i,
  }))
  await tournamentStore.update(created.state.id, created.state.revision, s => {
    s.phase = 'ready'
    s.participants = participants
  })
  const state = await tournamentStore.get(created.state.id)
  // 登记 handles：每个 participant session 一个 handle（模拟 recruit 完成后 handle 在册）
  const handlesByTournament = new Map<string, AgentHandleLike[]>()
  const registered: FakeHandle[] = []
  for (const p of participants) {
    const h = await registry.create({ sessionId: p.sessionId })
    registered.push(h as FakeHandle)
  }
  handlesByTournament.set(created.state.id, registered)
  const orchestrator = new TournamentOrchestrator({
    store: tournamentStore,
    match: matches,
    handlesOf: id => handlesByTournament.get(id) ?? [],
    log: () => {},
  })
  return { tournamentStore, matches, registry, orchestrator, tournamentId: created.state.id, state: state!, handles: registered }
}

describe('buildRoundPrompt', () => {
  it('includes matchId/opponent/roundToken and forbids self-scheduling', () => {
    const prompt = buildRoundPrompt({
      tournamentId: 't1',
      round: 1,
      slotId: 'r1s0',
      attempt: 0,
      matchId: 'm1',
      displayName: 'Agent 1',
      opponentDisplayName: 'Agent 2',
      roundToken: 'rt-secret',
    })
    expect(prompt).toContain('m1')
    expect(prompt).toContain('Agent 2')
    expect(prompt).toContain('rt-secret')
    expect(prompt).toContain('screeps_submit_code')
    expect(prompt).toContain('不要调用 schedule_create')
  })
})

describe('TournamentOrchestrator — activation & advance', () => {
  it('start() builds initial slots and activates round1 slot 0 (creating match, prompting exactly its two agents)', async () => {
    const sessions = ['s1', 's2', 's3', 's4']
    const { tournamentStore, matches, registry, orchestrator, tournamentId, state } = await readyTournament(sessions)
    const running = await orchestrator.start(tournamentId, state.revision)
    expect(running.phase).toBe('running')
    expect(running.slots.map(s => s.slotId)).toEqual(['r1s0', 'r1s1'])
    const r1s0 = running.slots.find(s => s.slotId === 'r1s0')!
    expect(r1s0.phase).toBe('running')
    expect(r1s0.attempts[0]!.phase).toBe('running')
    expect(r1s0.attempts[0]!.matchId).toBeTruthy()
    // 恰好两名（p0/p1）handle 收到 prompt
    const prompted = registry.handles.filter(h => h.followups.length > 0)
    expect(prompted).toHaveLength(2)
    expect(prompted.map(h => h.agent.id).sort()).toEqual(['s1', 's2'])
    // 其余空闲
    expect(registry.handles.filter(h => h.agent.id === 's3')[0]!.followups).toHaveLength(0)
    // roundTokenHash 只存 hash（无明文落盘）
    const match = await matches.store.get(r1s0.attempts[0]!.matchId!)
    expect(match?.roundTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(match?.tournamentId).toBe(tournamentId)
    expect(match?.attempt).toBe(0)
    expect(match?.spawnedBy).toBe('tournament')
    expect(match?.codeMode).toBe('round')
    expect(match?.players.map(p => p.participantId).sort()).toEqual(['p0', 'p1'])
    expect(match?.players.map(p => p.username).every(u => /^[A-Za-z0-9_-]{1,30}$/.test(u))).toBe(true)
  })

  it('second activation is deferred while an active match is present (single-active invariant)', async () => {
    const sessions = ['s1', 's2', 's3', 's4']
    const { tournamentStore, orchestrator, tournamentId, state } = await readyTournament(sessions)
    await orchestrator.start(tournamentId, state.revision)
    // 已有 active（creating）match → activateCurrent 返回 null（等 settle）
    const second = await orchestrator.activateCurrent(tournamentId)
    expect(second).toBeNull()
    // 当前 match 仍未推进：r1s1 pending
    const t = await tournamentStore.get(tournamentId)
    expect(t!.slots.find(s => s.slotId === 'r1s1')!.phase).toBe('pending')
  })

  it('onMatchSettled returns terminal for a completed tournament (no pending work after terminal)', async () => {
    const sessions = ['s1', 's2', 's3', 's4']
    const { tournamentStore, matches, orchestrator, tournamentId, state } = await readyTournament(sessions)
    // 直接建一个赛事 attempt match（不经 start），把赛事置 completed
    const attemptMatch = await matches.createTournamentAttempt({
      tournamentId,
      slotId: 'r1s0',
      attempt: 0,
      roundTokenHash: sha256Hex('rt'),
      players: [
        { sessionId: 's1', username: 'u1', participantId: 'p0' },
        { sessionId: 's2', username: 'u2', participantId: 'p1' },
      ],
    })
    await tournamentStore.update(tournamentId, (await tournamentStore.get(tournamentId))!.revision, s => {
      s.phase = 'completed'
      s.championParticipantId = 'p0'
    })
    const r = await orchestrator.onMatchSettled(attemptMatch.id)
    expect(r).toBe('terminal')
    void state
  })

  it('onMatchSettled returns idle for a match not in the store', async () => {
    const sessions = ['s1', 's2', 's3', 's4']
    const { orchestrator, tournamentId, state } = await readyTournament(sessions)
    void tournamentId
    void state
    const r = await orchestrator.onMatchSettled('unknown-match-not-in-store')
    expect(r).toBe('idle')
  })
})
