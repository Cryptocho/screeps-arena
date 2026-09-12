/**
 * M3/D4 房间池分配纯函数打表（plan-M3 §3 S5 stub 部分）：
 * 多活跃对局、恢复局占池（roomsSnapshot 为唯一事实源）、teardown 瞬时拒绝语义。
 */
import { describe, expect, it } from 'vitest'
import { allocateRooms, RoomPoolExhaustedError } from '../src/server/pool.js'

describe('allocateRooms（M3/D4）', () => {
  const pool = ['E5N5', 'E7N5', 'E9N5', 'E5N7']

  it('空闲池：按序指派', () => {
    expect(allocateRooms(pool, {}, ['a', 'b'])).toEqual({ a: 'E5N5', b: 'E7N5' })
  })

  it('多活跃对局：已在占房间被扣减，新局拿到不重叠房间', () => {
    const assigned = { a: 'E5N5', b: 'E7N5' } // 对局 1 在占
    expect(allocateRooms(pool, assigned, ['c', 'd'])).toEqual({ c: 'E9N5', d: 'E5N7' })
  })

  it('池不足：拒绝（多活跃并存守卫 = 池可容纳）', () => {
    const assigned = { a: 'E5N5', b: 'E7N5', c: 'E9N5', d: 'E5N7' }
    expect(() => allocateRooms(pool, assigned, ['e'])).toThrow(RoomPoolExhaustedError)
  })

  it('恢复局占池：journal 恢复局房间在 snapshot 中即被扣（防新局撞房覆盖已发展世界）', () => {
    const assigned = { restoredA: 'E5N5', restoredB: 'E7N5' } // 恢复局（从未写 usedSeats 旁簿）
    expect(allocateRooms(pool, assigned, ['new1'])).toEqual({ new1: 'E9N5' })
  })

  it('teardown 在飞窗口：被拆房仍在 snapshot → 瞬时拒绝（D3：建局方重试）', () => {
    const assigned = { a: 'E5N5' } // settle 后 releaseSeat 未完成
    expect(() => allocateRooms(['E5N5'], assigned, ['x'])).toThrow(RoomPoolExhaustedError)
  })

  it('同席位重复出现在请求中：只占一房', () => {
    const result = allocateRooms(pool, {}, ['a', 'a'])
    expect(result).toEqual({ a: 'E5N5' })
  })
})
