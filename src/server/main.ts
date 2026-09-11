/**
 * M2/S0 统一真实组装入口：ScreepsService（managed 私服）+ RealArena + MatchDriver +
 * HTTP/WS 桥 + 前端静态托管 + 对局 journal（interrupted 恢复）。
 * dev / compose / IT **共用同一份组装**（M1 复审问题 3 教训：mock 自证而真实路径漏接）。
 *
 * CLI：node dist/server/main.mjs [--port N] [--host H] [--data-dir D] [--static-dir P]
 *      [--agent-dir P] [--model M]
 * 环境变量：OPENROUTER_API_KEY（在位时挂真实 LLM 唤醒，缺席 = 只推进时钟的观战形态）；
 *          SMOKE_BASE_URL（provider 覆盖）；ARENA_MOD_PATH（mod 路径覆盖）。
 *
 * 数据布局（--data-dir，默认 <cwd>/.arena-data）：
 *   server/            = 私服 serverDir（compose 挂卷 screeps-data）
 *   journal/matches/   = 对局 journal（相位迁移原子落盘，启动扫描恢复，M2/S5）
 *   agents/            = 席位工作区（seatSlug 目录，M2/S7）
 *
 * M2 范围约束：单世界单活跃对局（第二局创建拒绝）；房间池固定 E5N5/E7N5，
 * 公平性距离校验重掷在 prepareRooms（M2/S6）。多局世界/房间池扩张归 M3+。
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
import { RealArena } from './screeps/arena.js'
import { MatchMachine } from './match/machine.js'
import type { MatchEvent } from './match/machine.js'
import { MatchJournal } from './match/journal.js'
import type { MatchJournalRecord } from './match/journal.js'
import { computeOutcome } from './match/score.js'
import type { SeatScoreInput } from './match/score.js'
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
    model: { type: 'string', default: 'xiaomi/mimo-v2.5' },
    // 镜像构建期私服安装口（Dockerfile RUN 段）：走 ensureRunning 链装完即停，不挂 HTTP
    'install-only': { type: 'boolean', default: false },
  },
}).values

const PORT = Number(args.port)
const HOST = args.host
const KEY = process.env.OPENROUTER_API_KEY
const MODEL = args.model
const MODEL_BASE = process.env.SMOKE_BASE_URL ?? 'https://openrouter.ai/api/v1'
const dataDir = args['data-dir'] ?? path.join(process.cwd(), '.arena-data')
const agentDir = args['agent-dir'] ?? path.join(dataDir, 'agents')
const journal = new MatchJournal(path.join(dataDir, 'journal', 'matches'))

const defaultModPath = path.join(process.cwd(), 'src', 'server', 'screeps', 'arena-mod.cjs')
const modPath = process.env.ARENA_MOD_PATH ?? defaultModPath
if (!existsSync(modPath)) {
  console.error(`[main] arena-mod not found: ${modPath} (set ARENA_MOD_PATH)`)
  process.exit(1)
}

const svc = new ScreepsService(
  { dataDir, tickDuration: 200, mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))] },
  (msg, ...rest) => console.log('[svc]', msg.replace(/%s/g, () => String(rest.shift() ?? ''))),
)
const driver = new MatchDriver({
  intervalMs: 500,
  log: (m) => console.log('[driver]', m),
  // M2/S1：roundBreak 相位机器在 advance 前取分（roundsExhausted 真实结算的唯一新鲜取分点）
  scoreSnapshot: (m) => scoreSnapshotFor(m.players.map((p) => p.seatId)),
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

/** 相位迁移事件 → 唤醒 + 广播 + journal（唯一写点，同步落盘）。settled 即清 journal。
 *  闭包引用 m 本身：构造函数不 emit，首事件必然发生在构造完成后（dev-services 同款模式）。 */
function wireMachine(m: MatchMachine): (e: MatchEvent) => void {
  return (e) => {
    void driver.onEvent(m, e)
    broadcast({ type: 'match_state', match: m.id, phase: m.phase, roundIndex: m.state.roundIndex, event: e.type })
    try {
      if (e.type === 'settled') {
        journal.remove(m.id)
        machines.delete(m.id) // 不占坑：settle 后允许再建局（单活跃约束按 phase 判定）
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
      tools: buildSeatTools({ registry: arena, backend: arena }, seatId),
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

const ROOM_POOL = ['E5N5', 'E7N5']
const machines = new Map<string, MatchMachine>()
const usedSeats = new Set<string>()

/** 惰性 waker（首唤醒时建号 + 建 AgentRunner）；无 provider 时不产生 waker（只推进时钟）。 */
function lazyWaker(seatId: string): SeatWaker {
  return { prompt: async (sid, text) => (await wakerFor(sid)).prompt(sid, text) }
}

const services: ArenaHttpServices = {
  matches: () => [...machines.values()],
  match: (id) => machines.get(id),
  createMatch: (input) => {
    if (machines.size > 0) throw new Error('one active match per world (M2 scope); settle it first')
    for (const p of input.players) {
      if (usedSeats.has(p.seatId)) continue
      const room = ROOM_POOL[usedSeats.size]
      if (!room) throw new Error('room pool exhausted (M2: fixed 2-room pool)')
      arena.assignRoom(p.seatId, room)
      usedSeats.add(p.seatId)
    }
    const m = new MatchMachine({
      players: input.players,
      ...(input.config ? { config: input.config } : {}),
      onEvent: (e) => wireMachine(m)(e),
    })
    machines.set(m.id, m)
    // 驱动链接线（M1 复审问题 3 教训；成果审查阻塞 1）：createMatch 必须 watch，
    // 否则 tick 恒 no-op、Agent 永不唤醒——与 dev-services 同一铁律
    const wakers: Record<string, SeatWaker> = {}
    if (provider) for (const p of input.players) wakers[p.seatId] = lazyWaker(p.seatId)
    driver.watch(m, wakers)
    // 房间生成 + 公平性校验重掷后台预热（建号/首唤醒前完成；幂等 + 并发安全）
    void arena.prepareRooms().catch((err) => console.log('[arena] prepareRooms failed:', String(err)))
    return m
  },
  getWorld: () => svc.getWorld(),
  getTerrain: (rooms) => svc.getTerrain(rooms),
  // 观战 console 口（成果审查阻塞 2）：入参统一为 seatId，host 侧解析真实用户名——
  // 前端显示名（HTTP 建局输入）≠ agent_<slug>；未映射席位原样透传（→ bound:false 静默）
  consoleSince: (user, since) => arena.consoleSince(arena.resolveUser(user) ?? user, since),
  getScoreSnapshot: scoreSnapshotFor,
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
      if (provider) wakers[p.seatId] = { prompt: async (sid, text) => (await wakerFor(sid)).prompt(sid, text) }
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
    console.log(`[journal] restored match ${m.id} at phase ${m.phase} round ${m.state.roundIndex} (interrupted recovery)`)
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
driver.start()
// 启动即拉起私服（观战形态世界常跑；不阻塞 HTTP 起服，但失败 = 主功能不可用，fail fast）
void svc
  .ensureRunning()
  .then(({ baseUrl }) => console.log(`[main] screeps server ready at ${baseUrl}`))
  .catch((err) => {
    console.error('[main] screeps server failed:', String(err))
    process.exit(1)
  })
console.log(
  `[main] http://${HOST}:${handle.port} data=${dataDir} (real world; wake=${provider ? `real ${MODEL}` : 'disabled'}; journal-restored=${restored})`,
)

process.on('SIGINT', async () => {
  driver.stop()
  for (const r of runners.values()) r.dispose()
  await handle.close()
  process.exit(0)
})
