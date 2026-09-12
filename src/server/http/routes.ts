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

/** 桥需要的服务面（结构化最小接口）。 */
export interface ArenaHttpServices {
  matches(): MatchMachine[]
  match(id: string): MatchMachine | undefined
  createMatch(input: { config?: Partial<MatchConfig>; players: Array<{ seatId: string; username: string }> }): MatchMachine
  getWorld(): Promise<unknown>
  getTerrain(rooms: string[]): Promise<{ terrain: Record<string, string> }>
  /** 逐用户 console 增量（游标由服务层维护）。 */
  consoleSince(username: string, since?: number): Promise<{ lines: unknown[]; cursor: number; bound: boolean }>
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

/** 对局公开投影（players 只暴露 seatId/username/ready/code 有无；不暴露 code 内容）。 */
export function matchView(m: MatchMachine): unknown {
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
    })),
    errors: m.state.errors,
    settledAt: m.state.settledAt ?? null,
    settleReason: m.state.settleReason ?? null,
    winner: m.state.winner ?? null,
    scores: m.state.scores ?? null,
  }
}

/** 路由核心：纯函数打表。未知路由 404；方法不匹配 405；业务错误 400/409。 */
export async function handleArenaRequest(services: ArenaHttpServices, req: ArenaRequest): Promise<ArenaResponse> {
  const { pathname } = req
  const method = req.method.toUpperCase()

  if (pathname === '/api/matches') {
    if (method === 'GET') return ok({ matches: services.matches().map(matchView) })
    if (method === 'POST') {
      const body = (req.body ?? {}) as {
        config?: Partial<MatchConfig>
        players?: Array<{ seatId: string; username: string }>
      }
      if (!Array.isArray(body.players) || body.players.length === 0) {
        return bad(400, 'players required (array of {seatId, username})')
      }
      for (const p of body.players) {
        if (typeof p.seatId !== 'string' || !USERNAME_RE.test(p.seatId)) return bad(400, `invalid seatId: ${String(p.seatId)}`)
        if (typeof p.username !== 'string' || !USERNAME_RE.test(p.username)) return bad(400, `invalid username: ${String(p.username)}`)
      }
      try {
        const m = services.createMatch({ ...(body.config ? { config: body.config } : {}), players: body.players })
        return { status: 201, json: matchView(m) }
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
      if (method === 'GET') return ok(matchView(m))
      return bad(405, `method ${method} not allowed`)
    }
    if (method !== 'POST') return bad(405, `method ${method} not allowed`)
    try {
      if (action === 'start') {
        m.start()
        return ok(matchView(m))
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
      return ok(matchView(m))
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
    return ok({ history: services.history?.() ?? [] })
  }

  if (pathname === '/api/teardown-failures') {
    if (method !== 'GET') return bad(405, `method ${method} not allowed`)
    return ok({ failures: services.teardownFailures?.() ?? [] })
  }

  return bad(404, `no route for ${method} ${pathname}`)
}

export type { MatchEvent }
