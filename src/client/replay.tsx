/**
 * 战报与回放（M6/S4/S5，plan-M6 D6）——纯受控组件 + 可单测的投影纯函数。
 *
 * - BattleReport：summary 卡片 + scoreCurve 折线 + killTimeline + 内嵌回放控件；
 *   running 期 3s 轮询 `?frames=none`（只拉 meta+summary），settled 停；
 *   回放帧在用户首次操作（加载/播放/拖动）时才按窗口拉取。
 * - ReplayPlayer/ReplayCanvas：TerrainCanvas 抽帧版——按采样帧画单位位置 + 战斗闪烁标记；
 *   kills 的 x/y 缺省降级为房级色带（D1）；roundBreak 的 gap 不插值（时间轴自然分段）。
 * - 显示名：killer/owner/user 是 seatId/userId，统一经 summary.players 渲染，缺行落原始 id。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ReplayFrameView, ReplayKillView, ReplayObjectView, ReplayScoreView, ReplaySummaryView, ReplayView } from '../shared/types.js'
import { terrainBitAt } from '../shared/types.js'
import { fetchReplay, fetchTerrain } from './api.js'
import { terrainColor } from './terrain-canvas.js'

/* ---------------- 投影纯函数（单测锚点） ---------------- */

/** 显示名：seatId/userId → 「席位名（私服名）」；未映射 → 原始 id（不留白）。 */
export function seatLabel(players: ReplaySummaryView['players'], id: string | null): string {
  if (id === null) return '—'
  const p = players.find((x) => x.seatId === id)
  if (!p) return id
  return p.screepsUsername ? `${p.username} (${p.screepsUsername})` : p.username
}

/** 归属色：席位序 0 红 / 1 绿 / 其余灰（D6 的 killer 红绿口径）。 */
export function seatColorAt(index: number): string {
  return index === 0 ? '#e06060' : index === 1 ? '#60c060' : '#a0a0b0'
}

export function killColor(players: ReplaySummaryView['players'], id: string | null): string {
  const i = id === null ? -1 : players.findIndex((p) => p.seatId === id)
  return seatColorAt(i)
}

/** 位置帧对象归属色：userId → 席位序色（idmap 缺行 → 中性灰）。 */
export function objectColor(players: ReplaySummaryView['players'], userId: string | null): string {
  const i = userId === null ? -1 : players.findIndex((p) => p.screepsUserId === userId)
  return seatColorAt(i)
}

/** 曲线取最大计数（含 0 基线；空曲线 → 0）。 */
export function curveMax(curve: ReplaySummaryView['scoreCurve'], metric: keyof ReplayScoreView): number {
  let max = 0
  for (const c of curve) for (const s of Object.values(c.scores)) max = Math.max(max, Number(s[metric] ?? 0))
  return max
}

/** 折线点串（SVG polyline points）：i/(n-1) 横轴、值/最大值纵轴（max ≤ 0 → 贴底）。 */
export function sparkPoints(values: number[], width: number, height: number, max: number): string {
  if (values.length === 0) return ''
  if (values.length === 1) return `0,${height} ${width},${height}`
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width
      const y = max <= 0 ? height : height - (v / max) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

/** 一帧内的闪烁标记：有 x/y → 点位；缺省 → 房级色带（D1 降级）。 */
export function killMarkers(
  kills: ReplayKillView[],
  players: ReplaySummaryView['players'],
): Array<{ room: string; type: string; color: string; x?: number; y?: number }> {
  return kills.map((k) => {
    const m: { room: string; type: string; color: string; x?: number; y?: number } = {
      room: k.room,
      type: k.type,
      color: killColor(players, k.killer),
    }
    if (k.x !== undefined && k.y !== undefined) {
      m.x = k.x
      m.y = k.y
    }
    return m
  })
}

/** 帧回看：最后一个 gameTime ≤ t 的帧下标（采样非逐 tick；不插值）。 */
export function frameIndexAt(frames: ReplayFrameView[], gameTime: number): number {
  let idx = 0
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.gameTime <= gameTime) idx = i
    else break
  }
  return idx
}

