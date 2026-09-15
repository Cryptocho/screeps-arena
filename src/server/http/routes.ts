/**
 * HTTP 路由核心（M1/S4，plan-M1 §3）——纯函数打表：method/pathname/body → status/json。
 * 不碰 node:http / fastify——单测直接打表（对照 reference/src/host/http.ts 设计）。
 * Fastify 壳（server.ts）只是薄接线。
 *
 * 公平边界：桥只暴露控制面与公开投影，无「以任意用户身份执行」通道；
 * report 投影的 fog 过滤在 RealArena（S3）收口。
 */
import type { MatchMachine } from '../match/machine.js'
import type { MatchEvent } from '../match/machine.js'
import type { MatchConfig } from '../match/model.js'
import { computeOutcome } from '../match/score.js'
import type { SeatScoreInput } from '../match/score.js'
import { standings } from '../tournament/bracket.js'
import type { Tournament, TournamentParticipant } from '../tournament/types.js'
import type { MatchPreset } from '../match/model.js'

/** 桥需要的服务面（结构化最小接口）。 */
export interface ArenaHttpServices {
  matches(): MatchMachine[]
  match(id: string): MatchMachine | undefined
  createMatch(input: {
    config?: Partial<MatchConfig>
    preset?: MatchPreset
    players: Array<{ seatId: string; username: string }>
  }): MatchMachine
  getWorld(): Promise<unknown>
  getTerrain(rooms: string[]): Promise<{ terrain: Record<string, string> }>
  /** 逐用户 console 增量（游标由服务层维护）。 */
  consoleSince(username: string, since?: number): Promise<{ lines: unknown[]; cursor: number; bound: boolean }>
  /** seatId → 真实私服用户名（可选；host 侧映射的旁观投影，缺席时视图给 null）。 */
  seatUsername?(seatId: string): string | undefined
  /** 计分快照（M2/S1；可选——缺席时 settle 维持 M0 全 0 draw）。keys = seatIds。 */
  getScoreSnapshot?(seatIds: string[]): Promise<Record<string, SeatScoreInput> | undefined>
  /** 对局历史（M3/S4；可选——缺席时路由返回空表，dev/mock lane 无需实现）。 */
  history?(): Array<{
    id: string
    config: unknown
    winner: unknown
    settleReason: string | null
    scores: Record<string, number> | null
    roundIndex: number
    createdAt: number
    settledAt: number | null
    teardown: string
  }>
  /** teardown 失败可查面（M3/D3；settle 后 machine 已删，errors 通道不可达）。 */
  teardownFailures?(): Array<{ matchId: string; seatId: string; error: string; at: number }>
  /** 回放查询（M6/S3；可选——缺席时路由 404，dev/mock lane 无需实现）。undefined = 404。 */
  replay?(matchId: string, opts: { from?: number; to?: number; frames: boolean }): Promise<unknown> | unknown
  /** 回放数据可读性（M6/D6：历史表「战报」入口可用性；缺席视为不可用）。 */
  replayExists?(matchId: string): boolean
  /** 锦标赛编排（M4/D6；可选——dev/mock lane 无需实现）。业务规则错误 throw → 400。 */
  createTournament?(input: { name?: string; participants: TournamentParticipant[]; matchConfig?: Partial<MatchConfig> }): Tournament
  tournaments?(): Tournament[]
  tournament?(id: string): Tournament | undefined
}

export interface ArenaRequest {
  method: string
  pathname: string
  body?: unknown
  query?: Record<string, string>
}

export interface ArenaResponse {
  status: number
  json: unknown
}

const USERNAME_RE = /^[A-Za-z0-9_-]{1,30}$/

function ok(json: unknown): ArenaResponse {
  return { status: 200, json }
}

function bad(status: number, error: string): ArenaResponse {
  return { status, json: { ok: false, error } }
}

/** 对局公开投影（players 只暴露 seatId/username/ready/code 有无；不暴露 code 内容）。
 *  seatUsername（可选）：host 侧 seatId→真实私服用户名（agent_<slug>）——人类旁观 UI
 *  用它对齐 /api/world 的 user 行（浏览器实测补洞：前端按 username 匹配永远落空 →
 *  席位表 rooms/rcl/spawns/creeps 恒 0）。仅旁观投影，不进 Agent 可见面。 */
