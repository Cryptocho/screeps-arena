/**
 * M6/S4/S5 前端回放投影纯函数单测（受控组件设计的地基）：显示名映射、归属色、
 * 击杀标记降级（x/y 缺省 → 房级）、曲线取最大/折线点串、帧回看（不插值）。
 */
import { describe, expect, it } from 'vitest'
import { curveMax, frameIndexAt, killColor, killMarkers, objectColor, positionsAt, seatLabel, sparkPoints } from '../src/client/replay.js'
import type { ReplayFrameView, ReplaySummaryView } from '../src/shared/types.js'

const PLAYERS: ReplaySummaryView['players'] = [
  { seatId: 's1', username: 'alice', screepsUsername: 'agent_alice', screepsUserId: 'u1' },
  { seatId: 's2', username: 'bob', screepsUsername: null, screepsUserId: 'u2' },
]

describe('M6 战报投影纯函数', () => {
  it('seatLabel：席位名（私服名）；无私服名只给席位名；未映射落原始 id；null → —', () => {
    expect(seatLabel(PLAYERS, 's1')).toBe('alice (agent_alice)')
    expect(seatLabel(PLAYERS, 's2')).toBe('bob')
    expect(seatLabel(PLAYERS, 'ghost-user-id')).toBe('ghost-user-id')
    expect(seatLabel(PLAYERS, null)).toBe('—')
  })

  it('归属色：席位序 0 红 / 1 绿 / 未知或 null 灰（D6 红绿口径）', () => {
    expect(killColor(PLAYERS, 's1')).toBe('#e06060')
    expect(killColor(PLAYERS, 's2')).toBe('#60c060')
    expect(killColor(PLAYERS, 'nobody')).toBe('#a0a0b0')
    expect(killColor(PLAYERS, null)).toBe('#a0a0b0')
    // 位置帧对象按 screensUserId 反查同一色序
    expect(objectColor(PLAYERS, 'u2')).toBe('#60c060')
    expect(objectColor(PLAYERS, 'u9')).toBe('#a0a0b0')
  })

  it('killMarkers：有 x/y → 点位；缺省 → 房级（无 x/y 字段）', () => {
    const kills: ReplayFrameView['kills'] = [
      { tick: 10, killer: 's1', owner: 's2', type: 'creep', room: 'W15N15', x: 3, y: 4 },
      { tick: 10, killer: 's2', owner: 's1', type: 'unknown', room: 'W14N15' },
    ]
    expect(killMarkers(kills, PLAYERS)).toEqual([
      { room: 'W15N15', type: 'creep', color: '#e06060', x: 3, y: 4 },
      { room: 'W14N15', type: 'unknown', color: '#60c060' },
    ])
  })

  it('sparkPoints：单点/空/最大值 0 贴底；序列单调上升时起点在底、终点在顶', () => {
    expect(sparkPoints([], 100, 50, 10)).toBe('')
    expect(sparkPoints([5], 100, 50, 10)).toBe('0,50 100,50')
    expect(sparkPoints([0, 10], 100, 50, 10)).toBe('0.0,50.0 100.0,0.0')
    expect(sparkPoints([1, 2], 100, 50, 0)).toBe('0.0,50.0 100.0,50.0')
  })

  it('curveMax：跨席位/跨时刻取最大；空曲线 0', () => {
    const curve: ReplaySummaryView['scoreCurve'] = [
      { gameTime: 1, round: 0, scores: { s1: { creeps: 3, spawns: 1 } } },
      { gameTime: 2, round: 0, scores: { s1: { creeps: 2 }, s2: { creeps: 7 } } },
    ]
    expect(curveMax(curve, 'creeps')).toBe(7)
    expect(curveMax(curve, 'spawns')).toBe(1)
    expect(curveMax([], 'creeps')).toBe(0)
  })

  it('frameIndexAt：最后一个 gameTime ≤ t 的帧（采样非逐 tick；t 早于首帧取 0）', () => {
    const frames = [10, 20, 30].map((g) => ({ gameTime: g, round: 0, scores: {}, kills: [] }) as ReplayFrameView)
    expect(frameIndexAt(frames, 5)).toBe(0)
    expect(frameIndexAt(frames, 20)).toBe(1)
    expect(frameIndexAt(frames, 25)).toBe(1) // 不插值：落到前一采样帧
    expect(frameIndexAt(frames, 999)).toBe(2)
  })

  it('positionsAt：保持最近一次位置采样（kills-only 帧不闪空）；首帧前无采样 → undefined', () => {
    const p1 = { W15N15: [{ type: 'creep', x: 1, y: 2, user: 'u1', name: null, hits: null }] }
    const frames: ReplayFrameView[] = [
      { gameTime: 10, round: 0, scores: {}, kills: [] }, // 无 positions
      { gameTime: 12, round: 0, scores: {}, kills: [], positions: p1 },
      { gameTime: 13, round: 0, scores: {}, kills: [] }, // kills-only
    ]
    expect(positionsAt(frames, 0)).toBeUndefined()
    expect(positionsAt(frames, 1)).toBe(p1)
    expect(positionsAt(frames, 2)).toBe(p1) // 保持上一采样
  })
})
