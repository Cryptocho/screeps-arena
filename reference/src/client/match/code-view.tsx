/**
 * M6 — 代码查看器（观战公开视角）：玩家 tab + 版本列表 + 内容视图。
 *
 * plan-M6 §3.3：挂在 MatchBoard（比分与 console 之间）。列表 5s 轮询（元数据，
 * 不含内容）；选中版本才 fetch 内容一次（不轮询）。渲染 = 等宽 pre + 行号 +
 * 极简 JS 高亮（highlightJs 纯函数，打表单测）。
 *
 * 公平边界（AGENTS）：这里是人类观战公开视角——Agent 主动提交的代码本身；
 * 对手代码对 **Agent 工具面** 仍不可见（观察分层不变）。DTO 经 guard 白名单收口
 * （对齐 m4/api.ts 模式：未知字段一律丢弃）。
 */
import { useEffect, useRef, useState } from 'react'
import { ui } from './board.tsx'

/* ------------------------------ DTO guard（strict 白名单） ------------------------------ */

export interface CodeVersionView {
  seq: number
  ts: number
  username: string
  phase: string
  roundIndex?: number
  source: string
  size: number
}

export interface CodeListView {
  matchId: string
  players: Array<{ username: string; versions: CodeVersionView[] }>
}

/** 列表 DTO guard（未知字段丢弃；players[].versions 只留白名单元数据）。 */
export function guardCodeList(raw: unknown): CodeListView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.matchId !== 'string' || !Array.isArray(o.players)) return undefined
  const players = o.players
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof p.username === 'string')
    .map(p => ({
      username: p.username as string,
      versions: (Array.isArray(p.versions) ? p.versions : [])
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof v.seq === 'number')
        .map(v => ({
          seq: v.seq as number,
          ts: typeof v.ts === 'number' ? v.ts : 0,
          username: typeof v.username === 'string' ? v.username : '',
          phase: typeof v.phase === 'string' ? v.phase : '',
          roundIndex: typeof v.roundIndex === 'number' ? v.roundIndex : undefined,
          source: typeof v.source === 'string' ? v.source : '',
          size: typeof v.size === 'number' ? v.size : 0,
        })),
    }))
    .filter(p => p.versions.length > 0)
  return { matchId: o.matchId, players }
}

export interface CodeContentView {
  username: string
  seq: number
  ts: number
  phase: string
  roundIndex?: number
  source: string
  size: number
  modules: Record<string, string>
}

/** 内容 DTO guard（只有 Agent 提交的代码本身；无 sessionId/token 的容身之处）。 */
export function guardCodeEntry(raw: unknown): CodeContentView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.username !== 'string' || typeof o.seq !== 'number' || typeof o.modules !== 'object' || o.modules === null) {
    return undefined
  }
  const modules: Record<string, string> = {}
  for (const [k, v] of Object.entries(o.modules as Record<string, unknown>)) {
    if (typeof v === 'string') modules[k] = v
  }
  return {
    username: o.username,
    seq: o.seq,
    ts: typeof o.ts === 'number' ? o.ts : 0,
    phase: typeof o.phase === 'string' ? o.phase : '',
    roundIndex: typeof o.roundIndex === 'number' ? o.roundIndex : undefined,
    source: typeof o.source === 'string' ? o.source : '',
    size: typeof o.size === 'number' ? o.size : 0,
    modules,
  }
}

/* ------------------------------ 极简 JS 高亮（纯函数） ------------------------------ */

export interface CodeSpan {
  text: string
  /** 三色语义：comment / string / keyword；undefined = 普通文本。 */
  kind?: 'comment' | 'string' | 'keyword'
}

const JS_KEYWORDS = new Set([
  'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'const', 'let', 'var', 'typeof', 'instanceof', 'new', 'delete', 'void', 'in', 'of', 'class',
  'extends', 'super', 'this', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally',
  'throw', 'async', 'await', 'yield', 'null', 'undefined', 'true', 'false',
])

/**
 * 极简单遍历 tokenize：注释（// 与 /* *\/）→ 字符串（' " `）→ 关键字 → 普通文本。
 * 不做嵌套语法树（观感足够；打表单测钉死边界：字符串内 keyword 不染色、注释吞掉一切）。
 */
export function highlightJs(src: string): CodeSpan[] {
  const spans: CodeSpan[] = []
  let i = 0
  const push = (text: string, kind?: CodeSpan['kind']): void => {
    if (text === '') return
    const last = spans[spans.length - 1]
    if (last && last.kind === kind) last.text += text
    else spans.push({ text, kind })
  }
  while (i < src.length) {
    const rest = src.slice(i)
    // 注释：// 到行尾；/* */ 到闭合（未闭合吞到尾）
    if (rest.startsWith('//')) {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      push(src.slice(i, stop), 'comment')
      i = stop
      continue
    }
    if (rest.startsWith('/*')) {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      push(src.slice(i, stop), 'comment')
      i = stop
      continue
    }
    // 字符串：' " `（反斜杠转义跳过）
    const q = rest[0]
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') j += 2
        else if (src[j] === q) {
          j++
          break
        } else if (q !== '`' && src[j] === '\n') break // 未闭合单/双行字符串到行尾止
        else j++
      }
      push(src.slice(i, j), 'string')
      i = j
      continue
    }
    // 标识符/关键字
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
    if (ident) {
      push(ident[0], JS_KEYWORDS.has(ident[0]) ? 'keyword' : undefined)
      i += ident[0].length
      continue
    }
    push(rest[0]!)
    i++
  }
  return spans
}

