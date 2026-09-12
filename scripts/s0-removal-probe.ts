/**
 * M3/S0 调研钉子（plan-M3 §3 S0 / 附录 A）：真实私服上实测 removeUser/removeRoom
 * 前置事实。产物 = 控制台 JSON 报告，人工回填 plan-M3 附录 A。
 *
 * 实测项：
 *  ① createUser 后 dbProbe（用户关联集合/env 键基线）；
 *  ② removeUser 后按 id dbProbe（残留清单）；
 *  ③ removeUser 幂等（再删 → found:false）；同名 createUser 重建可用；
 *  ④ removeRoom 后 roomObjects 空、terrain 为全墙桩、generateRoom 同名重建可行；
 *  ⑤ ACTIVE_ROOMS smembers / ACCESSIBLE_ROOMS 在 removeRoom 后不含被删房；
 *  ⑥ env.srem 存在性（若 storage env 无 srem 则 removeRoom 的 ACTIVE_ROOMS 分支需改写）。
 *
 * 跑法（≈6 分钟首次安装；dataDir 复用以续用安装产物）：
 *   fnm exec --using=22 -- npx tsx scripts/s0-removal-probe.ts [dataDir]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ScreepsService, modFileFromContent } from '../src/server/screeps/service.js'

const modPath = fileURLToPath(new URL('../src/server/screeps/arena-mod.cjs', import.meta.url))
const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 's0-probe-'))

const svc = new ScreepsService(
  {
    dataDir,
    tickDuration: 100,
    readyTimeoutMs: 180_000,
    mods: [modFileFromContent('arena-mod.cjs', readFileSync(modPath, 'utf8'))],
  },
  (msg, ...args) => console.log('[svc]', msg.replace(/%s/g, () => String(args.shift() ?? ''))),
)

const report: Record<string, unknown> = {}
try {
  await svc.ensureRunning()
  await svc.system('resetArena') // 幂等起步：清掉上次运行的残留（探针专用，不影响正式链路）

  // ① 基线：建房 + 建号（placeSpawn 会写 ACTIVE_ROOMS / rooms.objects 等）
  await svc.system('generateRoom', { room: 'E5N5', sources: 2 })
  const user = await svc.createUser({ username: 'probe_user', room: 'E5N5', cpu: 100 })
  report.before = await svc.system('dbProbe', { id: user.id })
  report.envProbe = await svc.system('envProbe')

  // ② removeUser + 残留清点（controller.user 所有权应随 {user:id} 对象一并消失）
  report.removeUser = await svc.system('removeUser', 'probe_user')
  report.afterRemoveUser = await svc.system('dbProbe', { id: user.id })
  report.roomObjectsAfterRemoveUser = (await svc.system('roomObjects', 'E5N5')).objects as unknown[]

  // ④ removeRoom（删号后删房）+ 重建链
  report.removeRoom = await svc.system('removeRoom', 'E5N5')
  report.roomObjectsAfterRemoveRoom = (await svc.system('roomObjects', 'E5N5')).objects as unknown[]
  report.terrainAfterRemove = (await svc.getTerrain(['E5N5'])).terrain.E5N5
  report.envAfterRemove = await svc.system('envProbe')
  report.regenerate = await svc.system('generateRoom', { room: 'E5N5', sources: 2 })
  report.roomObjectsAfterRegen = (await svc.system('roomObjects', 'E5N5')).objects as unknown[]
  const rebuilt = await svc.createUser({ username: 'probe_user', room: 'E5N5', cpu: 100 })
  report.rebuiltUser = { id: rebuilt.id, username: rebuilt.username }

  // ③ 幂等：重建的 probe_user 再删（found:true）+ 从未存在的用户（found:false）+
  // 已重建房再删 → 再生成 → 同名再建（闭环）
  report.removeUserAgain = await svc.system('removeUser', 'probe_user')
  report.removeGhost = await svc.system('removeUser', 'probe_user2') // 从未存在
  report.removeRoomAgain = await svc.system('removeRoom', 'E5N5') // 已重建后又删
  report.regenerate2 = await svc.system('generateRoom', { room: 'E5N5', sources: 2 })
  const rebuilt2 = await svc.createUser({ username: 'probe_user', room: 'E5N5', cpu: 100 })
  report.rebuiltAfterIdempotent = { id: rebuilt2.id }
} finally {
  await svc.shutdown()
  if (!process.argv[2]) rmSync(dataDir, { recursive: true, force: true })
  console.log('===== S0 REPORT =====')
  console.log(JSON.stringify(report, null, 2))
}
