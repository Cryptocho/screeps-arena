/**
 * S7a — M0 主线闭环：拉起私服 → 同参数生成两房 → 建 2 用户传代码（A 空脚本 / B 采集升级）
 * → 加速 tick → 观察 controller progress → 判定胜负。对应 AGENTS.md M0 验收。
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=... npm run test:it
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

const EMPTY_BOT = 'module.exports.loop = function () {}'

const UPGRADE_BOT = `
module.exports.loop = function () {
  let upgrades = Memory.upgrades || 0
  for (const creep of Object.values(Game.creeps)) {
    if (creep.store.getFreeCapacity() === 0) {
      const target = creep.room.controller
      const r = creep.upgradeController(target)
      if (r === OK) upgrades++
      if (r === ERR_NOT_IN_RANGE) creep.moveTo(target)
    } else {
      const src = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE)
      if (src && creep.harvest(src) === ERR_NOT_IN_RANGE) creep.moveTo(src)
    }
  }
  Memory.upgrades = upgrades
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && Object.keys(Game.creeps).length < 4) {
    spawn.spawnCreep([WORK, CARRY, MOVE], 'c' + Game.time)
  }
}
`

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe.skipIf(!provisioned)('M0 closed loop (real server)', () => {
  it('two users submit code, world accelerates, upgrader bot wins on controller progress', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-m0-'))
    const { mkdirSync, symlinkSync } = await import('node:fs')
    mkdirSync(dataDir, { recursive: true })
    symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
    symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

    const ctx = new Context()
    const config = ScreepsService.Config({ serverMode: 'managed', dataDir, port: 0, nodeVersion: '22', tickDuration: 150 })
    const fiber = await ctx.plugin(ScreepsService, config)
    const svc = ctx.screeps
    try {
      await svc.ensureRunning()

      // 干净世界（对局创建的标准第一步；同时清掉历史探针用户，保证 tick 速度）
      await svc.system('resetArena')

      // 两个默认参数房间（M0 不要求同参公平；公平生成是 S9 的事）
      const suffix = Math.random().toString(36).slice(2, 6)
      const pick = () => 40 + Math.floor(Math.random() * 50)
      const roomA = `W${pick()}N${pick()}`
      const roomB = `W${pick()}N${pick()}`
      await svc.system('generateRoom', roomA)
      await svc.system('generateRoom', roomB)

      const a = await svc.createUser({ username: `m0_a_${suffix}`, room: roomA, code: { main: EMPTY_BOT } })
      const b = await svc.createUser({ username: `m0_b_${suffix}`, room: roomB, code: { main: UPGRADE_BOT } })
      expect(a.username).toContain('m0_a')
      expect(b.username).toContain('m0_b')

      // 关键：runner 的地形缓冲在进程级缓存（S7a 结论），生成房间后必须重启刷新，
      // 否则新房间内用户代码全部 "Could not load terrain data" 不执行。
      await svc.restart()
      expect(svc.getStatus().status).toBe('running')

      // 地形交接断言（m0-flake §三）：restart 后 runner 视角的 blob 必须包含两个新房间
      //（含 8 邻居 walled stub），把「竞态显式化」为可判定断言。
      const terrain = (await svc.system('terrainRooms')) as { envRooms: string[] }
      expect(terrain.envRooms).toEqual(expect.arrayContaining([roomA, roomB]))

      // 加速世界并等待世界推进（轻量身体 1:1:1 全速移动；采集→升级往返约 150+ tick）
      await svc.system('setTickDuration', 100)
      const before = (await svc.getWorld()).gameTime

      // 多次采样：creep 出生→采集→走到 controller 需 ~150 tick，之后 progress 才开始涨
      let bProgress = 0
      let aProgress = 0
      let mid = await svc.getWorld()
      for (let i = 0; i < 6; i++) {
        await sleep(10_000)
        mid = await svc.getWorld()
        expect(mid.gameTime).toBeGreaterThan(before + 50)
        const ua = mid.users.find(u => u.username === a.username)!
        const ub = mid.users.find(u => u.username === b.username)!
        expect(ua.ownedRooms).toBe(1)
        expect(ub.ownedRooms).toBe(1)
        bProgress = ub.rooms[0]!.progress + (ub.rclTotal - 1) * 200
        aProgress = ua.rooms[0]!.progress + (ua.rclTotal - 1) * 200
        const mem = (await svc.readMemory(b.username)) as { data?: string }
        let upgrades = 'n/a'
        if (mem.data?.startsWith('gz:')) {
          const raw = Buffer.from(mem.data.slice(3), 'base64')
          const { gunzipSync } = await import('node:zlib')
          const parsed = JSON.parse(gunzipSync(raw).toString()) as { upgrades?: number }
          upgrades = String(parsed.upgrades)
        } else {
          upgrades = String(mem.data)
        }
        console.log(`[sample ${i}] t=${mid.gameTime} b=${bProgress} a=${aProgress} upgrades=${upgrades}`)
        if (bProgress > 0) break
      }
      expect(bProgress).toBeGreaterThan(0)
      expect(bProgress).toBeGreaterThan(aProgress)
    } finally {
      await fiber.dispose()
    }
  }, 240_000)
})
