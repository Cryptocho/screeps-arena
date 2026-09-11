/**
 * M4-D HTTP 路由单测：tournaments / history/leaderboard / matches/:id/replay 端点的
 * route-core 行为（用真实 store + fake backend；settle 由 lifecycle 驱动）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ScreepsWorldSnapshot, ScreepsService } from './service.ts'
import { MatchService } from './match/match-service.ts'
import { buildMatchResult, toResultHash } from './history/model.ts'
import type { MatchState, SettlementJournal } from './match/model.ts'
import { handleArenaRequest, type ArenaHttpServices } from './http.ts'
import { TournamentStore } from './tournament/store.ts'
import { TournamentService } from './tournament/service.ts'
import { TournamentGateway } from './tournament/gateway.ts'
import { defaultTournamentConfig } from './tournament/model.ts'
import { AdmissionStore } from './admission/store.ts'
import { AdmissionGate } from './admission/gate.ts'
import { HistoryStore } from './history/store.ts'
import { ReplayStore } from './replay/store.ts'
import type { ReplayRecord } from './replay/model.ts'
import { TournamentOrchestrator } from './tournament/orchestrator.ts'
import { sha256Hex } from './canonical.ts'

let base: string
let dirs: string[]
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-screeps-http-m4-'))
  dirs = [base]
})
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const GEN = 'g-http'

function frame(seq: number): ReplayRecord {
  return {
    schemaVersion: 1,
    sourceGeneration: GEN,
    replayId: 'r-m1',
    seq,
    kind: 'frame',
    gameTime: seq + 1,
    frame: {
      sourceGeneration: GEN,
      replayId: 'r-m1',
      seq,
      gameTime: seq + 1,
      rooms: [
        {
          room: 'W15N15',
          status: 'normal',
          own: { username: 'u_p0', level: 1 },
          publicObjects: [{ kind: 'spawn', x: 1, y: 1, username: 'u_p0' }],
        },
      ],
      events: [],
    },
  }
}

function snapshot(): ScreepsWorldSnapshot {
  return { ok: true, gameTime: 5, users: [] }
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

interface Harness {
  services: ArenaHttpServices
  match: MatchService
  tournamentStore: TournamentStore
  historyStore: HistoryStore
  replayStore: ReplayStore
  tournaments: TournamentService
}

function makeHarness(): Harness {
  const tournamentStore = new TournamentStore(join(base, 'tournaments'))
  const historyStore = new HistoryStore(join(base, 'history'))
  const replayStore = new ReplayStore(join(base, 'replays'))
  let matches: MatchService
  matches = new MatchService(
    fakeScreeps(),
    join(base, 'data'),
    () => {},
    {},
    {
      history: async (m: MatchState, j: SettlementJournal) => {
        const r = buildMatchResult(m, j)
        await historyStore.put(r)
        return { resultId: r.resultId, resultHash: toResultHash(r) }
      },
      tournament: new TournamentGateway({
        tournaments: tournamentStore,
        matches: () => matches.store,
      }),
    },
  )
  const admission = new AdmissionGate({ admission: new AdmissionStore(join(base, 'admission')), matches: matches.store, tournaments: tournamentStore })
  const tournaments = new TournamentService({
    store: tournamentStore,
    gate: admission,
    match: matches,
    registry: () => null,
    timeoutMs: 1000,
    log: () => {},
  })
  const services: ArenaHttpServices = {
    getWorld: () => fakeScreeps().getWorld(),
    getTerrain: async (rooms: string[]) => {
      const terrain: Record<string, string> = {}
      for (const room of rooms) terrain[room] = '1'.repeat(2500)
      return { terrain }
    },
    match: matches,
    spawnAgentMatch: async () => ({ matchId: 'm', sessionIds: [] }),
    agentModel: undefined,
    consoleOutput: async () => ({ lines: [], cursor: 0, bound: true }),
    httpCreateTournament: async input => {
      const res = await tournaments.create(input.requestId, input.config, 'op-1', { awaitRecruit: false })
      return { ok: true, tournamentId: res.tournamentId, recruiting: true, quotaWarning: true, operationId: 'op-1' }
    },
    httpListTournaments: async () => {
      const { toTournamentPublicView } = await import('./tournament/model.ts')
      return (await tournamentStore.list()).map(toTournamentPublicView)
    },
    httpGetTournament: async id => {
      const { toTournamentPublicView } = await import('./tournament/model.ts')
      const s = await tournamentStore.get(id)
      return s ? toTournamentPublicView(s) : null
    },
    httpGetTournamentBracket: async id => {
      const { toTournamentBracketView } = await import('./tournament/model.ts')
      const s = await tournamentStore.get(id)
      return s ? toTournamentBracketView(s) : null
    },
    httpStartTournament: async id => {
      const s = await tournaments.storeRef.get(id)
      if (!s) throw new Error('not found')
      // 无 registry 无法 recruit → start 需 ready；此处直接造 ready 状态
      const state = await tournaments.start(id, 'op-start').catch(e => e)
      if (state instanceof Error) throw state
      return { ok: true, tournamentId: state.id, phase: state.phase }
    },
    httpRetryTournament: async () => ({ ok: true, tournamentId: '', phase: 'recruiting' }),
    httpReadReplay: async (matchId, opts) => {
      const page = await replayStore.read(matchId, opts)
      if (page.unavailable) return { ...page, sanitized: [] }
      return { ...page, sanitized: page.records }
    },
    httpLeaderboard: async opts => historyStore.leaderboard(opts),
  }
  return { services, match: matches, tournamentStore, historyStore, replayStore, tournaments }
}

describe('M4-D http routes', () => {
  it('POST /tournaments creates recruiting (202) and GET returns the redacted public view', async () => {
    const { services } = makeHarness()
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/tournaments',
      body: { requestId: 'req-1', seats: 4 },
    })
    expect(created.status).toBe(202)
    const body = created.body as { ok: boolean; tournamentId: string; recruiting: boolean; quotaWarning: boolean }
    expect(body.tournamentId).toBeTruthy()
    expect(body.recruiting).toBe(true)
    expect(body.quotaWarning).toBe(true)
    // 详情
    const detail = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/tournaments/${body.tournamentId}`,
    })
    expect(detail.status).toBe(200)
    const t = (detail.body as { tournament: Record<string, unknown> }).tournament
    expect(JSON.stringify(t)).not.toContain('sessionId')
    expect(JSON.stringify(t)).not.toContain('screeps-tournament-')
    expect(t.phase).toBe('recruiting')
    expect(t.retryable).toBe(false)
    expect((t as { config: { seats: number } }).config.seats).toBe(4)
  })

  it('POST /tournaments validates seats and requestId', async () => {
    const { services } = makeHarness()
    expect((await handleArenaRequest(services, { method: 'POST', pathname: '/dsh-screeps/tournaments', body: { requestId: 'r1', seats: 6 } })).status).toBe(400)
    expect((await handleArenaRequest(services, { method: 'POST', pathname: '/dsh-screeps/tournaments', body: { seats: 4 } })).status).toBe(400)
    expect((await handleArenaRequest(services, { method: 'POST', pathname: '/dsh-screeps/tournaments', body: { requestId: '', seats: 4 } })).status).toBe(400)
  })

  it('start on a recruiting (not ready) tournament returns conflict/terminal guards', async () => {
    const { services } = makeHarness()
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/tournaments',
      body: { requestId: 'req-2', seats: 4 },
    })
    const tid = (created.body as { tournamentId: string }).tournamentId
    // recruiting → start 会经 TournamentService.start → conflict（ready only）
    const started = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/tournaments/${tid}/start`,
      body: {},
    })
    // 缺 registry 的 create 后状态 recruiting；start 拒 recruiting（conflict 409 or 500）
    expect([409, 500]).toContain(started.status)
  })

  it('GET /tournaments/:id/bracket returns redacted bracket projection', async () => {
    const { services } = makeHarness()
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/tournaments',
      body: { requestId: 'req-bracket', seats: 4 },
    })
    const tid = (created.body as { tournamentId: string }).tournamentId
    const bracket = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/tournaments/${tid}/bracket`,
    })
    expect(bracket.status).toBe(200)
    const b = (bracket.body as { bracket: Record<string, unknown> }).bracket
    // 纯投影：无 sessionId / 无内部字段
    expect(JSON.stringify(b)).not.toContain('sessionId')
    expect(JSON.stringify(b)).not.toContain('screeps-tournament-')
    expect(b.phase).toBe('recruiting')
    expect((b as { seats: number }).seats).toBe(4)
    expect((b as { rounds: unknown[] }).rounds).toEqual([]) // recruiting 尚无配对
    // 404
    const missing = await handleArenaRequest(services, {
      method: 'GET',
      pathname: '/dsh-screeps/tournaments/no-such/bracket',
    })
    expect(missing.status).toBe(404)
  })

  it('GET /history/leaderboard returns stable page (empty initially)', async () => {
    const { services } = makeHarness()
    const page = await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/history/leaderboard' })
    expect(page.status).toBe(200)
    expect((page.body as { leaderboard: { rows: unknown[] } }).leaderboard.rows).toEqual([])
    // 非法 limit
    expect(
      (
        await handleArenaRequest(services, {
          method: 'GET',
          pathname: '/dsh-screeps/history/leaderboard',
          query: new URLSearchParams({ limit: '0' }),
        })
      ).status,
    ).toBe(400)
  })

  it('GET /matches/:id/replay returns unavailable for ordinary matches (no fake empty replay)', async () => {
    const { services, match } = makeHarness()
    const m = await match.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'e2e_a' })
    const page = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${m.id}/replay` })
    expect(page.status).toBe(200)
    const body = page.body as { unavailable?: boolean; ok: boolean }
    expect(body.unavailable).toBe(true)
    expect(body.ok).toBe(true)
  })

  it('GET /matches/:id/replay returns persisted sanitized records when replay exists', async () => {
    const { services, match, replayStore } = makeHarness()
    const m = await match.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'e2e_a' })
    await match.join(m.id, { sessionId: 's2', username: 'e2e_b' })
    // 手工造 replay（普通局无 participant → username 保留公开）
    await replayStore.create(m.id, { replayId: 'r-m1', sourceGeneration: GEN })
    await replayStore.append(m.id, { records: [frame(0), frame(1)], sourceGeneration: GEN, replayId: 'r-m1' })
    const page = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/matches/${m.id}/replay`,
      query: new URLSearchParams({ limit: '200' }),
    })
    expect(page.status).toBe(200)
    const body = page.body as { status: string; records: ReplayRecord[]; unavailable?: boolean }
    expect(body.unavailable).toBeUndefined()
    expect(body.records).toHaveLength(2)
    const first = body.records[0]!
    expect(first.kind).toBe('frame')
    if (first.kind === 'frame') {
      const own = first.frame.rooms[0]!.own as { username: string } | null
      expect(own?.username).toBe('u_p0') // 无映射原样保留
    }
    // afterTick 参数
    const p2 = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/matches/${m.id}/replay`,
      query: new URLSearchParams({ afterTick: '1' }),
    })
    expect((p2.body as { records: ReplayRecord[] }).records.map(r => r.seq)).toEqual([1])
  })
})
