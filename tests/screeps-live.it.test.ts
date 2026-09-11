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
})
