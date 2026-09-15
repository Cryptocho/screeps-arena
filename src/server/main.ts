/**
 * M2/S0 统一真实组装入口：ScreepsService（managed 私服）+ RealArena + MatchDriver +
 * HTTP/WS 桥 + 前端静态托管 + 对局 journal（interrupted 恢复）。
 * dev / compose / IT **共用同一份组装**（M1 复审问题 3 教训：mock 自证而真实路径漏接）。
 *
 * CLI：node dist/server/main.mjs [--port N] [--host H] [--data-dir D] [--static-dir P]
 *      [--agent-dir P] [--model M] [--rooms E5N5,E7N5,…]
 * 环境变量：OPENROUTER_API_KEY（在位时挂真实 LLM 唤醒，缺席 = 只推进时钟的观战形态）；
 *          ARENA_ROOMS（房间池覆盖）；SMOKE_BASE_URL（provider 覆盖）；ARENA_MOD_PATH（mod 路径覆盖）；
 *          ARENA_MODEL（模型覆盖，compose 形态——CMD 不便传 CLI 参数）。
 *
 * 数据布局（--data-dir，默认 <cwd>/.arena-data）：
 *   server/            = 私服 serverDir（compose 挂卷 screeps-data）
 *   journal/matches/   = 对局 journal（相位迁移原子落盘，启动扫描恢复，M2/S5）
 *   history/           = 对局历史 jsonl（记账全量 + teardown 状态，M3/S4）
 *   agents/            = 席位工作区（seatSlug 目录，M2/S7）
 *   replays/           = 回放 JSONL（append-only，M6/D1；查询面 GET /api/replays/:matchId）
 *
 * M3（plan-M3）：多活跃对局——createMatch 守卫 = 房间池可容纳（可用池 = ROOM_POOL −
 * roomsSnapshot 在占，含 journal 恢复局）；settle → history(pending) → journal.remove →
 * 异步定点 teardown（removeUser/removeRoom，幂等，崩溃由重启扫描 history pending 补拆解）；
 * 启动日志 `[main] teardown-recovered=N`。
 *
 * mod 路径：默认 <cwd>/src/server/screeps/arena-mod.cjs（dev 与 compose WORKDIR=/app 均成立；
 * tsdown bundle 不复制 .cjs 附件）。容器外异目录运行用 ARENA_MOD_PATH 覆盖。
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { MatchDriver } from './http/driver.js'
import type { SeatWaker } from './http/driver.js'
import { startHttpServer } from './http/server.js'
import type { ArenaHttpServices } from './http/routes.js'
import { ScreepsService, modFileFromContent } from './screeps/service.js'
import { RealArena, ARENA_BASE_ROOM, arenaMirrorRoom } from './screeps/arena.js'
import { allocateRooms, assertSeatsFree } from './pool.js'
import { recoverPendingTeardowns } from './teardown.js'
import { MatchMachine } from './match/machine.js'
import type { MatchEvent } from './match/machine.js'
import { configFromPreset, DEFAULT_MATCH_CONFIG, PRESETS } from './match/model.js'
import type { MatchConfig, MatchPreset } from './match/model.js'
import { MatchJournal } from './match/journal.js'
import type { MatchJournalRecord } from './match/journal.js'
import { MatchHistory } from './history.js'
import type { MatchHistoryRecord } from './history.js'
import { TournamentStore } from './tournament/store.js'
import { TournamentScheduler, initialPromptText } from './tournament/scheduler.js'
import { computeOutcome } from './match/score.js'
import type { SeatScoreInput } from './match/score.js'
import { KillLedger, arenaSettleDecision, ticksExhaustedDecision } from './match/arena-observe.js'
import type { ArenaSettleDecision, KillDetail } from './match/arena-observe.js'
import { MatchRecorder } from './match/recorder.js'
import type { ReplayObject } from './match/recorder.js'
import { ReplayStore } from './replay/store.js'
import type { EventTick } from './match/attribution.js'
import { AgentRunner } from '../agent/runner.js'
import type { AgentProviderConfig } from '../agent/runner.js'
import { buildSeatTools } from '../agent/tools.js'

const args = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    'data-dir': { type: 'string' },
    'static-dir': { type: 'string' },
    'agent-dir': { type: 'string' },
    model: { type: 'string' }, // 默认值交由 ARENA_MODEL 环境变量供给（compose 形态）；都有值时 CLI 优先
    // M3/D6 房间池（缺省 E5N5,E7N5）；池大小 = 并发席位上限
    rooms: { type: 'string' },
    // 镜像构建期私服安装口（Dockerfile RUN 段）：走 ensureRunning 链装完即停，不挂 HTTP
    'install-only': { type: 'boolean', default: false },
  },
}).values

const PORT = Number(args.port)
const HOST = args.host
const KEY = process.env.OPENROUTER_API_KEY
const MODEL = args.model ?? process.env.ARENA_MODEL ?? 'qwen/qwen3.7-flash'
const MODEL_BASE = process.env.SMOKE_BASE_URL ?? 'https://openrouter.ai/api/v1'
const dataDir = args['data-dir'] ?? path.join(process.cwd(), '.arena-data')
const agentDir = args['agent-dir'] ?? path.join(dataDir, 'agents')
// M3/D6：房间池可配置（CLI --rooms > 环境变量 ARENA_ROOMS > 默认 E5N5,E7N5）
const ROOM_POOL = (args.rooms ?? process.env.ARENA_ROOMS ?? 'E5N5,E7N5')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')
if (ROOM_POOL.length === 0) {
  console.error('[main] room pool empty (use --rooms "E5N5,E7N5,…")')
  process.exit(1)
}
// M5/D3 守卫：房间池不得含 arena 镜像房（固定 W15N15 + 东邻镜像）——否则 world 局
// prepareRooms 与 arena 局共用战场必撞车。
const ARENA_ROOMS = new Set([ARENA_BASE_ROOM, arenaMirrorRoom(ARENA_BASE_ROOM)])
for (const room of ROOM_POOL) {
  if (ARENA_ROOMS.has(room)) {
    console.error(`[main] room pool must not contain arena mirror rooms (${ARENA_BASE_ROOM},${arenaMirrorRoom(ARENA_BASE_ROOM)}): got ${room}`)
    process.exit(1)
  }
}
const journal = new MatchJournal(path.join(dataDir, 'journal', 'matches'))
const history = new MatchHistory(path.join(dataDir, 'history'))
/** teardown 失败可查面（D3）：settle 后 machine 已删、m.state.errors 不可达，独立列表 + GET。 */
const teardownFailuresList: Array<{ matchId: string; seatId: string; error: string; at: number }> = []

