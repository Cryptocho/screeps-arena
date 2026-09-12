/**
 * M3/D4 房间池分配（纯函数）——createMatch 守卫与席位→房间指派的唯一逻辑源。
 * 可用池 = ROOM_POOL − 在占房间（roomsSnapshot 是唯一在占事实源，含 journal 恢复局房间）。
 * teardown 在飞窗口内被拆房间仍在 snapshot → 瞬时拒绝可接受（D3，建局方重试）。
 */

export class RoomPoolExhaustedError extends Error {
  constructor(needed: number, available: string[], pool: string[]) {
    super(`room pool exhausted: need ${needed} room(s), available ${available.length} (pool: ${pool.join(',')})`)
    this.name = 'RoomPoolExhaustedError'
  }
}

/** 返回本局新增分配（已占席位复用原房间，不出现在结果中）；池不足抛 RoomPoolExhaustedError。 */
export function allocateRooms(
  pool: string[],
  assigned: Record<string, string>,
  seatIds: string[],
): Record<string, string> {
  const taken = new Set(Object.values(assigned))
  const available = pool.filter((room) => !taken.has(room))
  const unassigned = [...new Set(seatIds.filter((seatId) => !(seatId in assigned)))]
  if (unassigned.length > available.length) throw new RoomPoolExhaustedError(unassigned.length, available, pool)
  const result: Record<string, string> = {}
  let i = 0
  for (const seatId of unassigned) result[seatId] = available[i++]!
  return result
}
