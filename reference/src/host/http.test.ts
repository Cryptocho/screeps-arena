/**
 * S11 HTTP 桥路由核心单测：handleArenaRequest 打表（method/pathname/body → status/json）。
 * 用 fake ArenaBackend + 真实 MatchStore/MatchLifecycle（tmpdir）跑完整状态机。
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchService } from './match/match-service.ts'
import { handleArenaRequest, type ArenaHttpServices } from './http.ts'
import type { ArenaBackend } from './match/lifecycle.ts'
import type { ScreepsService } from './service.ts'

function makeServices(overrides: Partial<ArenaBackend> = {}): ArenaHttpServices {
  let gameTime = 1000
  const backend = {
    ensureRunning: async () => ({ port: 1234 }),
    system: async (cmd: string) => (cmd === 'getTickDuration' ? { ok: true, tickDuration: 150 } : { ok: true }),
    createUser: async (input: { username: string; room: string }) => ({ username: input.username, id: 'uid-' + input.username }),
    restart: async () => ({}),
    eventLog: async () => ({ events: [], cursor: 0, bound: true }),
    getWorld: async () => ({
      ok: true,
      gameTime: ++gameTime,
      users: [
        { id: 'uid-e2e_a', username: 'e2e_a', isBot: true, cpu: 1, gcl: 0, ownedRooms: 1, rclTotal: 1, spawns: 1, rooms: [{ room: 'W45N74', level: 1, progress: 0 }] },
        { id: 'uid-e2e_b', username: 'e2e_b', isBot: true, cpu: 1, gcl: 0, ownedRooms: 1, rclTotal: 1, spawns: 1, rooms: [{ room: 'W68N70', level: 1, progress: 0 }] },
      ],
    }),
    ...overrides,
  }
  const matches = new MatchService(backend as unknown as ScreepsService, join(tmpdir(), 'dsh-screeps-http-test-' + Math.random().toString(36).slice(2, 8)), () => {})
  const buffers = new Map<string, { lines: unknown[]; cursor: number }>([
    ['e2e_a', { lines: [{ messages: { log: ['a-1'], results: [] } }, { messages: { log: ['a-2'], results: [] } }], cursor: 2 }],
    ['e2e_b', { lines: [{ messages: { log: ['b-1'], results: [] } }], cursor: 1 }],
  ])
  return {
    getWorld: () => backend.getWorld(),
    getTerrain: async (rooms: string[]) => {
      // 假数据：2500 字符位域串（bit1=wall）——只给请求的房
      const terrain: Record<string, string> = {}
      for (const room of rooms) terrain[room] = '1'.repeat(2500)
      return { terrain }
    },
    match: matches,
    spawnAgentMatch: async (input: { preset: string; count?: number }) => ({ matchId: `spawned-${input.preset}`, sessionIds: ['s1', 's2'] }),
    agentModel: undefined,
    consoleOutput: async (username: string, since = 0) => {
      const buf = buffers.get(username)
      if (!buf) throw new Error(`no buffer for ${username}`)
      const from = Math.min(since, buf.lines.length)
      return { lines: buf.lines.slice(from), cursor: buf.cursor, bound: true }
    },
    // M4 stubs（tournament/replay/history 的完整 store 级测试在 http.test 的 M4 describe 中
    // 用真实 store 单独构造 services——此处只保证接口形状）
    httpCreateTournament: async () => ({ ok: true, tournamentId: 't-stub', recruiting: true, quotaWarning: true, operationId: 'op-stub' }),
    httpListTournaments: async () => [],
    httpGetTournament: async () => null,
    httpGetTournamentBracket: async () => null,
    httpStartTournament: async () => ({ ok: true, tournamentId: '', phase: 'running' }),
    httpRetryTournament: async () => ({ ok: true, tournamentId: '', phase: 'recruiting' }),
    httpReadReplay: async matchId => ({
      unavailable: true,
      matchId,
      records: [],
      sanitized: [],
      nextCursor: 0,
      availableCount: 0,
      complete: false,
      status: 'live',
      gapReasons: [],
    }),
    httpLeaderboard: async () => ({ rows: [], hasMore: false }),
  }
}

async function createStartedMatch(services: ArenaHttpServices): Promise<string> {
  const created = await handleArenaRequest(services, {
    method: 'POST',
    pathname: '/dsh-screeps/matches',
    body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
  })
  const matchId = (created.body as { match: { id: string } }).match.id
  await services.match.join(matchId, { sessionId: 'sess-b', username: 'e2e_b' })
  const started = await handleArenaRequest(services, {
    method: 'POST',
    pathname: `/dsh-screeps/matches/${matchId}/start`,
    body: { sessionId: 'sess-a' },
  })
  expect(started.status).toBe(200)
  return matchId
}

describe('arena http bridge (route core)', () => {
  it('404s unknown paths and 405s method mismatches', async () => {
    const services = makeServices()
    expect((await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/nope' })).status).toBe(404)
    expect((await handleArenaRequest(services, { method: 'GET', pathname: '/other/world' })).status).toBe(404)
    const postWorld = await handleArenaRequest(services, { method: 'POST', pathname: '/dsh-screeps/world' })
    expect(postWorld.status).toBe(405)
  })

  it('validates create payload (preset/username)', async () => {
    const services = makeServices()
    const badPreset = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'nope', sessionId: 's', username: 'u' },
    })
    expect(badPreset.status).toBe(400)
    const badUser = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 's', username: 'bad name!' },
    })
    expect(badUser.status).toBe(400)
  })

  it('A0: spawn-agents returns 202 + recruiting (异步编排), validates preset/count/activeExists', async () => {
    const services = makeServices()
    // 非法 preset
    const badPreset = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/spawn-agents',
      body: { preset: 'nope' },
    })
    expect(badPreset.status).toBe(400)
    // arena 强制 2
    const arena3 = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/spawn-agents',
      body: { preset: 'arena-blitz', count: 3 },
    })
    expect(arena3.status).toBe(400)
    // world 超 seats
    const world5 = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/spawn-agents',
      body: { preset: 'world-rounds', count: 5 },
    })
    expect(world5.status).toBe(400)
    // 合法请求 → 202 recruiting（不等异步编排完成）
    const accepted = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/spawn-agents',
      body: { preset: 'arena-blitz', model: 'deepseek-v4-flash' },
    })
    expect(accepted.status).toBe(202)
    expect((accepted.body as { ok: boolean; recruiting: boolean }).recruiting).toBe(true)
    // 无 model（body 未传且 config 无 agentModel）→ 400 明确指引
    const noModel = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/spawn-agents',
      body: { preset: 'arena-blitz' },
    })
    expect(noModel.status).toBe(400)
    expect(String((noModel.body as { error?: string }).error ?? '')).toContain('agent model not configured')
    // GET 不支持
    expect((await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/spawn-agents' })).status).toBe(405)
  })

  it('A0: spawn-agents is rejected while an active match exists (409 预检)', async () => {
    const services = makeServices()
    await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    const spawn = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/spawn-agents',
      body: { preset: 'arena-blitz' },
    })
    expect(spawn.status).toBe(409)
  })

  it('creates, lists, shows and settles a match end to end', async () => {
    const services = makeServices()
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    expect(created.status).toBe(201)
    const matchId = (created.body as { match: { id: string } }).match.id

    const listed = await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/matches' })
    expect((listed.body as { matches: unknown[] }).matches).toHaveLength(1)

    await services.match.join(matchId, { sessionId: 'sess-b', username: 'e2e_b' })
    const started = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/start`,
      body: { sessionId: 'sess-a' },
    })
    expect(started.status).toBe(200)
    const startedMatch = (started.body as { match: { phase: string; startTick: number } }).match
    expect(startedMatch.phase).toBe('running')
    expect(startedMatch.startTick).toBeGreaterThan(0)

    const observation = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/observe` })
    expect(observation.status).toBe(200)
    const scoreboard = (observation.body as { observation: { scoreboard: Record<string, { score: number }> } }).observation.scoreboard
    expect(Object.keys(scoreboard)).toEqual(['sess-a', 'sess-b'])

    const settled = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/settle`,
      body: { reason: 'manual', sessionId: 'sess-a' },
    })
    expect(settled.status).toBe(200)
    const settledMatch = (settled.body as { match: { phase: string; winner: { kind: string }; scores: Record<string, number> } }).match
    expect(settledMatch.phase).toBe('settled')
    expect(settledMatch.winner.kind).toBe('draw') // 双方分数相同
    expect(Object.keys(settledMatch.scores)).toHaveLength(2)
  })

  it('maps MatchError to 404/409', async () => {
    const services = makeServices()
    const missing = await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/matches/m-nope' })
    expect(missing.status).toBe(404)

    // creating 阶段不能 start（<2 players）→ full/badPhase 族 → 409
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    const matchId = (created.body as { match: { id: string } }).match.id
    const earlyStart = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/start`,
      body: { sessionId: 'sess-a' },
    })
    expect(earlyStart.status).toBe(409)
    // 无 sessionId 的 start → 400（M2 C 步：sessionId 是 creator 校验载体）
    const noSession = await handleArenaRequest(services, { method: 'POST', pathname: `/dsh-screeps/matches/${matchId}/start` })
    expect(noSession.status).toBe(400)
    // settled 后再 settle → badTransition → 409
    await services.match.join(matchId, { sessionId: 'sess-b', username: 'e2e_b' })
    await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/start`,
      body: { sessionId: 'sess-a' },
    })
    const reSettle = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/settle`,
      body: { reason: 'manual', sessionId: 'sess-a' },
    })
    expect(reSettle.status).toBe(200)
    const third = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/settle`,
      body: { reason: 'manual', sessionId: 'sess-a' },
    })
    expect(third.status).toBe(409)
  })

  it('GET /matches/:id/console returns per-user delta with cursor', async () => {
    const services = makeServices()
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    const matchId = (created.body as { match: { id: string } }).match.id
    await services.match.join(matchId, { sessionId: 'sess-b', username: 'e2e_b' })

    // 无 since = 全量
    const all = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/console` })
    expect(all.status).toBe(200)
    const delta = (all.body as { lines: { user: string; text: string }[]; cursor: Record<string, number> }).lines
    expect(delta).toHaveLength(3) // a-1, a-2, b-1
    expect(delta[0]).toEqual({ user: 'e2e_a', text: 'a-1' })

    // since 增量（只取之后）——URLSearchParams 会自动 URL 编码，不用预 encodeURIComponent
    const rawSince = JSON.stringify({ e2e_a: 1, e2e_b: 0 })
    const partial = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/matches/${matchId}/console`,
      query: new URLSearchParams({ since: rawSince }),
    })
    expect(partial.status).toBe(200)
    const partialBody = partial.body as { lines: { user: string; text: string }[]; cursor: Record<string, number> }
    expect(partialBody.lines).toHaveLength(2) // a-2 + b-1
    expect(partialBody.cursor).toEqual({ e2e_a: 2, e2e_b: 1 })
  })

  it('console: invalid since JSON -> 400; unknown match -> 404; POST -> 405', async () => {
    const services = makeServices()
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    const matchId = (created.body as { match: { id: string } }).match.id

    const bad = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/matches/${matchId}/console`,
      query: new URLSearchParams({ since: 'not-json' }),
    })
    expect(bad.status).toBe(400)

    const wrongCursor = await handleArenaRequest(services, {
      method: 'GET',
      pathname: `/dsh-screeps/matches/${matchId}/console`,
      query: new URLSearchParams({ since: JSON.stringify({ e2e_a: -1 }) }),
    })
    expect(wrongCursor.status).toBe(400)

    const missing = await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/matches/m-nope/console' })
    expect(missing.status).toBe(404)

    const post = await handleArenaRequest(services, { method: 'POST', pathname: `/dsh-screeps/matches/${matchId}/console` })
    expect(post.status).toBe(405)
  })

  it('console: creating phase degrades per-user failures to empty delta (no 500)', async () => {
    const services = makeServices()
    // creating 阶段（1 玩家，未建号）：consoleOutput 对未建号用户抛错 → 降级空增量
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'nobody' },
    })
    const matchId = (created.body as { match: { id: string } }).match.id
    const res = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/console` })
    expect(res.status).toBe(200)
    const body = res.body as { lines: unknown[]; cursor: Record<string, number>; bound: boolean }
    expect(body.lines).toEqual([])
    expect(body.cursor).toEqual({ nobody: 0 })
  })

  it('DELETE /matches/:id removes only terminal matches (settled/interrupted)', async () => {
    const services = makeServices()
    // 创建 + join + start 跑一局后再 settle → 终态可删
    const matchId = await createStartedMatch(services)
    await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/settle`,
      body: { reason: 'manual', sessionId: 'sess-a' },
    })
    const del = await handleArenaRequest(services, { method: 'DELETE', pathname: `/dsh-screeps/matches/${matchId}` })
    expect(del.status).toBe(200)
    expect((del.body as { removed: string }).removed).toBe(matchId)
    // 已删 → 404
    const gone = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}` })
    expect(gone.status).toBe(404)

    // 活跃对局（creating）不可删 → 409
    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    const liveId = (created.body as { match: { id: string } }).match.id
    const blocked = await handleArenaRequest(services, { method: 'DELETE', pathname: `/dsh-screeps/matches/${liveId}` })
    expect(blocked.status).toBe(409)

    // 不存在 → 404
    const missing = await handleArenaRequest(services, { method: 'DELETE', pathname: '/dsh-screeps/matches/m-nope' })
    expect(missing.status).toBe(404)
  })

  it('observe: GET works (board.tsx poll), POST stays, GET pause 405 (method table)', async () => {
    const services = makeServices()
    const matchId = await createStartedMatch(services)
    // GET observe（S12 board 轮询现状修复）
    const getObs = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/observe` })
    expect(getObs.status).toBe(200)
    const scoreboard = (getObs.body as { observation: { scoreboard: Record<string, unknown> } }).observation.scoreboard
    expect(Object.keys(scoreboard)).toEqual(['sess-a', 'sess-b'])
    // POST observe 保留（兼容）
    const postObs = await handleArenaRequest(services, { method: 'POST', pathname: `/dsh-screeps/matches/${matchId}/observe` })
    expect(postObs.status).toBe(200)
    // GET pause → 405（pause 仍是 POST-only 写操作）
    const getPause = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/pause` })
    expect(getPause.status).toBe(405)
  })

  it('pause/resume/settle require a player session; start requires creator', async () => {
    const services = makeServices()
    const matchId = await createStartedMatch(services)

    // 非玩家会话操作 → 403
    const stranger = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/pause`,
      body: { sessionId: 'nobody' },
    })
    expect(stranger.status).toBe(403)
    const strangerSettle = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/settle`,
      body: { reason: 'manual', sessionId: 'nobody' },
    })
    expect(strangerSettle.status).toBe(403)

    // 缺 sessionId → 400（非 start 的写操作也要）
    const noSess = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/pause`,
      body: {},
    })
    expect(noSess.status).toBe(400)

    // join 玩家（非 creator）不能 start
    const nonCreatorStart = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/start`,
      body: { sessionId: 'sess-b' },
    })
    expect(nonCreatorStart.status).toBe(403)
  })

  it('create/join reject __bot__ reserved prefixes', async () => {
    const services = makeServices()
    const botCreate = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: '__bot__harvester', username: 'x' },
    })
    expect(botCreate.status).toBe(400)
    const botUser = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: '__bot_harvester' },
    })
    expect(botUser.status).toBe(400)

    const created = await handleArenaRequest(services, {
      method: 'POST',
      pathname: '/dsh-screeps/matches',
      body: { preset: 'world-rounds', sessionId: 'sess-a', username: 'e2e_a' },
    })
    const matchId = (created.body as { match: { id: string } }).match.id
    // HTTP join 端点已随 M3 A0 移除（三审次要 2：join 只走工具面）：此处验证路由 404
    const botJoin = await handleArenaRequest(services, {
      method: 'POST',
      pathname: `/dsh-screeps/matches/${matchId}/join`,
      body: { sessionId: '__bot__harvester', username: 'e2e_b' },
    })
    expect(botJoin.status).toBe(404)
  })
})

describe('M6 code endpoints (plan-M6 §3.2)', () => {
  it('lists submit versions grouped by player (meta only, no content/sessionId)', async () => {
    const services = makeServices()
    const matchId = await createStartedMatch(services)
    // start 注入（点 4）：两座位各一条 placing/start-injected
    const res = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/code` })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; matchId: string; players: Array<{ username: string; versions: Array<Record<string, unknown>> }> }
    expect(body.ok).toBe(true)
    expect(body.matchId).toBe(matchId)
    expect(body.players.map(p => p.username)).toEqual(['e2e_a', 'e2e_b'])
    // seq 是 per-match 全局计数：e2e_a=1、e2e_b=2
    expect(body.players[0]!.versions[0]).toMatchObject({ seq: 1, phase: 'placing', source: 'start-injected' })
    expect(body.players[1]!.versions[0]).toMatchObject({ seq: 2, phase: 'placing', source: 'start-injected' })
    for (const p of body.players) {
      expect(p.versions).toHaveLength(1)
      expect(p.versions[0]).not.toHaveProperty('modules')
    }
    expect(JSON.stringify(body)).not.toContain('sessionId')
    expect(JSON.stringify(body)).not.toContain('sess-a')
  })

  it('serves a single version content by (username, seq)', async () => {
    const services = makeServices()
    const matchId = await createStartedMatch(services)
    const res = await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/code/e2e_a/1` })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; username: string; seq: number; phase: string; modules: Record<string, string> }
    expect(body.ok).toBe(true)
    expect(body.username).toBe('e2e_a')
    expect(body.seq).toBe(1)
    expect(body.phase).toBe('placing')
    expect(body.modules.main).toContain('module.exports.loop')
    expect(JSON.stringify(body)).not.toContain('sessionId')
  })

  it('404s unknown match/version and 400s malformed username/seq; 405s POST', async () => {
    const services = makeServices()
    const matchId = await createStartedMatch(services)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/matches/nope/code' })).status,
    ).toBe(404)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/code/e2e_a/99` })).status,
    ).toBe(404)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/code/e2e_a/0` })).status,
    ).toBe(400)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/code/e2e_a/abc` })).status,
    ).toBe(400)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: `/dsh-screeps/matches/${matchId}/code/bad%20name/1` })).status,
    ).toBe(400)
    // POST 落到既有 action switch 的 default（unknown action 404）——GET 分流只对 GET 生效
    expect(
      (await handleArenaRequest(services, { method: 'POST', pathname: `/dsh-screeps/matches/${matchId}/code`, body: {} })).status,
    ).toBe(404)
  })

  it('M6 terrain endpoint: validates rooms and passes bit-field strings through', async () => {
    const services = makeServices()
    const good = await handleArenaRequest(services, {
      method: 'GET',
      pathname: '/dsh-screeps/terrain',
      query: new URLSearchParams({ rooms: 'W15N15,W14N15' }),
    })
    expect(good.status).toBe(200)
    const body = good.body as { ok: boolean; rooms: string[]; terrain: Record<string, string> }
    expect(body.rooms).toEqual(['W15N15', 'W14N15'])
    expect(Object.keys(body.terrain)).toEqual(['W15N15', 'W14N15'])
    expect(body.terrain['W15N15']).toHaveLength(2500)
    // 校验：缺参 / 空参 / 坏房名 / 超上限
    expect((await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/terrain' })).status).toBe(400)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/terrain', query: new URLSearchParams({ rooms: 'bogus' }) })).status,
    ).toBe(400)
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/terrain', query: new URLSearchParams({ rooms: 'W15N15' }) })).status,
    ).toBe(200)
    const tooMany = Array.from({ length: 65 }, (_, i) => `W${40 + (i % 20)}N${40 + (i % 20)}`).join(',')
    expect(
      (await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/terrain', query: new URLSearchParams({ rooms: tooMany }) })).status,
    ).toBe(400)
    expect((await handleArenaRequest(services, { method: 'POST', pathname: '/dsh-screeps/terrain', body: {} })).status).toBe(405)
  })

  it('M6 world passthrough includes per-room spawns when backend provides them', async () => {
    const services = makeServices({
      getWorld: async () => ({
        ok: true,
        gameTime: 42,
        users: [
          {
            id: 'uid-e2e_a',
            username: 'e2e_a',
            isBot: true,
            cpu: 1,
            gcl: 0,
            ownedRooms: 1,
            rclTotal: 1,
            spawns: 1,
            rooms: [{ room: 'W15N15', level: 1, progress: 0, spawns: [{ x: 25, y: 25 }] }],
          },
        ],
      }),
    })
    const res = await handleArenaRequest(services, { method: 'GET', pathname: '/dsh-screeps/world' })
    expect(res.status).toBe(200)
    const world = (res.body as { world: { users: Array<{ rooms: Array<{ spawns?: Array<{ x: number; y: number }> }> }> } }).world
    expect(world.users[0]!.rooms[0]!.spawns).toEqual([{ x: 25, y: 25 }])
  })
})