const defaultModPath = path.join(process.cwd(), 'src', 'server', 'screeps', 'arena-mod.cjs')
const modPath = process.env.ARENA_MOD_PATH ?? defaultModPath
if (!existsSync(modPath)) {
  console.error(`[main] arena-mod not found: ${modPath} (set ARENA_MOD_PATH)`)
  process.exit(1)
}

const svc = new ScreepsService(
  {
    dataDir,
    tickDuration: 200,
    mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))],
    // M5/[N3] form 感知 tick：存在活跃 arena 局（含 journal 恢复局）→ 150ms；
    // ensure 链每次（重）启动按此重申——arena 局中私服重启不再静默回 200。
    resolveTickDuration: () =>
      [...machines.values()].some((m) => m.config.form === 'arena' && m.phase !== 'settled') ? 150 : 200,
  },
  (msg, ...rest) => console.log('[svc]', msg.replace(/%s/g, () => String(rest.shift() ?? ''))),
)
const driver = new MatchDriver({
  intervalMs: 500,
  log: (m) => console.log('[driver]', m),
  // M2/S1：roundBreak 相位机器在 advance 前取分（roundsExhausted 真实结算的唯一新鲜取分点）
  scoreSnapshot: (m) => scoreSnapshotFor(m.players.map((p) => p.seatId)),
  // M5/D5（B2 新增件）：arena 局 running 期结算观察（歼灭/双淘汰/maxTicks）
  arenaObserve: (m) => observeArenaMatch(m),
  // M6/S2：world 局 running 期回放采样（相位门控在 driver 侧；函数内自带采样节流）
  worldObserve: (m) => observeWorldMatch(m),
})
const arena = new RealArena(svc, { rooms: {}, log: (m) => console.log('[arena]', m) })

const runners = new Map<string, AgentRunner>()
const provider: AgentProviderConfig | undefined = KEY
  ? {
      name: 'openrouter',
      model: MODEL,
      baseUrl: MODEL_BASE,
      apiKey: KEY,
      contextWindow: 128_000,
      maxTokens: 4_096,
    }
  : undefined

/** 广播通道占位（服务器起来后回填；createMatch 在 listen 之后才会被调用）。 */
let broadcast: (e: { type: string; [k: string]: unknown }) => void = () => {}

/** seatIds → 计分快照（seatId 经 host 侧映射到 username，再查 world.users）。 */
async function scoreSnapshotFor(seatIds: string[]): Promise<Record<string, SeatScoreInput>> {
  const world = await svc.getWorld()
  const snap: Record<string, SeatScoreInput> = {}
  for (const seatId of seatIds) {
    const username = arena.resolveUser(seatId)
    const u = world.users.find((x) => x.username === username)
    snap[seatId] = {
      spawns: u?.spawns ?? 0,
      creeps: u?.creeps ?? 0,
      rooms: u?.ownedRooms ?? 0,
      rclTotal: u?.rclTotal ?? 0,
    }
  }
  return snap
}

/* ---------------- M6/S2 回放记录（recorder，plan-M6 D1/D2） ---------------- */

/** 位置采样节拍（墙钟 ms，D2）：500ms 驱动节拍下实际每 2 拍一帧。 */
const REPLAY_SAMPLE_MS = 1000
const replayDir = path.join(dataDir, 'replays')
/** 回放查询面（S3）：stat+mtime 失效缓存，LRU 4。 */
const replayStore = new ReplayStore(replayDir)
/** matchId → 记录器（settle 后删；不照抄 M5 三容器的无清理泄漏）。 */
const replayRecorders = new Map<string, MatchRecorder>()
/** matchId → 上次位置采样墙钟（节流）。 */
const replayLastSample = new Map<string, number>()
/** matchId → 最近一拍的 seatId→userId（settle 时 end 行账本/映射反查）。 */
const replayUserIds = new Map<string, Record<string, string | null>>()

/** 本局房间集合（arena = 固定镜像双房；world = 房间池分配）。 */
function replayRoomsFor(m: MatchMachine): string[] {
  if (m.config.form === 'arena') return [ARENA_BASE_ROOM, arenaMirrorRoom(ARENA_BASE_ROOM)]
  const snap = arena.roomsSnapshot()
  return m.players.map((p) => snap[p.seatId]).filter((r): r is string => typeof r === 'string')
}

function replayRecorderFor(m: MatchMachine, recovered = false): MatchRecorder {
  let rec = replayRecorders.get(m.id)
  if (!rec) {
    rec = new MatchRecorder({
      dir: replayDir,
      matchId: m.id,
      form: m.config.form,
      config: m.config,
      players: m.players.map((p) => ({ seatId: p.seatId, username: p.username })),
      rooms: replayRoomsFor(m),
      createdAt: m.state.createdAt,
      ...(recovered ? { recovered: true } : {}),
    })
    replayRecorders.set(m.id, rec)
  }
  return rec
}