const SPAN_COLOR: Record<NonNullable<CodeSpan['kind']>, string> = {
  comment: '#6a9955',
  string: '#ce9178',
  keyword: '#569cd6',
}

/* ------------------------------ 组件 ------------------------------ */

const VERSION_POLL_MS = 5000

/** 时间戳 → HH:MM:SS（列表展示；纯函数便于断言）。 */
export function formatTs(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 版本列表行文案（周期号 + 来源 + 大小；纯函数便于断言）。 */
export function versionLabel(v: CodeVersionView): string {
  const round = v.roundIndex !== undefined ? `R${v.roundIndex + 1} ` : ''
  const source = v.source === 'start-injected' ? '注入' : '提交'
  const size = v.size >= 1024 ? `${(v.size / 1024).toFixed(1)}KB` : `${v.size}B`
  return `#${v.seq} ${round}${source} · ${formatTs(v.ts)} · ${size}`
}

export function CodeView({ matchId, usernames }: { matchId: string; usernames: string[] }): React.JSX.Element {
  const [list, setList] = useState<CodeListView | undefined>(undefined)
  const [selected, setSelected] = useState<{ username: string; seq: number } | undefined>(undefined)
  const [content, setContent] = useState<CodeContentView | undefined>(undefined)
  const inFlight = useRef(false)
  const latestRef = useRef<{ username: string; seq: number } | undefined>(undefined)

  // 列表轮询（5s，no-store、in-flight guard）
  useEffect(() => {
    let alive = true
    setList(undefined)
    setSelected(undefined)
    setContent(undefined)
    latestRef.current = undefined
    const tick = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await fetch(`/dsh-screeps/matches/${matchId}/code`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        if (!res.ok) return
        const view = guardCodeList(await res.json())
        if (alive && view) {
          setList(view)
          // 首次/有新版本时自动选中最前玩家的最新版本
          const first = view.players[0]
          const newest = first?.versions[0]
          if (newest && latestRef.current?.seq !== newest.seq) {
            latestRef.current = { username: newest.username, seq: newest.seq }
            setSelected({ username: newest.username, seq: newest.seq })
          }
        }
      } catch {
        // 失败保留快照
      } finally {
        inFlight.current = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), VERSION_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [matchId])

  // 选中版本 → 拉内容一次（不轮询）
  useEffect(() => {
    if (!selected) return
    let alive = true
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/dsh-screeps/matches/${matchId}/code/${encodeURIComponent(selected.username)}/${selected.seq}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return
        const view = guardCodeEntry(await res.json())
        if (alive && view) setContent(view)
      } catch {
        // 失败保留上次内容
      }
    })()
    return () => {
      alive = false
    }
  }, [matchId, selected])

  const activePlayer = list?.players.find(p => p.username === selected?.username)
  const source = content ? Object.entries(content.modules).map(([name, src]) => `/* --- ${name} --- */\n${src}`).join('\n\n') : undefined

  return (
    <div>
      <div style={{ ...ui.muted, marginBottom: 4 }}>代码 · 提交记录（观战公开视角）</div>
      {!list || list.players.length === 0 ? (
        <div style={{ ...ui.card, ...ui.muted }}>该对局暂无代码提交记录</div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* 玩家 tab */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {list.players.map(p => (
              <button
                key={p.username}
                type='button'
                style={{
                  ...ui.btn,
                  padding: '4px 10px',
                  fontWeight: selected?.username === p.username ? 700 : 400,
                }}
                onClick={() => {
                  const newest = p.versions[0]
                  if (newest) setSelected({ username: p.username, seq: newest.seq })
                }}
              >
                {p.username}
              </button>
            ))}
          </div>
          {/* 版本列表（最新在前） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto', minWidth: 210 }}>
            {(activePlayer?.versions ?? []).map(v => (
              <button
                key={v.seq}
                type='button'
                style={{
                  ...ui.btn,
                  padding: '3px 8px',
                  fontSize: 12,
                  background: selected?.seq === v.seq ? 'rgba(74,158,255,0.25)' : undefined,
                }}
                onClick={() => setSelected({ username: v.username, seq: v.seq })}
              >
                {versionLabel(v)}
              </button>
            ))}
          </div>
          {/* 内容视图（行号 + 极简高亮） */}
          <pre
            data-testid='code-content'
            style={{
              flex: 1,
              minWidth: 260,
              margin: 0,
              background: 'rgba(0,0,0,0.4)',
              padding: 8,
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.5,
              maxHeight: 260,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {source === undefined
              ? '（选择版本查看内容…）'
              : source.split('\n').map((line, idx) => (
                  <div key={idx}>
                    <span style={{ opacity: 0.4, userSelect: 'none', display: 'inline-block', minWidth: 28 }}>{idx + 1}</span>
                    {line === '' ? ' ' : highlightJs(line).map((span, i) => (
                      <span key={i} style={span.kind ? { color: SPAN_COLOR[span.kind] } : undefined}>{span.text}</span>
                    ))}
                  </div>
                ))}
          </pre>
        </div>
      )}
    </div>
  )
}
