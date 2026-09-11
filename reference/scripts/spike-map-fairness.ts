/**
 * S7d 地图公平性实验：terrainType/swampType/sources 相同的房间是否公平？
 * 步骤：起服 → 同参数生成房间对 → 拉 terrain 对比 → 统计 source/controller 布局。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'
import { ensureScreepsServer, readArenaSecret } from '../src/runtime/server-installer.ts'
import { launchScreepsServer } from '../src/runtime/server-launcher.ts'

const dataDir = process.env.DSH_SCREEPS_DATA ?? '/tmp/dsh-screeps-server-smoke'
const serverDir = join(dataDir, 'server')

const runtime = await ensureNodeRuntime({ runtimeDir: join(dataDir, 'runtime'), versionSpec: '22' })
const modContent = readFileSync(new URL('../screeps-mod/arena-mod.cjs', import.meta.url), 'utf8')
await ensureScreepsServer({ serverDir, runtime, mods: [{ name: 'arena-mod.cjs', content: modContent }], onLog: () => {} })
const secret = await readArenaSecret(serverDir)

const server = await launchScreepsServer({ serverDir, runtime, readyTimeoutMs: 120_000, onLog: () => {} })
const base = `http://127.0.0.1:${server.port}`
const H = { 'content-type': 'application/json', 'x-arena-secret': secret! }

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

  // 干净世界（db.original 自带 4 simplebot 房间，避开它们：用远端房间名）
  const terrainOf = async (room: string) => {
    const r = await fetch(`${base}/api/game/room-terrain?room=${room}&encoded=1`).then(r => r.json() as Promise<any>)
    return r.terrain?.[0]?.terrain as string
  }

  const trials: Array<{ terrainType: number; sources: number; pairs: string[][]; terrainIdentical: boolean[]; layouts: any[] }> = []
  for (const [terrainType, sources] of [[7, 2], [7, 2], [13, 2], [22, 1]] as const) {
    const tag = `${terrainType}-${sources}-${Math.random().toString(36).slice(2, 6)}`
    const rooms = [`E30N${tag.length ? '30' : '30'}X${tag}`.replace(/[^A-Z0-9]/gi, '').slice(0, 4) + 'N30', ''] as string[]
    void rooms
    // 房间名格式 [WE]<n>[NS]<n>；用大坐标远离初始区
    const r1 = `W${terrainType * 3}N${sources * 7}`
    const r2 = `W${terrainType * 3}S${sources * 7}`
    const g1 = await api('rooms', { room: r1, terrainType, sources, mineral: false })
    const g2 = await api('rooms', { room: r2, terrainType, sources, mineral: false })
    const t1 = await terrainOf(r1)
    const t2 = await terrainOf(r2)
    trials.push({
      terrainType,
      sources,
      pairs: [[r1, r2]],
      terrainIdentical: [t1 === t2],
      layouts: [g1, g2],
    })
    console.log(`terrainType=${terrainType} sources=${sources}: ${r1} vs ${r2}`)
    console.log(`  terrain identical: ${t1 === t2}`)
    console.log(`  ${r1} sources:`, JSON.stringify(g1.sources), 'controller:', JSON.stringify(g1.controller))
    console.log(`  ${r2} sources:`, JSON.stringify(g2.sources), 'controller:', JSON.stringify(g2.controller))
  }
  console.log('\nSUMMARY:', JSON.stringify(trials.map(t => ({ tt: t.terrainType, s: t.sources, identical: t.terrainIdentical[0] })), null, 0))
} finally {
  await server.stop()
}
