/**
 * arena 结算观察（M5/S3，plan-M5 D5）——kill 账本 + 结算决策，供 driver 的 form 感知
 * 观察分支每 tick 调用。对照 reference lifecycle.ts 的观察/终止语义裁剪：
 *   - 事件消费：eventLog 游标增量（**观察游标 host 侧独立**——与 RealArena.report 的
 *     per-user eventCursors 是同一 ring 的两套游标，不得复用席位游标）；
 *   - 归因：attribution.ts（同 tick ATTACK↔DESTROYED 匹配 → kills 归攻击方；无匹配
 *     的 DESTROYED 不计 combat loss，记 decayLosses——B1 订正语义）；
 *   - 结算判定：任一席 isDefeated('arena')（spawns==0）→ lastStanding；同 tick 双淘汰
 *     → 击杀分高者胜（kills−losses，平 → draw）；gameTime ≥ maxTicks → ticksExhausted
 *     按击杀分（基线 = started 时 gameTime 快照，不假设 gameTime 归零）；
 *   - ring 溢出（bound:false）→ 局 errors 警告（击杀分可能低估），不中断对局（[N4]）。
 * 纯逻辑 + 显式依赖注入，不碰网络；测试打表。
 */
import { attributeTick } from './attribution.js'
import type { ArenaEvent, EventTick } from './attribution.js'
import { isDefeated } from './score.js'
import type { SeatScoreInput } from './score.js'
import type { SettleReason, WinnerRef } from './model.js'

/** eventLog 单 tick 条目（与 attribution 共享形状）。 */
export type { EventTick, ArenaEvent }

/** 击杀账本：按 Screeps user id 累积 kills/losses/decayLosses；游标单飞归属观察侧。 */
export class KillLedger {
  /**
   * 事件游标 = eventLog 返回的 **ring 下标**（mod 契约：since=ring 下标非 tick 数值，
   * cursor=eventRing.length；host 侧独立——勿与席位 report 游标混用，n2）。
   * 一审阻塞 1 订正：此前误存 gameTime（tick 数值）→ 观察拍 since 越界被 mod 静默
   * 回退 0 → 整个 ring 每拍全量重消费，击杀分随拍数膨胀且新旧事件重消费倍率不对称，
   * 双淘汰/maxTicks 的击杀分比较可被翻转。
   */
  cursor = 0
  private readonly kills = new Map<string, number>()
  private readonly losses = new Map<string, number>()
  private readonly decayLosses = new Map<string, number>()
  /** 溢出标记（[N4]）：消费序列里出现过 bound:false → 击杀分可能低估。 */
  overflow = false

  /** 消费一批 eventLog tick（拍平 eventsByRoom → 归因 → 累积）；推进游标。 */
  consume(ticks: EventTick[]): void {
    for (const tick of ticks) {
      const flat: ArenaEvent[] = Object.values(tick.eventsByRoom ?? {}).flat()
      for (const a of attributeTick(flat)) {
        if (a.combat && a.killerUserId) {
          this.kills.set(a.killerUserId, (this.kills.get(a.killerUserId) ?? 0) + 1)
        }
        if (a.ownerUserId) {
          if (a.combat) {
            this.losses.set(a.ownerUserId, (this.losses.get(a.ownerUserId) ?? 0) + 1)
          } else {
            // B1：无 ATTACK 匹配的老死/自杀/回收/降解不计 combat loss（核对用计数）
            this.decayLosses.set(a.ownerUserId, (this.decayLosses.get(a.ownerUserId) ?? 0) + 1)
          }
        }
      }
    }
  }

  /** 权重 kills:1 / losses:1（plan-M5 D5：不做变体参数化）。 */
  score(userId: string | null): number {
    return userId ? (this.kills.get(userId) ?? 0) - (this.losses.get(userId) ?? 0) : 0
  }

  counts(userId: string | null): { kills: number; losses: number; decayLosses: number } {
    return {
      kills: userId ? (this.kills.get(userId) ?? 0) : 0,
      losses: userId ? (this.losses.get(userId) ?? 0) : 0,
      decayLosses: userId ? (this.decayLosses.get(userId) ?? 0) : 0,
    }
  }
}

export interface ArenaSettleDecision {
  reason: SettleReason
  outcome: { scores: Record<string, number>; winner: WinnerRef }
}

/**
 * 纯决策：给定双席快照（seatId → SeatScoreInput）+ 双席击杀分 → 结算决策或 undefined
 * （继续对局）。语义（D5）：
 *   - 恰一席 spawns==0 → lastStanding，winner=对手；
 *   - 双席同灭（对撞同尽）→ 击杀分高者胜，平 → draw；
 *   - 双席都活 → undefined（调用方再查 maxTicks）。
 * scores 用 displayScore（与 world 结算同面），击杀分另行比较（killScore 键不进 scores，
 * scores 形状与 world-rounds 一致供历史/前端复用）。
 */
export function arenaSettleDecision(
  snapshot: Record<string, SeatScoreInput | undefined>,
  killScore: Record<string, number>,
): ArenaSettleDecision | undefined {
  const seats = Object.keys(snapshot)
  if (seats.length === 0) return undefined
  const defeated = seats.filter((s) => isDefeated(snapshot[s] ?? { spawns: 0, creeps: 0, rooms: 0, rclTotal: 0 }, 'arena'))
  if (defeated.length === 0) return undefined
  const scores: Record<string, number> = {}
  for (const s of seats) {
    const v = snapshot[s]
    scores[s] = (v?.spawns ?? 0) * 100 + (v?.creeps ?? 0)
  }
  if (defeated.length === 1) {
    const winner = seats.find((s) => s !== defeated[0])
    if (!winner) return undefined
    return { reason: 'lastStanding', outcome: { scores, winner: { kind: 'seat', seatId: winner } } }
  }
  // 同 tick 双淘汰：击杀分高者胜（权重 kills:1/losses:1），平 → draw
  const ka = killScore[seats[0]!] ?? 0
  const kb = killScore[seats[1]!] ?? 0
  if (ka === kb) return { reason: 'lastStanding', outcome: { scores, winner: { kind: 'draw' } } }
  const winner = ka > kb ? seats[0]! : seats[1]!
  return { reason: 'lastStanding', outcome: { scores, winner: { kind: 'seat', seatId: winner } } }
}

/** maxTicks 兜底决策（D5）：gameTime ≥ startGameTime + maxTicks → 击杀分定胜负，平 → draw。 */
export function ticksExhaustedDecision(
  seats: [string, string],
  killScore: Record<string, number>,
  startGameTime: number,
  gameTime: number,
  maxTicks: number,
  snapshot: Record<string, SeatScoreInput | undefined>,
): ArenaSettleDecision | undefined {
  if (maxTicks <= 0 || gameTime < startGameTime + maxTicks) return undefined
  const scores: Record<string, number> = {}
  for (const s of seats) {
    const v = snapshot[s]
    scores[s] = (v?.spawns ?? 0) * 100 + (v?.creeps ?? 0)
  }
  const ka = killScore[seats[0]] ?? 0
  const kb = killScore[seats[1]] ?? 0
  if (ka === kb) return { reason: 'ticksExhausted', outcome: { scores, winner: { kind: 'draw' } } }
  return { reason: 'ticksExhausted', outcome: { scores, winner: { kind: 'seat', seatId: ka > kb ? seats[0]! : seats[1]! } } }
}
