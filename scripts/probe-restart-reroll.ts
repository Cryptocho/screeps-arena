/**
 * restart 持久化异常探针 A（fairness 重掷形态）：同房 1 秒内连续两轮 generateRoom
 * （模拟公平性重掷的覆盖写）→ 立即 restart → 查两房。循环 3 轮。
 * 对照基线（probe-restart-persistence.ts，单轮生成）0/3 复现。
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
const dataDir = mkdtempSync(join(tmpdir(), 'probe-reroll-'))
console.log(ts(), 'dataDir=', dataDir)

const svc = new ScreepsService(
  { dataDir, tickDuration: 200, mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))] },
  (msg, ...args) => console.log(ts(), '[svc]', msg.replace(/%s/g, () => String(args.shift() ?? ''))),
)

async function roomExists(room: string): Promise<boolean> {
  const t = await svc.getTerrain([room])
  return t.terrain[room] !== undefined && t.terrain[room] !== '1'.repeat(2500)
}

try {
  await svc.ensureRunning()
  console.log(ts(), '=== ready, start reroll-shape rounds ===')
  let lostRounds = 0
  for (let round = 1; round <= 3; round++) {
    const rooms = [`E5N${6 + round * 2}`, `E7N${6 + round * 2}`]
    // attempt 0：生成一轮
    for (const room of rooms) await svc.system('generateRoom', { room, sources: 2 })
    // fairness 不达标 → attempt 1：立即覆盖重掷（异常形态：末次写与 restart 相隔 <1s）
    for (const room of rooms) await svc.system('generateRoom', { room, sources: 2 })
    const before = await Promise.all(rooms.map((r) => roomExists(r)))
    console.log(ts(), `round${round}: before restart =`, before)
    await svc.restart({ resume: true })
    console.log(ts(), `round${round}: restart returned`)
    const after = await Promise.all(rooms.map((r) => roomExists(r)))
    const lost = before.some((x, i) => x && !after[i])
    if (lost) lostRounds++
    console.log(ts(), `round${round}: after restart =`, after, lost ? '>>> DATA LOST <<<' : 'ok')
  }
  console.log(ts(), `=== probe A done: lostRounds=${lostRounds}/3 ===`)
} finally {
  await svc.shutdown().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
