/**
 * M6 IT — 产品补全真实私服全链（plan-M6 §4-F）：world-rounds 局里
 *   ① 提交一律走 buildTools(svc) 的 screeps_submit_code.execute（一审 B1：store.update 直写
 *      会绕过工具层记录点——禁止照抄 m5-rounds 的直写模式；store 直写仅 bot 座位注入前置态）；
 *   ② 代码端点：版本列表 seq 递增（creating → start 注入 → roundBreak commit）+ 单条内容与提交一致；
 *   ③ 地形端点：2500 字符位域串 + 墙边界；world DTO rooms[].spawns 有坐标；
 *   ④ 公平兜底：DTO 全文无 sessionId / 无 token。
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=<smoke> npm run test:it
 * 串行纪律：共享 smoke dataDir 单写者，全套 IT 文件串行（vitest fileParallelism:false）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { buildTools } from '../src/host/tools.ts'
import { handleArenaRequest } from '../src/host/http.ts'
import { BotRegistry } from './helpers/bot-registry.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
const botRegistry = new BotRegistry(join(import.meta.dirname, 'fixtures', 'bots'))

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const ROUND0_CODE = `
module.exports.loop = function () {
  Memory.stats = Memory.stats || {}
  Memory.stats.m6round0 = Game.time
}
`
const ROUND1_CODE = `
module.exports.loop = function () {
  if (Game.time % 5 === 0) console.log('M6_ROUND1_MARK tick', Game.time)
  Memory.stats = Memory.stats || {}
  Memory.stats.m6round1 = Game.time
}
`

describe.skipIf(!provisioned)('M6 product surfaces (real server, plan-M6 §4-F)', () => {
  it(
    'code-log via tool submits + HTTP code/terrain/world endpoints + fairness DTO',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-m6-'))
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
          driveIntervalMs: 500,
          roundBreakTimeoutMs: 60_000,
        }),
      )
      const svc = ctx.screeps
      const matches = svc.match
      const tools = buildTools(svc) as Array<{ name: string; execute: (args: unknown, exec: never) => Promise<Record<string, unknown>> }>
      const tool = (name: string) => {
        const found = tools.find(t => t.name === name)
        if (!found) throw new Error(`tool not found: ${name}`)
        return found
      }
      const makeExec = (sessionId: string): never => ({ agent: { id: sessionId }, signal: new AbortController().signal } as never)
      // handleArenaRequest 的 pathname 不含 query（生产侧由 URL 解析分离）——这里同样拆开传
      const get = (pathWithQuery: string) => {
        const url = new URL(pathWithQuery, 'http://localhost')
        return handleArenaRequest(svc, { method: 'GET', pathname: url.pathname, query: url.searchParams })
      }

      try {
        await svc.ensureRunning()
        // world-rounds 局：Agent 座位（工具面驱动）+ bot 座位（roundBreak 自动 ready）
        const created = await matches.createMatch({
          preset: 'world-rounds',
          sessionId: 'm6-agent',
          username: 'm6_pa',
          tickDuration: 100,
          roundTicks: 100,
          maxRounds: 2,
        })
        const botCode = await botRegistry.load('harvester')
        await matches.store.addPlayer(created.id, { sessionId: '__bot__harvester', username: '__bot_harvester', botCode })

        // === 记录点 2：creating 暂存（经工具 execute，plan B1 通道）===
        const staged = (await tool('screeps_submit_code').execute(
          { modules: { main: ROUND0_CODE } },
          makeExec('m6-agent'),
        )) as { staged?: boolean }
        expect(staged.staged).toBe(true)

        // start → running；记录点 4 = 两座位 placing/start-injected
        const started = await matches.start(created.id)
        expect(started.phase).toBe('running')

        // === round0 → roundBreak（drive 循环驱动；roundTicks=100 @100ms ≈ 10s）===
        let broke = false
        const breakDeadline = Date.now() + 90_000
        while (Date.now() < breakDeadline && !broke) {
          await sleep(2_000)
          const state = await matches.store.get(created.id)
          if (state?.phase === 'roundBreak') broke = true
        }
        expect(broke).toBe(true)

        // === 记录点 1：roundBreak commit（工具 execute → ready=true）===
        const committed = (await tool('screeps_submit_code').execute(
          { modules: { main: ROUND1_CODE } },
          makeExec('m6-agent'),
        )) as { text: string }
        expect(committed.text).toContain('round break')

        // === 代码端点：版本列表（全局 seq：1 creating / 2 placing(pa) / 3 placing(bot) / 4 roundBreak）===
        const listRes = await get(`/dsh-screeps/matches/${created.id}/code`)
        expect(listRes.status).toBe(200)
        const list = listRes.body as {
          ok: boolean
          players: Array<{ username: string; versions: Array<{ seq: number; phase: string; source: string; roundIndex?: number }> }>
        }
        expect(list.ok).toBe(true)
        const pa = list.players.find(p => p.username === 'm6_pa')!
        expect(pa.versions.map(v => [v.seq, v.phase, v.source])).toEqual([
          [1, 'creating', 'agent-submit'],
          [2, 'placing', 'start-injected'],
          [4, 'roundBreak', 'agent-submit'],
        ])
        const botEntry = list.players.find(p => p.username === '__bot_harvester')!
        expect(botEntry.versions).toEqual([{ seq: 3, ts: expect.any(Number), username: '__bot_harvester', phase: 'placing', source: 'start-injected', size: expect.any(Number) }])

        // 单条内容与提交一致（round1 commit / creating 暂存）
        const round1 = await get(`/dsh-screeps/matches/${created.id}/code/m6_pa/4`)
        expect(round1.status).toBe(200)
        expect((round1.body as { modules: { main: string }; phase: string; roundIndex?: number }).modules.main).toBe(ROUND1_CODE)
        expect((round1.body as { phase: string }).phase).toBe('roundBreak')
        expect((round1.body as { roundIndex?: number }).roundIndex).toBe(0)
        const round0 = await get(`/dsh-screeps/matches/${created.id}/code/m6_pa/2`)
        expect(round0.status).toBe(200)
        expect((round0.body as { modules: { main: string } }).modules.main).toBe(ROUND0_CODE)
        // 公平兜底：DTO 全文无 sessionId / token（含 m6-agent 会话 id）
        const listRaw = JSON.stringify(listRes.body)
        expect(listRaw).not.toContain('sessionId')
        expect(listRaw).not.toContain('m6-agent')
        expect(listRaw).not.toContain('token')

        // === terrain 端点（真实私服）：对局房间的 2500 字符位域串 + 墙边界 ===
        const state = (await matches.store.get(created.id))!
        const rooms = Object.values(state.assignments ?? {})
        expect(rooms.length).toBeGreaterThan(0)
        const terrainRes = await get(`/dsh-screeps/terrain?rooms=${encodeURIComponent(rooms.join(','))}`)
        expect(terrainRes.status).toBe(200)
        const terrainBody = terrainRes.body as { ok: boolean; terrain: Record<string, string> }
        expect(terrainBody.ok).toBe(true)
        for (const room of rooms) {
          const terrain = terrainBody.terrain[room]
          expect(terrain).toBeDefined()
          expect(terrain).toHaveLength(2500)
          // 墙边界：第一行（索引 0-49）应含 wall（bit1 → 字符奇数）
          const topRow = terrain.slice(0, 50)
          expect(topRow.split('').some(ch => (Number(ch) & 1) === 1)).toBe(true)
        }

        // === world DTO：rooms[].spawns 有真实坐标（placeSpawn 建号即存在）===
        const world = (await svc.getWorld()).users
        const paUser = world.find(u => u.username === 'm6_pa')!
        expect(paUser.rooms.length).toBeGreaterThan(0)
        const spawns = paUser.rooms.flatMap(r => r.spawns ?? [])
        expect(spawns.length).toBeGreaterThan(0)
        for (const s of spawns) {
          expect(s.x).toBeGreaterThanOrEqual(0)
          expect(s.x).toBeLessThan(50)
          expect(s.y).toBeGreaterThanOrEqual(0)
          expect(s.y).toBeLessThan(50)
        }

        // === 全员就绪 → drive 自动续跑 round1（新代码在私服生效——M5 IT 已深验，此处验推进）===
        let resumed = false
        const resumeDeadline = Date.now() + 60_000
        while (Date.now() < resumeDeadline && !resumed) {
          await sleep(2_000)
          const cur = await matches.store.get(created.id)
          if (cur && cur.phase === 'running' && (cur.roundIndex ?? 0) >= 1) resumed = true
        }
        expect(resumed).toBe(true)
      } finally {
        await fiber.dispose()
      }
    },
    360_000,
  )
})
