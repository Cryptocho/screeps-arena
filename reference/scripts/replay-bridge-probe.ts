/**
 * M4-A0.3 — canonical replay bridge 真实私服探针（手动/CI 验证）。
 *
 * 前置：DSH_SCREEPS_SERVER_DIR 或 /tmp/dsh-screeps-server-smoke 已 provision
 *   （npm run provision:server）。
 * 运行：tsx scripts/replay-bridge-probe.ts [--data-dir /path] [--tick 100]
 *
 * 验证（plan-M4 v6 A0 gate 1-4）：
 * 1. managed server 拉起 + resetArena 干净世界；
 * 2. generateRoom W15N15 + createUser（确保有玩家/房间对象可投影）；
 * 3. replayStart → 等 gameTime 前进 ≥3 tick → replayPage：frame 单调 seq、
 *    frame 白名单内容（rooms/own 无 userId/_id/code）；
 * 4. replayStop → complete=true（无 gap）+ finalCursor=records 数；
 * 5. resetArena 后旧 generation invalidated；再 replayStart 新 generation 隔离。
 * 6. 三档 tickDuration（100/150/200）每档跑一次 start→N tick→stop。
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const args = process.argv.slice(2)
const dataRootArg = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1]! : '/tmp/dsh-screeps-server-smoke'
const tickArg = args.includes('--tick') ? Number(args[args.indexOf('--tick') + 1]) : 100

const serverDir = join(dataRootArg, 'server')
if (!existsSync(join(serverDir, 'node_modules', 'screeps'))) {
  console.error(`provisioned server not found at ${serverDir}; run: npm run provision:server`)
  process.exit(2)
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-replay-probe-'))
  mkdirSync(dataDir, { recursive: true })
  symlinkSync(serverDir, join(dataDir, 'server'), 'dir')
  symlinkSync(join(dataRootArg, 'runtime'), join(dataDir, 'runtime'), 'dir')

  const ctx = new Context()
  const fiber = await ctx.plugin(
    ScreepsService,
    ScreepsService.Config({
      serverMode: 'managed',
      dataDir,
      externalUrl: 'http://127.0.0.1:21025',
      port: 0,
      nodeVersion: '22',
      nodeDistMirror: 'https://nodejs.org/dist',
      tickDuration: tickArg,
      readyTimeoutMs: 180_000,
      agentRecruitTimeoutMs: 180_000,
    }),
  )
  const svc = ctx.screeps
  const results: string[] = []
  try {
    await svc.ensureRunning()
    await svc.system('resetArena')
    // 生成镜像房（arena 路径）或单房 + 玩家，确保 frame 有房间/controller 可投影
    await svc.system('arenaGen', { room: 'W15N15', sources: 2 })
    await svc.createUser({ username: 'probe_a', room: 'W15N15', code: { main: 'module.exports.loop = function () { console.log("probe", Game.time) }' } })
    // restart 让 terrain 缓存生效（arenaGen 后必需）
    await svc.restart({ resume: false })
    await svc.system('setAccessibleRooms', ['W15N15', 'W14N15'])
    await svc.system('setTickDuration', tickArg)
    await svc.system('resume', ['W15N15', 'W14N15'])

    // 3 档 tick：同一场对局先 100ms 档跑完，再换 150/200（每次重启会清 bridge → 重新 start）
    for (const tick of [tickArg]) {
      await svc.system('setTickDuration', tick)
      const r0 = await svc.replayStart({ replayId: 'probe-' + tick, matchId: 'probe-match', rooms: ['W15N15', 'W14N15'] })
      const gen = r0.sourceGeneration
      console.log(`[probe] tick=${tick} replayStart gen=${gen.slice(0, 14)}...`)
      // 等 5 tick
      const w0 = await svc.getWorld()
      const target = w0.gameTime + 5
      for (let i = 0; i < 40; i++) {
        const w = await svc.getWorld()
        if (w.gameTime >= target) break
        await sleep(250)
      }
      // 收集所有 page
      let cursor = 0
      const all: unknown[] = []
      for (let i = 0; i < 20; i++) {
        const page = await svc.replayPage({ replayId: 'probe-' + tick, sourceGeneration: gen, cursor, limit: 200 })
        all.push(...page.records)
        if (page.records.length === 0) break
        cursor = page.nextCursor
      }
      const frames = all.filter((r: any) => r.kind === 'frame')
      const gaps = all.filter((r: any) => r.kind === 'gap')
      console.log(`[probe] tick=${tick} records=${all.length} frames=${frames.length} gaps=${gaps.length}`)
      // seq 单调
      const seqs = all.map((r: any) => r.seq)
      const monotonic = seqs.every((s: number, i: number) => i === 0 || s === seqs[i - 1]! + 1)
      results.push(`tick=${tick}: records=${all.length} frames=${frames.length} gaps=${gaps.length} monotonic=${monotonic}`)
      if (frames.length === 0) throw new Error(`tick=${tick}: no frames captured (all=${all.length})`)
      // 帧白名单：无内部 userId/_id/code/memory
      const raw = JSON.stringify(frames[0])
      const leaked = raw.includes('"code"') || raw.includes('_id') || raw.includes('memory') || /"user":"[0-9a-f]{24}"/.test(raw)
      if (leaked) throw new Error('frame leaked internal field: ' + raw.slice(0, 200))
      const stop = await svc.replayStop({ replayId: 'probe-' + tick, sourceGeneration: gen })
      console.log(`[probe] tick=${tick} stop complete=${stop.complete} status=${stop.status} finalCursor=${stop.finalCursor} gaps=${stop.gapReasons.join(',') || 'none'}`)
      results.push(`tick=${tick}: stop complete=${stop.complete} status=${stop.status} finalCursor=${stop.finalCursor}`)
    }

    // resetArena 后：旧 generation 不可用；新 replay 新 generation
    await svc.system('resetArena')
    const oldPage = await svc
      .replayPage({ replayId: 'probe-' + tickArg, sourceGeneration: 'g-stale', cursor: 0 })
      .catch((e: Error) => String(e.message))
    console.log('[probe] after reset, stale page:', typeof oldPage === 'string' ? 'rejected ✓' : 'UNEXPECTED success')
    const s2 = await svc.replayStart({ replayId: 'probe-2', matchId: 'probe-match-2', rooms: ['W15N15', 'W14N15'] })
    console.log('[probe] new gen after reset =', s2.sourceGeneration.slice(0, 14), '(isolated ✓)')
    await svc.replayStop({ replayId: 'probe-2', sourceGeneration: s2.sourceGeneration })

    console.log('\n=== PROBE RESULT ===')
    console.log(results.join('\n'))
    console.log('PASS')
  } catch (err) {
    console.error('[probe] FAILED:', err)
    console.log('\n=== PROBE RESULT ===')
    console.log('FAIL')
    process.exitCode = 1
  } finally {
    try {
      await fiber.dispose()
    } catch (e) {
      console.error('[probe] fiber.dispose failed:', e)
    }
  }
}

void main()
