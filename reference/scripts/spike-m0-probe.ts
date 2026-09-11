/**
 * M0 诊断探针：建 1 个用户跑升级 bot（带 restart 流程，与 e2e 相同），观察升级计数。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'
import { ensureScreepsServer, readArenaSecret } from '../src/runtime/server-installer.ts'
import { launchScreepsServer } from '../src/runtime/server-launcher.ts'

const dataDir = process.env.DSH_SCREEPS_DATA ?? '/tmp/dsh-screeps-server-smoke'
const serverDir = join(dataDir, 'server')

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
  Memory.diag = { t: Game.time, creeps: Object.keys(Game.creeps).length }
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && Object.keys(Game.creeps).length < 4) {
    spawn.spawnCreep([WORK, CARRY, MOVE], 'c' + Game.time)
  }
}
`

const runtime = await ensureNodeRuntime({ runtimeDir: join(dataDir, 'runtime'), versionSpec: '22' })
const modContent = readFileSync(new URL('../screeps-mod/arena-mod.cjs', import.meta.url), 'utf8')
await ensureScreepsServer({ serverDir, runtime, mods: [{ name: 'arena-mod.cjs', content: modContent }], onLog: () => {} })
const secret = await readArenaSecret(serverDir)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const mkApi = (srv: { port: number }) => async (path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/arena/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-arena-secret': secret! },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return res.json() as Promise<any>
}

// —— 第一阶段：起服 v1，建房间 + 用户 ——
const server1 = await launchScreepsServer({ serverDir, runtime, readyTimeoutMs: 120_000, onLog: () => {} })
let api = mkApi(server1)
let username = ''
try {
  await server1.waitReady()
  const stamp = Date.now() % 100000
  const room = `W6${stamp % 10}N6${Math.floor(stamp / 10) % 10}`
  console.log('generate:', JSON.stringify(await api('rooms', { room, terrainType: 7, sources: 2, mineral: false })))
  username = `dbg${stamp}`
  await api('users', { username, room, code: { main: UPGRADE_BOT } })
  console.log('user:', username)
} finally {
  await server1.stop()
}

// —— 第二阶段：重启（刷新地形缓存），观察 ——
const server2 = await launchScreepsServer({ serverDir, runtime, readyTimeoutMs: 120_000, onLog: () => {} })
api = mkApi(server2)
try {
  await server2.waitReady()
  await api('system', { cmd: 'resume' })
  await api('system', { cmd: 'setTickDuration', value: 100 })
  for (let i = 0; i < 4; i++) {
    await sleep(8_000)
    const world = (await api('world')) as any
    const me = world.users.find((u: any) => u.username === username)
    console.log(`[${i}] t=${world.gameTime} rooms:`, JSON.stringify(me?.rooms))
  }
} finally {
  await server2.stop()
}