/** seatId → Screeps userId（world.users 反查；未绑定 null）。 */
function replayUserIdsFor(m: MatchMachine, world: { users: Array<{ id: string; username: string }> }): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const p of m.players) {
    const username = arena.resolveUser(p.seatId)
    out[p.seatId] = world.users.find((u) => u.username === username)?.id ?? null
  }
  return out
}

/** 位置采样（仅到点调用）：roomObjects 全房投影 → ReplayObject[]。 */
async function samplePositions(m: MatchMachine): Promise<Record<string, ReplayObject[]>> {
  const out: Record<string, ReplayObject[]> = {}
  for (const room of replayRoomsFor(m)) {
    const raw = (await svc.system('roomObjects', room)) as { objects: Array<Record<string, unknown>> }
    out[room] = raw.objects.map((o) => ({
      type: String(o.type),
      x: Number(o.x),
      y: Number(o.y),
      user: typeof o.user === 'string' ? o.user : null,
      name: typeof o.name === 'string' ? o.name : null,
      hits: typeof o.hits === 'number' ? o.hits : null,
    }))
  }
  return out
}

/** 到点则采样（返回 positions；未到点 undefined——world 侧同样靠此节流不取数）。 */
async function positionsIfDue(m: MatchMachine, now: number): Promise<Record<string, ReplayObject[]> | undefined> {
  if (now - (replayLastSample.get(m.id) ?? 0) < REPLAY_SAMPLE_MS) return undefined
  replayLastSample.set(m.id, now)
  return samplePositions(m)
}

/** recorder 生命周期收尾（settle 挂点）：删本计划新增的三容器（D1 v4）。 */
function disposeRecorder(m: MatchMachine): void {
  replayRecorders.delete(m.id)
  replayLastSample.delete(m.id)
  replayUserIds.delete(m.id)
}

/* ---------------- M5/D5 arena 结算观察（B2 新增件） ---------------- */

/** matchId → 击杀账本（观察游标 host 侧独立，n2——不与 report 的 per-user 游标共享 ring）。 */
const arenaLedgers = new Map<string, KillLedger>()
/** matchId → started 时 gameTime 快照（maxTicks 基线，D5：不假设 gameTime 归零）。 */
const arenaStartGameTime = new Map<string, number>()
/** [N4] 溢出警告去重（每局最多记一次）。 */
const arenaOverflowWarned = new Set<string>()
/** matchId → 最后成功收到的事件 tick（R4 缺口定位；settle 清理）。 */
const arenaLastEventTick = new Map<string, number>()

/** arena 局结算观察（driver 每 500ms 调用）：事件增量消费 → 归因 → world 快照 →
 *  歼灭/双淘汰（lastStanding）或 maxTicks（ticksExhausted）决策；无决策返回 undefined。
 *  M6/S2：同一消费点顺路喂 recorder（复用 ledger 明细 + 同拍 world，零额外 getWorld）。 */
async function observeArenaMatch(m: MatchMachine): Promise<ArenaSettleDecision | undefined> {
  const ledger = arenaLedgers.get(m.id) ?? new KillLedger()
  arenaLedgers.set(m.id, ledger)
  const raw = (await svc.system('eventLog', ledger.cursor)) as {
    ok?: boolean
    events?: EventTick[]
    cursor?: number
    bound?: boolean
    ringCapacity?: number
    error?: string
  }
  if (raw.ok !== true) throw new Error(`eventLog failed: ${String(raw.error ?? 'unknown')}`)
  if (raw.bound === false && !arenaOverflowWarned.has(m.id)) {
    arenaOverflowWarned.add(m.id)
    m.state.errors.push('event ring overflow detected (bound:false) — kill scores may be underestimated')
    console.log(`[arena] ${m.id}: event ring overflow — kill scores may be underestimated`)
    // R4：饱和即停投——mark 记下 ring 水位与最后收到的事件 tick（缺口可定位）
    replayRecorderFor(m).mark({
      at: Date.now(),
      type: 'eventRingSaturated',
      ringCapacity: raw.ringCapacity,
      lastEventTick: arenaLastEventTick.get(m.id),
    })
  }
  // 一审阻塞 1：游标 = eventLog 返回的 ring 下标（非 tick 数值——见 KillLedger.cursor 注释）
  ledger.cursor = typeof raw.cursor === 'number' ? raw.cursor : ledger.cursor
  const batch = raw.events ?? []
  const details = ledger.consume(batch)
  for (const t of batch) if ((t.tick ?? -1) > (arenaLastEventTick.get(m.id) ?? -1)) arenaLastEventTick.set(m.id, t.tick)
  const world = await svc.getWorld()
  const snap = await scoreSnapshotFor(m.players.map((p) => p.seatId))
  // seatId → Screeps user id（归因键）
  const killScore: Record<string, number> = {}
  const userIds = replayUserIdsFor(m, world)
  for (const p of m.players) {
    killScore[p.seatId] = ledger.score(userIds[p.seatId] ?? null)
  }
  // M6/S2：回放帧（同拍 world 复用；positions 按 REPLAY_SAMPLE_MS 节流）
  replayUserIds.set(m.id, userIds)
  const positions = await positionsIfDue(m, Date.now())
  replayRecorderFor(m).recordTick({
    gameTime: world.gameTime,
    round: m.state.roundIndex,
    enrichedEvents: batch,
    details,
    scores: snap,
    userIds,
    ...(positions ? { positions } : {}),
  })
  const seats = m.players.map((p) => p.seatId)
  const decision = arenaSettleDecision(snap, killScore)
  if (decision) return decision
  const start = arenaStartGameTime.get(m.id)
  if (start === undefined) return undefined // started 事件尚未带回 gameTime 基线
  return ticksExhaustedDecision([seats[0]!, seats[1]!], killScore, start, world.gameTime, m.config.maxTicks, snap)
}

