/**
 * 真实计分（M2/S1，plan-M2 §2）——纯函数，不碰 fs / 网络 / 时钟。
 *
 * 规则来源（plan-M2 §1）：
 *   - 出局判定：world = spawns==0 且 creeps==0；arena = spawns==0
 *     （reference/AGENTS.md 玩法设计节 + 旧 M3 结论，平移复核）；
 *   - 一方出局 → 对方胜；双方同轮出局 → tiebreak：creeps → rooms → rclTotal
 *     （**M2 新增设计**，reference 无出处；顺序已经用户确认 2026-09-11）；仍平 → draw；
 *   - 无人出局（双活到 maxRounds 或 manual 提前收）→ draw，但 scores 保留真实计数。
 * 坐标/计数来源：`svc.getWorld()` → `world.users[]`（rooms/rclTotal/spawns/creeps），
 * 由组装层（main.ts 闭包）按 seatId → username 映射后转成 snapshot，本层不做映射。
 */
import type { WinnerRef } from './model.js'

/** 计分快照输入（world.users 同源字段；缺失席位按全 0 计 = 出局）。 */
export interface SeatScoreInput {
  spawns: number
  creeps: number
  rooms: number
  rclTotal: number
}

export interface SettleOutcome {
  scores: Record<string, number>
  winner: WinnerRef
}

const ZEROS: SeatScoreInput = { spawns: 0, creeps: 0, rooms: 0, rclTotal: 0 }

/** 出局判定。 */
export function isDefeated(s: SeatScoreInput, form: 'world' | 'arena' = 'world'): boolean {
  return form === 'world' ? s.spawns === 0 && s.creeps === 0 : s.spawns === 0
}

/** 展示分：spawns×100（防守）+ creeps（进攻）——保留真实计数，替换 M0 全 0。 */
export function displayScore(s: SeatScoreInput): number {
  return s.spawns * 100 + s.creeps
}

/** tiebreak 比较（a 严格强于 b 返回负数）。 */
export function tiebreakCompare(a: SeatScoreInput, b: SeatScoreInput): number {
  return b.creeps - a.creeps || b.rooms - a.rooms || b.rclTotal - a.rclTotal
}

/**
 * 快照 → 结算结果。snapshot keys = 对局席位（缺的席位按全 0 计）。
 * snapshot 为空（无席位）→ 空 scores + draw。
 */
export function computeOutcome(
  snapshot: Record<string, SeatScoreInput | undefined>,
  opts: { form?: 'world' | 'arena' } = {},
): SettleOutcome {
  const form = opts.form ?? 'world'
  const seatIds = Object.keys(snapshot)
  const scores: Record<string, number> = {}
  const alive: string[] = []
  for (const seat of seatIds) {
    const s = snapshot[seat] ?? ZEROS
    scores[seat] = displayScore(s)
    if (!isDefeated(s, form)) alive.push(seat)
  }
  if (alive.length === 1) return { scores, winner: { kind: 'seat', seatId: alive[0]! } }
  if (alive.length >= 2) return { scores, winner: { kind: 'draw' } }
  // 全员出局：tiebreak 全序排名，唯一最强者胜，并列第一 → draw
  const ranked = [...seatIds].sort((a, b) => tiebreakCompare(snapshot[a] ?? ZEROS, snapshot[b] ?? ZEROS))
  const top = ranked[0]
  const second = ranked[1]
  if (!top || !second) return { scores, winner: { kind: 'draw' } }
  const tied = tiebreakCompare(snapshot[top] ?? ZEROS, snapshot[second] ?? ZEROS) === 0
  return { scores, winner: tied ? { kind: 'draw' } : { kind: 'seat', seatId: top } }
}
