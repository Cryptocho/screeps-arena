/**
 * S3 RealArena 单测（fake ScreepsService）——接口实现 + 公平边界断言。
 * 真实私服链路由 test:live 扩展覆盖（S6 冒烟）。
 */
import { describe, expect, it, vi } from 'vitest'
import { RealArena, visibleRooms } from '../src/server/screeps/arena.js'
import type { ScreepsService } from '../src/server/screeps/service.js'
import { seatSlug } from '../src/shared/seat-slug.js'

function fakeSvc(overrides: Partial<Record<string, any>> = {}): ScreepsService {
  return {
    system: vi.fn(async (cmd: string, value?: unknown) => {
      if (cmd === 'generateRoom') return { generated: true }
      if (cmd === 'getTickDuration') return { tickDuration: '100' }
      if (cmd === 'eventLog') return { events: [], cursor: typeof value === 'number' ? value : 0, bound: true }
      return { ok: true }
    }),
    createUser: vi.fn(async (input: { username: string }) => ({ id: 'u1', username: input.username })),
    submitCode: vi.fn(async () => ({ timestamp: 12345 })),
    getWorld: vi.fn(async () => ({
      ok: true,
      gameTime: 100,
      users: [
        { id: 'u1', username: 'agent_a', isBot: true, cpu: 100, gcl: 0, ownedRooms: 1, rclTotal: 1, spawns: 1, creeps: 2, rooms: [{ room: 'E5N5', level: 1, progress: 0 }] },
        { id: 'u2', username: 'agent_b', isBot: true, cpu: 100, gcl: 0, ownedRooms: 1, rclTotal: 1, spawns: 1, creeps: 0, rooms: [{ room: 'E7N5', level: 1, progress: 0 }] },
      ],
    })),
    getRoomObjects: vi.fn(async (room: string) =>
      room === 'E5N5'
        ? [{ type: 'controller', x: 10, y: 10, user: 'agent_a' }, { type: 'spawn', x: 11, y: 11, user: 'agent_a' }]
        : [{ type: 'controller', x: 10, y: 10, user: 'agent_b' }],
    ),
    consoleOutput: vi.fn(async (_u: string, since?: number) => ({ lines: since ? ['hello'] : [], cursor: 5, bound: true })),
    runConsoleAs: vi.fn(async () => 'ok'),
    restart: vi.fn(async (_o?: { resume?: boolean }) => {}),
    ...overrides,
  } as unknown as ScreepsService
}

