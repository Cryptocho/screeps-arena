// @vitest-environment jsdom
/**
 * M6 — 看板坐标地图 jsdom 测试（plan-M6 §4-E）：
 * - 视图切换（默认卡片，S12 体验零回归）；
 * - 坐标图 DOM 文本（图例 + 房间列表——canvas 像素 jsdom 不可断言）；
 * - jsdom 无 canvas 2D → null-guard 路径（组件不崩）。
 * MatchBoard 全量轮询（world/observe/console/code）→ fetch 统一按 path 分流。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MatchBoard, type LobbyMatch } from './board.tsx'

if (typeof AbortSignal.timeout !== 'function') {
  ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () => new AbortController().signal
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const match: LobbyMatch = {
  id: 'mmttest000000',
  phase: 'running',
  preset: 'world-rounds',
  players: [
    { sessionId: 'sess-a', username: 'e2e_a', submitted: true },
    { sessionId: 'sess-b', username: 'e2e_b', submitted: true },
  ],
  createdAt: 1,
  roundIndex: 1,
  maxRounds: 8,
}

function stubBoardFetch(): void {
  const world = {
    ok: true,
    world: {
      ok: true,
      gameTime: 5000,
      users: [
        { username: 'e2e_a', ownedRooms: 1, rclTotal: 1, spawns: 1, rooms: [{ room: 'W15N15', level: 1, progress: 0, spawns: [{ x: 25, y: 25 }] }] },
        { username: 'e2e_b', ownedRooms: 1, rclTotal: 1, spawns: 1, rooms: [{ room: 'W14N15', level: 1, progress: 0, spawns: [{ x: 24, y: 25 }] }] },
      ],
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path.startsWith('/dsh-screeps/world')) return { ok: true, json: async () => world }
      if (path.includes('/terrain')) {
        return {
          ok: true,
          json: async () => ({ ok: true, terrain: { W15N15: '1'.repeat(2500), W14N15: '1'.repeat(2500) } }),
        }
      }
      if (path.includes('/code')) return { ok: true, json: async () => ({ ok: true, matchId: match.id, players: [] }) }
      return { ok: false, json: async () => ({}) }
    }),
  )
}

describe('MatchBoard 世界地图视图切换 (jsdom)', () => {
  it('默认卡片视图（S12 零回归），可切到坐标图并渲染图例与房间列表', async () => {
    stubBoardFetch()
    render(<MatchBoard match={match} />)
    // 等 world 轮询落地（首次渲染是空态，按钮在 world 数据到达后才出现）
    expect(await screen.findByText(/📍 W15N15/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '卡片' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '坐标图' })).toBeTruthy()
    // 切坐标图 → 图例 + 房间列表（DOM 文本可断言；canvas 像素观感归 TEST.md 人工项）
    screen.getByRole('button', { name: '坐标图' }).click()
    const legend = await screen.findByTestId('coords-legend')
    expect(legend.textContent).toContain('图例')
    expect(legend.textContent).toContain('W14N15')
    expect(legend.textContent).toContain('W15N15')
    // canvas 元素存在且带 aria 标签（jsdom getContext 返回 null → 组件 null-guard 不崩）
    const canvas = document.querySelector('canvas[aria-label]')
    expect(canvas).not.toBeNull()
    expect(canvas!.getAttribute('aria-label')).toContain('世界坐标地图')
  })

  it('切换回卡片视图不崩（离屏缓存/terrain 拉取与卡片渲染互不干扰）', async () => {
    stubBoardFetch()
    render(<MatchBoard match={match} />)
    await screen.findByText(/📍 W15N15/)
    screen.getByRole('button', { name: '坐标图' }).click()
    await screen.findByTestId('coords-legend')
    screen.getByRole('button', { name: '卡片' }).click()
    expect(await screen.findByText(/📍 W14N15/)).toBeTruthy()
  })
})
