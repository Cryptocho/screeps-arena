/**
 * M2 E 步 — 战斗 IT（kills>0）：单会话 + harvester bot 对手，带 exits 的南北相邻房，
 * clearSafeMode 解除 20000 tick 免疫后 A 的攻击 bot 跨房拆 B 的 spawn。
 *
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律（AGENTS/plan-M2）：共享 smoke dataDir 是单写者资源，本文件与主闭环 IT 串行执行。
 *
 * 前置事实（九审 PASS 复核清单）：
 * - W15N16 是 W15N15 的北邻（utils.js roomNameToXY + map.js L420-426 邻居表）；
 *   exits 形状 = {top/right/bottom/left: [格点坐标]}（map.js L14-26/L275-299）；
 *   W15N15 top[22,23,24]（北边界 y=0）↔ W15N16 bottom[22,23,24]（南边界 y=49）同 x 坐标逐格一致。
 * - safeMode：engine 每 tick 从 db 直读 controller（driver L249-251），clearSafeMode 后下一 tick 生效，免 restart。
 * - damage：calcBodyEffectiveness 逐部件加和，[ATTACK,ATTACK,MOVE] = 60/tick；拆 5000hits spawn ≈ 84 tick。
 * - 预算：出生 ~9 + 移动 ~100 + 拆 ~84 ≈ 200 tick ≪ 4000（4000 < ring 4096）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { buildTools } from '../src/host/tools.ts'
import { BotRegistry } from './helpers/bot-registry.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
/** 测试专用 bot fixture（2026-09-09：bots/ 移出产品路径，BotRegistry 走 tests/fixtures/bots）。
 *  用 import.meta.dirname 锚定 tests/（vitest 转换下 import.meta.url 的 .. 会退错级；dirname 是源码真实目录）。 */
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