/** world 局回放采样（driver 每 500ms 调用，phase==='running' 门控在 driver 侧）：
 *  注入函数内节流（未到采样点直接 return，不调 getWorld——R1）；一次 getWorld 同时供
 *  scores/userIds 用。world 侧无 host 事件游标消费点，帧不含 kills（R5 不做第二游标）。 */
async function observeWorldMatch(m: MatchMachine): Promise<void> {
  const now = Date.now()
  if (now - (replayLastSample.get(m.id) ?? 0) < REPLAY_SAMPLE_MS) return
  replayLastSample.set(m.id, now)
  const world = await svc.getWorld()
  const ids = replayUserIdsFor(m, world)
  const scores: Record<string, SeatScoreInput> = {}
  for (const p of m.players) {
    const u = world.users.find((x) => x.id === ids[p.seatId])
    scores[p.seatId] = { spawns: u?.spawns ?? 0, creeps: u?.creeps ?? 0, rooms: u?.ownedRooms ?? 0, rclTotal: u?.rclTotal ?? 0 }
  }
  replayUserIds.set(m.id, ids)
  replayRecorderFor(m).recordTick({
    gameTime: world.gameTime,
    round: m.state.roundIndex,
    enrichedEvents: [],
    details: [],
    scores,
    userIds: ids,
    positions: await samplePositions(m),
  })
}

function toRecord(m: MatchMachine): MatchJournalRecord {
  const seatUsers: Record<string, string> = {}
  for (const p of m.players) {
    const u = arena.resolveUser(p.seatId)
    if (u) seatUsers[p.seatId] = u
  }
  const rooms = Object.fromEntries(
    Object.entries(arena.roomsSnapshot()).filter(([seatId]) => m.players.some((p) => p.seatId === seatId)),
  )
  return {
    id: m.id,
    config: m.config,
    players: m.players.map((p) => ({ ...p, ...(p.code ? { code: { ...p.code } } : {}) })),
    seatUsers,
    rooms,
    state: {
      createdAt: m.state.createdAt,
      phase: m.state.phase,
      roundIndex: m.state.roundIndex,
      ...(m.state.roundBreakSince !== undefined ? { roundBreakSince: m.state.roundBreakSince } : {}),
      ...(m.state.roundStartedAt !== undefined ? { roundStartedAt: m.state.roundStartedAt } : {}),
      errors: [...m.state.errors],
    },
  }
}

/** history 记录快照（D7）：seatUsers + rooms 必须在 teardown 前取——journal.remove 后
 *  这是补拆解唯一可还原映射的载体。 */
function historyRecordFor(m: MatchMachine): MatchHistoryRecord {
  const seatUsers: Record<string, string> = {}
  for (const p of m.players) {
    const u = arena.resolveUser(p.seatId)
    if (u) seatUsers[p.seatId] = u
  }
  const rooms = Object.fromEntries(
    Object.entries(arena.roomsSnapshot()).filter(([seatId]) => m.players.some((p) => p.seatId === seatId)),
  )
  return {
    id: m.id,
    config: m.config,
    winner: m.state.winner ?? null,
    settleReason: m.state.settleReason ?? null,
    scores: m.state.scores ?? null,
    roundIndex: m.state.roundIndex,
    createdAt: m.state.createdAt,
    settledAt: m.state.settledAt ?? null,
    seatUsers,
    rooms,
    teardown: 'pending',
  }
}

/** 定点 teardown（D3）：dispose runners → 逐席位 releaseSeat（removeUser + removeRoom +
 *  host 侧映射清理，幂等）→ history 标记 done。逐席位 try/catch：单席失败入可查面，
 *  其余席位继续；history 留 pending，重启补拆解兜底。
 *  成果审查阻塞 3：releaseSeat 必须传 settle 快照（historyRecordFor）——异步窗口内席位
 *  可能被新对局复用，按当前映射删会误删新对局用户/房间。 */
async function teardownMatch(m: MatchMachine, snap: MatchHistoryRecord): Promise<void> {
  for (const p of m.players) {
    const runner = runners.get(p.seatId)
    if (runner) {
      runner.dispose()
      runners.delete(p.seatId)
    }
  }
  for (const p of m.players) {
    try {
      await arena.releaseSeat(p.seatId, { username: snap.seatUsers[p.seatId], room: snap.rooms[p.seatId] })
    } catch (err) {
      teardownFailuresList.push({ matchId: m.id, seatId: p.seatId, error: String(err instanceof Error ? err.message : err), at: Date.now() })
      console.log(`[teardown] seat ${p.seatId} of ${m.id} failed:`, String(err))
    }
  }
  history.markDone(m.id)
}

/** 相位迁移事件 → 唤醒 + 广播 + journal（唯一写点，同步落盘）。settled 即清 journal。
 *  闭包引用 m 本身：构造函数不 emit，首事件必然发生在构造完成后（dev-services 同款模式）。 */
