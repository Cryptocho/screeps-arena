/**
 * S1/S2 真实私服启动 IT（test:live lane，plan-M1 §4）——bare-metal 全链：
 * 播种→安装（npm install screeps + native 编译，首次 ≈8 分钟）→启动→setTickDuration
 * →generateRoom→createUser→submitCode→getWorld 断言用户/房间出现→consoleOutput 游标。
 * 装置纪律（m0-flake §四）：per-test mkdtemp 独立 serverDir；结束 shutdown 清进程。
 * 跑法：fnm exec --using=22 -- npm run test:live（默认 npm test 不含）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'
import { RealArena } from '../src/server/screeps/arena.js'
import { fairnessDeviation, roomDistanceScore } from '../src/server/screeps/fairness.js'
import { MatchMachine } from '../src/server/match/machine.js'
import { computeOutcome } from '../src/server/match/score.js'
import type { SeatScoreInput } from '../src/server/match/score.js'
import { allocateRooms } from '../src/server/pool.js'
import { TournamentStore } from '../src/server/tournament/store.js'
import { TournamentScheduler } from '../src/server/tournament/scheduler.js'
import { tournamentFinished } from '../src/server/tournament/types.js'
import { MatchHistory } from '../src/server/history.js'
import { recoverPendingTeardowns } from '../src/server/teardown.js'
import { fileURLToPath } from 'node:url'

const modPath = fileURLToPath(new URL('../src/server/screeps/arena-mod.cjs', import.meta.url))
const POOL = ['E5N5', 'E7N5']

const dataDir = mkdtempSync(join(tmpdir(), 'screeps-arena-live-'))
let svc: ScreepsService
const svcLog: string[] = []

beforeAll(() => {
  svc = new ScreepsService(
    {
      dataDir,
      tickDuration: 100,
      readyTimeoutMs: 180_000,
      mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))],
    },
    (msg, ...args) => {
      const line = msg.replace(/%s/g, () => String(args.shift() ?? ''))
      svcLog.push(line)
      console.log('[svc]', line)
    },
  )
})

afterAll(async () => {
  await svc.shutdown()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('ScreepsService 真实私服（live）', () => {
  it('启动→setTickDuration→generateRoom→createUser→submitCode→getWorld→consoleOutput', async () => {
    const { baseUrl } = await svc.ensureRunning()
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // system 面：tick 已在 ensure 链内设置；读回验证
    const tick = await svc.system('getTickDuration')
    expect(tick.tickDuration).toBe('100')

    // generateRoom（World 同参数生成；mod 链含墙桩/accessibleRooms）
    await svc.system('generateRoom', { room: 'E5N5', sources: 2 })

    // createUser（带初始代码；mod 写 users.code timestamp + placeSpawn）
    const user = await svc.createUser({
      username: 'live_agent',
      room: 'E5N5',
      code: { main: 'module.exports.loop = function () { console.log("alive", Game.time) }' },
      cpu: 100,
    })
    expect(user.username).toBe('live_agent')

    // submitCode（官方 /api/user/code 通道）
    const sub = await svc.submitCode('live_agent', {
      main: 'module.exports.loop = function () { console.log("tick", Game.time) }',
    })
    expect(sub.timestamp).toBeGreaterThan(0)

    // 世界快照：用户出现 + 拥有房间
    const world = await svc.getWorld()
    expect(world.ok).toBe(true)
    const u = world.users.find((x) => x.username === 'live_agent')
    expect(u).toBeDefined()
    expect(u!.ownedRooms).toBeGreaterThanOrEqual(1)
    expect(u!.spawns).toBeGreaterThanOrEqual(1)

    // 地形：E5N5 位域串 2500 字符
    const terrain = await svc.getTerrain(['E5N5'])
    expect(terrain.terrain.E5N5).toHaveLength(2500)

    // console 游标（ring buffer；bound 初始 true）
    const out = await svc.consoleOutput('live_agent')
    expect(out.bound).toBe(true)
    expect(Array.isArray(out.lines)).toBe(true)

    // 事件流（roomsDone 采集）
    const events = await svc.system('eventLog', 0)
    expect(events.ok).toBe(true)
  }, 600_000)

  it('M2：prepareRooms（同房重复 generateRoom 重掷语义）+ bindUser + settle 真实计分', async () => {
    const arena = new RealArena(svc, { rooms: { ma: 'E5N5', mb: 'E7N5' }, log: (m) => console.log('[arena]', m) })
    // E5N5 已由上一用例生成——同房名重复 generateRoom 的覆盖行为在此实测（plan-M2 S6：先 IT 钉住）
    await arena.prepareRooms()
    // 公平性断言（plan-M2 §3/S6）：两房 Σ(source→controller) 距离偏离中位数 ≤ 阈值 10
    const distances: number[] = []
    for (const room of ['E5N5', 'E7N5']) {
      const objects = await svc.getRoomObjects(room)
      const sources = objects.filter((o) => o.type === 'source').map((o) => ({ x: o.x, y: o.y }))
      const controller = objects.find((o) => o.type === 'controller')
      expect(controller, `controller in ${room}`).toBeDefined()
      expect(sources.length, `sources in ${room}`).toBeGreaterThan(0)
      distances.push(roomDistanceScore(sources, { x: controller!.x, y: controller!.y }))
    }
    expect(fairnessDeviation(distances)).toBeLessThanOrEqual(10)
    const ua = await arena.bindUser('ma')
    const ub = await arena.bindUser('mb')
    expect(arena.resolveUser('ma')).toBe(ua.username)
    expect(ub.username).not.toBe(ua.username)

    // restart 后快照可用 + 建号用户已入世界
    const world = await svc.getWorld()
    expect(world.ok).toBe(true)
    expect(world.users.some((u) => u.username === ua.username)).toBe(true)

    // seatId → username 映射快照（scoreSnapshotFor 同款语义）→ computeOutcome → settle
    const snap: Record<string, SeatScoreInput> = {}
    for (const seat of ['ma', 'mb'] as const) {
      const u = world.users.find((x) => x.username === arena.resolveUser(seat))
      snap[seat] = { spawns: u?.spawns ?? 0, creeps: u?.creeps ?? 0, rooms: u?.ownedRooms ?? 0, rclTotal: u?.rclTotal ?? 0 }
    }
    const m = new MatchMachine({
      players: [
        { seatId: 'ma', username: ua.username },
        { seatId: 'mb', username: ub.username },
      ],
      config: { maxRounds: 2 },
    })
    m.submitCode('ma', { main: 'module.exports.loop = function () {}' })
    m.submitCode('mb', { main: 'module.exports.loop = function () {}' })
    m.start()
    m.settle('manual', Date.now(), computeOutcome(snap))
    expect(m.state.settleReason).toBe('manual')
    // spawn 刚部署（双活）→ draw，但 scores 非全 0（真实计数接通，M0 全 0 语义退役）
    expect(m.state.winner).toEqual({ kind: 'draw' })
    expect(Object.values(m.state.scores!).some((v) => v > 0)).toBe(true)
  }, 600_000)

  // ---- M3 增补段（plan-M3 验收判据 2；成果审查阻塞 1）----

  it('M3：removeUser→removeRoom→重建闭环 + 被删房与活跃房相邻形态（活跃房不受损）', async () => {
    await svc.ensureRunning()
    // 相邻房对：E11N5 与 E11N6 相邻（8 邻）。活跃房 E11N6 生成 + 建号；被删房 E11N5 相邻
    await svc.system('generateRoom', { room: 'E11N6', sources: 2 })
    await svc.system('generateRoom', { room: 'E11N5', sources: 2 })
    const u = await svc.createUser({ username: 'm3_live_a', room: 'E11N6', cpu: 100 })

    // removeRoom 被删房（与活跃房相邻）：terrain 恰一行全墙桩；活跃房不受损
    await svc.system('removeRoom', 'E11N5')
    const removedTerrain = await svc.getTerrain(['E11N5'])
    expect(removedTerrain.terrain.E11N5).toBe('1'.repeat(2500))
    const activeTerrain = await svc.getTerrain(['E11N6'])
    expect(activeTerrain.terrain.E11N6).toHaveLength(2500)
    expect(activeTerrain.terrain.E11N6).not.toBe('1'.repeat(2500))
    const activeObjects = await svc.getRoomObjects('E11N6')
    expect(activeObjects.some((o) => o.type === 'controller')).toBe(true)
    expect(activeObjects.some((o) => o.type === 'spawn')).toBe(true)

    // removeUser（该用户自己的席位拆解）：用户出世界；其 controller/spawn 所有权对象随删
    // （同名重建不撞 owned）
    await svc.system('removeUser', 'm3_live_a')
    let world = await svc.getWorld()
    expect(world.users.some((x) => x.username === 'm3_live_a')).toBe(false)
    await svc.system('removeRoom', 'E11N6')
    const afterObjects = await svc.getRoomObjects('E11N6')
    expect(afterObjects.some((o) => o.type === 'controller')).toBe(false)

    // 闭环：E11N5 重新 generateRoom → 同名 user 建号进被删过的房
    await svc.system('generateRoom', { room: 'E11N5', sources: 2 })
    const rebuilt = await svc.createUser({ username: 'm3_live_a', room: 'E11N5', cpu: 100 })
    world = await svc.getWorld()
    expect(world.users.some((x) => x.username === rebuilt.username)).toBe(true)
    // 幂等：再删不存在的
    await svc.system('removeUser', 'm3_never_existed')
    await svc.system('removeRoom', 'E11N9')
  }, 600_000)

  it('M3：teardown 崩溃恢复——真实残留 + history pending → recoverPendingTeardowns 补拆解', async () => {
    await svc.ensureRunning()
    // 造真实残留：房 + 用户（等价于 settle 落账 pending 后、拆解完成前崩溃）
    await svc.system('generateRoom', { room: 'E13N5', sources: 2 })
    const u = await svc.createUser({ username: 'm3_crash_user', room: 'E13N5', cpu: 100 })
    const histDir = mkdtempSync(join(tmpdir(), 'm3-hist-'))
    const hist = new MatchHistory(histDir)
    hist.upsert({
      id: 'mcrash',
      config: { seats: 2, roundMs: 60000, roundBreakTimeoutMs: 300000, maxRounds: 8 },
      winner: { kind: 'draw' }, settleReason: 'manual', scores: null, roundIndex: 0,
      createdAt: 1, settledAt: 2,
      seatUsers: { s: 'm3_crash_user' },
      rooms: { s: 'E13N5' },
      teardown: 'pending',
    })

    // 同一段代码（main.ts 启动恢复用 recoverPendingTeardowns）补拆解
    const failures: string[] = []
    const recovered = await recoverPendingTeardowns({
      system: (cmd, value) => svc.system(cmd, value),
      pending: hist.pending(),
      markDone: (id) => hist.markDone(id),
      onFail: (_m: string, _s: string, e: string) => failures.push(e),
    })
    expect(recovered).toBe(1)
    expect(failures).toEqual([])

    // 残留真被删掉（非幽灵 found:false）：用户出世界、房对象清空、terrain 全墙桩
    const world = await svc.getWorld()
    expect(world.users.some((x) => x.username === 'm3_crash_user')).toBe(false)
    const objs = await svc.system('roomObjects', 'E13N5')
    expect((objs as { objects: unknown[] }).objects).toHaveLength(0)
    const terrain = await svc.getTerrain(['E13N5'])
    expect(terrain.terrain.E13N5).toBe('1'.repeat(2500))
    // history 标记 done；再跑恢复 = 0（幂等收敛）
    expect(hist.pending()).toHaveLength(0)
    expect(await recoverPendingTeardowns({ system: (c: string, v?: unknown) => svc.system(c, v), pending: hist.pending(), markDone: (id: string) => hist.markDone(id) })).toBe(0)
    rmSync(histDir, { recursive: true, force: true })
  }, 600_000)

  // ---- M4 增补段（plan-M4 验收判据 2；S5-③/S5-④）----

  it('restart 竞态回归：窗口内并发 API 不穿透 guard——恰好一次重启 + 生成房不丢', async () => {
    // 根因取证（2026-09-13，/tmp/m4-kill9-debug.log + scripts/probe-restart-*.ts）：
    // 旧实现 stop 窗口（server=undefined、status 仍 running）内并发 ensureRunning 各自
    // ensure() → 双/三重私服互踩 db.json 丢房。修复后并发调用与 restart 共享同一周期。
    await svc.ensureRunning()
    await svc.system('generateRoom', { room: 'E15N5', sources: 2 })
    const readyCount = (): number => svcLog.filter((l) => l.includes('server ready on port')).length
    const readyBefore = readyCount()

    let polling = true
    const poller = (async () => {
      while (polling) {
        try {
          await svc.getTerrain(['E15N5']) // 修复后：与 restart 共享 barrier，阻塞至重启完成
        } catch {
          /* 防御：不应发生 */
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    })()
    await svc.restart()
    polling = false
    await poller

    expect(readyCount() - readyBefore, 'restart 窗口并发轮询不得触发额外启动').toBe(1)
    const terrain = await svc.getTerrain(['E15N5'])
    expect(terrain.terrain.E15N5, '重启后生成房仍在（db.json 不被竞争世界覆盖）').toHaveLength(2500)
  }, 600_000)

  it('M4：锦标赛真实私服链——自动建局（真实房间/建号）→ 开局 → settle 回填 → 届终局', async () => {
    await svc.ensureRunning()
    const dataDirT = mkdtempSync(join(tmpdir(), 'm4-tourn-'))
    const store = new TournamentStore(join(dataDirT, 'tournaments'))
    const arena = new RealArena(svc, { rooms: {}, log: (m) => console.log('[arena]', m) })
    const machines = new Map<string, MatchMachine>()
    const prompts: Array<{ seatId: string; matchId: string }> = []
    const scheduler = new TournamentScheduler({
      store,
      // main.ts createMatchInternal 同款流程（真实 RealArena + allocateRooms + prepareRooms）
      createMatch: (players, config) => {
        const m = new MatchMachine({
          players,
          ...(config ? { config } : {}),
          onEvent: (e) => {
            if (e.type === 'settled') scheduler.onSettled(m)
          },
        })
        for (const [seatId, room] of Object.entries(allocateRooms(POOL, arena.roomsSnapshot(), players.map((p) => p.seatId)))) {
          arena.assignRoom(seatId, room)
        }
        machines.set(m.id, m)
        void arena.prepareRooms().catch(() => {})
        return m
      },
      getMachine: (id) => machines.get(id),
      journalEntries: () => [],
      historyGet: () => undefined,
      historyFindByPair: () => undefined,
      initialPrompt: (seatId, matchId) => {
        prompts.push({ seatId, matchId })
      },
      log: (msg) => console.log(`[tournament] ${msg}`),
    })
    const t = scheduler.create({
      name: 'live-duel',
      participants: [
        { seatId: 'ta', username: 'ta' },
        { seatId: 'tb', username: 'tb' },
      ],
    })
    // pump（stub 同步）→ 首场已建局：真实房间生成
    const mid = t.matches[0]!.matchId!
    const machine = machines.get(mid)!
    const rooms = arena.roomsSnapshot()
    expect(Object.values(rooms)).toHaveLength(2)
    // 初始 prompt 已发（开局驱动 D5）；模拟 Agent：提交代码（真实私服 submitCode）
    expect(prompts.map((p) => p.seatId).sort()).toEqual(['ta', 'tb'])
    for (const p of prompts.splice(0)) machine.submitCode(p.seatId, { main: 'module.exports.loop = function () {}' })
    for (const seatId of ['ta', 'tb'] as const) await arena.bindUser(seatId)
    // 全员就绪 → starter 自动 start（真实 started 事件面）
    scheduler.tickStarter()
    expect(machine.phase).toBe('running')
    // 真实计分快照 → settle → onSettled 同步回填 → 届终局
    const world = await svc.getWorld()
    const snap: Record<string, SeatScoreInput> = {}
    for (const seat of ['ta', 'tb'] as const) {
      const u = world.users.find((x) => x.username === arena.resolveUser(seat))
      snap[seat] = { spawns: u?.spawns ?? 0, creeps: u?.creeps ?? 0, rooms: u?.ownedRooms ?? 0, rclTotal: u?.rclTotal ?? 0 }
    }
    machine.settle('manual', Date.now(), computeOutcome(snap))
    expect(t.matches[0]!.status).toBe('settled')
    expect(t.matches[0]!.result).not.toBeNull()
    expect(t.finishedAt).toBeTruthy()
    expect(tournamentFinished(t)).toBe(true)
    // 真实用户进过世界（自动建局非纸面）
    expect(world.users.some((u) => u.username === arena.resolveUser('ta'))).toBe(true)
    rmSync(dataDirT, { recursive: true, force: true })
  }, 600_000)
  it('M4/D8：kill -9 三真合一——真实 main 进程 teardown pending 窗口被杀 → 重启补拆解清残留', async () => {
    // 真实 main.mjs 子进程（dist 未建则现建——live lane 一次性代价）
    const root = fileURLToPath(new URL('..', import.meta.url))
    if (!existsSync(join(root, 'dist', 'server', 'main.mjs'))) {
      execSync('npx tsdown', { cwd: root, stdio: 'inherit' })
    }
    const port = 8793
    const dataDirK = mkdtempSync(join(tmpdir(), 'm4-kill9-'))
    const debug = (msg: string): void => appendFileSync('/tmp/m4-kill9-debug.log', `${new Date().toISOString()} ${msg}\n`)
    rmSync('/tmp/m4-kill9-debug.log', { force: true })
    debug(`dataDir=${dataDirK}`)
    let childSeq = 0
    const spawnMain = () => {
      const tag = `main-${++childSeq}`
      const p = spawn(process.execPath, [join(root, 'dist', 'server', 'main.mjs'), '--port', String(port), '--data-dir', dataDirK], {
        detached: true, // 独立进程组：kill -9 -pgid 连私服子进程一起清（ensure 无复用检测）
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const append = (d: Buffer) => appendFileSync(join(dataDirK, `${tag}.log`), d)
      p.stdout?.on('data', append)
      p.stderr?.on('data', append)
      return p
    }
    const waitReady = async (): Promise<void> => {
      for (let i = 0; i < 300; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/world`)
          const body = (await res.json()) as { ok?: boolean }
          if (body.ok) return
        } catch {
          /* 未就绪 */
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('main.mjs not ready in 150s')
    }
    const killGroup = (pid: number): void => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }

    const child = spawnMain()
    let matchId = ''
    try {
      await waitReady()
      debug('ready (first)')
      // 建局（无 provider：无 waker，纯编排形态）。**不等 prepareRooms 完成**：
      // settle 立即执行——teardown 的 releaseSeat 会 await preparePromise（生成房间 +
      // restart 链，秒~分钟级），pending 窗口因此足够宽，kill -9 锚定可靠（D8）。
      // 房间级残留清理语义已由 M3 live IT（recoverPendingTeardowns + 真实房间）覆盖；
      // 本 IT 验证的是进程级三真：真实 main + 真实 kill -9 + 真实重启恢复管线。
      const createRes = await fetch(`http://127.0.0.1:${port}/api/matches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ players: [{ seatId: 'ka', username: 'ka' }, { seatId: 'kb', username: 'kb' }] }),
      })
      expect(createRes.status).toBe(201)
      const match = (await createRes.json()) as { id: string }
      matchId = match.id
      const settleRes = await fetch(`http://127.0.0.1:${port}/api/matches/${match.id}/settle`, { method: 'POST' })
      expect(settleRes.status).toBe(200)
      // history pending 在 settle HTTP 响应返回前已同步落盘（wireMachine 同步块）——
      // 响应一回来立即 kill -9 整组 = 必落在 teardown 窗口（D8 锚定方式）
      debug('settled, killing group now')
      killGroup(child.pid!)

      // 磁盘证据：history 落了 pending（kill 前已同步写）；rooms 记录了本局分配
      const histLines = readFileSync(join(dataDirK, 'history', 'matches.jsonl'), 'utf8').trim().split('\n')
      const rec = JSON.parse(histLines[0]!) as { id: string; teardown: string; rooms: Record<string, string> }
      expect(rec.id).toBe(match.id)
      expect(rec.teardown).toBe('pending')
      expect(Object.values(rec.rooms)).toEqual(expect.arrayContaining(['E5N5', 'E7N5']))
    } finally {
      killGroup(child.pid!)
    }

    // 重启（同 data-dir）：teardown-recovered 补拆解 → history done + 房间清干净
    const child2 = spawnMain()
    try {
      await waitReady()
      let done = false
      for (let i = 0; i < 60; i++) {
        const hist = (await (await fetch(`http://127.0.0.1:${port}/api/history`)).json()) as { history: Array<{ id: string; teardown: string }> }
        if (hist.history.find((h) => h.id === matchId)?.teardown === 'done') {
          done = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(done, 'teardown recovered to done after restart').toBe(true)
      const fails = (await (await fetch(`http://127.0.0.1:${port}/api/teardown-failures`)).json()) as { failures: unknown[] }
      expect(fails.failures).toEqual([])
      // 幂等收敛：重启后 history 无 pending（补拆解已重放完毕）
      const hist2 = (await (await fetch(`http://127.0.0.1:${port}/api/history`)).json()) as { history: Array<{ teardown: string }> }
      expect(hist2.history.every((h) => h.teardown === 'done')).toBe(true)
      // 注：房间级残留（terrain 全墙桩）断言在 M3 live IT 覆盖（真实生成房 + 补拆解）；
      // 本 IT 的房间可能尚未生成（found:false 幂等路径），不在此断言。
    } finally {
      killGroup(child2.pid!)
      await new Promise((r) => setTimeout(r, 500))
      rmSync(dataDirK, { recursive: true, force: true })
    }
  }, 900_000)
})
