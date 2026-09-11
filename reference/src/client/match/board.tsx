/**
 * 对局看板（S12 体验轮）：地图 + 统计 + console 流。
 *
 * 从 MatchView（会话 tab）抽出的公共组件，供中心列面板与会话 tab 复用。
 * 数据全部来自 host 公开桥（/dsh-screeps/*），**不依赖 session**——观战即全局。
 *
 * 地图渲染改进（S12 实测修正）：真实坐标缩放但格子有最小尺寸 + 网格线 + 房间名 /
 * 用户名标签 + 横向滚动——两格不再是小黑点。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ownerColor, roomWorldXY, terrainColors } from './projection.ts'
import { CodeView } from './code-view.tsx'

export interface LobbyMatch {
  id: string
  phase: string
  preset: string
  players: { sessionId: string; username: string; submitted?: boolean; ready?: boolean }[]
  createdAt: number
  /** M5 world-rounds：当前周期序号（0 起；非 rounds 局缺省）。 */
  roundIndex?: number
  /** M5 world-rounds：maxRounds（0/缺省 = 不限）。 */
  maxRounds?: number
}

interface WorldSnapshot {
  ok: boolean
  gameTime: number
  users: Array<{
    username: string
    ownedRooms: number
    rclTotal: number
    spawns: number
    rooms: Array<{ room: string; level: number; progress: number; spawns?: Array<{ x: number; y: number }> }>
  }>
}

interface MatchObservation {
  ok: boolean
  scoreboard?: Record<string, { score: number; territory: number; rclTotal: number }>
  gameTime?: number
}

interface ConsoleDelta {
  ok: boolean
  lines?: Array<{ user: string; text: string }>
  cursor?: Record<string, number>
  bound?: boolean
  error?: string
}

/** 状态徽标色（统一色板）。 */
const PHASE_META: Record<string, { color: string; label: string }> = {
  creating: { color: '#4a9eff', label: '创建中' },
  placing: { color: '#4a9eff', label: '布置中' },
  running: { color: '#3ddc84', label: '运行中' },
  paused: { color: '#ffb347', label: '已暂停' },
  roundBreak: { color: '#ffb347', label: '周期边界' },
  settled: { color: '#9aa', label: '已结算' },
  interrupted: { color: '#889', label: '已中断' },
}

export const ui = {
  row: { display: 'flex', alignItems: 'center', gap: 8 } as const,
  col: { display: 'flex', flexDirection: 'column', gap: 12 } as const,
  muted: { fontSize: 12, opacity: 0.7 } as const,
  card: { border: '1px solid rgba(128,128,128,0.25)', borderRadius: 6, padding: '8px 10px', background: 'rgba(128,128,128,0.06)' } as const,
  badge: (phase: string): CSSProperties => {
    const meta = PHASE_META[phase] ?? { color: '#aaa', label: phase }
    return {
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
      color: '#111', background: meta.color,
    }
  },
  btn: {
    padding: '6px 12px', borderRadius: 6, fontSize: 13, border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(128,128,128,0.12)', cursor: 'pointer',
  } as const,
  input: { padding: '6px 8px', borderRadius: 6, fontSize: 13, border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit' } as const,
}

/** 轮询一个 JSON 端点（no-store、in-flight guard、失败保留快照）。 */
export function usePollJson<T>(path: string, intervalMs: number): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined)
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        if (!res.ok) return
        const json = (await res.json()) as T
        if (alive) setData(json)
      } catch {
        // 失败保留最后快照
      } finally {
        inFlight.current = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [path, intervalMs])

  return data
}

/** 玩家卡片地图（S12 体验轮，默认视图）：按玩家横排卡片，固定大字，不按世界坐标铺开。
 *  每卡：色块 + 用户名 + 房间名 + RCL/进度。文本清晰（div 渲染非 canvas 缩放）。
 *  原因：世界坐标铺开在房间稀疏时画布拉长条、文字 5px 模糊——观战要的是"谁在哪个房"，
 *  不是坐标地图。M6：真坐标地图 + 地形作为第二个视图（CoordinateMap），默认仍是卡片。 */