/**
 * 位置保持：≤ idx 的最近一帧带 positions 的帧（D2 位置采样按秒节流，采样帧之间的
 * kills-only 帧若直接画空会闪烁；回放器保持最近位置，kills 仍按当前帧精确取）。
 */
export function positionsAt(frames: ReplayFrameView[], idx: number): Record<string, ReplayObjectView[]> | undefined {
  for (let i = Math.min(idx, frames.length - 1); i >= 0; i--) {
    const f = frames[i]
    if (f?.positions) return f.positions
  }
  return undefined
}

/* ---------------- 组件 ---------------- */

const ROOM_PX = 50

export interface ReplayPlayerProps {
  rooms: string[]
  terrain: Record<string, string>
  /** null = 帧尚未拉取（受控父组件决定何时加载）。 */
  frames: ReplayFrameView[] | null
  players: ReplaySummaryView['players']
  cellPx?: number
  onNeedFrames?: () => void
}

export function ReplayPlayer({ rooms, terrain, frames, players, cellPx = 3, onNeedFrames }: ReplayPlayerProps): ReactElement {
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const n = frames?.length ?? 0
  useEffect(() => {
    if (!playing || n === 0) return
    // 帧间按墙钟回放（采样节拍 1s/帧），速度倍数缩放
    const t = setInterval(() => setIdx((i) => (i + 1 >= n ? 0 : i + 1)), 1000 / speed)
    return () => clearInterval(t)
  }, [playing, speed, n])
  const frame = frames && n > 0 ? frames[Math.min(idx, n - 1)]! : null
  const positions = frames ? positionsAt(frames, idx) : undefined
  const first = frames && n > 0 ? frames[0]!.gameTime : 0
  const last = frames && n > 0 ? frames[n - 1]!.gameTime : 0
  return (
    <div style={{ marginTop: 8 }}>
      {frames === null ? (
        <button onClick={onNeedFrames} disabled={!onNeedFrames}>
          加载回放
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setPlaying((p) => !p)}>{playing ? '暂停' : '播放'}</button>
          <button onClick={() => setIdx(0)}>⏮</button>
          <input
            type="range"
            min={0}
            max={Math.max(0, n - 1)}
            value={idx}
            onChange={(e) => {
              setPlaying(false)
              setIdx(Number(e.target.value))
            }}
            style={{ width: 220 }}
            data-testid="replay-slider"
          />
          <small>
            frame {n === 0 ? 0 : idx + 1}/{n} · t{frame?.gameTime ?? 0}（{first}–{last}）· round {frame?.round ?? 0}
          </small>
          {[1, 4, 16].map((s) => (
            <button key={s} onClick={() => setSpeed(s)} disabled={speed === s}>
              {s}×
            </button>
          ))}
        </div>
      )}
      <ReplayCanvas rooms={rooms} terrain={terrain} positions={positions} kills={frame?.kills ?? []} players={players} cellPx={cellPx} />
    </div>
  )
}

export interface ReplayCanvasProps {
  rooms: string[]
  terrain: Record<string, string>
  /** 最近一次位置采样（回放器保持；缺席 = 尚无采样）。 */
  positions?: Record<string, ReplayObjectView[]>
  /** 当前帧的战斗事件（精确到帧）。 */
  kills: ReplayKillView[]
  players: ReplaySummaryView['players']
  cellPx?: number
}

