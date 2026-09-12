/**
 * M3/S5 stub IT（plan-M3 判据：双对局并存；成果审查阻塞 2）——真实 RealArena +
 * MatchMachine 装置（fake 私服），mock LLM 不参与：
 * ① 双对局并存、房间互不重叠（真实 roomsSnapshot 分配）；
 * ② 一局 settle 拆解后另一局完全不受影响（用户映射在、房间未被重建——无 generateRoom）；
 * ③ 拆解后全池可复用（新局拿到被拆房间的真实分配）；
 * ④ teardown 窗口内席位易主：releaseSeat 按 settle 快照跳过删除（不误删新对局）。
 * 真实私服链路由 test:live / m2-smoke 承担。
 */
import { describe, expect, it, vi } from 'vitest'
import { RealArena } from '../src/server/screeps/arena.js'
import { MatchMachine } from '../src/server/match/machine.js'
import { allocateRooms, assertSeatsFree } from '../src/server/pool.js'
import type { ScreepsService } from '../src/server/screeps/service.js'

const POOL = ['E5N5', 'E7N5', 'E9N5', 'E5N7']

function fakeSvc(): ScreepsService & { commands: Array<[string, unknown]> } {
  const commands: Array<[string, unknown]> = [] as Array<[string, unknown]>
  const base = {
    commands,
    system: vi.fn(async (cmd: string, value?: unknown) => {
      commands.push([cmd, value])
      if (cmd === 'generateRoom') return { generated: true }
      if (cmd === 'eventLog') return { events: [], cursor: 0, bound: true }
      return { ok: true }
    }),
    createUser: vi.fn(async (input: { username: string }) => ({ id: 'u-' + input.username, username: input.username })),
    submitCode: vi.fn(async () => ({ timestamp: 1 })),
    getWorld: vi.fn(async () => ({ ok: true, gameTime: 1, users: [] })),
    getRoomObjects: vi.fn(async () => []),
    consoleOutput: vi.fn(async () => ({ lines: [], cursor: 0, bound: true })),
    runConsoleAs: vi.fn(async () => 'ok'),
    restart: vi.fn(async () => {}),
  } as unknown as ScreepsService
  return Object.assign(base, { commands })
}

/** main.ts createMatch 同款流程（守卫 → 分配 → 机器 → watch 等价物）。 */
function createMatchOn(arena: RealArena, input: { players: Array<{ seatId: string; username: string }> }, activeSeats: () => string[]): MatchMachine {
  assertSeatsFree(activeSeats(), input.players.map((p) => p.seatId))
  const m = new MatchMachine({ players: input.players, onEvent: () => {} })
  for (const [seatId, room] of Object.entries(allocateRooms(POOL, arena.roomsSnapshot(), input.players.map((p) => p.seatId)))) {
    arena.assignRoom(seatId, room)
  }
  return m
}

describe('M3 双对局并存（stub IT，真实 RealArena）', () => {
  it('两局并存房间不重叠；settle 其一拆解后另一局不受影响；全池可复用', async () => {
    const svc = fakeSvc()
    const arena = new RealArena(svc, { rooms: {} })

    const machines = new Map<string, MatchMachine>()
    const activeSeats = () => [...machines.values()].flatMap((m) => m.players.map((p) => p.seatId))
    const m1 = createMatchOn(arena, { players: [{ seatId: 'a', username: 'a' }, { seatId: 'b', username: 'b' }] }, activeSeats)
    machines.set(m1.id, m1)
    const m2 = createMatchOn(arena, { players: [{ seatId: 'c', username: 'c' }, { seatId: 'd', username: 'd' }] }, activeSeats)
    machines.set(m2.id, m2)

    // 建号（真实 bindUser：prepareRooms 幂等补齐 + createUser）
    for (const seatId of ['a', 'b', 'c', 'd']) await arena.bindUser(seatId)

    // ① 房间互不重叠
    const snap = arena.roomsSnapshot()
    expect(new Set(Object.values(snap)).size).toBe(4)
    expect(snap).toEqual({ a: 'E5N5', b: 'E7N5', c: 'E9N5', d: 'E5N7' })

    // ② settle m1 → teardown（同 main.ts：快照 → releaseSeat(expected)）
    const generateCallsBefore = svc.commands.filter(([cmd]) => cmd === 'generateRoom').length
    const snap1 = {
      seatUsers: Object.fromEntries(['a', 'b'].map((s) => [s, arena.resolveUser(s)!])),
      rooms: Object.fromEntries(['a', 'b'].map((s) => [s, snap[s]!])),
    }
    m1.settle('manual', Date.now())
    machines.delete(m1.id)
    await arena.releaseSeat('a', { username: snap1.seatUsers.a, room: snap1.rooms.a })
    await arena.releaseSeat('b', { username: snap1.seatUsers.b, room: snap1.rooms.b })

    // m2 完全不受影响：映射在、房间在、无任何 generateRoom（防误重掷）
    expect(arena.resolveUser('c')).toMatch(/^agent_c/)
    expect(arena.resolveUser('d')).toMatch(/^agent_d/)
    expect(arena.roomsSnapshot()).toEqual({ c: 'E9N5', d: 'E5N7' })
    expect(svc.commands.filter(([cmd]) => cmd === 'generateRoom')).toHaveLength(generateCallsBefore)
    expect(svc.system).toHaveBeenCalledWith('removeUser', snap1.seatUsers.a)
    expect(svc.system).toHaveBeenCalledWith('removeRoom', 'E5N5')

    // ③ 拆解后全池可复用：新局拿到被拆房间（真实 roomsSnapshot 输入）
    const m3 = createMatchOn(arena, { players: [{ seatId: 'e', username: 'e' }, { seatId: 'f', username: 'f' }] }, activeSeats)
    expect(arena.roomsSnapshot()).toMatchObject({ e: 'E5N5', f: 'E7N5' })
    expect(m3.players).toHaveLength(2)

    // ④ teardown 窗口席位易主：expected 与当前映射不一致 → 跳过删除、保留新映射
    arena.restoreUser('z', 'agent_new')
    arena.assignRoom('z', 'E9N7')
    await arena.releaseSeat('z', { username: 'agent_old', room: 'E9N9' })
    expect(arena.resolveUser('z')).toBe('agent_new') // 未被 unbind 抹掉
    expect(arena.roomsSnapshot().z).toBe('E9N7')
    const removeUserTargets = svc.commands.filter(([cmd, v]) => cmd === 'removeUser' && v === 'agent_old')
    expect(removeUserTargets).toHaveLength(0)
  })
})
