/**
 * 地图公平性度量（M2/S6，plan-M2 §2）——纯函数。
 * 结论平移 reference/docs/spikes/map-fairness.md §决策：
 * World 用同参数房间（数量公平）+ 距离校验重掷；Arena 1v1 用 mod 镜像克隆（M3+）。
 * 度量 = 每房 Σ(source→controller) 曼哈顿距离，偏离全体中位数超阈值 → 重掷。
 * 阈值数值 spike 未给（只定了方法），M2 拍板 10；重掷预算 ≤3（spike 原文）。
 */

export interface RoomCoord {
  x: number
  y: number
}

/** Σ(source → controller) 曼哈顿距离。 */
export function roomDistanceScore(sources: RoomCoord[], controller: RoomCoord): number {
  return sources.reduce((sum, s) => sum + (Math.abs(s.x - controller.x) + Math.abs(s.y - controller.y)), 0)
}

/** 偏离全体中位数：max |d_i − median|。空集 → 0（单房无从比较，视为公平）。 */
export function fairnessDeviation(distances: number[]): number {
  if (distances.length === 0) return 0
  const sorted = [...distances].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return Math.max(...sorted.map((d) => Math.abs(d - median)))
}

export const FAIRNESS_THRESHOLD = 10
export const REROLL_BUDGET = 3