export function ReplayCanvas({ rooms, terrain, positions, kills, players, cellPx = 3 }: ReplayCanvasProps): ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#11131a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const markers = killMarkers(kills, players)
    rooms.forEach((room, i) => {
      const t = terrain[room]
      const ox = (i % 4) * ROOM_PX * cellPx
      const oy = Math.floor(i / 4) * ROOM_PX * cellPx
      if (t) {
        for (let y = 0; y < ROOM_PX; y++) {
          for (let x = 0; x < ROOM_PX; x++) {
            ctx.fillStyle = terrainColor(terrainBitAt(t, x, y).wall, '#3d5a3d')
            ctx.fillRect(ox + x * cellPx, oy + y * cellPx, cellPx, cellPx)
          }
        }
      }
      for (const o of positions?.[room] ?? []) {
        // creep 小点 / 其他结构 2×2（user 归属色；null → 中性）
        const size = o.type === 'creep' ? cellPx : cellPx * 2
        ctx.fillStyle = objectColor(players, o.user)
        ctx.fillRect(ox + o.x * cellPx, oy + o.y * cellPx, size, size)
      }
      for (const m of markers) {
        if (m.room !== room) continue
        if (m.x !== undefined && m.y !== undefined) {
          ctx.fillStyle = m.color
          ctx.fillRect(ox + m.x * cellPx - 2, oy + m.y * cellPx - 2, cellPx + 4, cellPx + 4)
        } else {
          // 降级：房级色带（顶部 3px）
          ctx.fillStyle = m.color
          ctx.fillRect(ox, oy, ROOM_PX * cellPx, 3)
        }
      }
    })
  })
  const cols = Math.min(rooms.length, 4)
  const w = Math.max(1, cols) * ROOM_PX * cellPx
  const h = Math.max(1, Math.ceil(rooms.length / 4)) * ROOM_PX * cellPx
  return <canvas ref={ref} width={w} height={h} data-testid="replay-canvas" />
}

/** 计分曲线（SVG polyline；creeps/spawns 双线 × 双席 + 图例）。 */
export function ScoreCurve({ curve, players }: { curve: ReplaySummaryView['scoreCurve']; players: ReplaySummaryView['players'] }): ReactElement {
  const W = 320
  const H = 60
  const series: Array<{ label: string; color: string; values: number[]; dashed: boolean }> = []
  players.forEach((p, i) => {
    for (const metric of ['creeps', 'spawns'] as const) {
      series.push({
        label: `${seatLabel(players, p.seatId)} ${metric}`,
        color: seatColorAt(i),
        values: curve.map((c) => Number(c.scores[p.seatId]?.[metric] ?? 0)),
        dashed: metric === 'spawns',
      })
    }
  })
  const max = Math.max(curveMax(curve, 'creeps'), curveMax(curve, 'spawns'))
  return (
    <div>
      <svg width={W} height={H} style={{ background: '#0a0c12' }} data-testid="score-curve">
        {series.map((s, i) => (
          <polyline
            key={i}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            strokeDasharray={s.dashed ? '4 3' : undefined}
            points={sparkPoints(s.values, W, H, max)}
          />
        ))}
      </svg>
      <div style={{ fontSize: 11 }}>
        {series
          .filter((s) => s.label.endsWith('creeps'))
          .map((s, i) => (
            <span key={i} style={{ marginRight: 10, color: s.color }}>
              ■ {s.label}
            </span>
          ))}
        <span style={{ color: '#888' }}>（虚线 = spawns，同色）</span>
      </div>
    </div>
  )
}

