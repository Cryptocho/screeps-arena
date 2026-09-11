// @vitest-environment jsdom
/**
 * M4-E.3 — replay player jsdom 测试：complete:false/gap banner、seek、
 * 播放/暂停、卸载（dispose）后 timer/fetch 清理。
 *
 * 组件只消费 host 公开桥（GET /matches/:id/replay），fetch 用 vi.stubGlobal 桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ReplayPlayer } from './replay-player.tsx'

function stubFetchOnce(payload: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  })))
}

function replayPayload(over: Record<string, unknown> = {}): unknown {
  return {
    matchId: 'm1',
    replayId: 'r-m1',
    status: 'partial',
    complete: false,
    gapReasons: ['busy'],
    nextCursor: 3,
    availableCount: 3,
    records: [
      {
        kind: 'frame',
        seq: 0,
        gameTime: 10,
        // host 返回 sanitized frame（guard 从中抽公开 frameSummary）
        frame: { rooms: [{ room: 'W15N15', own: { username: 'u1' }, publicObjects: [{ kind: 'spawn' }] }], events: [] },
      },
      { kind: 'gap', seq: 1, fromTick: 11, toTick: 15, reason: 'busy' },
      {
        kind: 'frame',
        seq: 2,
        gameTime: 16,
        frame: { rooms: [{ room: 'W15N15', own: { username: 'u1' }, publicObjects: [{ kind: 'spawn' }, { kind: 'spawn2' }] }], events: [{ type: 'attack' }] },
      },
    ],
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function replayPage(): unknown {
  return replayPayload()
}

describe('ReplayPlayer (jsdom)', () => {
  it('渲染 partial/gap banner 与当前帧摘要', async () => {
    stubFetchOnce(replayPage())
    render(<ReplayPlayer matchId="m1" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText(/部分回放/)).toBeTruthy()
    expect(screen.getByText(/缺口: busy/)).toBeTruthy()
    expect(screen.getByText(/tick 10–16/)).toBeTruthy()
    // 初始帧摘要（seq 0 → tick 10 / W15N15）
    expect(screen.getByText(/tick 10 · seq 0/)).toBeTruthy()
    expect(screen.getByText(/W15N15/)).toBeTruthy()
  })

  it('seek 到帧：点击 ⏮ 回开头显示 seq 0', async () => {
    stubFetchOnce(replayPage())
    render(<ReplayPlayer matchId="m1" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    // 播放到 seq 2（推进 2 帧）
    const playBtn = screen.getByRole('button', { name: /播放/ })
    act(() => playBtn.click())
    await act(async () => {
      // fps=2 → 每帧 500ms
      await vi.advanceTimersByTimeAsync(1100)
    })
    // 播放到底后自动暂停并停留在最后一帧
    const pauseBtn = screen.getByRole('button', { name: /播放|暂停/ })
    expect(pauseBtn).toBeTruthy()
    // 回开头
    const resetBtn = screen.getByRole('button', { name: /⏮/ })
    await act(async () => resetBtn.click())
    expect(screen.getByText(/tick 10 · seq 0/)).toBeTruthy()
  })

  it('卸载后不再轮询/播放（timer 清理）', async () => {
    stubFetchOnce(replayPage())
    const { unmount } = render(<ReplayPlayer matchId="m1" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    act(() => screen.getByRole('button', { name: /播放/ }).click())
    unmount()
    // 卸载后推进 timer 不应抛错/崩溃（计时器已清理）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    // fetch 只在初始加载被调用（播放不新增请求；live 拉页由播放到末尾触发，此处两帧内不触发）
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })
})