export function matchView(m: MatchMachine, seatUsername?: (seatId: string) => string | undefined): unknown {
  return {
    id: m.id,
    phase: m.phase,
    roundIndex: m.state.roundIndex,
    config: m.config,
    players: m.players.map((p) => ({
      seatId: p.seatId,
      username: p.username,
      ready: p.ready,
      hasCode: !!p.code,
      autoReady: p.autoReady ?? null,
      screepsUsername: seatUsername?.(p.seatId) ?? null,
    })),
    errors: m.state.errors,
    settledAt: m.state.settledAt ?? null,
    settleReason: m.state.settleReason ?? null,
    winner: m.state.winner ?? null,
    scores: m.state.scores ?? null,
  }
}

/** 锦标赛投影（M4/D6）：全量字段 + 纯派生积分榜。 */
export function tournamentView(t: Tournament): unknown {
  return { ...structuredClone(t), standings: standings(t) }
}

/** 路由核心：纯函数打表。未知路由 404；方法不匹配 405；业务错误 400/409。 */
export async function handleArenaRequest(services: ArenaHttpServices, req: ArenaRequest): Promise<ArenaResponse> {
  const { pathname } = req
  const method = req.method.toUpperCase()

  if (pathname === '/api/matches') {
    if (method === 'GET') return ok({ matches: services.matches().map((m) => matchView(m, services.seatUsername)) })
    if (method === 'POST') {
      const body = (req.body ?? {}) as {
        config?: Partial<MatchConfig>
        preset?: string
        players?: Array<{ seatId: string; username: string }>
      }
      // M5 公平红线：botCode 只存在于 server 内部链（IT/调度）——HTTP 层显式剥除 + 拒绝
      if (body && typeof body === 'object' && 'botCode' in body) {
        return bad(400, 'botCode is not accepted via HTTP (internal channel only)')
      }
      let preset: MatchPreset | undefined
      if (body.preset !== undefined) {
        if (body.preset !== 'arena-blitz' && body.preset !== 'world-rounds') return bad(400, `unknown preset: ${String(body.preset)}`)
        preset = body.preset
      }
      if (!Array.isArray(body.players) || body.players.length === 0) {
        return bad(400, 'players required (array of {seatId, username})')
      }
      for (const p of body.players) {
        if (typeof p.seatId !== 'string' || !USERNAME_RE.test(p.seatId)) return bad(400, `invalid seatId: ${String(p.seatId)}`)
        if (typeof p.username !== 'string' || !USERNAME_RE.test(p.username)) return bad(400, `invalid username: ${String(p.username)}`)
      }
      try {
        const m = services.createMatch({
          ...(body.config ? { config: body.config } : {}),
          ...(preset ? { preset } : {}),
          players: body.players,
        })
        return { status: 201, json: matchView(m, services.seatUsername) }
      } catch (err) {
        return bad(400, String(err instanceof Error ? err.message : err))
      }
    }
    return bad(405, `method ${method} not allowed`)
  }

  const consolePath = /^\/api\/matches\/([^/]+)\/console$/.exec(pathname)
  if (consolePath) {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    const id = decodeURIComponent(consolePath[1]!)
    const m = services.match(id)
    if (!m) return bad(404, `match ${id} not found`)
    const user = req.query?.user ?? ''
    if (!USERNAME_RE.test(user)) return bad(400, 'user required')
    const since = req.query?.since !== undefined ? Number(req.query.since) : undefined
    try {
      return ok(await services.consoleSince(user, since))
    } catch (err) {
      return bad(502, String(err instanceof Error ? err.message : err))
    }
  }

  const matchPath = /^\/api\/matches\/([^/]+)(\/(start|settle))?$/.exec(pathname)
  if (matchPath) {
    const id = decodeURIComponent(matchPath[1]!)
    const action = matchPath[3]
    const m = services.match(id)
    if (!m) return bad(404, `match ${id} not found`)
    if (!action) {
      if (method === 'GET') return ok(matchView(m, services.seatUsername))
      return bad(405, `method ${method} not allowed`)
    }
    if (method !== 'POST') return bad(405, `method ${method} not allowed`)
    try {
      if (action === 'start') {
        m.start()
        return ok(matchView(m, services.seatUsername))
      }
      // 真实计分（M2/S1）：先取快照算 outcome；快照缺席/失败 → 降级 M0 全 0 draw（不卡结算）
      let outcome: Parameters<MatchMachine['settle']>[2] | undefined
      if (services.getScoreSnapshot) {
        try {
          const snap = await services.getScoreSnapshot(m.players.map((p) => p.seatId))
          if (snap) outcome = computeOutcome(snap)
        } catch {
          outcome = undefined
        }
      }
      m.settle('manual', Date.now(), outcome)
      return ok(matchView(m, services.seatUsername))
    } catch (err) {
      return bad(409, String(err instanceof Error ? err.message : err))
    }
  }

  if (pathname === '/api/world') {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    try {
      return ok(await services.getWorld())
    } catch (err) {
      return bad(502, String(err instanceof Error ? err.message : err))
    }
  }

  if (pathname === '/api/terrain') {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    const roomsParam = req.query?.rooms ?? ''
    const rooms = roomsParam.split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (rooms.length === 0 || rooms.length > 64) return bad(400, 'rooms must contain 1..64 names')
    try {
      return ok(await services.getTerrain(rooms))
    } catch (err) {
      return bad(502, String(err instanceof Error ? err.message : err))
    }
  }

  if (pathname === '/api/history') {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    const rows = services.history?.() ?? []
    // M6/D6：逐行标注回放可读性（与 history 本身解耦：文件缺失 → 前端按钮禁用）
    return ok({ history: rows.map((h) => ({ ...h, replay: services.replayExists?.(h.id) ?? false })) })
  }

  const replayPath = /^\/api\/replays\/([^/]+)$/.exec(pathname)
  if (replayPath) {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    const id = decodeURIComponent(replayPath[1]!)
    if (!services.replay) return bad(404, `replay ${id} not found`)
    const from = req.query?.from !== undefined ? Number(req.query.from) : undefined
    const to = req.query?.to !== undefined ? Number(req.query.to) : undefined
    // 数值校验：NaN 会静默裁剪成空集（客户端很难诊断），显式 400
    if (from !== undefined && !Number.isFinite(from)) return bad(400, 'from must be a number')
    if (to !== undefined && !Number.isFinite(to)) return bad(400, 'to must be a number')
    const frames = req.query?.frames !== 'none' // ?frames=none → 只回 meta+summary（D4）
    try {
      const body = await services.replay(id, { from, to, frames })
      if (body === undefined) return bad(404, `replay ${id} not found`)
      return ok(body)
    } catch (err) {
      return bad(502, String(err instanceof Error ? err.message : err))
    }
  }

  if (pathname === '/api/teardown-failures') {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    return ok({ failures: services.teardownFailures?.() ?? [] })
  }

  if (pathname === '/api/tournaments') {
    if (method === 'GET') return ok({ tournaments: (services.tournaments?.() ?? []).map(tournamentView) })
    if (method === 'POST') {
      if (!services.createTournament) return bad(400, 'tournaments not supported by this instance')
      const body = (req.body ?? {}) as {
        name?: string
        participants?: TournamentParticipant[]
        matchConfig?: Partial<MatchConfig>
      }
      if (!Array.isArray(body.participants)) return bad(400, 'participants required (array of {seatId, username})')
      for (const p of body.participants) {
        if (typeof p.seatId !== 'string' || !USERNAME_RE.test(p.seatId)) return bad(400, `invalid seatId: ${String(p.seatId)}`)
        if (typeof p.username !== 'string' || !USERNAME_RE.test(p.username)) return bad(400, `invalid username: ${String(p.username)}`)
      }
      try {
        const t = services.createTournament({
          ...(body.name !== undefined ? { name: body.name } : {}),
          participants: body.participants,
          ...(body.matchConfig ? { matchConfig: body.matchConfig } : {}),
        })
        return { status: 201, json: tournamentView(t) }
      } catch (err) {
        return bad(400, String(err instanceof Error ? err.message : err))
      }
    }
    return bad(405, `method ${method} not allowed`)
  }

  const tournamentPath = /^\/api\/tournaments\/([^/]+)$/.exec(pathname)
  if (tournamentPath) {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    const id = decodeURIComponent(tournamentPath[1]!)
    const t = services.tournament?.(id)
    if (!t) return bad(404, `tournament ${id} not found`)
    return ok(tournamentView(t))
  }

  return bad(404, `no route for ${method} ${pathname}`)
}

export type { MatchEvent }
