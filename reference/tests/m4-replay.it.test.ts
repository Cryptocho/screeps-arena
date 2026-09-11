/**
 * M4-D.4 — 真实私服 canonical replay generation 隔离 IT。
 *
 * 链路（plan-M4 v6 §D.4）：resetArena → arenaGen + createUser → restart →
 * attempt1：begin（generation g1）→ 等 tick 前进 → drain 收帧 → pause →
 *   finish（final drain + stop）→ ReplayStore meta complete + 帧单调 seq；
 * resetArena（旧 generation stale）→ attempt2：begin（新 generation g2 ≠ g1）
 *   → 等 tick → finish → 两局 replay 各自独立可读（matchId 隔离）。
 *
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律：共享 smoke dataDir 是单写者资源，全 IT 文件串行执行。
 *
 * 前置事实（plan-M4 A0/D 节钉死）：
 * - arena-mod replay bridge：replayStart 建新 generation，单 active；resetArena
 *   invalidate 旧 generation（stale，不可再 page）；
 * - ReplayRecorder.finish = 全量 drain → stop → 残余 append → finalize（meta
 *   replayMetaHash 权威字段集）；未 begin 时自动 begin（从当前起录）；
 * - frame 白名单：rooms/own 无 userId/_id/code/memory（A0 探针已验，此处复核）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import type { MatchState } from '../src/host/match/model.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** recorder 只消费 id/assignments/players 的 MatchState 投影。 */
function attemptState(id: string, username: string, participantId: string, room: string): MatchState {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'running',
    config: {} as MatchState['config'],
    players: [{ sessionId: 'sess-' + username, username, participantId }],
    assignments: { [username]: room },
  }
}

describe.skipIf(!provisioned)('M4-D.4 replay generation 隔离（真实私服）', () => {
  it(
    'reset→begin g1→frames→pause→finish complete；resetArena 后 g2 隔离且两局 replay 独立可读',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-replay-'))
      mkdirSync(dataDir, { recursive: true })
      symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
      symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

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
          tickDuration: 100,
          readyTimeoutMs: 180_000,
        }),
      )
      const svc = ctx.screeps
      try {
        await svc.ensureRunning()
        await svc.system('resetArena')
        await svc.system('arenaGen', { room: 'W15N15', sources: 2 })
        await svc.createUser({
          username: 'replay_a',
          room: 'W15N15',
          code: { main: 'module.exports.loop = function () { console.log("replay", Game.time) }' },
        })
        // arenaGen 后必须 restart 让 terrain 缓存生效（生命周期陷阱）
        await svc.restart({ resume: false })
        await svc.system('setAccessibleRooms', ['W15N15', 'W14N15'])
        await svc.system('setTickDuration', 100)
        await svc.system('resume', ['W15N15', 'W14N15'])

        // ---- attempt1：begin g1 → 等 ≥4 tick → drain → pause → finish ----
        const m1 = attemptState('m-attempt-1', 'replay_a', 'p1', 'W15N15')
        const b1 = await svc.replayRecorder.begin(m1)
        expect(b1.sourceGeneration).toMatch(/^g-/)
        const g1 = b1.sourceGeneration

        const w0 = await svc.getWorld()
        const target = w0.gameTime + 4
        for (let i = 0; i < 60; i++) {
          const w = await svc.getWorld()
          if (w.gameTime >= target) break
          await sleep(300)
        }
        await svc.drainReplay('m-attempt-1')
        await svc.system('pause') // 冻结世界，验证 finish 的 final drain/stop 语义
        const f1 = await svc.replayRecorder.finish(m1)
        expect(f1.completeness).toBe('complete')
        expect(f1.receipt.replayId).toBe('r-m-attempt-1')
        expect(f1.receipt.payloadHash).toMatch(/^[0-9a-f]{64}$/)

        const meta1 = await svc.replayStore.getMeta('m-attempt-1')
        expect(meta1?.status).toBe('complete')
        expect(meta1?.sourceGeneration).toBe(g1)
        expect(meta1!.recordCount).toBeGreaterThanOrEqual(2) // ≥2 帧（等 tick 前进）
        const page1 = await svc.replayStore.read('m-attempt-1', {})
        expect(page1.unavailable).toBe(false)
        const frames1 = page1.records.filter(r => r.kind === 'frame')
        expect(frames1.length).toBeGreaterThanOrEqual(2)
        // seq 单调（0..n-1）
        frames1.forEach((r, i) => expect(r.seq).toBe(i))
        // 帧白名单复核：无内部 userId/_id/code/memory
        const raw1 = JSON.stringify(frames1[0])
        expect(raw1).not.toMatch(/"code"/)
        expect(raw1).not.toMatch(/_id/)
        expect(raw1).not.toMatch(/memory/)
        expect(raw1).not.toMatch(/"user":"[0-9a-f]{24}"/)

        // ---- resetArena：旧 generation stale → attempt2 新 generation g2 隔离 ----
        await svc.system('resetArena')
        const stalePage = await svc
          .replayPage({ replayId: 'r-m-attempt-1', sourceGeneration: g1, cursor: 0 })
          .then(() => 'UNEXPECTED success')
          .catch((e: Error) => String(e.message))
        // reset 清空 bridge（replayId=null）→ 'unknown or inactive replay'；若仅 invalidate
        // 则 'stale generation'。两者都表示旧 generation 不可再 page（plan §5.2 reset 语义）。
        expect(stalePage).toMatch(/stale|inactive|unknown/)
        // reset 清空世界/用户：重建生成房间 + 用户 + restart（terrain 缓存）+ resume
        await svc.system('arenaGen', { room: 'W15N15', sources: 2 })
        await svc.createUser({
          username: 'replay_b',
          room: 'W15N15',
          code: { main: 'module.exports.loop = function () { console.log("replay2", Game.time) }' },
        })
        await svc.restart({ resume: false })
        await svc.system('setAccessibleRooms', ['W15N15', 'W14N15'])
        await svc.system('resume', ['W15N15', 'W14N15'])

        const m2 = attemptState('m-attempt-2', 'replay_b', 'p1', 'W15N15')
        const b2 = await svc.replayRecorder.begin(m2)
        expect(b2.sourceGeneration).not.toBe(g1) // 新 generation 天然隔离
        const g2 = b2.sourceGeneration

        const w1 = await svc.getWorld()
        const target2 = w1.gameTime + 2
        for (let i = 0; i < 60; i++) {
          const w = await svc.getWorld()
          if (w.gameTime >= target2) break
          await sleep(300)
        }
        const f2 = await svc.replayRecorder.finish(m2)
        expect(f2.completeness).toBe('complete')
        const meta2 = await svc.replayStore.getMeta('m-attempt-2')
        expect(meta2?.sourceGeneration).toBe(g2)
        expect(meta2!.recordCount).toBeGreaterThanOrEqual(1)

        // 两局 replay 独立可读（matchId 隔离，互不串帧）
        const page1b = await svc.replayStore.read('m-attempt-1', {})
        const page2 = await svc.replayStore.read('m-attempt-2', {})
        expect(page1b.records.length).toBe(meta1!.recordCount)
        expect(page2.records.length).toBe(meta2!.recordCount)
        for (const r of page1b.records) expect(r.sourceGeneration).toBe(g1)
        for (const r of page2.records) expect(r.sourceGeneration).toBe(g2)
      } finally {
        try {
          await fiber.dispose()
        } catch (err) {
          console.error('[it] fiber.dispose failed:', err)
        }
      }
    },
    300_000,
  )
})