describe('RealArena（S3）', () => {
  it('bindUser：惰性 prepareRooms（generateRoom+restart 一次）+ createUser + 映射落地；重复 bind 拒；无房拒', async () => {
    const svc = fakeSvc()
    const arena = new RealArena(svc, { rooms: { 'seat-a': 'E5N5' } })
    const user = await arena.bindUser('seat-a')
    expect(user.username).toBe(`agent_${seatSlug('seat-a')}`)
    expect(arena.resolveUser('seat-a')).toBe(user.username)
    expect(svc.system).toHaveBeenCalledWith('generateRoom', { room: 'E5N5', sources: 2 })
    expect(svc.restart).toHaveBeenCalledTimes(1)
    await arena.prepareRooms() // 幂等：已 prepare 早退，不再重启
    expect(svc.restart).toHaveBeenCalledTimes(1)
    await expect(arena.bindUser('seat-a')).rejects.toThrow('already bound')
    const arenaNoRoom = new RealArena(fakeSvc(), { rooms: {} })
    await expect(arenaNoRoom.bindUser('seat-x')).rejects.toThrow('no room assigned')
    // M2/S7：仅特殊字符不同的 seatId 不再同 username 碰撞
    const arena2 = new RealArena(fakeSvc(), { rooms: { 'a:b': 'E5N5', a_b: 'E7N5' } })
    const [u1, u2] = [await arena2.bindUser('a:b'), await arena2.bindUser('a_b')]
    expect(u1.username).not.toBe(u2.username)
  })

  it('submitCode：成功回 seq=timestamp；失败回 ok:false+reason（不抛）', async () => {
    const arena = new RealArena(fakeSvc(), { rooms: {} })
    const ok = await arena.submitCode('agent_seat-a', { main: 'module.exports.loop=function(){}' })
    expect(ok).toEqual({ ok: true, seq: 12345 })
    const fail = new RealArena(fakeSvc({ submitCode: async () => { throw new Error('boom') } }), { rooms: {} })
    const bad = await fail.submitCode('agent_seat-a', { main: 'x' })
    expect(bad).toEqual({ ok: false, reason: 'boom' })
  })

  it('report：fog 过滤——对手在自己房间（无视野）不出现在战报', async () => {
    const arena = new RealArena(fakeSvc(), { rooms: {} })
    const text = await arena.report('agent_a')
    // 己方完整视图
    expect(text).toContain('gameTime=100')
    expect(text).toContain('you: rooms=1')
    // 对手 E7N5 不在己方视野（E5N5）→ 不出现
    expect(text).not.toContain('E7N5')
    expect(text).not.toContain('agent_b')
    expect(text).toContain('visibleRooms: E5N5')
  })

  it('report：对手进入己方视野房间时出现（存在性，不透视细节）', async () => {
    const svc = fakeSvc({
      getRoomObjects: vi.fn(async (room: string) =>
        room === 'E5N5'
          ? [{ type: 'controller', x: 10, y: 10, user: 'agent_a' }, { type: 'creep', x: 20, y: 20, user: 'agent_b' }]
          : [],
      ),
    })
    // 对手 world 快照里 rooms 含 E5N5（creep 进入己方房不会改 controller 归属——
    // 真实语义里对手 creep 在我方房间 = 我方视野内；这里用 roomObjects 的 user 判定）
    const arena = new RealArena(svc, { rooms: {} })
    const text = await arena.report('agent_a')
    expect(text).toContain('visibleRooms: E5N5')
    // 对手 agent_b 的 creep 进入我方视野房 E5N5 → 出现（仅存在性，不含坐标/资源）
    expect(text).toContain('opponent agent_b units visible in your rooms')
  })

  it('visibleRooms：owned ∪ 己方对象所在房间（负向测试锚点）', () => {
    const v = visibleRooms(['E5N5'], [
      { room: 'E5N5', user: 'me', type: 'controller' },
      { room: 'E6N5', user: 'me', type: 'creep' },
      { room: 'E7N5', user: 'other', type: 'creep' },
      { room: 'E8N5', user: null, type: 'controller' },
    ], 'me')
    expect([...v].sort()).toEqual(['E5N5', 'E6N5'])
  })

  it('report：事件流 fog 过滤——无视野房间的事件不进战报（负向）', async () => {
    const svc = fakeSvc({
      system: vi.fn(async (cmd: string, value?: unknown) => {
        if (cmd === 'eventLog') {
          return {
            events: [
              { tick: 101, eventsByRoom: { E5N5: [{ event: 1, objectId: 'own1' }], E7N5: [{ event: 2, objectId: 'enemy1' }] } },
            ],
            cursor: 1,
            bound: true,
          }
        }
        if (cmd === 'generateRoom') return { generated: true }
        if (cmd === 'getTickDuration') return { tickDuration: '100' }
        return { ok: true }
      }),
    })
    const arena = new RealArena(svc, { rooms: {} })
    const text = await arena.report('agent_a')
    // 有视野房间 E5N5 的事件出现
    expect(text).toContain('event tick 101 room E5N5')
    // 无视野房间 E7N5 的事件一律剥离
    expect(text).not.toContain('room E7N5')
  })

  it('runConsole：官方通道 + ring 增量取回', async () => {
    const svc = fakeSvc()
    const arena = new RealArena(svc, { rooms: {} })
    const out = await arena.runConsole('agent_a', '1+1')
    expect(out).toBe('hello')
    expect(svc.runConsoleAs).toHaveBeenCalledWith('agent_a', '1+1')
  })

  it('consoleSince：游标推进（未传 since 用内部游标）', async () => {
    const arena = new RealArena(fakeSvc(), { rooms: {} })
    const p1 = await arena.consoleSince('agent_a')
    expect(p1.cursor).toBe(5)
    const p2 = await arena.consoleSince('agent_a')
    expect(p1.lines).toEqual([]) // 首次从 0 起
    expect(p2.lines).toEqual(['hello']) // since=5 → 有增量
  })
})
