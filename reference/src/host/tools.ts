/**
 * S13 — 工具面（host，session 映射后）。
 *
 * 公平边界（AGENTS.md 红线）：一个 DSH 会话 = 一个 Screeps 用户。映射键是
 * exec.agent.id（SessionId），映射来源是对局参与者（screeps_match create/join 时
 * 绑定）。未绑定的会话除 world_status/match(list) 外一律被拒。
 *
 * 工具面（本文件）：world_status / report / wait / submit_code / console /
 * read_memory / write_memory / match。注册经 ctx.inject(['tools']) 等服务就绪，
 * ctx.effect 挂账注销；执行细节（超时/取消/展示）归 dsh-tools 管线。
 */
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { MatchPreset } from './match/model.ts'
import type { ScreepsService, ScreepsWorldSnapshot } from './service.ts'
import type { MatchService } from './match/match-service.ts'
import { extractConsoleErrors, filterPlayerEvents, flattenEvents, summarizeEvents, type EventSummary } from './report.ts'
import type { EventTick } from './match/attribution.ts'

/** webServer/tools 的结构化最小接口（正式包未安装，降低耦合）。 */
export interface ToolRegistryLike {
  register(definition: unknown): () => void
}

const WAIT_LIMIT_MS = 120_000
const CONSOLE_CAPTURE_MS = 4_000
const USERNAME_RE = /^[A-Za-z0-9_-]{1,30}$/

/** mod 自环探针帧（consoleOutput 命令每次 publish SELFTEST 验证 pubsub 链路）——
 *  是诊断数据不是玩家输出，消费时必须过滤，否则污染正常 console 流（M2 D 步
 *  report 预调用 consoleOutput 后 SELFTEST 会提前触发工具的 lineCount>0 break）。 */
export function isSelfTestFrame(entry: unknown): boolean {
  const message = entry as { messages?: string[] | { log?: string[]; results?: string[] }; error?: string }
  if (Array.isArray(message.messages)) return message.messages.includes('SELFTEST')
  return false
}

export interface SessionBinding {
  username: string
  matchId: string
  matchPhase: string
  /** M4-C：代码模式（live/frozen/round）。 */
  codeMode?: string
  /** M4-C：round 局的 roundTokenHash（明文只在调用方内存；工具校验用明文 hash 比对）。 */
  roundTokenHash?: string
  /** M4-C：该玩家在赛事中的 participantId。 */
  participantId?: string
}

/** 该会话的全部绑定（活跃对局优先，其余按 updatedAt 降序）。 */
export async function listBindings(svc: MatchService, sessionId: string): Promise<SessionBinding[]> {
  const all = await svc.store.list()
  const rank = (phase: string): number => (phase === 'running' || phase === 'paused' || phase === 'placing' ? 0 : 1)
  const sorted = [...all].sort((a, b) => rank(a.phase) - rank(b.phase) || b.updatedAt - a.updatedAt)
  const out: SessionBinding[] = []
  for (const match of sorted) {
    for (const player of match.players) {
      if (player.sessionId === sessionId) {
        out.push({
          username: player.username,
          matchId: match.id,
          matchPhase: match.phase,
          ...(match.codeMode !== undefined ? { codeMode: match.codeMode } : {}),
          ...(match.roundTokenHash !== undefined ? { roundTokenHash: match.roundTokenHash } : {}),
          ...(player.participantId !== undefined ? { participantId: player.participantId } : {}),
        })
      }
    }
  }
  return out
}