function wireMachine(m: MatchMachine): (e: MatchEvent) => void {
  return (e) => {
    void driver.onEvent(m, e)
    broadcast({ type: 'match_state', match: m.id, phase: m.phase, roundIndex: m.state.roundIndex, event: e.type })
    // M6/S2：回放 mark 行（两 form 共用；recorder 惰性建——'started' 时落 meta）
    if (e.type === 'started') replayRecorderFor(m).mark({ at: Date.now(), type: 'started', round: e.round })
    else if (e.type === 'round_break') replayRecorderFor(m).mark({ at: Date.now(), type: 'roundBreak', round: e.round })
    else if (e.type === 'round_resume') replayRecorderFor(m).mark({ at: Date.now(), type: 'resume', round: e.round })
    // M5/D5：arena 局 started 时记录 gameTime 基线（maxTicks 起算点，不假设归零），
    // 并解除 prepareArena 的 paused（双席建号已在 paused 世界完成——防 Invader 抢注）
    if (e.type === 'started' && m.config.form === 'arena' && !arenaStartGameTime.has(m.id)) {
      void svc.system('resume').catch((err) => console.log(`[arena] ${m.id} resume failed:`, String(err)))
      void svc
        .getWorld()
        .then((w) => arenaStartGameTime.set(m.id, w.gameTime))
        .catch((err) => console.log(`[arena] ${m.id} gameTime baseline failed:`, String(err)))
    }
    try {
      if (e.type === 'settled') {
        // D3 顺序：history(pending) 先落（含映射快照）→ journal.remove → machines 释放
        // → 异步 teardown（不阻断 settle 落账）→ history(done)。
        // upsert 与 remove 为同一同步块相邻的两次同步 fs 写——「pending 落了、journal
        // 未删」的窗口仅微秒级（kill -9 恰落在两写之间的概率极小）；该窗口下恢复局房间
        // 会经 markRoomsPrepared 灌回且不释放，接受为已知边界（M3 复审非阻塞 2）。
        const snap = historyRecordFor(m)
        history.upsert(snap)
        journal.remove(m.id)
        machines.delete(m.id) // 不占坑：settle 后允许再建局
        // M6/S2：end 行（账本按 seat 归属）+ 记录器容器清理（D1 v4：不扩 M5 泄漏）
        const rec = replayRecorders.get(m.id)
        if (rec) {
          const led = arenaLedgers.get(m.id)
          const ids = replayUserIds.get(m.id) ?? {}
          const ledgerCounts: Record<string, { kills: number; losses: number; decayLosses: number }> = {}
          for (const p of m.players) {
            ledgerCounts[p.seatId] = led ? led.counts(ids[p.seatId] ?? null) : { kills: 0, losses: 0, decayLosses: 0 }
          }
          rec.mark({ at: Date.now(), type: 'settled', reason: m.state.settleReason, winner: m.state.winner, scores: m.state.scores })
          rec.end({
            settledAt: m.state.settledAt ?? Date.now(),
            settleReason: m.state.settleReason ?? 'manual',
            winner: m.state.winner ?? { kind: 'draw' },
            scores: m.state.scores ?? {},
            ledger: ledgerCounts,
            userIds: ids,
          })
        }
        disposeRecorder(m)
        arenaLastEventTick.delete(m.id)
        void teardownMatch(m, snap).catch((err) => {
          // 成果审查非阻塞 6：markDone 的同步 fs 抛错不能成为 unhandled rejection
          teardownFailuresList.push({ matchId: m.id, seatId: '*', error: `teardown finalize: ${String(err)}`, at: Date.now() })
          console.log(`[teardown] finalize of ${m.id} failed:`, String(err))
        })
        // M4/D3-②：锦标赛结果同步回填（applyResult 同步落账）+ 异步 pump 排下一场。
        // 挂点在 void teardownMatch 派发语句之后（plan-M4 v2 N1：不依赖 dispose 隐式顺序）。
        scheduler.onSettled(m)
      } else {
        journal.save(toRecord(m))
      }
    } catch (err) {
      console.log('[journal] save failed:', String(err))
    }
  }
}

async function wakerFor(seatId: string): Promise<SeatWaker> {
  let runner = runners.get(seatId)
  if (!runner) {
    // 已恢复映射的席位（journal 恢复灌回）跳过建号；新席位惰性建号（含 prepareRooms 公平性）
    if (!arena.resolveUser(seatId)) await arena.bindUser(seatId)
    if (!provider) throw new Error('no provider configured (OPENROUTER_API_KEY missing)')
    runner = await AgentRunner.create({
      seatId,
      tools: buildSeatTools({ registry: arena, backend: seatBackendFor(seatId) }, seatId),
      provider,
      baseDir: agentDir,
      onEvent: (e) => {
        if (e.type === 'tool_end') console.log(`[${seatId}] tool_end ${e.toolName ?? ''} ${e.isError ? 'ERR' : 'OK'}`)
      },
    })
    runners.set(seatId, runner)
  }
  const r = runner
  return { prompt: (_sid, text) => r.prompt(text) }
}

const machines = new Map<string, MatchMachine>()

/** 建局唯一正道（M4/D5：HTTP 与锦标赛调度器共用同一函数，非自调 HTTP）。
 *  M5/D1：preset 展开（显式 config 字段覆盖）；botCode 仅供 server 内部 IT/调度链
 *  （HTTP 路由层剥除——LLM 永不经由 HTTP 注代码，公平边界）。 */
