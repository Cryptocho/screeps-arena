// @vitest-environment jsdom
/**
 * M6 — 代码查看器测试（plan-M6 §4-C）：
 * - guard 纯函数（strict 白名单，未知字段丢弃）；
 * - highlightJs 纯函数打表（注释/字符串/关键字/合并）；
 * - 组件 jsdom（玩家 tab / 版本列表 / 内容渲染 / 空态）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CodeView, formatTs, guardCodeEntry, guardCodeList, highlightJs, versionLabel } from './code-view.tsx'

// jsdom 可能缺 AbortSignal.timeout（usePollJson/组件 fetch 用）——防御性补齐
if (typeof AbortSignal.timeout !== 'function') {
  ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () => new AbortController().signal
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('guardCodeList / guardCodeEntry (strict DTO)', () => {
  it('keeps whitelisted meta only, drops empty players and unknown fields', () => {
    const view = guardCodeList({
      matchId: 'm1',
      players: [
        {
          username: 'alice',
          sessionId: 'sess-secret', // 未知字段 → 丢弃
          versions: [
            { seq: 1, ts: 5, username: 'alice', phase: 'creating', source: 'agent-submit', size: 10, modules: { main: 'x' }, extra: true },
            { noSeq: true }, // 无 seq → 丢
          ],
        },
        { username: 'bob', versions: [] }, // 空 versions → 玩家丢弃
        'garbage', // 非对象 → 丢
      ],
    })
    expect(view?.matchId).toBe('m1')
    expect(view?.players).toHaveLength(1)
    expect(view?.players[0]!.versions[0]).toEqual({ seq: 1, ts: 5, username: 'alice', phase: 'creating', source: 'agent-submit', size: 10 })
    expect(JSON.stringify(view)).not.toContain('sess-secret')
    expect(JSON.stringify(view)).not.toContain('modules')
  })

  it('guardCodeEntry keeps only string modules; rejects malformed', () => {
    const entry = guardCodeEntry({ username: 'a', seq: 2, ts: 1, phase: 'roundBreak', source: 'agent-submit', size: 4, modules: { main: 'ok', bad: 42 } })
    expect(entry?.modules).toEqual({ main: 'ok' })
    expect(entry?.roundIndex).toBeUndefined()
    expect(guardCodeEntry({ nope: true })).toBeUndefined()
    expect(guardCodeEntry({ username: 'a', seq: 'x', modules: {} })).toBeUndefined()
  })
})

describe('highlightJs (纯函数打表)', () => {
  it('colors keywords, strings and comments; string content stays string', () => {
    const spans = highlightJs(`const main = "hello function"; // tail comment`)
    const kinds = spans.map(s => s.kind)
    expect(kinds).toContain('keyword') // const
    expect(kinds).toContain('string') // "hello function"
    expect(kinds).toContain('comment') // // tail comment
    // 字符串内的 function 不产生 keyword 染色（整个字符串一个 span）
    const str = spans.find(s => s.text.includes('hello function'))
    expect(str?.kind).toBe('string')
  })

  it('block comments swallow everything until close (unterminated → to end)', () => {
    const spans = highlightJs('a /* hidden <script> "quote" still comment')
    const c = spans.find(s => s.kind === 'comment')
    expect(c?.text).toBe('/* hidden <script> "quote" still comment')
    expect(highlightJs('const x /* closed */ = 1').some(s => s.text === ' = 1' || s.text === '= 1')).toBe(true)
  })

  it('adjacent same-kind spans merge; escaped quotes inside strings', () => {
    expect(highlightJs('const')).toEqual([{ text: 'const', kind: 'keyword' }])
    const esc = highlightJs(`"a \\" b"`)
    expect(esc.filter(s => s.kind === 'string')).toHaveLength(1)
  })
})

describe('formatTs / versionLabel (纯函数)', () => {
  it('formats timestamp and version label', () => {
    expect(formatTs(0)).toBe('—')
    const d = new Date(2026, 0, 1, 9, 5, 3).getTime()
    expect(formatTs(d)).toBe('09:05:03')
    expect(versionLabel({ seq: 3, ts: d, username: 'a', phase: 'roundBreak', roundIndex: 1, source: 'agent-submit', size: 2048 })).toBe('#3 R2 提交 · 09:05:03 · 2.0KB')
    expect(versionLabel({ seq: 1, ts: d, username: 'a', phase: 'placing', source: 'start-injected', size: 47 })).toBe('#1 注入 · 09:05:03 · 47B')
  })
})

describe('CodeView (jsdom)', () => {
  const listDto = {
    ok: true,
    matchId: 'm1',
    players: [
      {
        username: 'alice',
        versions: [
          { seq: 1, ts: 5, username: 'alice', phase: 'creating', source: 'agent-submit', size: 30 },
          { seq: 2, ts: 6, username: 'alice', phase: 'roundBreak', roundIndex: 0, source: 'agent-submit', size: 40 },
        ],
      },
      { username: 'bob', versions: [{ seq: 3, ts: 7, username: 'bob', phase: 'placing', source: 'start-injected', size: 47 }] },
    ],
  }
  const entryDto = { ok: true, username: 'alice', seq: 2, ts: 6, phase: 'roundBreak', roundIndex: 0, source: 'agent-submit', size: 40, modules: { main: 'module.exports.loop = function () { return "round1" }' } }

  function stubFetch(): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async (path: string) => {
      if (path.endsWith('/code')) return { ok: true, json: async () => listDto }
      if (path.includes('/code/alice/')) return { ok: true, json: async () => entryDto }
      return { ok: false, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('renders player tabs, version list and content of the newest version', async () => {
    stubFetch()
    render(<CodeView matchId='m1' usernames={['alice', 'bob']} />)
    expect(screen.getByText('代码 · 提交记录（观战公开视角）')).toBeTruthy()
    // 时间展示与时区相关 → 用正则匹配结构（seq/周期/来源/大小）
    expect(await screen.findByText(/#2 R1 提交 · \d{2}:\d{2}:\d{2} · 40B/)).toBeTruthy()
    expect(screen.getByText(/#1 提交 · \d{2}:\d{2}:\d{2} · 30B/)).toBeTruthy()
    const pre = screen.getByTestId('code-content') as HTMLElement
    // 内容是 selected → fetch 的第二个异步回合 → waitFor 等它
    await vi.waitFor(() => {
      expect(pre.textContent).toContain('/* --- main --- */')
      expect(pre.textContent).toContain('round1')
    })
    // 关键字染色的 span 存在（function → color 样式）
    expect(pre.querySelector('span[style*="color"]')).not.toBeNull()
  })

  it('switching player tab fetches that player’s newest version', async () => {
    const mock = stubFetch()
    render(<CodeView matchId='m1' usernames={['alice', 'bob']} />)
    await screen.findByText(/#2 R1 提交/)
    mock.mockClear()
    const bobTab = screen.getAllByRole('button', { name: 'bob' }).at(-1)!
    bobTab.click()
    await vi.waitFor(() => {
      expect(mock).toHaveBeenCalledWith('/dsh-screeps/matches/m1/code/bob/3', expect.anything())
    })
  })

  it('shows empty state when there are no submissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, matchId: 'm1', players: [] }) })))
    render(<CodeView matchId='m1' usernames={['alice']} />)
    expect(await screen.findByText('该对局暂无代码提交记录')).toBeTruthy()
  })
})
