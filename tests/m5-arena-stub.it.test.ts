/**
 * M5/S2-S3 stub IT（plan-M5 D8）——真实 RealArena + MatchMachine 装置（fake 私服）：
 * ① arena 局固定镜像房分配（不占房间池、不触 prepareRooms 公平重掷）；
 * ② B3 负向：arena 登记后，后续 world 局 prepareRooms 不生成镜像房（防覆盖战场）；
 * ③ 对称坐标建号（base(25,25)/mirror(24,25) 透传 createUser）；
 * ④ bindUser 与 prepareArena 并发竞态（waker 先到 → ensureRoomReady 等待单飞）；
 * ⑤ arena running 热更登记（seatBackendFor 语义在 machine 层的等价面）+ 歼灭结算落 history。
 * 真实私服链路由 test:live / s0 探针承担。
 */
import { describe, expect, it, vi } from 'vitest'
import { RealArena } from '../src/server/screeps/arena.js'
import { MatchMachine } from '../src/server/match/machine.js'
import { configFromPreset } from '../src/server/match/model.js'
import { arenaSettleDecision } from '../src/server/match/arena-observe.js'
import { MatchHistory } from '../src/server/history.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScreepsService } from '../src/server/screeps/service.js'

const POOL = ['E5N5', 'E7N5']

function fakeSvc(): ScreepsService & { commands: Array<[string, unknown]> } {
  const commands: Array<[string, unknown]> = [] as Array<[string, unknown]>
  const base = {
    commands,
    system: vi.fn(async (cmd: string, value?: unknown) => {
      commands.push([cmd, value])
      if (cmd === 'arenaGen') return { base: 'W15N15', mirror: 'W14N15', exits: { right: [24, 25] } }
      if (cmd === 'removeRoom') return { room: value }
      if (cmd === 'removeUser') return { user: value }
      if (cmd === 'eventLog') return { events: [], cursor: 0, bound: true }
      return { ok: true }
    }),
    createUser: vi.fn(async (input: { username: string; x?: number; y?: number }) => ({
      id: 'u-' + input.username,
      username: input.username,
      placedAt: { x: input.x, y: input.y },
    })),
    submitCode: vi.fn(async () => ({ timestamp: 1 })),
    getWorld: vi.fn(async () => ({ ok: true, gameTime: 1, users: [] })),
    getRoomObjects: vi.fn(async () => []),
    getTerrain: vi.fn(async () => ({ terrain: { W15N15: '0'.repeat(2500) } })),
    consoleOutput: vi.fn(async () => ({ lines: [], cursor: 0, bound: true })),
    restart: vi.fn(async () => {}),
  } as unknown as ScreepsService
  return Object.assign(base, { commands })
}

describe('M5 arena 局（stub IT，真实 RealArena）', () => {
  it('镜像房分配/对称建号/B3 防覆盖/热更登记/歼灭结算', async () => {
    const svc = fakeSvc()
    const arena = new RealArena(svc, { rooms: {} })
    const config = configFromPreset('arena-blitz')

    // ① 分配镜像房（不占池）：先占满池再建 arena 局，守卫只看 arena 单飞
    const m = new MatchMachine({
      players: [
        { seatId: 'aa', username: 'aa' },
        { seatId: 'ab', username: 'ab' },
      ],
      config,
    })
    arena.assignRoom('aa', 'W15N15')
    arena.assignRoom('ab', 'W14N15')
    void arena
      .prepareArena()
      .then(({ spawnA, spawnB }) => {
        console.log('[dbg] setSpawnCoords', spawnA, spawnB)
        arena.setSpawnCoords('aa', spawnA)
        arena.setSpawnCoords('ab', spawnB)
      })
      .catch((err) => console.log('[dbg] prepareArena rejected:', String(err)))
    // ③ 并发竞态（[waker 先到]）：bindUser 与 prepareArena 并发 → 等待战场就绪后建号
    const [ua, ub] = [await arena.bindUser('aa'), await arena.bindUser('ab')]
    expect(ua.username).toMatch(/^agent_/)
    expect(arena.resolveUser('aa')).toBe(ua.username)
    // ③ 对称坐标透传 createUser
    const calls = (svc as unknown as { createUser: ReturnType<typeof vi.fn> }).createUser.mock.calls as Array<
      Array<{ username: string; x?: number; y?: number; room: string }>
    >
    console.log('[dbg] createUser calls:', JSON.stringify(calls.map((c) => c[0])))
    const byUser = new Map(calls.map((c) => [c[0]!.username, c[0]!]))
    // 对称性断言（坐标由 prepareArena 地形选定，fake terrain 全 0 → (5,5)/(44,5) 对）
    expect(byUser.get(ua.username)?.x).toBe(byUser.get(ub.username) ? 49 - (byUser.get(ub.username)!.x ?? 0) : undefined)
    expect(byUser.get(ua.username)?.y).toBe(byUser.get(ub.username)?.y)

    // ② B3 负向：arena 局运行中建 world 局 → prepareRooms 不生成镜像房
    arena.assignRoom('wa', POOL[0]!)
    void arena.prepareRooms().catch(() => {})
    const generateCalls = (svc as unknown as { system: ReturnType<typeof vi.fn> }).system.mock.calls.filter(
      ([cmd, v]) => cmd === 'generateRoom',
    )
    // B3 本质断言：镜像房永不进 prepareRooms 的生成域（公平重掷只碰池房）
    const genTargets = generateCalls.map(([, v]) => (v as { room: string }).room)
    expect(genTargets.length).toBeGreaterThan(0)
    expect(genTargets).not.toContain('W15N15')
    expect(genTargets).not.toContain('W14N15')

    // ⑤ 热更登记（machine 层语义：submitCode during running for arena）+ 歼灭结算
    m.submitCode('aa', { main: 'module.exports.loop = function () {}' })
    m.submitCode('ab', { main: 'module.exports.loop = function () {}' })
    m.start(0)
    m.submitCode('aa', { main: 'module.exports.loop = function () { console.log("v2") }' }, 500)
    expect(m.players[0]!.code).toMatchObject({ main: expect.stringContaining('v2') }) // 热更登记
    expect(m.phase).toBe('running')
    m.advance(60_000) // arena 无 roundBreak
    expect(m.phase).toBe('running')
    const decision = arenaSettleDecision({ aa: { spawns: 0, creeps: 2, rooms: 0, rclTotal: 0 }, ab: { spawns: 1, creeps: 4, rooms: 1, rclTotal: 1 } }, { aa: 1, ab: 3 })
    m.settle(decision!.reason, 1000, decision!.outcome)
    expect(m.state.settleReason).toBe('lastStanding')
    expect(m.state.winner).toEqual({ kind: 'seat', seatId: 'ab' })
    expect(m.state.scores).toEqual({ aa: 2, ab: 104 })

    // history 落账（复用现有链形状）
    const histDir = mkdtempSync(join(tmpdir(), 'm5-hist-'))
    const hist = new MatchHistory(histDir)
    hist.upsert({
      id: m.id,
      config: { seats: 2, roundMs: 60000, roundBreakTimeoutMs: 300000, maxRounds: 8 },
      winner: m.state.winner ?? null,
      settleReason: m.state.settleReason ?? null,
      scores: m.state.scores ?? null,
      roundIndex: m.state.roundIndex,
      createdAt: 0,
      settledAt: 100,
      seatUsers: { aa: ua.username, ab: ub.username },
      rooms: { aa: 'W15N15', ab: 'W14N15' },
      teardown: 'pending',
    })
    expect(hist.list()).toHaveLength(1)
    rmSync(histDir, { recursive: true, force: true })
  })
})