function CardMap({ world }: { world: WorldSnapshot }): React.JSX.Element {
  const roomsByUser = new Map<string, WorldSnapshot['users'][number]['rooms']>()
  for (const u of world.users) {
    if (u.rooms.length > 0) roomsByUser.set(u.username, u.rooms)
  }
  const entries = [...roomsByUser.entries()]

  if (entries.length === 0) {
    return (
      <div style={{ ...ui.card, ...ui.muted, textAlign: 'center', padding: 20 }}>
        暂无房间数据（worldTime={world.gameTime}）
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
      {entries.map(([username, rooms]) => {
        const color = ownerColor(username)
        return (
          <div key={username} style={{ ...ui.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: color, flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: 14 }}>{username}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {rooms.map(r => (
                <div key={r.room} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ opacity: 0.85 }}>📍 {r.room}</span>
                  <span style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>
                    RCL {r.level}
                  </span>
                </div>
              ))}
            </div>
            {rooms.length > 0 && (
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                能量 {Math.round(rooms[0]!.progress)}%
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 坐标图常量：房间格边长（px）；房内 50×50 地形格 = ROOM_CELL/50。 */
const ROOM_CELL = 96

/** M6 坐标地图：地形（位域串逐格着色，离屏缓存按房）+ 归属色底/边框 + spawn ▲ + 房间名。
 *  降级：无 terrain 数据（拉取失败/未加载）→ 纯归属色块，地图永不白屏；
 *  jsdom 无 canvas 2D → getContext null-guard 跳过绘制，DOM 图例/房间名照常渲染。 */
function CoordinateMap({ world }: { world: WorldSnapshot }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 离屏地形层缓存（key = 房名|地形串长度——terrain 到位前后 key 不同，天然失效重画）。 */
  const terrainLayers = useRef(new Map<string, HTMLCanvasElement>())
  /** 已成功拉取的 roomsKey（成功钉住；失败随 world 轮询重试——plan-M6 §3.4）。 */
  const fetchedKeys = useRef(new Set<string>())
  const [terrain, setTerrain] = useState<Record<string, string>>({})

  const parsed = world.users.flatMap(u =>
    u.rooms.map(r => ({ room: r.room, owner: u.username, level: r.level, spawns: r.spawns ?? [] })),
  )
  const roomsKey = [...new Set(parsed.map(p => p.room))].sort().join(',')

  useEffect(() => {
    if (!roomsKey || fetchedKeys.current.has(roomsKey)) return
    let alive = true
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/dsh-screeps/terrain?rooms=${encodeURIComponent(roomsKey)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return
        const json = (await res.json()) as { terrain?: Record<string, string> }
        if (alive && json.terrain && Object.keys(json.terrain).length > 0) {
          fetchedKeys.current.add(roomsKey)
          setTerrain(prev => ({ ...prev, ...json.terrain }))
        }
      } catch {
        // 失败保留旧值，随 world 轮询（3s）重试
      }
    })()
    return () => {
      alive = false
    }
  }, [roomsKey, world.gameTime])

  // 绘制（world/terrain 变化触发；地形层离屏缓存，重绘只 drawImage + 叠标记）
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const bounds = parsed
      .map(p => roomWorldXY(p.room))
      .reduce(
        (acc, { x, y }) => ({
          minX: Math.min(acc.minX, x),
          minY: Math.min(acc.minY, y),
          maxX: Math.max(acc.maxX, x),
          maxY: Math.max(acc.maxY, y),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      )
    const cols = bounds.maxX - bounds.minX + 1
    const rows = bounds.maxY - bounds.minY + 1
    if (cols <= 0 || rows <= 0 || !Number.isFinite(cols)) return
    canvas.width = cols * ROOM_CELL
    canvas.height = rows * ROOM_CELL
    ctx.fillStyle = '#12151a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const sub = ROOM_CELL / 50
    for (const p of parsed) {
      const { x, y } = roomWorldXY(p.room)
      const ox = (x - bounds.minX) * ROOM_CELL
      const oy = (y - bounds.minY) * ROOM_CELL
      const color = ownerColor(p.owner)
      // 底：淡归属色（无地形数据时的降级观感 = 纯归属色块）
      ctx.globalAlpha = 0.25
      ctx.fillStyle = color
      ctx.fillRect(ox, oy, ROOM_CELL, ROOM_CELL)
      ctx.globalAlpha = 1
      // 地形层（离屏缓存）
      const terrainStr = terrain[p.room]
      const layerKey = `${p.room}|${terrainStr?.length ?? 0}`
      let layer = terrainLayers.current.get(layerKey)
      if (!layer) {
        layer = document.createElement('canvas')
        layer.width = ROOM_CELL
        layer.height = ROOM_CELL
        const lctx = layer.getContext('2d')
        if (lctx) {
          const colors = terrainColors(terrainStr)
          for (let i = 0; i < colors.length; i++) {
            const c = colors[i]!
            if (c === 'transparent') continue
            lctx.fillStyle = c
            lctx.fillRect((i % 50) * sub, Math.floor(i / 50) * sub, sub + 0.5, sub + 0.5)
          }
        }
        terrainLayers.current.set(layerKey, layer)
      }
      ctx.drawImage(layer, ox, oy)
      // 边框：归属色
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(ox + 1, oy + 1, ROOM_CELL - 2, ROOM_CELL - 2)
      // spawn 标记（▲）
      ctx.fillStyle = '#ffd54a'
      for (const s of p.spawns) {
        const sx = ox + (s.x / 50) * ROOM_CELL
        const sy = oy + (s.y / 50) * ROOM_CELL
        ctx.beginPath()
        ctx.moveTo(sx, sy - 6)
        ctx.lineTo(sx - 5, sy + 4)
        ctx.lineTo(sx + 5, sy + 4)
        ctx.closePath()
        ctx.fill()
      }
      // 房间名 + RCL（ROOM_CELL ≥ 22px 才画字——S12 可读性纪律）
      if (ROOM_CELL >= 22) {
        ctx.fillStyle = '#e8e8e8'
        ctx.font = '11px monospace'
        ctx.fillText(`${p.room} R${p.level}`, ox + 4, oy + 14)
      }
    }
  }, [parsed, terrain])

  return (
    <div>
      <div style={{ ...ui.muted, marginBottom: 4 }} data-testid='coords-legend'>
        图例：底色=归属 · 深灰=墙 · 蓝灰=沼泽 · ▲=spawn ｜ 房间：{roomsKey || '—'}
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 340 }}>
        <canvas ref={canvasRef} aria-label={`世界坐标地图（${roomsKey}）`} />
      </div>
    </div>
  )
}

/** 世界地图（双视图）：卡片（默认，S12 已验收）/ 坐标图（M6：地形 + spawn）。 */
function WorldMap({ matchId }: { matchId: string }): React.JSX.Element {
  const worldResp = usePollJson<{ ok: boolean; world?: WorldSnapshot }>('/dsh-screeps/world', 3000)
  const [view, setView] = useState<'cards' | 'coords'>('cards')
  const world = worldResp?.world

  if (!world || world.users.every(u => u.rooms.length === 0)) {
    return (
      <div style={{ ...ui.card, ...ui.muted, textAlign: 'center', padding: 20 }}>
        暂无房间数据（worldTime={world?.gameTime ?? '—'}）
      </div>
    )
  }

  return (
    <div data-match-id={matchId}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <button type='button' style={{ ...ui.btn, padding: '3px 10px', fontSize: 12, fontWeight: view === 'cards' ? 700 : 400 }} onClick={() => setView('cards')}>
          卡片
        </button>
        <button type='button' style={{ ...ui.btn, padding: '3px 10px', fontSize: 12, fontWeight: view === 'coords' ? 700 : 400 }} onClick={() => setView('coords')}>
          坐标图
        </button>
        <span style={{ ...ui.muted, marginLeft: 'auto' }}>worldTime={world.gameTime}</span>
      </div>
      {view === 'cards' ? <CardMap world={world} /> : <CoordinateMap world={world} />}
    </div>
  )
}

/** 比分表。 */
function ScoreTable({ matchId }: { matchId: string }): React.JSX.Element {
  const observeData = usePollJson<MatchObservation>(`/dsh-screeps/matches/${matchId}/observe`, 3000)
  const rows = Object.entries(observeData?.scoreboard ?? {})
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr>
          <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>玩家</th>
          <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>得分</th>
          <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>领地</th>
          <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>RCL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([player, row]) => (
          <tr key={player}>
            <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>{player}</td>
            <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>{row.score}</td>
            <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>{row.territory}</td>
            <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>{row.rclTotal}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr><td colSpan={4} style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', opacity: 0.6 }}>（暂无比分数据）</td></tr>
        )}
      </tbody>
    </table>
  )
}

/** console 增量流（逐用户游标 + 自动滚动到底）。 */
function ConsoleStream({ matchId }: { matchId: string }): React.JSX.Element {
  const [lines, setLines] = useState<Array<{ user: string; text: string }>>([])
  const cursorRef = useRef<Record<string, number> | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const preRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    setLines([])
    cursorRef.current = undefined
    setError(undefined)
    let alive = true
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const since = cursorRef.current === undefined ? undefined : encodeURIComponent(JSON.stringify(cursorRef.current))
        const url = since
          ? `/dsh-screeps/matches/${matchId}/console?since=${since}`
          : `/dsh-screeps/matches/${matchId}/console`
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        const json = (await res.json()) as ConsoleDelta
        if (!res.ok || !json.ok) {
          if (alive) setError(json.error ?? `HTTP ${res.status}`)
          return
        }
        if (alive) {
          if (json.lines && json.lines.length > 0) {
            setLines(prev => [...prev, ...json.lines!])
          }
          cursorRef.current = json.cursor
          setError(undefined)
        }
      } catch {
        // 失败保留快照
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [matchId])

  // 自动滚动到底
  useEffect(() => {
    const pre = preRef.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [lines])

  return (
    <div>
      <div style={{ ...ui.muted, marginBottom: 4 }}>
        控制台（{lines.length} 行）
        {error && <span style={{ color: '#e05' }}> · {error}</span>}
      </div>
      <pre ref={preRef} style={{
        background: 'rgba(0,0,0,0.4)',
        padding: 8,
        borderRadius: 6,
        fontSize: 11,
        maxHeight: 220,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        margin: 0,
      }}>
        {lines.length === 0
          ? '(等待输出…)'
          : lines.map((l, i) => (
              <div key={i}><span style={{ opacity: 0.6 }}>[{l.user}]</span> {l.text}</div>
            ))}
      </pre>
    </div>
  )
}

/** 完整看板：头部状态 + 地图 + 比分 + console。 */
export function MatchBoard({ match }: { match: LobbyMatch }): React.JSX.Element {
  const meta = PHASE_META[match.phase] ?? { color: '#aaa', label: match.phase }
  const isTerminal = match.phase === 'settled' || match.phase === 'interrupted'
  return (
    <div style={{ padding: 16, ...ui.col }}>
      <div style={ui.row}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{match.id.slice(-6)}</span>
        <span style={ui.badge(match.phase)}>{meta.label}</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>{match.preset}</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>
          {match.players
            .map(p => p.username + (p.ready === true ? ' ✅' : match.phase === 'roundBreak' ? ' ⏳' : ''))
            .join(' vs ') || '—'}
        </span>
        {/* M5 §3.6：周期进度（rounds 局才显示；maxRounds 0/缺省 = 不限） */}
        {match.roundIndex !== undefined && (
          <span style={{ fontSize: 12, opacity: 0.8 }}>
            周期 {match.roundIndex + 1}{match.maxRounds ? `/${match.maxRounds}` : ''}
          </span>
        )}
      </div>

      {match.phase === 'roundBreak' && (
        <div style={{ ...ui.card, background: 'rgba(255,179,71,0.12)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>⏸ 周期边界：世界已暂停</div>
          <div style={{ ...ui.muted, marginTop: 4 }}>
            各 Agent 查看战报并提交下轮代码（commit = 就绪 ✅）；全员就绪后自动续跑，超时未提交者沿用上一轮代码。
          </div>
        </div>
      )}

      {isTerminal && (
        <div style={{ ...ui.card, background: match.phase === 'interrupted' ? 'rgba(136,136,153,0.12)' : 'rgba(160,150,170,0.12)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {match.phase === 'interrupted' ? '⚠ 对局已中断（服务器重启打断）' : '🏁 对局已结算'}
          </div>
          <div style={{ ...ui.muted, marginTop: 4 }}>
            {match.phase === 'interrupted'
              ? '可查看最终快照；如需新对局，请先 settle 旧局或由大厅重新创建。'
              : '观战结束，可返回大厅查看历史。'}
          </div>
        </div>
      )}

      <WorldMap matchId={match.id} />
      <div>
        <div style={{ ...ui.muted, marginBottom: 4 }}>比分</div>
        <ScoreTable matchId={match.id} />
      </div>
      {/* M6：Agent 代码查看器（观战公开视角；客户端三件事收口） */}
      <CodeView matchId={match.id} usernames={match.players.map(p => p.username)} />
      <ConsoleStream matchId={match.id} />
    </div>
  )
}