/**
 * Replay sanitizer（M4-D.2）—— 把 host 收到的 canonical records 转成对外公开 DTO：
 * username（公开游戏昵称）映射为本赛事 participantId/displayName（plan §5.1：对外 frame
 * 不保留 username/sessionId/userId）。普通局（无 participant 映射）保留 username（它是公开
 * 昵称，非 host 私有；sessionId/userId 本就未进 frame）。
 *
 * 契约（测试钉死）：
 *   - frame.rooms[].own.username / rooms[].publicObjects[].username / events
 *     actorUsername/targetUsername 在映射存在时替换为 displayName；
 *   - 保留映射 = match.players 里 sessionId→(participantId,displayName)；
 *   - 无映射的 username 原样保留（普通 M3 局观战显示公开昵称）；
 *   - 不修改 seq/gameTime/rooms/status 等结构字段。
 */
import type { ReplayRecord } from './model.ts'

export interface ReplayNameMapping {
  /** username → displayName（公开投影）。 */
  byUsername: Map<string, string>
}

export function buildReplayNameMapping(
  players: Array<{ username: string; participantId?: string; displayName?: string }>,
): ReplayNameMapping {
  const byUsername = new Map<string, string>()
  for (const p of players) {
    if (p.participantId !== undefined) {
      byUsername.set(p.username, p.displayName ?? p.participantId)
    }
  }
  return { byUsername }
}

function mapName(mapping: ReplayNameMapping, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return mapping.byUsername.get(value) ?? value
}

/** 单条 record → 公开投影（返回新对象，不修改输入）。 */
export function sanitizeRecord(mapping: ReplayNameMapping, record: ReplayRecord): ReplayRecord {
  if (record.kind === 'gap') return record
  const frame = record.frame
  const rooms = frame.rooms.map(room => {
    const own = room.own === null || room.own === undefined ? null : { ...room.own, username: mapName(mapping, room.own.username)! }
    const publicObjects = room.publicObjects.map(obj =>
      obj.username !== undefined ? { ...obj, username: mapName(mapping, obj.username) } : obj,
    )
    return { ...room, own, publicObjects }
  })
  const events = frame.events.map(ev => ({
    ...ev,
    ...(ev.actorUsername !== undefined ? { actorUsername: mapName(mapping, ev.actorUsername) } : {}),
    ...(ev.targetUsername !== undefined ? { targetUsername: mapName(mapping, ev.targetUsername) } : {}),
  }))
  return { ...record, frame: { ...frame, rooms, events } }
}

/** 批量。 */
export function sanitizeRecords(mapping: ReplayNameMapping, records: ReplayRecord[]): ReplayRecord[] {
  return records.map(r => sanitizeRecord(mapping, r))
}
