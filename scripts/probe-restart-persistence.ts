/**
 * restart 持久化异常探针（M4 期发现，LOG 2026-09-13）：
 * 复现「generateRoom → svc.restart → 房间丢失 + 单次 restart 多次 launch」。
 * 每步带时间戳；循环 3 轮量化丢失概率。证据输出到 stdout（重定向留档）。
 * 跑法：fnm exec --using=22 -- npx tsx scripts/probe-restart-persistence.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const modPath = fileURLToPath(new URL('../src/server/screeps/arena-mod.cjs', import.meta.url))
const t0 = Date.now()
const ts = (): string => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`
const dataDir = mkdtempSync(join(tmpdir(), 'probe-restart-'))
console.log(ts(), 'dataDir=', dataDir)

const svc = new ScreepsService(
  {
    dataDir,
    tickDuration: 200,
    mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))],
  },
  (msg, ...args) => console.log(ts(), '[svc]', msg.replace(/%s/g, () => String(args.shift() ?? ''))),
)

async function roomExists(room: string): Promise<boolean> {
  const t = await svc.getTerrain([room])
  return t.terrain[room] !== undefined && t.terrain[room] !== '1'.repeat(2500)
}

try {
  await svc.ensureRunning()
  console.log(ts(), '=== server ready, start probe rounds ===')
  let lostRounds = 0
  for (let round = 1; round <= 3; round++) {
    const rooms = [`E5N${5 + round * 2}`, `E7N${5 + round * 2}`] // 每轮新房名，排除种子世界干扰
    for (const room of rooms) {
      const r = await svc.system('generateRoom', { room, sources: 2 })
      console.log(ts(), `round${round}: generateRoom ${room} ->`, JSON.stringify(r).slice(0, 60))
    }
    const before = await Promise.all(rooms.map((r) => roomExists(r)))
    console.log(ts(), `round${round}: before restart, rooms present =`, before)
    await svc.restart({ resume: true })
    console.log(ts(), `round${round}: restart returned`)
    const after = await Promise.all(rooms.map((r) => roomExists(r)))
    const lost = before.some((x, i) => x && !after[i])
    if (lost) lostRounds++
    console.log(ts(), `round${round}: after restart, rooms present =`, after, lost ? '>>> DATA LOST <<<' : 'ok')
  }
  console.log(ts(), `=== probe done: lostRounds=${lostRounds}/3 ===`)
} finally {
  await svc.shutdown().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