function createMatchInternal(input: {
  config?: Partial<MatchConfig>
  preset?: MatchPreset
  players: Array<{ seatId: string; username: string }>
  botCode?: Record<string, string>
}): MatchMachine {
  // 成果审查阻塞 3：跨对局 seatId 守卫（pool.ts 纯函数）——活跃对局占用的 seatId 拒绝
  // 复用（allocateRooms 只看房间占池，看不出版位易主）。
  assertSeatsFree(
    [...machines.values()].flatMap((x) => x.players.map((p) => p.seatId)),
    input.players.map((p) => p.seatId),
  )
  // M5/D1：preset 展开（显式字段覆盖）；arena 单飞守卫（R1/[N7]：machines 含 journal
  // 恢复局——同世界同时只一场 blitz）。
  const config: MatchConfig = input.preset
    ? configFromPreset(input.preset, input.config)
    : input.config?.form === 'arena'
      ? { ...DEFAULT_MATCH_CONFIG, ...PRESETS['arena-blitz'], ...input.config } // 锦标赛 matchConfig 直传通道：arena 预设基底（否则 maxTicks 丢失——验收局实测）
      : { ...DEFAULT_MATCH_CONFIG, ...input.config }
  if (config.form === 'arena') {
    if (input.players.length !== 2) {
      throw new Error(`arena matches require exactly 2 players (base + mirrored room), got ${input.players.length}`)
    }
    if ([...machines.values()].some((x) => x.config.form === 'arena' && x.phase !== 'settled')) {
      throw new Error('an arena match is already active in this world (single-flight; settle it first)')
    }
  }
  // M3/D4：守卫从「无活跃对局」改为「池可容纳」（allocation 纯函数在 pool.ts，
  // roomsSnapshot 是唯一在占事实源——含 journal 恢复局房间）。
  const m = new MatchMachine({
    players: input.players,
    ...(input.preset || input.config ? { config } : {}),
    onEvent: (e) => wireMachine(m)(e),
  })
  if (m.config.form === 'arena') {
    // D3：固定镜像房（不占房间池、不触公平重掷——镜像即公平）；战场后台预热
    //（arenaGen 单飞 + B3 generatedRooms 登记），bindUser 经 ensureRoomReady 等待。
    arena.assignRoom(m.players[0]!.seatId, ARENA_BASE_ROOM)
    arena.assignRoom(m.players[1]!.seatId, arenaMirrorRoom(ARENA_BASE_ROOM))
    void arena
      .prepareArena()
      .then(() => {
        // 对称 spawn 坐标由 prepareArena 按真实地形选定并存实例（bindUser 按房间自取）
        // botCode 注入（[N6]：IT/内部链建号即注码；无 botCode = Agent 空壳起步热更）
        if (input.botCode) {
          for (const p of m.players) {
            arena
              .bindUser(p.seatId, input.botCode)
              .catch((err) => console.log(`[arena] botCode bind ${p.seatId} failed:`, String(err)))
          }
        }
      })
      .catch((err) => console.log('[arena] prepareArena failed:', String(err)))
  } else {
    for (const [seatId, room] of Object.entries(allocateRooms(ROOM_POOL, arena.roomsSnapshot(), input.players.map((p) => p.seatId)))) {
      arena.assignRoom(seatId, room)
    }
    // 房间生成 + 公平性校验重掷后台预热（建号/首唤醒前完成；幂等 + 并发安全）
    void arena.prepareRooms().catch((err) => console.log('[arena] prepareRooms failed:', String(err)))
  }
  machines.set(m.id, m)
  // 驱动链接线（M1 复审问题 3 教训；成果审查阻塞 1）：createMatch 必须 watch，
  // 否则 tick 恒 no-op、Agent 永不唤醒——与 dev-services 同一铁律
  const wakers: Record<string, SeatWaker> = {}
  if (provider) for (const p of input.players) wakers[p.seatId] = lazyWaker(p.seatId)
  driver.watch(m, wakers)
  return m
}

/* ---------------- M4 锦标赛编排（plan-M4/S3，D3/D5） ---------------- */

const tournamentStore = new TournamentStore(path.join(dataDir, 'tournaments'))

const scheduler = new TournamentScheduler({
  store: tournamentStore,
  createMatch: (players, config) => createMatchInternal({ players, ...(config ? { config } : {}) }),
  getMachine: (id) => machines.get(id),
  journalEntries: () => journal.list().map((r) => ({ id: r.id, players: r.players.map((p) => p.seatId) })),
  historyGet: (id) => {
    const rec = history.list().find((h) => h.id === id)
    return rec ? { winner: rec.winner, scores: rec.scores, settledAt: rec.settledAt } : undefined
  },
  historyFindByPair: (pair) => {
    const want = [...pair].sort()
    const rec = history
      .list()
      .find((h) => {
        const seats = Object.keys(h.seatUsers).sort()
        return seats.length === 2 && seats[0] === want[0] && seats[1] === want[1]
      })
    return rec ? { id: rec.id, winner: rec.winner, scores: rec.scores, settledAt: rec.settledAt } : undefined
  },
  initialPrompt: (seatId, matchId) =>
    // 返回在途 Promise：scheduler 据此去重补发（在途不重发、不耗配额）
    (async () => {
      const w = await wakerFor(seatId)
      await w.prompt(seatId, initialPromptText(matchId))
    })().catch((err) => console.log(`[tournament] initial prompt ${seatId}/${matchId} failed:`, String(err))),
  log: (msg) => console.log(`[tournament] ${msg}`),
})

/** 席位后端：arena 之上补一跳 machine 登记（submit_code 的三工具落点，machine.ts 语义）。
 *  compose 全链实测发现：此前 submit 只上传私服，p.code 恒空 → starter 全员就绪门槛
 *  永不可达、锦标赛对局永不开局。席位同时只属一个活跃对局（createMatchInternal 守卫）。 */
