/**
 * S11 — host HTTP 桥：把对局控制面与战况投影暴露在 DSH webServer 的
 * /dsh-screeps/* 前缀路由下。契约（reference/deepseek-harness
 * packages/host/webserver/src/index.ts）：WebRoute{kind,path,handler}，
 * handler 拥有完整响应生命周期，register 返回注销函数（经 ctx.effect 挂账）。
 *
 * 设计：
 * - 路由核心 handleArenaRequest 是纯函数（method/pathname/body → status/json），
 *   不碰 node:http —— 单测直接打表；webServer 接线只是薄壳。
 * - 全部响应 no-store（实时快照/状态）。
 * - MatchError → 4xx/409/500 明确映射；未知路由 404；方法不匹配 405。
 * - 公平边界：本桥只暴露控制面与公开投影，不提供"以任意用户身份执行"的通道；
 *   agent 的会话→用户映射在 S13 工具层完成。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MatchPreset, MatchState } from './match/model.ts'
import { configFromPreset } from './match/model.ts'
import type { MatchService } from './match/match-service.ts'
import { CodeLog } from './match/code-log.ts'
import type { SpawnResult } from './agents.ts'
import { MatchError } from './match/store.ts'
import type { ScreepsService } from './service.ts'

/** webServer 的结构化最小接口（正式包 @deepseek-ai/dsh-host-webserver 的子集）。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 对局桥需要的服务面（ScreepsService 结构化满足）。 */
export interface ArenaHttpServices {
  getWorld(): Promise<import('./service.ts').ScreepsWorldSnapshot>
  /** M6：地形位域串透传（观战坐标地图；rooms ≤64 由路由层校验）。 */
  getTerrain(rooms: string[]): Promise<{ terrain: Record<string, string> }>
  match: MatchService
  /** 逐用户 console ring buffer（S13 采集；未建号用户防御性降级为空）。 */
  consoleOutput(username: string, since?: number): Promise<{
    lines: unknown[]
    cursor: number
    bound: boolean
    pubsubTicks?: number
    selfLoop?: boolean
  }>
  /** A0：spawn-Agent 建赛（HTTP 端点触发编排，202 异步 recruiting）。 */
  spawnAgentMatch(input: { preset: MatchPreset; count?: number; model?: string; provider?: string }): Promise<SpawnResult>
  /** A0 扩展：Config agentModel 现值（spawn-agents 同步 400 预检用）。 */
  agentModel: string | undefined
  /** M4：赛事建赛（recruiting 持久化 → 后台 recruit；202 语义）。 */
  httpCreateTournament(input: { requestId: string; config: import('./tournament/model.ts').TournamentConfig }): Promise<{
    ok: boolean
    tournamentId: string
    recruiting: boolean
    quotaWarning: boolean
    operationId: string
  }>
  httpListTournaments(): Promise<import('./tournament/model.ts').TournamentPublicView[]>
  httpGetTournament(tournamentId: string): Promise<import('./tournament/model.ts').TournamentPublicView | null>
  /** M4-E：bracket 纯投影（公开 alias/slot/attempt，剥离 session）。 */
  httpGetTournamentBracket(tournamentId: string): Promise<import('./tournament/model.ts').TournamentBracketView | null>
  httpStartTournament(tournamentId: string): Promise<{ ok: boolean; tournamentId: string; phase: string }>
  httpRetryTournament(tournamentId: string): Promise<{ ok: boolean; tournamentId: string; phase: string }>
  /** M4-D：replay 读取（sanitize 后）。 */
  httpReadReplay(
    matchId: string,
    opts: { cursor?: number; limit?: number; afterTick?: number },
  ): Promise<import('./replay/store.ts').ReplayReadPage & { sanitized: import('./replay/model.ts').ReplayRecord[] }>
  /** M4-D：历史 leaderboard（公开 DTO）。 */
  httpLeaderboard(opts: { tournamentId?: string; limit?: number }): Promise<import('./history/model.ts').LeaderboardPage>
}

