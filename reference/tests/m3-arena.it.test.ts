/**
 * IT1 — arena-blitz 歼灭闭环（M3 A/E 验收，真实私服）。
 *
 * 链路：create(arena-blitz) → 测试会话代码暂存为 raider（A 侧）→ bot 座位注入 harvester（B 侧被动）
 * → start（arena 镜像自动，W15N15/W14N15，拒 rooms）→ 开局镜像对称断言（worldSnapshot 双侧）→
 * clearSafeMode 双房 → raider 跨房拆 B spawn → B spawns==0 → eliminated → lastStanding settle →
 * winner = arena 会话侧。
 *
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律：共享 smoke dataDir 是单写者资源，全 IT 文件串行执行。
 *
 * 前置事实（plan-M3 A/B/E 节钉死）：
 * - arenaGen：基准房 W15N15 + 东邻镜像 W14N15（B3：东邻 = roomNameFromXY(x+1,y)）；
 * - 镜像 terrain = 基准逐行反转（每 50 字符 1 行，x'=49-x、y 不变）——反转正确性由 mod 契约
 *   测试直接断言；IT 做真实私服侧复核（worldSnapshot 双侧对称）；
 * - 双侧 spawn 严格对称（同一 placeSpawn 常量 300/5000；IT 断言 spawnEnergy 双侧严格相等——
 *   绝对值=300 由 mod 契约保证，start 的 resume 已放行首 tick 可能扣 210）；
 * - safeMode：placeSpawn 设 gameTime+20000 → 战斗前必须 clearSafeMode（B5，m2-battle 实证）；
 * - damage：[ATTACK,ATTACK,MOVE] 60/tick 拆 5000hits spawn ≈ 84 tick ≪ 2000（tick 预算富余）；
 * - 确定性：A 侧 raider（攻击）vs B 侧 harvester（被动采集）——harvester 不拆 A spawn，
 *   raider 拆光 B spawn → B eliminated 唯一 → winner=arena-sess（无同时双拆平局风险）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { BotRegistry } from './helpers/bot-registry.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
/** 测试专用 bot fixture（P0 对齐：bots/ 移出产品路径，BotRegistry 走 tests/fixtures/bots）。 */
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe.skipIf(!provisioned)('M3 IT1 arena-blitz 歼灭闭环（真实私服）', () => {
  it(
    'raider vs harvester: mirror symmetry assert → cross-room fight → spawns==0 → lastStanding settle',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-arena-'))
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

        // 1) create(arena-blitz) → A 侧代码暂存为 raider（模拟暂存式 submit）→ B 侧 bot 座位 harvester
        const created = (await svc.match.createMatch({
          preset: 'arena-blitz',
          sessionId: 'arena-sess',
          username: 'arena_a',
          tickDuration: 100,
        })) as { id: string }
        const matchId = created.id
        const raiderCode = await botRegistry.load('raider')
        const harvesterCode = await botRegistry.load('harvester')
        // 测试会话侧 = raider（不建号直接注入 code 字段，start 时注入）
        await svc.match.store.update(matchId, s => {
          const a = s.players.find(p => p.sessionId === 'arena-sess')!
          a.code = raiderCode
        })
        await svc.match.store.addPlayer(matchId, {
          sessionId: '__bot__harvester',
          username: '__bot_harvester',
          botCode: harvesterCode,
        })
        const started = await svc.match.start(matchId)
        expect(started.phase).toBe('running')
        expect(started.assignments).toEqual({ 'arena-sess': 'W15N15', '__bot__harvester': 'W14N15' })

        // D 节铁律：Memory.arena.targetRoom 兜底注入（writeMemory 通道；start 后才建号可写）。
        // describeExits 在镜像房场景可能拿不到出口（记 LOG 遗留），Memory 注入是确定路径。
        await svc.writeMemory('arena_a', { arena: { targetRoom: 'W14N15' } })

        // 2) 开局镜像对称断言（真实私服侧复核 mod 契约）
        //    - arenaProbe: 镜像 terrain == base 逐行反转; objects 坐标 x'=49-x、y 不变
        //    - worldSnapshot: 双侧 spawns/能量/房间数对称
        const probe = (await svc.system('arenaProbe', { base: 'W15N15', mirror: 'W14N15' })) as {
          base: { terrain: string; objects: Array<{ type: string; x: number; y: number; room: string }> }
          mirror: { terrain: string; objects: Array<{ type: string; x: number; y: number; room: string }> }
        }
        // reverseTerrain 复算（host 侧）：每 50 字符一行反转
        function reverseRows(t: string): string {
          const rows: string[] = []
          for (let y = 0; y < 50; y++) rows.push(t.slice(y * 50, y * 50 + 50).split('').reverse().join(''))
          return rows.join('')
        }
        expect(probe.base.terrain).toHaveLength(2500)
        expect(probe.mirror.terrain).toEqual(reverseRows(probe.base.terrain)) // 镜像=基准逐行反转
        // objects 镜像坐标（x'=49-x、y 不变；type 对齐后逐个比）
        for (const obj of probe.base.objects) {
          const twin = probe.mirror.objects.find(
            o => o.type === obj.type && o.x === 49 - obj.x && o.y === obj.y && o.room === 'W14N15',
          )
          expect(twin).toBeTruthy()
        }

        const world0 = await svc.getWorld()
        const a = world0.users.find(u => u.username === 'arena_a')
        const b = world0.users.find(u => u.username === '__bot_harvester')
        expect(a?.spawns).toBe(1)
        expect(b?.spawns).toBe(1)
        expect(a?.spawnEnergy).toBe(b?.spawnEnergy) // 双侧初始能量严格相等（resume 可能已扣 210，只断言相等）
        expect(a?.ownedRooms).toBe(1)
        expect(b?.ownedRooms).toBe(1)

        // 3) 前置：clearSafeMode 双房（B5）→ roomObjects 断言 safeMode < gameTime
        const worldBefore = await svc.getWorld()
        for (const room of ['W15N15', 'W14N15']) {
          const cleared = (await svc.system('clearSafeMode', room)) as { safeMode: number }
          expect(cleared.safeMode).toBeLessThan(worldBefore.gameTime)
        }
        for (const room of ['W15N15', 'W14N15']) {
          const probe = (await svc.system('roomObjects', room)) as { objects: Array<{ type: string; safeMode?: number }> }
          const controller = probe.objects.find(o => o.type === 'controller')
          if (!controller || controller.safeMode === undefined || controller.safeMode >= worldBefore.gameTime) {
            throw new Error(`clearSafeMode 前置失败：${room} controller safeMode=${controller?.safeMode} 未清除（gameTime=${worldBefore.gameTime}）→ IT 判前置失败`)
          }
        }

        // 4) 等待歼灭：harvester spawns==0 → eliminated → autoSettle lastStanding
        // 180s（原 120s）：满套件尾段 CPU 饱和下 tick 显著变慢，放宽观察窗防负载性误报
        const deadline = Date.now() + 3 * 60_000
        let obs
        try {
          while (Date.now() < deadline) {
            await sleep(2_000)
            obs = await svc.match.observe(matchId)
            const eliminated = Object.values(obs.scoreboard).filter(s => s.eliminated)
            if (eliminated.length >= 1) break
          }
        } finally {
          const world = await svc.getWorld()
          console.log('[arena-dump] gameTime=', world.gameTime)
          console.log('[arena-dump] users=', world.users.map(u => `${u.username}: rooms=${u.ownedRooms} spawns=${u.spawns} creeps=${u.creeps} energy=${u.spawnEnergy}`).join(','))
          // per-room 诊断：看 raider creep 是否进了 W14N15、双方 spawn 归属
          for (const room of ['W15N15', 'W14N15']) {
            const probe = (await svc.system('roomObjects', room)) as { objects: Array<{ type: string; user?: string; name?: string }> }
            const condensed = probe.objects
              .filter(o => o.type === 'spawn' || o.type === 'creep' || o.type === 'controller')
              .map(o => `${o.type}:${o.user?.slice(-6) ?? 'none'}@${o.name ?? ''}`)
            console.log(`[arena-dump] ${room} objects=`, condensed.join(' | '))
          }
          // console 诊断：raider 脚本是否报错（帧含 error 字段）
          try {
            const out = await svc.consoleOutput('arena_a', 0)
            console.log('[arena-dump] console arena_a=', JSON.stringify(out.lines.slice(-6)))
          } catch (err) {
            console.log('[arena-dump] console arena_a unavailable:', String(err))
          }
        }

        // 5) 断言：harvester（被动侧）被拆光出局 + winner=arena 会话侧 + 无 scoreWarning
        expect(obs!.scoreboard['__bot__harvester'].eliminated).toBe(true)
        expect(obs!.scoreboard['arena-sess'].eliminated).toBe(false)
        expect(obs!.autoSettle.due).toBe(true)
        expect(obs!.autoSettle.reason).toBe('lastStanding')
        const settled = await svc.match.settle(matchId, 'lastStanding')
        expect(settled.phase).toBe('settled')
        expect(settled.winner).toEqual({ kind: 'session', id: 'arena-sess' })
        expect(settled.scores && Object.keys(settled.scores)).toHaveLength(2)
        expect(settled.scoreWarning).toBeUndefined()
        // 对方无复活 spawn：RCL1 上限 1 个 spawn（controller 不可升级）——最终快照确认 spawns=0
        const worldEnd = await svc.getWorld()
        expect(worldEnd.users.find(u => u.username === '__bot_harvester')?.spawns).toBe(0)
      } finally {
        try {
          await fiber.dispose()
        } catch (err) {
          // dispose 失败不能吞主错误；仅记录
          console.error('[it] fiber.dispose failed:', err)
        }
      }
    },
  )
})