function KillTimeline({ kills, players }: { kills: ReplayKillView[]; players: ReplaySummaryView['players'] }): ReactElement {
  return (
    <table cellPadding={3} style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th>tick</th>
          <th>击杀方</th>
          <th>损失方</th>
          <th>类型</th>
          <th>房</th>
          <th>坐标</th>
        </tr>
      </thead>
      <tbody>
        {kills.map((k, i) => (
          <tr key={i}>
            <td>{k.tick}</td>
            <td style={{ color: killColor(players, k.killer) }}>{seatLabel(players, k.killer)}</td>
            <td>{seatLabel(players, k.owner)}</td>
            <td>{k.type}</td>
            <td>{k.room}</td>
            <td>{k.x !== undefined ? `${k.x},${k.y}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export interface BattleReportProps {
  matchId: string
  /** 对局仍在进行（3s 轮询；settled 后停）。 */
  live?: boolean
}

export function BattleReport({ matchId, live = false }: BattleReportProps): ReactElement {
  const [view, setView] = useState<ReplayView | null>(null)
  const [frames, setFrames] = useState<ReplayFrameView[] | null>(null)
  const [terrain, setTerrain] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const viewRef = useRef<ReplayView | null>(null)
  const missingRef = useRef(false)

  useEffect(() => {
    let alive = true
    setView(null)
    setFrames(null)
    viewRef.current = null
    missingRef.current = false
    const load = async () => {
      try {
        const v = await fetchReplay(matchId, { frames: false })
        if (!alive) return
        if (v === null) {
          missingRef.current = true
          setError('无回放数据（该局没有 replay 文件）')
          return
        }
        setError(null)
        viewRef.current = v
        setView(v)
      } catch (err) {
        if (alive) setError(String(err instanceof Error ? err.message : err))
      }
    }
    void load()
    // running 期 3s 轮询 summary（frames=none：不含序列化/传输开销）；settled 停；
    // 已判 404 且非 live → 不再空转轮询
    const t = setInterval(() => {
      if (missingRef.current && !live) return
      if (!viewRef.current || viewRef.current.summary.partial) void load()
    }, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [matchId, live])

  useEffect(() => {
    if (!view) return
    const rooms = view.summary.rooms
    if (rooms.length === 0) return
    let alive = true
    void fetchTerrain(rooms)
      .then((t) => {
        if (alive) setTerrain(t)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [view])

  const loadFrames = async (): Promise<void> => {
    const v = await fetchReplay(matchId, { frames: true })
    if (v) setFrames(v.frames ?? [])
  }

  if (error) return <p style={{ color: '#e07070', fontSize: 12 }}>{error}</p>
  if (!view) return <p style={{ fontSize: 12 }}>加载战报…</p>
  const s = view.summary
  return (
    <div data-testid="battle-report">
      <h3 style={{ fontSize: 13 }}>战报 {s.partial ? <small style={{ color: '#c0a060' }}>[进行中]</small> : null}</h3>
      {s.incompleteAfterRestart && <small style={{ color: '#c0a060' }}>数据不完整（服务重启后续写，重启前的事件缺失） </small>}
      {s.eventsIncomplete && (
        <small style={{ color: '#e07070' }}>
          事件流不完整（ring 饱和）：容量 {s.eventsIncomplete.ringCapacity ?? '?'}，最后事件 tick {s.eventsIncomplete.lastEventTick ?? '?'}
        </small>
      )}
      <div style={{ fontSize: 12 }}>
        form {s.form} · rooms {s.rooms.join(' ')} · frames {s.frames}
        {s.settle ? ` · ${s.settle.settleReason} · ${winnerText(s.settle.winner, s.players)}` : ''}
      </div>
      <table cellPadding={3} style={{ fontSize: 12, marginTop: 6 }}>
        <thead>
          <tr>
            <th>席位</th>
            <th>击杀</th>
            <th>损失</th>
            <th>降解</th>
            <th>分</th>
          </tr>
        </thead>
        <tbody>
          {s.players.map((p) => (
            <tr key={p.seatId}>
              <td>{seatLabel(s.players, p.seatId)}</td>
              <td>{s.totals[p.seatId]?.kills ?? 0}</td>
              <td>{s.totals[p.seatId]?.losses ?? 0}</td>
              <td>{s.totals[p.seatId]?.decayLosses ?? 0}</td>
              <td>{s.settle?.scores?.[p.seatId] ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        <ScoreCurve curve={s.scoreCurve} players={s.players} />
      </div>
      <div style={{ marginTop: 8 }}>
        <h4 style={{ fontSize: 12 }}>击杀时间线（{s.killTimeline.length}）</h4>
        {s.killTimeline.length === 0 ? <small>无战斗事件</small> : <KillTimeline kills={s.killTimeline} players={s.players} />}
      </div>
      <ReplayPlayer rooms={s.rooms} terrain={terrain} frames={frames} players={s.players} onNeedFrames={() => void loadFrames()} />
      {live && s.partial ? <small style={{ color: '#888' }}>对局进行中——summary 每 3s 刷新</small> : null}
    </div>
  )
}

function winnerText(winner: unknown, players: ReplaySummaryView['players']): string {
  if (winner && typeof winner === 'object' && 'kind' in winner) {
    const w = winner as { kind: string; seatId?: string }
    if (w.kind === 'draw') return 'draw'
    if (w.kind === 'seat' && w.seatId) return `winner ${seatLabel(players, w.seatId)}`
  }
  return ''
}