function seatBackendFor(seatId: string) {
  return {
    submitCode: async (user: string, modules: Record<string, string>) => {
      const result = await arena.submitCode(user, modules)
      if (result.ok) {
        // [N8]：creating/roundBreak 照旧；arena 的 running 期 = 热更（form 分支）同样登记
        const m = [...machines.values()].find(
          (x) =>
            x.players.some((p) => p.seatId === seatId) &&
            (x.phase === 'creating' || x.phase === 'roundBreak' || (x.phase === 'running' && x.config.form === 'arena')),
        )
        if (m) {
          try {
            m.submitCode(seatId, modules)
          } catch (err) {
            console.log(`[${seatId}] machine code register failed:`, String(err))
          }
        }
      }
      return result
    },
    runConsole: (user: string, expression: string) => arena.runConsole(user, expression),
    report: (user: string) => arena.report(user),
  }
}

const wakerCreating = new Map<string, Promise<SeatWaker>>()

/** 惰性 waker（首唤醒时建号 + 建 AgentRunner）；无 provider 时不产生 waker（只推进时钟）。
 *  单飞：初始 prompt 的 starter 补发（5s 周期）与首发会并发进入——不收口则建号重复
 *  执行（mod 侧 createUser 报 already exists，整轮唤醒失败）。 */
function lazyWaker(seatId: string): SeatWaker {
  return {
    prompt: (_sid, text) => {
      let p = wakerCreating.get(seatId)
      if (!p) {
        p = wakerFor(seatId)
        wakerCreating.set(seatId, p)
        void p.catch(() => {
          if (wakerCreating.get(seatId) === p) wakerCreating.delete(seatId) // 失败可重试
        })
      }
      return p.then((w) => w.prompt(seatId, text))
    },
  }
}

const services: ArenaHttpServices = {
  matches: () => [...machines.values()],
  match: (id) => machines.get(id),
  createMatch: (input) => {
    // M5/D6：无 provider 的 arena 局拒建——建号完成前世界保持 paused，无 Agent 提交
    // 则永不开局、永远 paused（观战形态时钟驱动局也过不了代码门槛）
    const form = input.preset === 'arena-blitz' || input.config?.form === 'arena' ? 'arena' : 'world'
    if (form === 'arena' && !provider) throw new Error('arena matches require a provider (OPENROUTER_API_KEY missing)')
    const m = createMatchInternal(input)
    // M6 前实测补洞（审查阻塞 2 修订）：初始唤醒只发 HTTP 直建局——锦标赛对局的首发/
    // 补发/配额核算归 scheduler.sendInitialPrompts 独占（此前 createMatchInternal 里发
    // 会让锦标赛席位双发且绕过 wakerCreating 单飞）。经 lazyWaker 走单飞，fire-and-forget。
    if (provider) {
      for (const p of m.players) {
        void lazyWaker(p.seatId)
          .prompt(p.seatId, initialPromptText(m.id))
          .catch((err) => console.log(`[match] initial prompt ${p.seatId}/${m.id} failed:`, String(err)))
      }
    }
    return m
  },
  createTournament: (input) => {
    // D6：无 provider（观战形态）拒建——无唤醒的锦标赛永不完成且无提示
    if (!provider) throw new Error('tournament requires a provider (OPENROUTER_API_KEY missing)')
    return scheduler.create(input)
  },
  tournaments: () => tournamentStore.list(),
  tournament: (id) => tournamentStore.get(id),
  getWorld: () => svc.getWorld(),
  getTerrain: (rooms) => svc.getTerrain(rooms),
  // 观战 console 口（成果审查阻塞 2）：入参统一为 seatId，host 侧解析真实用户名——
  // 前端显示名（HTTP 建局输入）≠ agent_<slug>；未映射席位原样透传（→ bound:false 静默）
  consoleSince: (user, since) => arena.consoleSince(arena.resolveUser(user) ?? user, since),
  // 旁观投影：seatId → agent_<slug>（浏览器实测补洞——前端席位表按 username 匹配恒空）
  seatUsername: (seatId) => arena.resolveUser(seatId),
  getScoreSnapshot: scoreSnapshotFor,
  history: () => history.list(),
  teardownFailures: () => [...teardownFailuresList],
  // M6/S3：回放只读查询面（文件 IO/解析/缓存独立模块，routes 保持纯打表）
  replay: (id, opts) => replayStore.get(id, opts),
  replayExists: (id) => replayStore.has(id),
}

/** journal 恢复扫描（M2/S5）：映射灌回 → 机器重建 → driver.watch；roundBreakSince 重置为恢复时刻。 */
function restoreFromJournal(): number {
  let restored = 0
  for (const rec of journal.list()) {
    if (rec.state.phase === 'settled') {
      journal.remove(rec.id)
      continue
    }
    const wakers: Record<string, SeatWaker> = {}
    for (const [seatId, room] of Object.entries(rec.rooms)) {
      try {
        arena.assignRoom(seatId, room)
      } catch {
        /* 重复分配（理论上不会：重启后 rooms 空） */
      }
    }
    for (const [seatId, username] of Object.entries(rec.seatUsers)) {
      arena.restoreUser(seatId, username)
    }
    for (const p of rec.players) {
      if (provider) wakers[p.seatId] = lazyWaker(p.seatId)
    }
    const m = MatchMachine.restore({
      id: rec.id,
      config: rec.config,
      players: rec.players,
      state: rec.state,
      roundBreakSinceResetTo: rec.state.phase === 'roundBreak' ? Date.now() : undefined,
      onEvent: (e) => wireMachine(m)(e),
    })
    // 中断痕迹入 errors[]（plan-M2 S5；前端 errors 区可见）
    m.state.errors.push(`interrupted recovery: restored at phase ${rec.state.phase} round ${rec.state.roundIndex}`)
    machines.set(m.id, m)
    driver.watch(m, wakers)
    // M6/S2：恢复局续写既有回放文件 + 补 'recovered' mark（D3；文件不存在则补 meta）
    replayRecorderFor(m, true)
    console.log(`[journal] restored match ${m.id} at phase ${m.phase} round ${m.state.roundIndex} (interrupted recovery)`)
    // 审查非阻塞 1：恢复的 arena 局不会再触发 started → 在此补 maxTicks 基线
    //（restoreFromJournal 在 listen 前同步执行，不会与 observe 竞争）
    if (m.config.form === 'arena' && !arenaStartGameTime.has(m.id)) {
      void svc
        .getWorld()
        .then((w) => arenaStartGameTime.set(m.id, w.gameTime))
        .catch((err) => console.log(`[arena] ${m.id} recovery gameTime baseline failed:`, String(err)))
    }
    restored++
  }
  if (restored > 0) arena.markRoomsPrepared() // 恢复局房间已发展，跳过公平性重掷
  return restored
}