const PRESETS: readonly MatchPreset[] = ['world-rounds', 'world-frozen', 'arena-blitz']
const USERNAME_RE = /^[A-Za-z0-9_-]{1,30}$/
const ROOM_RE = /^[WE]\d+[NS]\d+$/

export interface ArenaRequest {
  method: string
  pathname: string
  /** 查询参数（S12 console 端点的 since 游标；可选，缺省=空游标全量——兼容现有调用点）。 */
  query?: URLSearchParams
  body?: unknown
}

export interface ArenaResponse {
  status: number
  body: unknown
}

function fail(status: number, error: string): ArenaResponse {
  return { status, body: { ok: false, error } }
}

function ok(status: number, body: Record<string, unknown>): ArenaResponse {
  return { status, body: { ok: true, ...body } }
}

function statusToHttp(code: MatchError['code']): number {
  switch (code) {
    case 'notFound':
      return 404
    case 'badPhase':
    case 'badTransition':
    case 'full':
    case 'duplicatePlayer':
    case 'activeExists':
      return 409
    case 'corrupt':
      return 500
    default:
      return 400
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** console 查询参数非法（since 不是合法 JSON）→ 路由层转 400。 */
export class ConsoleQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConsoleQueryError'
  }
}

export interface ConsoleLine {
  user: string
  text: string
}

export interface ConsoleDelta {
  lines: ConsoleLine[]
  /** 每用户游标（arena-mod ring buffer 下标；空游标=全量）。 */
  cursor: Record<string, number>
  bound: boolean
}

/** 提取一条 console 帧的显示文本（对齐 tools.ts 的 {log,results} 渲染）。 */
export function formatConsoleFrame(entry: unknown): string {
  const message = entry as { messages?: string[] | { log?: string[]; results?: string[] }; error?: string }
  if (Array.isArray(message.messages)) return message.messages.join('\n')
  if (message.messages) {
    const { log = [], results = [] } = message.messages
    const parts = [...log, ...results]
    return parts.length ? parts.join('\n') : '(tick ran, no output)'
  }
  if (message.error) return `error: ${message.error}`
  return JSON.stringify(message)
}

/**
 * S12 console 增量聚合纯函数：按对局玩家逐用户调 consoleOutput，聚合为
 * {lines, cursor, bound}。游标语义（九审钉死）：since 是 URL-encoded JSON
 * `{"userA":n,"userB":n}`（每用户 ring buffer 下标）；单用户失败（未建号/
 * getToken 抛错）降级为 {lines:[], cursor:保持, bound:false}，不整端 500；
 * creating 阶段空增量不闪挂。
 */
export async function collectConsole(
  services: Pick<ArenaHttpServices, 'consoleOutput'>,
  match: MatchState,
  query?: URLSearchParams,
): Promise<ConsoleDelta> {
  const since: Record<string, number> = {}
  const raw = query?.get('since')
  if (raw !== undefined && raw !== null && raw.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ConsoleQueryError('since must be URL-encoded JSON like {"userA":1}')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConsoleQueryError('since must be an object mapping username to cursor number')
    }
    for (const [user, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ConsoleQueryError(`since cursor for ${user} must be a non-negative integer`)
      }
      since[user] = value
    }
  }

  const lines: ConsoleLine[] = []
  const cursor: Record<string, number> = {}
  let bound = false
  for (const player of match.players) {
    const user = player.username
    const start = since[user] ?? 0
    try {
      const output = await services.consoleOutput(user, start)
      for (const entry of output.lines) {
        lines.push({ user, text: formatConsoleFrame(entry) })
      }
      cursor[user] = output.cursor
      bound = bound || output.bound
    } catch {
      // 未建号/服务不可用：该玩家降级为空，游标保持请求值，不整端 500
      cursor[user] = start
    }
  }
  return { lines, cursor, bound }
}

