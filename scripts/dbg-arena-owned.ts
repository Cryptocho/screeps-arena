/**
 * M5 调试探针：复现 live IT「createUser failed: room W14N15 is already owned」——
 * prepareArena → bindUser(p1, base) → dump 镜像房 controller 状态（谁 owned 了它）。
 * 跑法：fnm exec --using=22 -- npx tsx scripts/debug-arena-owned.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'
import { RealArena } from '../src/server/screeps/arena.js'

const modPath = fileURLToPath(new URL('../src/server/screeps/arena-mod.cjs', import.meta.url))
const dataDir = mkdtempSync(join(tmpdir(), 'dbg-arena-'))
const t0 = Date.now()
const ts = (): string => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`

const svc = new ScreepsService(
  { dataDir, tickDuration: 150, mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))] },
  (msg, ...args) => console.log(ts(), '[svc]', msg.replace(/%s/g, () => String(args.shift() ?? ''))),
)

try {
  await svc.ensureRunning()
  const arena = new RealArena(svc, { rooms: {}, log: (m) => console.log(ts(), '[arena]', m) })
  const { base, mirror } = await arena.prepareArena()
  console.log(ts(), `prepared base=${base} mirror=${mirror}`)
  await dump('after prepareArena')

  arena.setSpawnCoords('p1', { x: 25, y: 25 })
  arena.setSpawnCoords('p2', { x: 24, y: 25 })
  arena.assignRoom('p1', base)
  arena.assignRoom('p2', mirror)
  const u1 = await arena.bindUser('p1')
  console.log(ts(), `bindUser p1 ok: ${u1.username}`)
  await dump('after bindUser p1')
  const u2 = await arena.bindUser('p2')
  console.log(ts(), `bindUser p2 ok: ${u2.username}`)
  await dump('after bindUser p2')
  console.log(ts(), 'ALL OK')
} catch (err) {
  console.log(ts(), 'FAILED:', String(err))
  await dump('at failure')
} finally {
  await svc.shutdown().catch(() => {})
  console.log('dataDir kept:', dataDir)
}

async function dump(when: string): Promise<void> {
  for (const room of ['W15N15', 'W14N15']) {
    const objs = await svc.getRoomObjects(room)
    const interesting = objs.filter((o) => o.type === 'controller' || o.type === 'spawn')
    console.log(ts(), `[${when}] ${room}:`, JSON.stringify(interesting.map((o) => ({ type: o.type, x: o.x, y: o.y, user: o.user }))))
  }
  const world = await svc.getWorld()
  console.log(ts(), `[${when}] users:`, JSON.stringify(world.users.map((u) => ({ username: u.username, id: u.id }))))
}
