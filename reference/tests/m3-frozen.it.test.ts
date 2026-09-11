/**
 * IT2 — world-frozen 完整玩法闭环（M3 C/E 验收，真实私服）。
 *
 * 链路：create(world-frozen) → 测试会话（空壳 EMPTY_CODE）+ raider bot 注入 → start 显式相邻房
 * + 匹配 exits（W35N35/W35N36——W15N15 系已被历史 IT 污染过 reservedBy，另选全新房）→
 *   clearSafeMode 双房 → submit_code 被拒断言
 * （frozen 语义）→ raider 跨房拆空壳侧 spawn（空壳玩家无行动）→ 一方 spawns==0 && creeps==0
 * （world eliminated 判据，M3 B 节修正）→ lastStanding settle → winner=raider 侧。
 *
 * 注意：M3 A0 人类建赛仅 live；world-frozen 产品局排期外，本 IT 走 C 节 botCode 测试链路验收
 * （与 spawn-Agent 无关）——对局参与者仍只有 Agent 会话 + 测试 bot 座位（内部链路）。
 *
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it（全 IT 串行）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { buildTools } from '../src/host/tools.ts'
import { BotRegistry } from './helpers/bot-registry.ts'
import type { ScreepsService as ScreepsServiceType } from '../src/host/service.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function makeExec(sessionId: string): never {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

describe.skipIf(!provisioned)('M3 IT2 world-frozen 完整玩法（真实私服）', () => {
  it(
    'frozen: submit rejected → raider vs idle → spawns+creeps==0 → lastStanding settle → winner=raider',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-frozen-'))
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
      const svc = ctx.screeps as ScreepsServiceType
      try {
        await svc.ensureRunning()
        const tools = buildTools(svc) as Array<{ name: string; execute: (args: unknown, exec: never) => Promise<Record<string, unknown>> }>
        const tool = (name: string) => {
          const found = tools.find(t => t.name === name)
          if (!found) throw new Error(`tool not found: ${name}`)
          return found
        }

        // 1) create(world-frozen, tickDuration 100) → 空壳会话玩家 + raider bot 座位（内部链路）
        const created = (await tool('screeps_match').execute(
          { action: 'create', preset: 'world-frozen', tickDuration: 100, username: 'frozen_a' },
          makeExec('frozen-sess'),
        )) as { match: { id: string } }
        const matchId = created.match.id
        const raiderCode = await botRegistry.load('raider')
        await svc.match.store.addPlayer(matchId, {
          sessionId: '__bot__raider',
          username: '__bot_raider',
          botCode: raiderCode,
        })

        // 2) start 显式相邻房 + 匹配 exits（world 路径回归，m2-battle 先例）
        const started = (await tool('screeps_match').execute(
          {
            action: 'start',
            matchId,
            rooms: [
              { room: 'W35N35', exits: { top: [22, 23, 24] } },
              { room: 'W35N36', exits: { bottom: [22, 23, 24] } },
            ],
          },
          makeExec('frozen-sess'),
        )) as { match: { phase: string; assignments: Record<string, string> } }
        expect(started.match.phase).toBe('running')
        expect(Object.values(started.match.assignments)).toEqual(['W35N35', 'W35N36'])

        // D 节铁律：Memory.arena.targetRoom 注入（writeMemory 通道；raider 侧目标房）
        // （describeExits 在手动生成房场景可能拿不到出口，Memory 注入是确定路径——记 LOG 遗留）
        await tool('screeps_write_memory').execute(
          { value: { arena: { targetRoom: 'W35N35' } } },
          makeExec('__bot__raider'),
        )

        // 3) clearSafeMode 双房（B5 前置）
        const worldBefore = await svc.getWorld()
        for (const room of ['W35N35', 'W35N36']) {
          const cleared = (await svc.system('clearSafeMode', room)) as { safeMode: number }
          expect(cleared.safeMode).toBeLessThan(worldBefore.gameTime)
        }

        // 4) frozen：submit_code 被拒（frozen 预设下热更封闭）
        await expect(
          tool('screeps_submit_code').execute(
            { modules: { main: 'module.exports.loop = function () {}' } },
            makeExec('frozen-sess'),
          ),
        ).rejects.toThrow(/freezes code/)

        // 5) 等待歼灭：raider 拆空壳侧 spawn → 空壳侧 spawns==0 && creeps==0（world 判据）→ lastStanding
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
          console.log('[frozen-dump] gameTime=', world.gameTime)
          console.log('[frozen-dump] users=', world.users.map(u => `${u.username}: rooms=${u.ownedRooms} spawns=${u.spawns} creeps=${u.creeps}`).join(','))
          for (const room of ['W35N35', 'W35N36']) {
            const probe = (await svc.system('roomObjects', room)) as { objects: Array<{ type: string; user?: string; name?: string; x?: number; y?: number }> }
            const condensed = probe.objects
              .filter(o => o.type === 'spawn' || o.type === 'creep' || o.type === 'controller')
              .map(o => `${o.type}:${o.user?.slice(-6) ?? 'none'}@${o.name ?? ''}(${o.x},${o.y})`)
            console.log(`[frozen-dump] ${room} objects=`, condensed.join(' | '))
          }
          try {
            const out = await svc.consoleOutput('__bot_raider', 0)
            const withErr = out.lines.filter((l: unknown) => (l as { error?: string }).error !== undefined)
            console.log('[frozen-dump] console raider lines=', out.lines.length, 'errors=', withErr.length)
            console.log('[frozen-dump] console raider errors sample=', JSON.stringify(withErr.slice(0, 3)))
          } catch (err) {
            console.log('[frozen-dump] console unavailable:', String(err))
          }
        }

        // 6) 断言：frozen_a（空壳）被拆光出局 → winner=__bot_raider
        expect(obs!.scoreboard['frozen-sess'].eliminated).toBe(true)
        expect(obs!.scoreboard['__bot__raider'].eliminated).toBe(false)
        expect(obs!.autoSettle.due).toBe(true)
        expect(obs!.autoSettle.reason).toBe('lastStanding')
        const settled = await svc.match.settle(matchId, 'lastStanding')
        expect(settled.phase).toBe('settled')
        expect(settled.winner).toEqual({ kind: 'session', id: '__bot__raider' })
        expect(settled.scores && Object.keys(settled.scores)).toHaveLength(2)
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