function makeExec(sessionId: string): never {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

/**
 * 攻击 bot（M2 E 步两阶段骨架，plan 修法全落）：
 * 阶段 1（首房无敌人）：spawn [ATTACK,ATTACK,MOVE] army（210≤开局 300，可直接首发）
 *   → 无敌对对象时 creep.moveTo(22,0)（A* 绕墙到北出口，interRoom 自动转移）。
 * 阶段 2（进 B 房）：敌对方 creep/structure → moveTo 接近 → isNearTo 时 attack。
 * 玩家 API（隔离环境）：Game.roomObjects 不存在！敌对对象必须用 FIND_HOSTILE_*。
 */
const ATTACK_BOT = `
const BODY = [ATTACK, ATTACK, MOVE]
module.exports.loop = function () {
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning && Object.keys(Game.creeps).length === 0 && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    spawn.spawnCreep(BODY, 'a' + Game.time)
  }
  for (const creep of Object.values(Game.creeps)) {
    // 敌对方对象（玩家 API；FIND_HOSTILE_* 自动排除己方与中立）
    // controller 剔除：attack(controller) 恒 ERR_INVALID_TARGET，路径更近时会永久卡死（raider 同款）
    const structs = (creep.room.find(FIND_HOSTILE_STRUCTURES) || []).filter(
      o => o.structureType !== STRUCTURE_CONTROLLER,
    )
    const enemy = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS) ||
                  creep.pos.findClosestByPath(structs)
    if (enemy) {
      if (creep.pos.isNearTo(enemy)) {
        creep.attack(enemy)
      } else {
        creep.moveTo(enemy)
      }
    } else {
      // 首房无敌人：走向北出口 (22,0)（A* 绕墙，interRoom 自动转移）
      creep.moveTo(22, 0, { ignoreCreeps: true })
    }
  }
}
`

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe.skipIf(!provisioned)('M2 battle IT (kills>0, real server)', () => {
  it(
    'single session + harvester bot: exits rooms, clearSafeMode, attack bot crosses and kills',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-battle-'))
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
          tickDuration: 150,
          readyTimeoutMs: 180_000,
        }),
      )
      const svc = ctx.screeps
      try {
        await svc.ensureRunning()
        // 工具面（P0 对齐：addBot 已从工具面摘除，bot 座位走内部链路 BotRegistry+store.addPlayer）
        const tools = buildTools(svc) as Array<{ name: string; execute: (args: unknown, exec: never) => Promise<Record<string, unknown>> }>
        const tool = (name: string) => {
          const found = tools.find(t => t.name === name)
          if (!found) throw new Error(`tool not found: ${name}`)
          return found
        }

        // 1) create（tickDuration 100）→ 注入测试 bot 座位（harvester，不走工具面）→ start 带南北相邻房 + 匹配 exits
        const created = (await tool('screeps_match').execute(
          { action: 'create', preset: 'world-rounds', tickDuration: 100, roundTicks: 1500, maxRounds: 2, username: 'battle_a' },
          makeExec('battle-sess'),
        )) as { match: { id: string } }
        const matchId = created.match.id
        const botCode = await botRegistry.load('harvester')
        await svc.match.store.addPlayer(matchId, {
          sessionId: '__bot__harvester',
          username: '__bot_harvester',
          botCode,
        })
        // 2) A 提交攻击 bot（两阶段之第一段）——M5：creating 暂存（start 注入）；
        //    running 期 submit 在 world-rounds 下已拒（plan §3.3/§A：删除 running 期 submit 断言）。
        await tool('screeps_submit_code').execute({ modules: { main: ATTACK_BOT } }, makeExec('battle-sess'))
        const started = (await tool('screeps_match').execute(
          {
            action: 'start',
            matchId,
            rooms: [
              { room: 'W15N15', exits: { top: [22, 23, 24] } },
              { room: 'W15N16', exits: { bottom: [22, 23, 24] } },
            ],
          },
          makeExec('battle-sess'),
        )) as { match: { assignments: Record<string, string> } }
        expect(Object.values(started.match.assignments)).toEqual(['W15N15', 'W15N16'])

        // 2) clearSafeMode 清双方 → roomObjects 断言 safeMode < gameTime（clearSafeMode 设 gameTime-1）。
//    ✅ 用当前 gameTime 比较，不硬编码 1000——共享 server 目录 db.json 让 gameTime 跨测试累积
//    （closed-loop IT 跑完后 gameTime 可能已 1000+，之前 <1000 断言是脆的）。
//    失败即判定前置失败直接 fail。
        const worldBefore = await svc.getWorld()
        for (const room of ['W15N15', 'W15N16']) {
          const cleared = (await svc.system('clearSafeMode', room)) as { safeMode: number }
          expect(cleared.safeMode).toBeLessThan(worldBefore.gameTime)
        }
        const probe = (await svc.system('roomObjects', 'W15N16')) as { objects: Array<{ type: string; safeMode?: number }> }
        const controller = probe.objects.find(o => o.type === 'controller')
        if (!controller || controller.safeMode === undefined || controller.safeMode >= worldBefore.gameTime) {
          throw new Error(`clearSafeMode 前置失败：B 房 controller safeMode=${controller?.safeMode} 未清除（gameTime=${worldBefore.gameTime}）→ IT 判前置失败`)
        }

        // 3) 前进到 4000 tick 上限内：kills==0 → fail + dump（区分采集/归因断链）
        //    （原「running 期热更攻击代码」步骤已随 world-live 删除——ATTACK_BOT 已在 creating 暂存注入）
        const deadline = Date.now() + 150_000 // 100ms/tick × 4000 = 400s 太长；90s 在满套件尾段负载下不够（run3 实测），放宽到 150s
        let kills = 0
        let losses = 0
        try {
          while (Date.now() < deadline) {
            await sleep(2_000)
            const obs = await svc.match.observe(matchId)
            kills = obs.scoreboard['battle-sess']?.counters.kills ?? 0
            losses = obs.scoreboard['__bot__harvester']?.counters.losses ?? 0
            if (kills > 0) break
          }
        } finally {
          // 无论成败，dump 现场（报告 + 世界 + 事件尾段 + bound）用于调试
          const report = await tool('screeps_report').execute({}, makeExec('battle-sess'))
          const world = await svc.getWorld()
          const tail = await svc.eventLog(0)
          console.log('[battle-dump] kills=', kills, 'losses=', losses)
          console.log('[battle-dump] report:\n', (report as { text: string }).text)
          console.log('[battle-dump] world gameTime=', world.gameTime, 'users=', world.users.map(u => `${u.username}:${u.ownedRooms}/${u.spawns}`).join(','))
          console.log('[battle-dump] eventTail entries=', (tail.events as unknown[]).length, 'bound=', tail.bound)
          if (kills === 0) {
            const destroyedInEvents = JSON.stringify(tail.events).includes('"event":2')
            console.log('[battle-dump] 归因断链判定：DESTROYED 采集到=', destroyedInEvents)
          }
        }

        // 5) 断言（区分断链给出可行动信息）
        expect(kills).toBeGreaterThan(0)

        // === M5 周期推进（plan §3.4/IT3）：round0 战斗后 force break → A 提交更强攻击代码（commit=就绪）→ round1 续跑 ===
        const drive = svc.match as unknown as { driveNextRound(id: string, o?: unknown): Promise<string> }
        // autoRound 要等 roundTicks=1500（150s）太久——IT 直接 enterRoundBreak 模拟边界（接口幂等；
        // 与 drive 循环的 autoRound 路径共享同一 enterRoundBreak 实现，周期语义等价）。
        const lc = svc.match.lifecycle as unknown as { enterRoundBreak(id: string): Promise<unknown> }
        await lc.enterRoundBreak(matchId)
        const brk = await svc.match.observe(matchId)
        expect(brk.match.phase).toBe('roundBreak')
        // A 在边界提交新代码（更强攻击 bot：同一 ATTACK_BOT 变体，标记 round-2）→ commit=就绪
        const commit = await tool('screeps_submit_code').execute({ modules: { main: ATTACK_BOT.replace('/* attack */', '// round-2 attack') } }, makeExec('battle-sess'))
        expect(String((commit as { text?: string }).text ?? '')).toContain('round break')
        // bot 座位自动 ready + A commit → 全员就绪 → driveNextRound 续跑 round1
        await drive.driveNextRound(matchId, { roundBreakTimeoutMs: 30_000 })
        const r1 = await svc.match.observe(matchId)
        expect(r1.match.phase).toBe('running')
        expect((r1.match.roundIndex ?? 0)).toBeGreaterThanOrEqual(1)

        // settle（收尾清场）
        await tool('screeps_match').execute({ action: 'settle', matchId, reason: 'manual' }, makeExec('battle-sess'))
      } finally {
        await fiber.dispose()
      }
    },
    180_000,
  )
})