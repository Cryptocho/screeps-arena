/**
 * M0 控制台诊断：sockjs XHR fallback 订阅 user:<id>/console，实时看用户代码输出/报错。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'
import { ensureScreepsServer, readArenaSecret } from '../src/runtime/server-installer.ts'
import { launchScreepsServer } from '../src/runtime/server-launcher.ts'

const dataDir = process.env.DSH_SCREEPS_DATA ?? '/tmp/dsh-screeps-server-smoke'
const serverDir = join(dataDir, 'server')

const BOT = `
module.exports.loop = function () {
  console.log('BOT TICK', Game.time)
  for (const creep of Object.values(Game.creeps)) {
    if (creep.store.getFreeCapacity() === 0) {
      const target = creep.room.controller
      if (target && (creep.upgradeController(target) === ERR_NOT_IN_RANGE)) creep.moveTo(target)
    } else {
      const src = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE)
      if (src && creep.harvest(src) === ERR_NOT_IN_RANGE) creep.moveTo(src)
    }
  }
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && Object.keys(Game.creeps).length < 4) {
    spawn.spawnCreep([WORK, CARRY, MOVE], 'c' + Game.time)
  }
}
`

const runtime = await ensureNodeRuntime({ runtimeDir: join(dataDir, 'runtime'), versionSpec: '22' })
const modContent = readFileSync(new URL('../screeps-mod/arena-mod.cjs', import.meta.url), 'utf8')
const debugModContent = readFileSync(new URL('./debug-mod.cjs', import.meta.url), 'utf8')
await ensureScreepsServer({ serverDir, runtime, mods: [{ name: 'arena-mod.cjs', content: modContent }, { name: 'debug-mod.cjs', content: debugModContent }], onLog: () => {} })
const secret = await readArenaSecret(serverDir)

const server = await launchScreepsServer({ serverDir, runtime, readyTimeoutMs: 120_000, onLog: () => {} })
const base = `http://127.0.0.1:${server.port}`
const H = { 'content-type': 'application/json', 'x-arena-secret': secret! }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** sockjs XHR polling 客户端（仅够订阅用） */
class SockJsXhr {
  private session = randomBytes(8).toString('hex')
  constructor(private base: string) {}
  private url(suffix: string) {
    return `${this.base}/socket/s/${this.session}/${suffix}`
  }
  async open(): Promise<void> {
    await fetch(this.url('xhr'), { method: 'POST' }).then(r => r.text())
  }
  async send(msg: string): Promise<void> {
    await fetch(this.url('xhr_send'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) }).then(r => r.text())
  }
  async poll(): Promise<string[]> {
    const text = await fetch(this.url('xhr'), { method: 'POST' }).then(r => r.text())
    try {
      const frame = JSON.parse(text) as [string, string[]] | string
      if (Array.isArray(frame) && frame[0] === 'a' && Array.isArray(frame[1])) return frame[1]
      return []
    } catch {
      return []
    }
  }
}

try {
  await server.waitReady()
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/arena/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: H,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return res.json() as Promise<any>
  }

  const stamp = Date.now() % 100000
  const room = `W6${stamp % 10}N6${Math.floor(stamp / 10) % 10}`
  await api('rooms', { room, terrainType: 7, sources: 2, mineral: false })
  const username = `dbg${stamp}`
  await api('users', { username, room, code: { main: BOT } })
  const tok = (await api('token', { username })) as any
  console.log('room:', room, 'user:', username)

  const sock = new SockJsXhr(base)
  await sock.open()
  await sleep(200)
  await sock.send(`auth ${tok.token}`)
  await sleep(200)
  const world = (await api('world')) as any
  const me = world.users.find((u: any) => u.username === username)
  await sock.send(`subscribe user:${me.id}/console`)
  await sock.send(`subscribe user:${me.id}/cpu`)
  console.log('subscribed to console of', me.id)

  const dump = (await api('system', { cmd: 'userDump', value: username })) as any
  console.log('userDump:', JSON.stringify({ user: { cpu: dump.user?.cpu, active: dump.user?.active, bot: dump.user?.bot, cpuAvailable: dump.user?.cpuAvailable }, codeCount: dump.codeCountForUser, activeRoomsCount: dump.activeRooms?.length, hasRoom: dump.activeRooms?.includes(room) }))

  await api('system', { cmd: 'setTickDuration', value: 100 })
  const stopAt = Date.now() + 25_000
  let lastLog = Date.now()
  while (Date.now() < stopAt) {
    const msgs = await sock.poll()
    for (const m of msgs) {
      try {
        const parsed = JSON.parse(m) as [string, unknown]
        if (parsed[0].endsWith('/console')) {
          console.log('[console]', JSON.stringify(parsed[1]).slice(0, 300))
        }
      } catch {
        console.log('[raw]', m.slice(0, 200))
      }
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now()
      console.log('... waiting')
    }
    await sleep(300)
  }
} finally {
  await server.stop()
}
