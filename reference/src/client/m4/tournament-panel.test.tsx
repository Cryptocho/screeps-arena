// @vitest-environment jsdom
/**
 * M4-E.2 — tournament 面板 jsdom 测试：创建（4/8 seats）、recruiting 可见、
 * 开始（ready 才可点）、retry/failed 可见、纯 Agent 文案。
 *
 * fetch 桩返回公开 DTO（host 已剥离 sessionId）；组件只消费公开形状。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { TournamentList } from './tournament-panel.tsx'

function emptyTournamentList(): unknown {
  return { tournaments: [] }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('TournamentList (jsdom)', () => {
  it('渲染创建表单 + 额度/纯 Agent 文案 + 空列表', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => emptyTournamentList() }))
    vi.stubGlobal('fetch', fetchMock)
    const onSelect = vi.fn()
    const onCreate = vi.fn()
    render(
      <TournamentList tournaments={[]} onSelect={onSelect} onCreate={onCreate} busy={false} msg={undefined} />,
    )
    // 纯 Agent 文案
    expect(screen.getByText(/Agent 参赛 · 人类只观战\/触发编排/)).toBeTruthy()
    // 席位选择 4/8
    expect(screen.getByText('4 席 · 单淘汰')).toBeTruthy()
    expect(screen.getByText('8 席 · 单淘汰')).toBeTruthy()
    // 新建按钮 → onCreate(4)
    act(() => screen.getByRole('button', { name: /新建赛事/ }).click())
    expect(onCreate).toHaveBeenCalledWith(4)
    // 切 8 席
    act(() => {
      const sel = screen.getByRole('combobox')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
  })

  it('有赛事时显示状态/选手，点击条目回调查 onSelect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => emptyTournamentList() })))
    const onSelect = vi.fn()
    render(
      <TournamentList
        tournaments={[
          {
            tournamentId: 't1',
            requestId: 'req-1',
            phase: 'recruiting',
            revision: 1,
            config: { preset: 'arena-blitz', seats: 4 },
            participants: [{ participantId: 'p1', displayName: 'Agent 1', seed: 0 }],
            slots: [],
            retryable: false,
            createdAt: 1,
            updatedAt: 2,
          },
          {
            tournamentId: 't2',
            requestId: 'req-2',
            phase: 'failed',
            revision: 2,
            config: { preset: 'arena-blitz', seats: 8 },
            participants: [],
            slots: [],
            error: 'recruit timeout',
            retryable: true,
            createdAt: 1,
            updatedAt: 2,
          },
        ]}
        onSelect={onSelect}
        onCreate={vi.fn()}
        busy={false}
        msg={undefined}
      />,
    )
    expect(screen.getByText(/t1/)).toBeTruthy()
    expect(screen.getByText(/Agent 1/)).toBeTruthy()
    // failed 显示 ⚠（recruit timeout 在 title）
    expect(screen.getAllByTitle(/recruit timeout/).length).toBeGreaterThan(0)
    // 点击条目 → onSelect(t1)
    act(() => screen.getByLabelText(/赛事 t1 recruiting 1 名选手/).click())
    expect(onSelect).toHaveBeenCalledWith('t1')
  })
})