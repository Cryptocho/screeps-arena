/**
 * M2/S6 地图公平性度量单测（纯函数）——map-fairness.md §决策平移：Σ(source→controller)
 * 距离偏离全体中位数超阈值 → 重掷（预算 ≤3，重掷编排逻辑在 RealArena.prepareRooms）。
 */
import { describe, expect, it } from 'vitest'
import { FAIRNESS_THRESHOLD, REROLL_BUDGET, fairnessDeviation, roomDistanceScore } from '../src/server/screeps/fairness.js'

describe('roomDistanceScore（Σ source→controller 曼哈顿距离）', () => {
  it('已知坐标求和', () => {
    expect(roomDistanceScore([{ x: 10, y: 10 }, { x: 40, y: 40 }], { x: 25, y: 25 })).toBe(15 + 15 + 15 + 15)
    expect(roomDistanceScore([{ x: 0, y: 0 }], { x: 3, y: 4 })).toBe(7)
    expect(roomDistanceScore([], { x: 5, y: 5 })).toBe(0)
  })
})

describe('fairnessDeviation（偏离全体中位数）', () => {
  it('奇数长度：中位数取中位元素', () => {
    expect(fairnessDeviation([10, 20, 30])).toBe(10) // median 20 → max|d-20|=10
  })

  it('偶数长度：中位数取均值', () => {
    expect(fairnessDeviation([10, 20])).toBe(5) // median 15
    expect(fairnessDeviation([10, 20, 30, 40])).toBe(15) // median 25
  })

  it('全体相等 → 0（公平）；空集 → 0', () => {
    expect(fairnessDeviation([7, 7, 7])).toBe(0)
    expect(fairnessDeviation([])).toBe(0)
  })

  it('阈值与预算为拍板常量（M2：阈值 10，预算 ≤3——spike 未给数值）', () => {
    expect(FAIRNESS_THRESHOLD).toBe(10)
    expect(REROLL_BUDGET).toBe(3)
  })
})
