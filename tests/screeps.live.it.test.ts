/**
 * S1/S2 真实私服启动 IT（test:live lane，plan-M1 §4）——bare-metal 全链：
 * 播种→安装（npm install screeps + native 编译，首次 ≈8 分钟）→启动→setTickDuration
 * →generateRoom→createUser→submitCode→getWorld 断言用户/房间出现→consoleOutput 游标。
 * 装置纪律（m0-flake §四）：per-test mkdtemp 独立 serverDir；结束 shutdown 清进程。
 * 跑法：fnm exec --using=22 -- npm run test:live（默认 npm test 不含）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'
import { RealArena } from '../src/server/screeps/arena.js'
import { fairnessDeviation, roomDistanceScore } from '../src/server/screeps/fairness.js'
import { MatchMachine } from '../src/server/match/machine.js'
import { computeOutcome } from '../src/server/match/score.js'
import type { SeatScoreInput } from '../src/server/match/score.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const modPath = fileURLToPath(new URL('../src/server/screeps/arena-mod.cjs', import.meta.url))

const dataDir = mkdtempSync(join(tmpdir(), 'screeps-arena-live-'))
let svc: ScreepsService

beforeAll(() => {
  svc = new ScreepsService(
    {
      dataDir,
      tickDuration: 100,
      readyTimeoutMs: 180_000,
      mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))],
    },
    (msg, ...args) => console.log('[svc]', msg.replace(/%s/g, () => String(args.shift() ?? ''))),
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
})
