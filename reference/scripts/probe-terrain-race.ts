/**
 * docs/spikes/m0-flake.md §三 探针 C+B：地形交接竞态（最后一环 ❓）。
 *
 * 每轮迭代：
 *   resetArena → generateRoom×2（updateTerrainData 会在内存里 env.set 整包 blob）
 *   → terrainRooms(before)（应含新房间：证明内存态正确）
 *   → 手工复刻 restart（shutdown → stat db.json → ensureRunning → resume）
 *   → terrainRooms(after)：envRooms 是否仍含新房间。
 *
 * 判定矩阵：
 *   - db.json mtime 在 shutdown 后 ≥ generateRoom 完成时刻（flushed）且 after 含新房间 → 交接 OK
 *   - mtime 陈旧（STALE）且 after 缺新房间 → 竞态复现：generateRoom 后的 env.terrainData
 *     没活过 restart —— LokiJS autosave(10s) 与 SIGTERM 的持久化窗口丢失，根因钉死。
 *
 * 运行：npx tsx scripts/probe-terrain-race.ts [iterations=4]
 * 前提：/tmp/dsh-screeps-server-smoke 已 provision，且无其他 IT/探针在跑（单写者）。
 */
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

type Svc = InstanceType<typeof ScreepsService>

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const iterations = Number(process.argv[2] ?? '4')

interface TerrainRooms {
  envBlobPresent: boolean
  envRooms: string[]
  blobError: string | null
  dbTerrainRooms: string[]
}

function statDb(): { mtimeMs: number; size: number } {
  const st = statSync(join(serverDir, 'db.json'))
  return { mtimeMs: st.mtimeMs, size: st.size }
}

async function terrainRooms(svc: Svc): Promise<TerrainRooms> {
  return (await svc.system('terrainRooms')) as unknown as TerrainRooms
}

interface Row {
  i: number
  rooms: string
  beforeHasBoth: boolean
  flushed: boolean
  mtimeDeltaMs: number
  afterHasBoth: boolean
  verdict: 'OK' | 'REPRODUCED (stale blob after boot)' | 'ANOMALY'
}

async function main(): Promise<void> {
  if (!existsSync(join(serverDir, 'node_modules', 'screeps'))) {
    throw new Error(`smoke server not provisioned at ${serverDir}`)
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-probe-'))
  mkdirSync(dataDir, { recursive: true })
  symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
  symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

  const ctx = new Context()
  const config = ScreepsService.Config({
    serverMode: 'managed',
    dataDir,
    externalUrl: 'http://127.0.0.1:21025',
    port: 0,
    nodeVersion: '22',
    nodeDistMirror: 'https://nodejs.org/dist',
    tickDuration: 150,
    readyTimeoutMs: 180_000,
    agentRecruitTimeoutMs: 180_000,
  })
  const fiber = await ctx.plugin(ScreepsService, config)
  const svc = ctx.screeps
  const rows: Row[] = []
  try {
    await svc.ensureRunning()
    for (let i = 0; i < iterations; i++) {
      const pick = () => 40 + Math.floor(Math.random() * 50)
      const roomA = `W${pick()}N${pick()}`
      const roomB = `W${pick()}N${pick()}`
      await svc.system('resetArena')
      await svc.system('generateRoom', roomA)
      await svc.system('generateRoom', roomB)

      const before = await terrainRooms(svc)
      const beforeHasBoth = before.envRooms.includes(roomA) && before.envRooms.includes(roomB)
      const tGen = Date.now()
      const dbAtGen = statDb()

      // 手工复刻 restart()，以便在 stop 与 boot 之间观察 db.json 落盘状态
      await svc.shutdown()
      const dbAfterStop = statDb()
      await svc.ensureRunning()
      await svc.system('resume')

      const after = await terrainRooms(svc)
      const afterHasBoth = after.envRooms.includes(roomA) && after.envRooms.includes(roomB)
      const mtimeDeltaMs = Math.round(dbAfterStop.mtimeMs - tGen)
      const flushed = dbAfterStop.mtimeMs >= tGen - 1000
      const verdict: Row['verdict'] = afterHasBoth ? 'OK' : flushed ? 'ANOMALY' : 'REPRODUCED (stale blob after boot)'
      rows.push({ i, rooms: `${roomA},${roomB}`, beforeHasBoth, flushed, mtimeDeltaMs, afterHasBoth, verdict })

      console.log(
        `[probe ${i}] rooms=${roomA},${roomB} beforeMem=${beforeHasBoth ? 'both' : 'MISSING:' + JSON.stringify(before)}\n` +
          `          db.json: gen_mtimeΔ=${dbAtGen.mtimeMs - tGen}ms stop_mtimeΔ=${mtimeDeltaMs}ms flushed=${flushed}\n` +
          `          afterBoot: envRooms(${after.envRooms.length}) hasBoth=${afterHasBoth} dbTerrain=${after.dbTerrainRooms.length} blobError=${after.blobError}\n` +
          `          verdict=${verdict}`,
      )
    }
  } finally {
    await fiber.dispose()
  }

  const reproduced = rows.filter(r => r.verdict.startsWith('REPRODUCED'))
  const anomalies = rows.filter(r => r.verdict === 'ANOMALY')
  console.log('\n=== probe summary ===')
  for (const r of rows) console.log(`  [${r.i}] flushed=${r.flushed ? 'Y' : 'N'} stopΔ=${r.mtimeDeltaMs}ms after=${r.afterHasBoth ? 'OK' : 'MISSING'} -> ${r.verdict}`)
  console.log(`iterations=${rows.length} reproduced=${reproduced.length} anomaly=${anomalies.length}`)
  if (reproduced.length > 0) {
    console.log('竞态复现：generateRoom 后的 env.terrainData 未活过 restart（持久化窗口丢失）。')
    process.exitCode = 1
  } else if (anomalies.length > 0) {
    console.log('出现 ANOMALY（db.json 已落盘但 boot 后 blob 仍缺房）：需要探针 A（runner 侧对比）继续。')
    process.exitCode = 2
  } else {
    console.log('未复现：本批全部交接成功，需更多迭代或叠加负载再试。')
  }
}

main().catch(err => {
  console.error('probe failed:', err)
  process.exitCode = 3
})