// 前端产物探测：dist/client 存在则挂（build:client 后）；--static-dir 显式覆盖
const detectedStatic = args['static-dir']
  ? { staticDir: args['static-dir'] }
  : existsSync(path.join(process.cwd(), 'dist', 'client'))
    ? { staticDir: path.join(process.cwd(), 'dist', 'client') }
    : {}

if (args['install-only']) {
  await svc.ensureRunning()
  await svc.shutdown()
  console.log('[main] install-only: screeps server provisioned at', path.join(dataDir, 'server'))
  process.exit(0)
}

const handle = await startHttpServer({
  services,
  port: PORT,
  host: HOST,
  ...detectedStatic,
})
broadcast = (e) => handle.broadcast(e)

const restored = restoreFromJournal()
// M4/D3-③：锦标赛启动恢复（三态判定 + scheduled pair 采纳）+ starter/pump 定时器
const tournamentsRecovered = scheduler.recoverOnStartup()
scheduler.startTimers()
// M6 前实测补洞②：HTTP 直建对局自动开局（开局驱动只有锦标赛 starter——直建局全员
// 交码后永停 creating；上洞 1047583 补了初始唤醒，本洞补开局）。锦标赛对局由
// scheduler 专属驱动，按 id 排除避免双 start。世界局与 arena 局同一门槛（全员有码）。
const directStarter = setInterval(() => {
  const tournamentMatchIds = new Set(
    tournamentStore.list().flatMap((t) => t.matches.map((x) => x.matchId ?? '')),
  )
  for (const m of machines.values()) {
    if (m.phase !== 'creating' || tournamentMatchIds.has(m.id)) continue
    if (m.players.some((p) => !p.code)) continue
    try {
      m.start()
      console.log(`[match] auto-started direct match ${m.id}`)
    } catch (err) {
      console.log(`[match] auto-start ${m.id} failed:`, String(err))
    }
  }
}, 5000)
driver.start()
// 启动即拉起私服（观战形态世界常跑；不阻塞 HTTP 起服，但失败 = 主功能不可用，fail fast）。
// 私服就绪后先补拆解 history 中 teardown:pending 的残留（D3：崩溃于 pending 窗口 →
// 幂等重放 removeUser/removeRoom），再进入正常就绪态。
void svc
  .ensureRunning()
  .then(async ({ baseUrl }) => {
    const recovered = await recoverPendingTeardowns({
      system: (cmd, value) => svc.system(cmd, value),
      pending: history.pending(),
      markDone: (id) => history.markDone(id),
      onFail: (matchId, seatId, error) => {
        teardownFailuresList.push({ matchId, seatId, error, at: Date.now() })
        console.log(`[teardown] recover ${matchId}/${seatId} failed:`, error)
      },
    })
    if (recovered > 0) console.log(`[main] teardown-recovered=${recovered} (history pending replayed)`)
    console.log(`[main] screeps server ready at ${baseUrl}`)
  })
  .catch((err) => {
    console.error('[main] screeps server failed:', String(err))
    process.exit(1)
  })
console.log(
  `[main] http://${HOST}:${handle.port} data=${dataDir} (real world; wake=${provider ? `real ${MODEL}` : 'disabled'}; journal-restored=${restored}; tournaments-recovered=${tournamentsRecovered})`,
)

// 收到信号：先停驱动/调度（不再产生新工作）→ 优雅关停私服（pause → autosave 窗口 →
// SIGTERM 进程组 → SIGKILL，见 server-launcher.stop）→ 关 HTTP → 退出。
// M6 后补（踩坑修复）：私服是 detached 进程组，回收只靠两条路——svc.shutdown()，或
// service 装的 process 'exit' guard（同步 SIGKILL 进程组）。而 **SIGTERM 的默认处置是
// OS 直接终止进程，不触发 JS 'exit' 事件** → 原先只挂 SIGINT 时，任何 SIGTERM 退出
// （m2-smoke 的 pkill、docker stop、systemd）都会把私服 runner/storage/engine 留成孤儿
// 继续占内存与端口（实测一次 smoke 漏 4–8 个）。故 SIGINT/SIGTERM 共用同一优雅路径；
// shuttingDown 防重入（连发两个信号不双跑）。
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  driver.stop()
  scheduler.stopTimers()
  clearInterval(directStarter)
  for (const r of runners.values()) r.dispose()
  try {
    // 上界兜底：stop 自身有界（autosave 10.5s + 宽限 5s + 硬等 3s），此处不无限等
    await Promise.race([svc.shutdown(), new Promise((resolve) => setTimeout(resolve, 20_000))])
  } catch (err) {
    console.error('[main] shutdown: screeps server stop failed:', String(err))
  }
  await handle.close().catch(() => {})
  process.exit(0) // 'exit' → service 的 exit guard 兜底 SIGKILL 进程组
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