/** 路由核心：method + pathname + body → status + json。 */
export async function handleArenaRequest(services: ArenaHttpServices, req: ArenaRequest): Promise<ArenaResponse> {
  const method = req.method.toUpperCase()
  const segments = req.pathname.replace(/^\/+|\/+$/g, '').split('/')
  // 期望前缀：dsh-screeps/...
  if (segments[0] !== 'dsh-screeps') return fail(404, 'not found')
  const rest = segments.slice(1)

  try {
    // ============ M4：tournaments + history + replay 路由 ============

    // /dsh-screeps/tournaments[/<id>[/start|bracket]]
    if (rest[0] === 'tournaments') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const tournaments = await services.httpListTournaments()
          return ok(200, { tournaments })
        }
        if (method === 'POST') {
          const body = (req.body ?? {}) as Record<string, unknown>
          const requestId = asString(body.requestId)
          if (!requestId || requestId.length < 1 || requestId.length > 64) {
            return fail(400, 'requestId is required (1-64 printable chars)')
          }
          // 只允许可打印字符（plan §4.1 step1）
          // eslint-disable-next-line no-control-regex
          if (/[^\x20-\x7E]/.test(requestId)) return fail(400, 'requestId must be printable ASCII')
          const seats = body.seats
          if (seats !== 4 && seats !== 8) return fail(400, 'seats must be 4 or 8')
          const config: import('./tournament/model.ts').TournamentConfig = { preset: 'arena-blitz', seats: seats as 4 | 8, maxAttempts: 2 }
          const model = asString(body.model)
          const provider = asString(body.provider)
          if (model) config.model = model
          if (provider) config.provider = provider
          const tickDuration = typeof body.tickDuration === 'number' && body.tickDuration > 0 ? Math.floor(body.tickDuration) : undefined
          if (tickDuration) config.tickDuration = tickDuration
          const res = await services.httpCreateTournament({ requestId, config })
          return { status: 202, body: { ...res } }
        }
        return fail(405, 'method not allowed')
      }
      const tournamentId = asString(rest[1])
      if (!tournamentId) return fail(400, 'tournament id required')
      if (rest.length === 2) {
        if (method === 'GET') {
          const tournament = await services.httpGetTournament(tournamentId)
          if (!tournament) return fail(404, `tournament ${tournamentId} not found`)
          return ok(200, { tournament })
        }
        return fail(405, 'method not allowed')
      }
      if (rest.length === 3 && rest[2] === 'start') {
        if (method !== 'POST') return fail(405, 'method not allowed')
        const existing = await services.httpGetTournament(tournamentId)
        if (!existing) return fail(404, `tournament ${tournamentId} not found`)
        if (['completed', 'draw', 'failed', 'interrupted'].includes(existing.phase)) {
          return fail(409, `tournament ${tournamentId} is ${existing.phase} (terminal)`)
        }
        const res = await services.httpStartTournament(tournamentId)
        return { status: 202, body: { ...res } }
      }
      if (rest.length === 3 && rest[2] === 'bracket') {
        if (method !== 'GET') return fail(405, 'method not allowed')
        const bracket = await services.httpGetTournamentBracket(tournamentId)
        if (!bracket) return fail(404, `tournament ${tournamentId} not found`)
        return ok(200, { bracket })
      }
      if (rest.length === 3 && rest[2] === 'retry') {
        if (method !== 'POST') return fail(405, 'method not allowed')
        const res = await services.httpRetryTournament(tournamentId)
        return ok(200, { ...res })
      }
      return fail(404, 'not found')
    }

    // /dsh-screeps/history/leaderboard
    if (rest[0] === 'history' && rest.length === 2 && rest[1] === 'leaderboard') {
      if (method !== 'GET') return fail(405, 'method not allowed')
      const tournamentId = asString(req.query?.get('tournamentId') ?? undefined)
      const rawLimit = req.query?.get('limit')
      const limit = rawLimit !== undefined && rawLimit !== null ? Number(rawLimit) : undefined
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        return fail(400, 'limit must be an integer 1-100')
      }
      const page = await services.httpLeaderboard({ tournamentId, limit })
      return ok(200, { leaderboard: page })
    }

    // /dsh-screeps/matches/:id/replay
    if (rest.length === 3 && rest[0] === 'matches' && rest[2] === 'replay') {
      if (method !== 'GET') return fail(405, 'method not allowed')
      const matchId = asString(rest[1])!
      const match = await services.match.store.get(matchId)
      if (!match) return fail(404, `match ${matchId} not found`)
      const q = req.query
      let cursor: number | undefined
      let afterTick: number | undefined
      if (q?.has('cursor')) {
        cursor = Number(q.get('cursor'))
        if (!Number.isInteger(cursor) || cursor < 0) return fail(400, 'cursor must be a non-negative integer')
      }
      if (q?.has('afterTick')) {
        afterTick = Number(q.get('afterTick'))
        if (!Number.isInteger(afterTick) || afterTick < 0) return fail(400, 'afterTick must be a non-negative integer')
      }
      let limit = q?.has('limit') ? Number(q.get('limit')) : 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(400, 'limit must be an integer 1-200')
      const page = await services.httpReadReplay(matchId, { cursor, limit, afterTick })
      if (page.unavailable) {
        // ordinary legacy match 无 replay → 明确 unavailable（不伪造空完成回放，plan §5.3）
        return ok(200, { ok: true, matchId, unavailable: true, reason: 'no replay for this match (ordinary legacy match?)' })
      }
      return ok(200, {
        matchId,
        replayId: page.meta?.replayId,
        status: page.status,
        complete: page.complete,
        gapReasons: page.gapReasons,
        nextCursor: page.nextCursor,
        availableCount: page.availableCount,
        records: page.sanitized,
      })
    }

    // A0：POST /dsh-screeps/spawn-agents —— 人类建赛：host spawn N 个 Agent 会话为玩家。
    // 语义（七审提示 6 钉死）：同步预检（preset/count/activeExists）后返回 202 + {recruiting:true}，
    // 异步编排（A1 create → A2..N join → 写脚本）由后台推进，前端轮询 GET /matches 看「招募中」进展。
    // 注意：spawn 出的是真实 Agent 会话（真 LLM，烧模型额度）——client 按钮二次确认文案在此收口。
    if (rest[0] === 'spawn-agents' && rest.length === 1) {
      if (method !== 'POST') return fail(405, 'method not allowed')
      const body = (req.body ?? {}) as Record<string, unknown>
      const preset = asString(body.preset) as MatchPreset | undefined
      if (!preset || !PRESETS.includes(preset)) return fail(400, `preset must be one of ${PRESETS.join(', ')}`)
      const count = typeof body.count === 'number' ? body.count : undefined
      if (count !== undefined && (!Number.isInteger(count) || count < 2)) return fail(400, 'count must be an integer >= 2')
      // 数量/范围预检（与 orchestrator 同口径，立即 400 而不是 500）
      const cfg = configFromPreset(preset)
      if (cfg.form === 'arena' && count !== undefined && count !== 2) {
        return fail(400, 'arena matches require exactly 2 agents')
      }
      if (cfg.form === 'world' && count !== undefined && (count < 2 || count > cfg.seats)) {
        return fail(400, `world matches allow ${2}-${cfg.seats} agents`)
      }
      // spawn 前 activeExists 预检（plan A0：先查再 spawn，避免 spawn 完才 409）
      const active = await services.match.store.active()
      if (active) return fail(409, `active match ${active.id} (${active.phase}) must settle first`)
      const model = asString(body.model)
      const provider = asString(body.provider)
      // 真实 Agent 玩家必须有模型（persona 组装要 {{model}}；缺失 → 子会话 turn 直接 error，
      // 对局永不建出——2026-09-09 真实链路实测实锤）。同步 400 明确指引，不创建任何会话。
      const effectiveModel = model ?? services.agentModel
      if (!effectiveModel) {
        return fail(
          400,
          'agent model not configured: spawned Agent players need a model for persona assembly; ' +
            'pass body.model or set Config agentModel (e.g. "openrouter/deepseek/deepseek-v4-flash-0731")',
        )
      }
      // 异步编排：不等待完成（A1 create 前 matchId 未知）；失败仅记录（前端靠「招募中」超时兜底）
      void services
        .spawnAgentMatch({ preset, ...(count !== undefined ? { count } : {}), ...(model ? { model } : {}), ...(provider ? { provider } : {}) })
        .catch(err => {
          // 编排失败（含 dispose 全部已 spawn 会话后）：可观测，不崩 HTTP 响应
          ;(services as unknown as { log?: (msg: string) => void }).log?.(`spawn-agents ${preset} failed: ${String((err as Error).message ?? err)}`)
        })
      return { status: 202, body: { ok: true, recruiting: true } }
    }

    // GET /dsh-screeps/world —— 公开战况投影（M6：users[].rooms[].spawns 随透传带出）
    if (rest[0] === 'world' && rest.length === 1) {
      if (method !== 'GET') return fail(405, 'method not allowed')
      const world = await services.getWorld()
      return ok(200, { world })
    }

    // M6：GET /dsh-screeps/terrain?rooms=W15N15,W14N15 —— 地形位域串透传（观战坐标地图；
    // client 按 matchId 缓存，host 不缓存）。房名校验 + ≤64 上限（与 mod 端点一致，双保险）。
    if (rest[0] === 'terrain' && rest.length === 1) {
      if (method !== 'GET') return fail(405, 'method not allowed')
      const roomsParam = req.query?.get('rooms')
      if (!roomsParam) return fail(400, 'rooms required (comma-separated room names)')
      const rooms = roomsParam.split(',').map(s => s.trim()).filter(s => s !== '')
      if (rooms.length === 0 || rooms.length > 64) return fail(400, 'rooms must contain 1..64 names')
      if (rooms.some(r => !ROOM_RE.test(r))) return fail(400, 'rooms must be room names like E5N5')
      const data = await services.getTerrain(rooms)
      return ok(200, { rooms, terrain: data.terrain })
    }

    // /dsh-screeps/matches[/<id>[/<action>]]
    if (rest[0] === 'matches') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const matches = await services.match.store.list()
          return ok(200, { matches })
        }
        if (method === 'POST') {
          const body = (req.body ?? {}) as Record<string, unknown>
          const preset = asString(body.preset) as MatchPreset | undefined
          const sessionId = asString(body.sessionId)
          const username = asString(body.username)
          if (!preset || !PRESETS.includes(preset)) return fail(400, `preset must be one of ${PRESETS.join(', ')}`)
          if (!sessionId || !username) return fail(400, 'sessionId and username are required')
          if (!USERNAME_RE.test(username)) return fail(400, 'invalid username')
          // 2026-09-09：`__bot__` 前缀是测试 bot 座位的保留命名（仅测试内部链路注入，HTTP 面不暴露）
          if (sessionId.startsWith('__bot__') || username.startsWith('__bot_')) {
            return fail(400, 'sessionId/username starting with `__bot` is reserved for test bots')
          }
          // M2 E 步：create 可选 tickDuration（透传 preset override）
          const tickDuration = typeof body.tickDuration === 'number' && body.tickDuration > 0 ? Math.floor(body.tickDuration) : undefined
          const match = await services.match.createMatch({ preset, sessionId, username, tickDuration })
          return ok(201, { match })
        }
        return fail(405, 'method not allowed')
      }

      const matchId = asString(rest[1])
      if (!matchId) return fail(400, 'match id required')

      if (rest.length === 2) {
        if (method === 'GET') {
          const match = await services.match.store.get(matchId)
          if (!match) return fail(404, `match ${matchId} not found`)
          return ok(200, { match })
        }
        // S12 体验轮：DELETE /matches/:id —— 删除对局（终局清理，防中断累积）。
        // 仅终态（settled/interrupted）可删，活跃对局 409。
        if (method === 'DELETE') {
          const match = await services.match.store.get(matchId)
          if (!match) return fail(404, `match ${matchId} not found`)
          if (match.phase === 'settled' || match.phase === 'interrupted') {
            await services.match.store.remove(matchId)
            return ok(200, { removed: matchId })
          }
          return fail(409, 'only settled/interrupted matches can be deleted')
        }
        return fail(405, 'method not allowed')
      }

      // S12：GET /matches/:id/console —— 必须在下方 POST-only 405 检查之前分流
      // （http.ts 现状：action 赋值 + 非 POST 即 405 先于 switch）。
      if (rest.length === 3 && rest[2] === 'console') {
        if (method !== 'GET') return fail(405, 'method not allowed')
        const match = await services.match.store.get(matchId)
        if (!match) return fail(404, `match ${matchId} not found`)
        try {
          const delta = await collectConsole(services, match, req.query)
          return ok(200, { ...delta })
        } catch (err) {
          if (err instanceof ConsoleQueryError) return fail(400, err.message)
          throw err
        }
      }

      // M2 C 步：GET /matches/:id/observe —— 公开投影（scoreboard 是公开战况，
      // AGENTS 观察分层「公开投影不需会话」），同样在 POST-only 405 检查之前分流
      //（S12 board.tsx 现用 GET 轮询，此前恒 405 → 行为修复，非 client 新 UI）。
      if (rest.length === 3 && rest[2] === 'observe' && method === 'GET') {
        const match = await services.match.observe(matchId)
        return ok(200, { observation: match })
      }

      // M6：GET /matches/:id/code —— 代码提交版本列表（公开观战面；只给元数据不给内容，
      // 无 sessionId/token；内容端点同样必须在下方 POST-only 405 检查之前分流）。
      if (rest.length === 3 && rest[2] === 'code' && method === 'GET') {
        const match = await services.match.store.get(matchId)
        if (!match) return fail(404, `match ${matchId} not found`)
        const list = await services.match.codeLog.list(matchId)
        return ok(200, { matchId, players: CodeLog.groupVersions(list.versions) })
      }

      // M6：GET /matches/:id/code/:username/:seq —— 单条内容（观战公开视角：Agent 提交的
      // 代码本身；全文件过滤定位，无路径拼接）。username 过 USERNAME_RE 预校验。
      if (rest.length === 5 && rest[2] === 'code' && method === 'GET') {
        const username = asString(rest[3])
        const seq = Number(rest[4])
        if (!username || !USERNAME_RE.test(username)) return fail(400, 'invalid username')
        if (!Number.isInteger(seq) || seq < 1) return fail(400, 'seq must be a positive integer')
        const match = await services.match.store.get(matchId)
        if (!match) return fail(404, `match ${matchId} not found`)
        const entry = await services.match.codeLog.getEntry(matchId, username, seq)
        if (!entry) return fail(404, `code version ${username}/${seq} not found in match ${matchId}`)
        return ok(200, {
          username: entry.username,
          seq: entry.seq,
          ts: entry.ts,
          phase: entry.phase,
          ...(entry.roundIndex !== undefined ? { roundIndex: entry.roundIndex } : {}),
          source: entry.source,
          size: entry.size,
          modules: entry.modules,
        })
      }

      // S12 体验轮：DELETE /matches/:id 已并入 rest.length===2 块（GET/DELETE 分支）。

      const action = rest[2]
      if (method !== 'POST') return fail(405, 'method not allowed')
      const body = (req.body ?? {}) as Record<string, unknown>
      const sessionId = asString(body.sessionId)
      // 写操作的角色校验载体（M2 C 步）：非 start 的 pause/resume/settle 要求调用方是该对局玩家；
      // start 要求 creator（players[0]）。create/join 的 sessionId 是报名入局，由各自的 case 处理。
      const matchForAuth = await services.match.store.get(matchId)
      if (!matchForAuth) return fail(404, `match ${matchId} not found`)
      const isPlayer = (sid: string | undefined): boolean => !!sid && matchForAuth.players.some(p => p.sessionId === sid)
      const isCreator = (sid: string | undefined): boolean => !!sid && matchForAuth.players[0]?.sessionId === sid
      switch (action) {
        case 'start': {
          if (!sessionId) return fail(400, 'sessionId is required (creator)')
          if (!isCreator(sessionId)) return fail(403, 'only the creator may start the match')
          // M2 E 步：rooms 支持 string 或 {room, exits?}（战斗 IT 用带出口的相邻房）
          const rooms = Array.isArray(body.rooms) ? body.rooms : undefined
          if (rooms) {
            for (const r of rooms) {
              const ok2 = typeof r === 'string'
                ? ROOM_RE.test(r)
                : !!r && typeof r === 'object' && typeof (r as { room?: unknown }).room === 'string' &&
                  ROOM_RE.test((r as { room: string }).room)
              if (!ok2) return fail(400, 'rooms must be room names like E5N5 or {room, exits?} objects')
            }
          }
          const match = await services.match.start(matchId, rooms ? { rooms: rooms as never[] } : {})
          return ok(200, { match })
        }
        case 'pause': {
          if (!sessionId) return fail(400, 'sessionId is required')
          if (!isPlayer(sessionId)) return fail(403, 'only players of this match may pause it')
          const match = await services.match.pause(matchId)
          return ok(200, { match })
        }
        case 'resume': {
          if (!sessionId) return fail(400, 'sessionId is required')
          if (!isPlayer(sessionId)) return fail(403, 'only players of this match may resume it')
          const match = await services.match.resume(matchId)
          return ok(200, { match })
        }
        case 'observe': {
          const observation = await services.match.observe(matchId)
          return ok(200, { observation })
        }
        case 'settle': {
          if (!sessionId) return fail(400, 'sessionId is required')
          if (!isCreator(sessionId)) return fail(403, 'only the creator may settle the match')
          const reason = asString(body.reason) ?? 'manual'
          if (!['ticksExhausted', 'lastStanding', 'scoreTarget', 'manual'].includes(reason)) {
            return fail(400, 'invalid settle reason')
          }
          const match = await services.match.settle(matchId, reason as 'manual')
          return ok(200, { match })
        }
        default:
          return fail(404, 'not found')
      }
    }

    return fail(404, 'not found')
  } catch (err) {
    if (err instanceof MatchError) {
      return fail(statusToHttp(err.code), err.message)
    }
    return fail(500, String(err && (err as Error).message ? (err as Error).message : err))
  }
}

/** 读取请求体（上限 1MB，防呆）。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return undefined
  return JSON.parse(text)
}

/** 把路由核心挂到 DSH webServer（服务就绪后经 ctx.inject 激活，ctx.effect 挂账注销）。 */
export function registerHttp(ctx: import('@deepseek-ai/cordis').Context, svc: ScreepsService): void {
  ctx.inject(['webServer'], (cx) => {
    const webServer = (cx as unknown as { webServer: WebServerLike }).webServer
    cx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: '/dsh-screeps',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const pathname = url.pathname
            let body: unknown
            try {
              body = await readBody(req)
            } catch (err) {
              res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: String((err as Error).message) }))
              return
            }
            const response = await handleArenaRequest(svc, {
              method: req.method ?? 'GET',
              pathname,
              query: url.searchParams,
              body,
            })
            res.writeHead(response.status, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(response.body))
          },
        }),
      'dsh-screeps: http routes',
    )
  })
}