/** 会话 → Screeps 用户映射：取该会话参与的对局（活跃优先、最近优先）中的用户名。 */
export async function resolveBinding(svc: MatchService, sessionId: string): Promise<SessionBinding | undefined> {
  return (await listBindings(svc, sessionId))[0]
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function tickDurationMs(svc: ScreepsService): Promise<number> {
  try {
    const body = (await svc.system('getTickDuration')) as { tickDuration?: unknown }
    const value = Number(body.tickDuration)
    return Number.isFinite(value) && value > 0 ? value : 1000
  } catch {
    return 1000
  }
}

/** 会话 → 绑定用户；未绑定时抛出可读错误（工具层统一转 error 结果）。 */
export async function requireUser(svc: ScreepsService, sessionId: string | undefined): Promise<string> {
  if (!sessionId) throw new Error('no agent session on this call: user tools need an agent session')
  const binding = await resolveBinding(svc.match, sessionId)
  if (!binding) {
    throw new Error('this session has no bound Screeps user; create or join a match first (screeps_match action="create"/"join")')
  }
  return binding.username
}

/** M2 C 步：`__bot__` 前缀是内置 bot 座位的保留命名，普通 create/join 禁止仿冒。 */
export function isReservedBotName(value: string): boolean {
  return value.startsWith('__bot__') || value.startsWith('__bot_')
}

/** 世界快照 → 紧凑文本（delta 由调用方拼装）。 */
export function renderWorld(world: ScreepsWorldSnapshot): string {
  const users = world.users
    .map(
      u =>
        `${u.username} rooms=${u.ownedRooms} rcl=${u.rclTotal} spawns=${u.spawns} cpu=${u.cpu.toFixed(1)} ` +
        u.rooms.map(r => `${r.room}(${r.level},${r.progress})`).join(' '),
    )
    .join('\n')
  return `gameTime=${world.gameTime}\n${users || '(no users)'}`
}

export function buildTools(svc: ScreepsService): unknown[] {
  const reportCursors = new Map<
    string,
    { gameTime: number; users: Map<string, { ownedRooms: number; rclTotal: number; progress: number; lastUsedCpu?: number }> }
  >()
  const consoleCursors = new Map<string, number>()
  /** report 独立的事件 ring 游标（不与 lifecycle.observe 的消费互相影响）。 */
  const eventCursorBySession = new Map<string, number>()
  /** report 独立的 console 报错游标。 */
  const consoleCursorBySession = new Map<string, number>()

  const worldStatus = defineTool({
    name: 'screeps_world_status',
    description:
      'Public world projection: gameTime, every player with owned rooms, RCL totals, spawn counts and per-room progress. No session binding required.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute() {
      const world = await svc.getWorld()
      return { text: renderWorld(world), gameTime: world.gameTime }
    },
  })

  const report = defineTool({
    name: 'screeps_report',
    description:
      'Match report for your session: score/territory/RCL/progress deltas since the previous call plus the absolute projection, your-sight event digest, your script errors and CPU usage trend. Call this at every observation point.',
    parameters: {
      sinceTick: { type: 'number', description: 'Optional explicit since-tick; defaults to the previous report cursor' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      if (!sessionId) throw new Error('no agent session on this call')
      const binding = await resolveBinding(svc.match, sessionId)
      if (!binding) throw new Error('no bound Screeps user: create or join a match first (screeps_match)')
      const world = await svc.getWorld()
      const prev = reportCursors.get(sessionId)
      const since = args.sinceTick ?? prev?.gameTime
      reportCursors.set(sessionId, {
        gameTime: world.gameTime,
        users: new Map(world.users.map(u => [u.username, { ownedRooms: u.ownedRooms, rclTotal: u.rclTotal, progress: u.rooms.reduce((a, r) => a + r.progress, 0), lastUsedCpu: u.lastUsedCpu }])),
      })
      const lines: string[] = []
      lines.push(`gameTime=${world.gameTime}${since !== undefined ? ` (delta=${world.gameTime - since})` : ''}`)
      lines.push(`boundUser=${binding.username} match=${binding.matchId}(${binding.matchPhase})`)

      // M2 D 步：观察分层——事件聚合只给「己方视角」（attacker/target 是我 或 发生在我房间）
      const me = world.users.find(u => u.username === binding.username)
      const myRooms = new Set((me?.rooms ?? []).map(r => r.room))
      let eventDigest: EventSummary | undefined
      try {
        const fromCursor = eventCursorBySession.get(sessionId) ?? 0
        const page = await svc.eventLog(fromCursor)
        if (page.cursor > fromCursor && page.events.length > 0) {
          const visible = filterPlayerEvents(flattenEvents(page.events as EventTick[]), me?.id ?? null, myRooms)
          eventDigest = summarizeEvents(visible)
          eventCursorBySession.set(sessionId, page.cursor)
        }
      } catch {
        // 事件流不可用（如 server 未跑完部署）不阻塞 report 主体
      }

      // M2 D 步：己方报错（console ring 增量 filter error 帧）
      let errorCount = 0
      let firstError: string | undefined
      try {
        const fromCursor = consoleCursorBySession.get(sessionId) ?? 0
        const out = await svc.consoleOutput(binding.username, fromCursor)
        if (out.cursor > fromCursor && out.lines.length > 0) {
          const errors = extractConsoleErrors(out.lines)
          errorCount = errors.length
          firstError = errors[0]
          consoleCursorBySession.set(sessionId, out.cursor)
        }
      } catch {
        // 未建号（creating）阶段跳过
      }

      for (const user of world.users) {
        const before = prev?.users.get(user.username)
        const progress = user.rooms.reduce((a, r) => a + r.progress, 0)
        const delta = (label: string, now: number, old: number | undefined) =>
          old === undefined ? `${label}=${now}` : `${label}=${now}${now - old >= 0 ? '+' : ''}${now - old}`
        const cpuTrend =
          before?.lastUsedCpu !== undefined && user.lastUsedCpu !== undefined
            ? ` cpuUsed=${before.lastUsedCpu}→${user.lastUsedCpu}${user.lastUsedCpu >= before.lastUsedCpu ? '+' : ''}${user.lastUsedCpu - before.lastUsedCpu > 0 ? user.lastUsedCpu - before.lastUsedCpu : ''}`
            : user.lastUsedCpu !== undefined
              ? ` cpuUsed=${user.lastUsedCpu}`
              : ''
        lines.push(
          `${user.username}${user.username === binding.username ? ' (you)' : ''} ` +
            `${delta('rooms', user.ownedRooms, before?.ownedRooms)} ` +
            `${delta('rcl', user.rclTotal, before?.rclTotal)} ` +
            `${delta('progress', progress, before?.progress)} spawns=${user.spawns} cpu=${user.cpu.toFixed(1)}${cpuTrend}`,
        )
      }
      if (eventDigest) {
        lines.push(`events(inSight): involved=${eventDigest.involved} attack=${eventDigest.attack} destroyed=${eventDigest.destroyed} other=${eventDigest.other}`)
      }
      if (errorCount > 0) {
        lines.push(`errors: ${errorCount}${firstError ? ` — ${firstError.replace(/\n/g, ' ').slice(0, 160)}` : ''}`)
      }
      // M5 §3.6：周期边界提示——roundBreak 期间世界已暂停，Agent 可提交下一轮代码（commit=就绪）
      if (binding.matchPhase === 'roundBreak') {
        lines.push('ROUND_BREAK: world paused; submit your next-round code now (screeps_submit_code; all-ready auto-resumes)')
      }
      return { text: lines.join('\n'), gameTime: world.gameTime }
    },
  })

  const wait = defineTool({
    name: 'screeps_wait',
    description:
      'Block until the world advances by `ticks` (or `seconds` of wall time). Single call capped at 120s; cancelled via the caller signal. Use between report calls.',
    parameters: {
      ticks: { type: 'number', description: 'How many game ticks to wait for' },
      seconds: { type: 'number', description: 'Wall-time fallback cap in seconds' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const ticks = Number.isFinite(args.ticks) && args.ticks! > 0 ? Math.floor(args.ticks!) : undefined
      const seconds = Number.isFinite(args.seconds) && args.seconds! > 0 ? args.seconds! : undefined
      if (!ticks && !seconds) throw new Error('provide ticks or seconds')
      const started = Date.now()
      const budget = Math.min(WAIT_LIMIT_MS, seconds !== undefined ? seconds * 1000 : WAIT_LIMIT_MS)
      let deadline = Date.now() + budget
      if (ticks) {
        const perTick = await tickDurationMs(svc)
        deadline = Math.min(deadline, started + ticks * perTick * 1.5 + 2000)
        const world = await svc.getWorld()
        const target = world.gameTime + ticks
        while (Date.now() < deadline) {
          if (exec.signal.aborted) throw new Error('aborted')
          const current = await svc.getWorld()
          if (current.gameTime >= target) break
          await sleep(Math.min(500, deadline - Date.now()), exec.signal)
        }
      } else {
        const end = started + budget
        while (Date.now() < end) {
          if (exec.signal.aborted) throw new Error('aborted')
          await sleep(Math.min(500, end - Date.now()), exec.signal)
        }
      }
      const world = await svc.getWorld()
      return { text: `waited=${Date.now() - started}ms gameTime=${world.gameTime}`, waitedMs: Date.now() - started, gameTime: world.gameTime }
    },
  })

  const submitCode = defineTool({
    name: 'screeps_submit_code',
    description:
      'Upload/replace your Screeps code (hot update: active from the next tick). modules maps module name (main required) to source. The main module must export module.exports.loop = function () { ... }; the old module.exports = function () {} form is silently not executed by engine 4.3.x. Costs real match time in live presets.',
    parameters: {
      modules: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Module name → source. "main" is the entry module.',
        properties: {},
      },
      branch: { type: 'string', description: 'Optional branch; defaults to the active world branch' },
      roundToken: {
        type: 'string',
        description: 'M4 tournament round: the round token from your match prompt (required for codeMode=round attempts).',
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      if (!sessionId) throw new Error('no agent session on this call: user tools need an agent session')
      // M2 C 步：frozen 预设下热更被拒（BotArena 式代码冻结；完整 frozen 玩法归 M3）
      const binding = await resolveBinding(svc.match, sessionId)
      if (!binding) throw new Error('this session has no bound Screeps user; create or join a match first (screeps_match)')
      const username = binding.username
      const match = await svc.match.store.get(binding.matchId)
      if (match?.config.frozenCode) {
        throw new Error(`submit_code rejected: preset ${match.config.preset} freezes code (BotArena-style); live presets only`)
      }
      // M4 round-token 校验（plan §4.2）：赛事局 submit 必须携带本轮 roundToken 明文；
      // 明文 sha256 必须 === match.roundTokenHash；缺失/错 token 拒绝（旧 attempt 的 token 失效）。
      if (match?.codeMode === 'round') {
        const { sha256Hex } = await import('./canonical.ts')
        const token = typeof args.roundToken === 'string' ? args.roundToken : ''
        if (!match.roundTokenHash || token === '' || sha256Hex(token) !== match.roundTokenHash) {
          throw new Error(
            'submit_code rejected: this is a tournament round match — you must pass the roundToken from your match prompt',
          )
        }
        // placing/running/paused/settling 对 round 局显式拒绝（plan §4.2：submit 只在 creating
        // 接受一次结构合法 staged code；start 后不再热更——赛事局是 frozen-in-round 语义）
        if (match.phase !== 'creating') {
          throw new Error(`submit_code rejected: round matches only accept code during the submit window (phase=${match.phase})`)
        }
      }
      const modules = args.modules as Record<string, string>
      if (!modules || typeof modules !== 'object' || typeof modules.main !== 'string') {
        throw new Error('modules.main (entry module source) is required')
      }
      // M5 world-rounds 周期提交（plan §3.3 · codeMode='rounds'）：
      //   roundBreak → commit = 就绪（暂存 code + ready=true，下一轮 resumeNextRound 才真正上传私服）；
      //   running → 拒（周期内代码冻结，等下一周期边界）；
      //   creating → 走下方 A0 暂存（第 0 周期前代码，start 建号注入）；
      //   placing/settling → 各自显式拒。
      if (match?.codeMode === 'rounds') {
        if (match.phase === 'roundBreak') {
          if (!modules.main.includes('module.exports.loop')) {
            throw new Error('committed code rejected: main must contain module.exports.loop = function () { ... }')
          }
          await svc.match.store.update(match.id, state => {
            const mine = state.players.find(p => p.sessionId === sessionId)
            if (mine) {
              mine.code = modules
              mine.ready = true
            }
          })
          // M6 记录点 1（plan-M6 §3.1）：roundBreak commit = 该周期提交；append 永不 reject。
          await svc.match.codeLog.append(match.id, {
            username,
            phase: 'roundBreak',
            roundIndex: match.roundIndex,
            source: 'agent-submit',
            modules,
          })
          return {
            text: `code committed for ${username} (round break); will be uploaded before the next round resume — waiting for all players to commit`,
          }
        }
        if (match.phase === 'running') {
          throw new Error(
            'submit_code rejected: code is frozen during a round (rounds preset). Commit at the next round boundary instead.',
          )
        }
      }
      // A0 暂存式 submit（plan M3 v5.3 钉死，四审阻塞 1 修法）：creating 阶段用户未建号
      // （lifecycle.start 才 createUser），submit_code 直走 getToken → /api/arena/token 对未建号
      // 404 —— 拦截层 = resolveBinding+store.get 之后、svc.submitCode（getToken）之前。
      // creating 阶段：最小结构合法校验（modules 非空 + main 存在 + 含 module.exports.loop）后
      // 暂存进 MatchPlayer.code + submitted=true（start 建号注入，同 botCode 先例）。空 loop 通过
      // 是设计（结构无法区分空壳，开局后 live 热更可自救）。
      if (match && match.phase === 'creating') {
        if (!modules.main.includes('module.exports.loop')) {
          throw new Error('staged code rejected: main must contain module.exports.loop = function () { ... }')
        }
        await svc.match.store.update(match.id, state => {
          const mine = state.players.find(p => p.sessionId === sessionId)
          if (mine) {
            mine.code = modules
            mine.submitted = true
          }
        })
        // M6 记录点 2（plan-M6 §3.1）：creating 暂存（普通局与赛事局 codeMode='round' 同经此处）。
        await svc.match.codeLog.append(match.id, {
          username,
          phase: 'creating',
          source: 'agent-submit',
          modules,
        })
        const out: Record<string, JsonValue> = { text: `code staged for ${username}; active when the match starts` }
        out.staged = true
        return out
      }
      // A0 placing 显式拒（七审次要 2，防御性兜底——start 需全 submitted 才可点，实际不可达）
      if (match && match.phase === 'placing') {
        throw new Error('match is placing; wait for start (code no longer accepted)')
      }
      const result = await svc.submitCode(username, modules, args.branch ?? '$activeWorld')
      // M6 记录点 3（plan-M6 §3.1）：live 直传（arena-blitz running 等）——host 状态不留副本，
      // 提交即流水（modules 原样记录；live 分支无 loop 校验是有意维持的观战语义，不在此补）。
      await svc.match.codeLog.append(binding.matchId, {
        username,
        phase: match?.phase ?? 'running',
        ...(match?.roundIndex !== undefined ? { roundIndex: match.roundIndex } : {}),
        source: 'agent-submit',
        modules,
      })
      return { text: `code submitted for ${username} at ${result.timestamp}; active next tick`, timestamp: result.timestamp }
    },
  })

  const consoleTool = defineTool({
    name: 'screeps_console',
    description:
      'Run a console expression as your user and capture its output. The expression executes on the next tick; output is polled for a few seconds. Use for telemetry and emergency fixes.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression, max 1KB (official limit)' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const username = await requireUser(svc, exec.agent?.id)
      const since = consoleCursors.get(username) ?? 0
      const fired = await svc.runConsole(username, args.expression)
      if (fired !== 'ok') throw new Error(`console dispatch failed: ${fired}`)
      const deadline = Date.now() + CONSOLE_CAPTURE_MS
      let lines: unknown[] = []
      let cursor = since
      while (Date.now() < deadline) {
        await sleep(300, exec.signal)
        const output = await svc.consoleOutput(username, since)
        // 过滤 mod 自环探针帧（SELFTEST）后仍有真实输出才 break——自环帧不是玩家输出，
        // 提前 break 会漏掉真正的 TOOL_E2E/2（M2 D 步 report 预调用 consoleOutput 引入的时序变化）
        const real = output.lines.filter(entry => !isSelfTestFrame(entry))
        if (real.length > 0) {
          lines = real
          cursor = output.cursor
          break
        }
        cursor = output.cursor
      }
      consoleCursors.set(username, cursor)
      const text =
        lines.length === 0
          ? '(expression dispatched; no output captured yet — call again with screeps_console_output semantics via screeps_console to poll)'
          : lines
              .map(entry => {
                const message = entry as { messages?: string[] | { log?: string[]; results?: string[] }; error?: string }
                if (Array.isArray(message.messages)) return message.messages.join('\n')
                if (message.messages) {
                  const { log = [], results = [] } = message.messages
                  const parts = [...log, ...results]
                  return parts.length ? parts.join('\n') : '(tick ran, no output)'
                }
                if (message.error) return `error: ${message.error}`
                return JSON.stringify(message)
              })
              .join('\n')
      return { text, lineCount: lines.length }
    },
  })

  const readMemory = defineTool({
    name: 'screeps_read_memory',
    description: 'Read your Memory (optionally a dotted sub-path). Large values return gz+base64 encoded and are decoded for you.',
    parameters: {
      path: { type: 'string', description: 'Optional dotted path, e.g. "stats.tick"' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const username = await requireUser(svc, exec.agent?.id)
      const raw = (await svc.readMemoryPath(username, args.path)) as { data?: unknown }
      if (raw.data === undefined) return { text: 'undefined (path not found)', value: null }
      if (typeof raw.data === 'string' && raw.data.startsWith('gz:')) {
        const { gunzipSync } = await import('node:zlib')
        const parsed = JSON.parse(gunzipSync(Buffer.from(raw.data.slice(3), 'base64')).toString('utf8')) as JsonValue
        return { text: JSON.stringify(parsed), value: parsed }
      }
      return { text: typeof raw.data === 'string' ? raw.data : JSON.stringify(raw.data), value: raw.data as JsonValue }
    },
  })

  const writeMemory = defineTool({
    name: 'screeps_write_memory',
    description: 'Write a value into your Memory (optionally at a dotted sub-path). JSON value; 1MB official limit.',
    parameters: {
      value: { type: 'json', required: true, description: 'Value to write' },
      path: { type: 'string', description: 'Optional dotted sub-path' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const username = await requireUser(svc, exec.agent?.id)
      await svc.writeMemory(username, args.value, typeof args.path === 'string' ? args.path : undefined)
      return { text: `memory written${args.path ? ` at ${args.path}` : ''}` }
    },
  })

  const match = defineTool({
    name: 'screeps_match',
    description:
      'Match lifecycle control: create/join bind this session to a Screeps user (fair boundary); start deploys and resumes the world; pause/resume/observe/settle manage the run. start and settle are creator-only; pause/resume/observe require being a player. 对局参与者只能是 Agent 会话（测试 bot 座位由内部测试链路注入，不通过本工具）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'join', 'start', 'pause', 'resume', 'observe', 'settle', 'status', 'list'],
      },
      matchId: { type: 'string' },
      preset: { type: 'string', enum: ['world-rounds', 'world-frozen', 'arena-blitz'] },
      username: { type: 'string', description: 'Screeps username to bind (create/join)' },
      tickDuration: { type: 'number', description: 'Optional per-tick ms override for create (overrides preset default)' },
      roundTicks: { type: 'number', description: 'Optional world-rounds per-round tick length (create only; >0 to enable round boundaries)' },
      maxRounds: { type: 'number', description: 'Optional world-rounds max rounds (create only; >0 to cap)' },
      reason: { type: 'string', enum: ['ticksExhausted', 'lastStanding', 'scoreTarget', 'manual'] },
      rooms: { type: 'array', description: 'Per-player rooms; string name or {room, exits?} object', items: { type: 'object', additionalProperties: true } },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }] },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      if (!sessionId) throw new Error('no agent session on this call')
      const matches = svc.match

      const payload: Record<string, JsonValue> = { text: '' }
      switch (args.action) {
        case 'create': {
          if (!args.username || !USERNAME_RE.test(args.username)) throw new Error('username (^[A-Za-z0-9_-]{1,30}$) is required')
          // 2026-09-09：`__bot__` 前缀是测试 bot 座位的保留命名（仅测试内部链路注入，工具面不暴露 addBot）
          if (isReservedBotName(sessionId) || isReservedBotName(args.username)) throw new Error('__bot__ prefix is reserved for test bots')
          const state = await matches.createMatch({
            preset: (args.preset ?? 'world-rounds') as MatchPreset,
            sessionId,
            username: args.username,
            tickDuration: Number.isFinite(args.tickDuration) && args.tickDuration! > 0 ? Math.floor(args.tickDuration!) : undefined,
            roundTicks: Number.isFinite(args.roundTicks) && args.roundTicks! > 0 ? Math.floor(args.roundTicks!) : undefined,
            maxRounds: Number.isFinite(args.maxRounds) && args.maxRounds! > 0 ? Math.floor(args.maxRounds!) : undefined,
          })
          payload.match = state as unknown as JsonValue
          payload.text = `match ${state.id} created (${args.preset ?? 'world-rounds'}); join a second player then start`
          break
        }
        case 'join': {
          if (!args.matchId) throw new Error('matchId is required')
          if (!args.username || !USERNAME_RE.test(args.username)) throw new Error('username is required')
          if (isReservedBotName(sessionId) || isReservedBotName(args.username)) throw new Error('__bot__ prefix is reserved for built-in bots')
          const state = await matches.join(args.matchId, { sessionId, username: args.username })
          payload.match = state as unknown as JsonValue
          payload.text = `joined ${state.id} as ${args.username} (${state.players.length} players)`
          break
        }
        case 'start': {
          if (!args.matchId) throw new Error('matchId is required')
          const state = await matches.store.get(args.matchId)
          if (!state) throw new Error(`match ${args.matchId} not found`)
          if (state.players[0]?.sessionId !== sessionId) throw new Error('only the creator may start the match')
          // M2 E 步：rooms 支持 string 或 {room, exits?}（schema 层统一为 object/string 混合）
          const roomsArg = Array.isArray(args.rooms)
            ? (args.rooms as unknown[])
                .map(r => {
                  if (typeof r === 'string') return r as never
                  if (r && typeof r === 'object' && typeof (r as { room?: unknown }).room === 'string') {
                    return { room: (r as { room: string }).room, exits: (r as { exits?: unknown }).exits as Record<string, number[]> | undefined } as never
                  }
                  return null
                })
                .filter((x): x is never => x !== null)
            : undefined
          const started = await matches.start(args.matchId, roomsArg ? { rooms: roomsArg } : {})
          payload.match = started as unknown as JsonValue
          payload.text = `match running; startTick=${started.startTick}; rooms=${JSON.stringify(started.assignments)}`
          break
        }
        case 'pause': {
          if (!args.matchId) throw new Error('matchId is required')
          // M2 C 步：暂停/恢复/观战要求调用会话是该对局玩家（公平边界收口）
          const state = await matches.store.get(args.matchId)
          if (!state) throw new Error(`match ${args.matchId} not found`)
          if (!state.players.some(p => p.sessionId === sessionId)) throw new Error('only players of this match may pause it')
          const paused = await matches.pause(args.matchId)
          payload.match = paused as unknown as JsonValue
          payload.text = `match paused at tick ${paused.phaseTick ?? '?'}`
          break
        }
        case 'resume': {
          if (!args.matchId) throw new Error('matchId is required')
          const state = await matches.store.get(args.matchId)
          if (!state) throw new Error(`match ${args.matchId} not found`)
          if (!state.players.some(p => p.sessionId === sessionId)) throw new Error('only players of this match may resume it')
          const resumed = await matches.resume(args.matchId)
          payload.match = resumed as unknown as JsonValue
          payload.text = 'match resumed'
          break
        }
        case 'observe': {
          if (!args.matchId) throw new Error('matchId is required')
          const state = await matches.store.get(args.matchId)
          if (!state) throw new Error(`match ${args.matchId} not found`)
          if (!state.players.some(p => p.sessionId === sessionId)) throw new Error('only players of this match may observe it')
          const observation = await matches.observe(args.matchId)
          payload.observation = observation as unknown as JsonValue
          payload.text =
            `gameTime=${observation.gameTime} ticksElapsed=${observation.ticksElapsed ?? '?'} autoSettle=${observation.autoSettle.due ? observation.autoSettle.reason : 'no'}\n` +
            Object.entries(observation.scoreboard)
              .map(([sid, s]) => `${sid === sessionId ? '(you) ' : ''}${sid}: score=${s.score} territory=${s.counters.territory} rcl=${s.counters.rclTotal}${s.eliminated ? ' ELIMINATED' : ''}`)
              .join('\n')
          break
        }
        case 'settle': {
          if (!args.matchId) throw new Error('matchId is required')
          const state = await matches.store.get(args.matchId)
          if (!state) throw new Error(`match ${args.matchId} not found`)
          if (state.players[0]?.sessionId !== sessionId) throw new Error('only the creator may settle the match')
          const settled = await matches.settle(args.matchId, (args.reason ?? 'manual') as 'manual')
          payload.match = settled as unknown as JsonValue
          payload.text = `match settled; winner=${JSON.stringify(settled.winner)}`
          break
        }
        case 'status': {
          if (!args.matchId) throw new Error('matchId is required')
          const state = await matches.store.get(args.matchId)
          if (!state) throw new Error(`match ${args.matchId} not found`)
          payload.match = state as unknown as JsonValue
          payload.text = `${state.id}: ${state.phase} players=${state.players.map(p => `${p.sessionId}→${p.username}`).join(', ')}`
          break
        }
        case 'list': {
          const all = await matches.store.list()
          const mine = all.filter(m => m.players.some(p => p.sessionId === sessionId))
          payload.matches = mine as unknown as JsonValue
          payload.text = mine.length === 0 ? '(no matches for this session)' : mine.map(m => `${m.id}: ${m.phase} (${m.players.length} players)`).join('\n')
          break
        }
        default:
          // 2026-09-09 对齐：addBot 已从工具面摘除（对局参与者只能是 Agent）；未列 action 一律拒。
          throw new Error(`unsupported screeps_match action: ${String(args.action)}`)
      }
      return payload
    },
  })

  return [worldStatus, report, wait, submitCode, consoleTool, readMemory, writeMemory, match]
}

/** 服务就绪后注册全部工具（ctx.effect 挂账注销）。 */
export function registerTools(ctx: Context, svc: ScreepsService): void {
  ctx.inject(['tools'], (cx) => {
    const tools = (cx as unknown as { tools: ToolRegistryLike }).tools
    const definitions = buildTools(svc)
    const disposers = definitions.map(definition => tools.register(definition))
    cx.effect(
      () => () => {
        for (const dispose of disposers) dispose()
      },
      'dsh-screeps: tools',
    )
  })
}
