/**
 * report 增强（M2 D 步）—— 纯函数：事件聚合 + 观察分层过滤 + console 报错提取。
 * 无 I/O，接 tools.ts 的 screeps_report。
 *
 * 观察分层（AGENTS.md 红线 = 防透视）：
 *   事件聚合只给「己方完整视图 ∪ 有游戏内视野的对手动向」——
 *   `attackerUser == 我 || targetUser == 我 || room 属于我`；
 *   room 属于我 = 保守近似（引擎真实可见 = 我有对象的房间，含 creep 攻入对方的瞬态；
 *   M2 不做引擎级精确化）。map-stats 级公开投影不在此层（那是公开战况）。
 *
 * console 报错帧形状（driver/lib/index.js L409 实测）：顶层 `{userId, error}`——
 * runner 内的 {type:'error'} 经 driver 转成 `publish(user:<uid>/console, {userId, error})`。
 */
import type { ArenaEvent, EventTick } from './match/attribution.ts'

/** 事件类型映射（引擎 constants.js L785-803 子集）。 */
const EVENT_ATTACK = 1
const EVENT_OBJECT_DESTROYED = 2

export interface EventSummary {
  /** 通过分层过滤的事件总数（Agent 视野内）。 */
  involved: number
  attack: number
  destroyed: number
  other: number
}

/** 把事件 ticks 拍平并带上 roomId（分层过滤需要房间归属）。 */
export interface RoomEvent {
  roomId: string
  ev: ArenaEvent
}

export function flattenEvents(events: EventTick[]): RoomEvent[] {
  const out: RoomEvent[] = []
  for (const tick of events) {
    for (const [roomId, list] of Object.entries(tick.eventsByRoom)) {
      for (const ev of list) out.push({ roomId, ev })
    }
  }
  return out
}

/** 观察分层过滤：只留「与我相关」的事件（攻击/被攻击/发生在我房间）。 */
export function filterPlayerEvents(events: RoomEvent[], myUserId: string | null, myRooms: ReadonlySet<string>): RoomEvent[] {
  return events.filter(({ roomId, ev }) => {
    if (myUserId !== null) {
      if (ev.attackerUser === myUserId || ev.targetUser === myUserId) return true
    }
    return myRooms.has(roomId)
  })
}

/** 聚合过滤后的事件为类型计数（一行摘要）。 */
export function summarizeEvents(events: RoomEvent[]): EventSummary {
  const summary: EventSummary = { involved: events.length, attack: 0, destroyed: 0, other: 0 }
  for (const { ev } of events) {
    if (ev.event === EVENT_ATTACK) summary.attack++
    else if (ev.event === EVENT_OBJECT_DESTROYED) summary.destroyed++
    else summary.other++
  }
  return summary
}

/** 从 console ring 帧里提取报错文本（driver 顶层 {userId, error} 帧；兜底 messages 内 error）。 */
export function extractConsoleErrors(lines: unknown[]): string[] {
  const out: string[] = []
  for (const entry of lines) {
    const frame = entry as { error?: unknown; messages?: unknown[] }
    if (typeof frame.error === 'string') {
      out.push(frame.error)
      continue
    }
    if (Array.isArray(frame.messages)) {
      for (const item of frame.messages) {
        const m = item as { type?: string; error?: unknown } | string
        if (typeof m === 'object' && m !== null && m.type === 'error' && typeof m.error === 'string') {
          out.push(m.error)
        } else if (typeof m === 'string' && /error/i.test(m)) {
          out.push(m)
        }
      }
    }
  }
  return out
}