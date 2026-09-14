/**
 * S0 探针（plan-M5）：reference mod 的 arenaGen/arenaProbe 在本仓私服上原样冒烟
 * （回迁前确认防 flake 链在新版本依赖下工作）。断言（plan-M5 §1/D8）：
 *   ① arenaGen 双房生成成功（W15N15 base + W14N15 东邻镜像）；
 *   ② 镜像 terrain = 基准逐行反转（x'=49-x，y 不变，arenaProbe）；
 *   ③ objects 对称（source/controller 坐标 x'=49-x）；
 *   ④ 对称坐标建号（(25,25)/(24,25)）非墙 + 双席 spawn 严格镜像（[N2]）；
 *   ⑤ 双席 spawnEnergy 相等；
 *   （[N5] teardown→arenaGen 复用探针归 live IT ②——removeRoom 为本仓 mod 独有命令，
 *     reference mod 无此命令；S0 只验 reference mod 原样能力。）
 * 跑法：fnm exec --using=22 -- npx tsx scripts/s0-arena-probe.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'

const refModPath = fileURLToPath(new URL('../reference/screeps-mod/arena-mod.cjs', import.meta.url))
const t0 = Date.now()
const ts = (): string => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`
const dataDir = mkdtempSync(join(tmpdir(), 's0-arena-probe-'))
const BASE = 'W15N15'
const MIRROR = 'W14N15'
const failures: string[] = []
const check = (what: string, ok: boolean, detail = ''): void => {
  console.log(`${ts()} ${ok ? 'PASS' : 'FAIL'}: ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

const svc = new ScreepsService(
  { dataDir, tickDuration: 150, mods: [modFileFromContent('arena-mod.cjs', readFileSync(refModPath, 'utf8'))] },
  (msg, ...args) => console.log(ts(), '[svc]', msg.replace(/%s/g, () => String(args.shift() ?? ''))),
)

interface ProbeObjects extends Array<{ type: string; x: number; y: number }> {}
interface ArenaProbeResult {
  base: { room: string; terrain: string; objects: ProbeObjects }
  mirror: { room: string; terrain: string; objects: ProbeObjects }
}

try {
  await svc.ensureRunning()
  console.log(ts(), 'server ready')

  // ① arenaGen 双房生成
  await svc.system('arenaGen', { room: BASE, sources: 2 })
  const probe1 = (await svc.system('arenaProbe', { base: BASE, mirror: MIRROR })) as unknown as ArenaProbeResult
  check('① arenaGen + arenaProbe 返回双房', probe1.base?.room === BASE && probe1.mirror?.room === MIRROR)

  // ② terrain 逐行反转（50 字符/行，x'=49-x）
  const rev = (t: string): string => (t.match(/.{50}/g) ?? []).map((row) => [...row].reverse().join('')).join('')
  check('② mirror terrain = base 逐行反转', probe1.mirror.terrain === rev(probe1.base.terrain))

  // ③ objects 对称（controller/source：mirror.x = 49 - base.x 且 y 相等、type 对应）
  const sym = (kind: (o: { type: string }) => boolean): boolean => {
    const b = probe1.base.objects.filter(kind)
    const m = probe1.mirror.objects.filter(kind)
    if (b.length !== m.length || b.length === 0) return false
    for (const o of b) {
      const hit = m.find((p) => p.x === 49 - o.x && p.y === o.y)
      if (!hit) return false
    }
    return true
  }
  check('③ controller 对称', sym((o) => o.type === 'controller'))
  check('③ sources 对称', sym((o) => o.type === 'source'))

  // ④ 对称坐标建号：spawn 落点非墙 + 严格镜像（spawn 断言走 roomObjects——arenaProbe
  // 只收 source/mineral/controller，reference mod 语义如此）
  const wallAt = (t: string, x: number, y: number): boolean => t[y * 50 + x] === '1'
  await svc.createUser({ username: 's0_base', room: BASE, x: 25, y: 25, cpu: 100 })
  await svc.createUser({ username: 's0_mirror', room: MIRROR, x: 24, y: 25, cpu: 100 })
  const probe2 = (await svc.system('arenaProbe', { base: BASE, mirror: MIRROR })) as unknown as ArenaProbeResult
  const objsB = await svc.getRoomObjects(BASE)
  const objsM = await svc.getRoomObjects(MIRROR)
  const sb = objsB.find((o) => o.type === 'spawn')
  const sm = objsM.find((o) => o.type === 'spawn')
  check('④ base spawn 存在', !!sb)
  check('④ mirror spawn 存在', !!sm)
  if (sb && sm) {
    check('④ spawn 坐标非墙', !wallAt(probe2.base.terrain, sb.x, sb.y) && !wallAt(probe2.mirror.terrain, sm.x, sm.y))
    check('④ spawn 严格镜像 (x\'=49-x, y 相等)', sm.x === 49 - sb.x && sm.y === sb.y, `base=(${sb.x},${sb.y}) mirror=(${sm.x},${sm.y})`)
  }

  // ⑤ 双席 spawnEnergy 对等（world 快照扩展字段）
  const world = (await svc.getWorld()) as unknown as { users: Array<{ username: string; spawnEnergy?: number }> }
  const e1 = world.users.find((u) => u.username === 's0_base')?.spawnEnergy
  const e2 = world.users.find((u) => u.username === 's0_mirror')?.spawnEnergy
  check('⑤ spawnEnergy 对等', e1 !== undefined && e1 === e2, `base=${e1} mirror=${e2}`)

} catch (err) {
  failures.push(`exception: ${String(err)}`)
  console.log(ts(), 'EXCEPTION', String(err))
} finally {
  await svc.shutdown().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
console.log(ts(), failures.length === 0 ? 'S0 PROBE PASS' : `S0 PROBE FAIL: ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
