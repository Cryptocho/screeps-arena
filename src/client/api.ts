/** 前端 API 客户端（fetch + WS 订阅；不引状态库）。 */
import type { MatchView, ReplayView, WorldSnapshot } from '../shared/types.js'

/** 对局历史行（M3/S4，GET /api/history 投影）。replay = 回放文件可读（M6/D6 入口可用性）。 */
export interface HistoryView {
  id: string
  winner: { kind: string; seatId?: string } | null
  settleReason: string | null
  scores: Record<string, number> | null
  roundIndex: number
  createdAt: number
  settledAt: number | null
  teardown: string
  replay: boolean
}

export async function fetchHistory(): Promise<HistoryView[]> {
  const res = await fetch('/api/history')
  const body = (await res.json()) as { history: HistoryView[] }
  return body.history
}

/**
 * 回放查询（M6/S3）：frames=false → `?frames=none`（只回 meta+summary，running 期轮询用）；
 * from/to 由服务端裁剪。404 → null（入口禁用语义）。
 */
export async function fetchReplay(
  id: string,
  opts: { frames?: boolean; from?: number; to?: number } = {},
): Promise<ReplayView | null> {
  const q = new URLSearchParams()
  if (opts.frames === false) q.set('frames', 'none')
  if (opts.from !== undefined) q.set('from', String(opts.from))
  if (opts.to !== undefined) q.set('to', String(opts.to))
  const suffix = q.toString() === '' ? '' : `?${q.toString()}`
  const res = await fetch(`/api/replays/${encodeURIComponent(id)}${suffix}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`replay ${id}: HTTP ${res.status}`)
  return (await res.json()) as ReplayView
}

/** 锦标赛行（M4/D6，GET /api/tournaments 投影）。 */
export interface TournamentView {
  id: string
  name: string
  createdAt: number
  format: string
  participants: Array<{ seatId: string; username: string }>
  matches: Array<{
    pair: [string, string]
    status: string
    matchId?: string
    result?: { winner: string | null; scores: Record<string, number>; settledAt: number } | null
  }>
  finishedAt?: number | null
  errors: string[]
  standings: Array<{ seatId: string; username: string; played: number; wins: number; draws: number; losses: number; points: number; scoreDiff: number }>
}

export async function fetchTournaments(): Promise<TournamentView[]> {
  const res = await fetch('/api/tournaments')
  const body = (await res.json()) as { tournaments: TournamentView[] }
  return body.tournaments
}

export async function fetchMatches(): Promise<MatchView[]> {
  const res = await fetch('/api/matches')
  const body = (await res.json()) as { matches: MatchView[] }
  return body.matches
}

export async function fetchMatch(id: string): Promise<MatchView> {
  const res = await fetch(`/api/matches/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`match ${id}: HTTP ${res.status}`)
  return (await res.json()) as MatchView
}

export async function createMatch(input: {
  players: Array<{ seatId: string; username: string }>
  config?: Partial<MatchView['config']>
}): Promise<MatchView> {
  const res = await fetch('/api/matches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`create failed: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as MatchView
}

export async function startMatch(id: string): Promise<void> {
  const res = await fetch(`/api/matches/${encodeURIComponent(id)}/start`, { method: 'POST' })
  if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`)
}

export async function settleMatch(id: string): Promise<void> {
  const res = await fetch(`/api/matches/${encodeURIComponent(id)}/settle`, { method: 'POST' })
  if (!res.ok) throw new Error(`settle failed: HTTP ${res.status}`)
}

export async function fetchWorld(): Promise<WorldSnapshot> {
  const res = await fetch('/api/world')
  return (await res.json()) as WorldSnapshot
}

export async function fetchTerrain(rooms: string[]): Promise<Record<string, string>> {
  const res = await fetch(`/api/terrain?rooms=${encodeURIComponent(rooms.join(','))}`)
  const body = (await res.json()) as { terrain: Record<string, string> }
  return body.terrain
}

/** WS 订阅（对局状态流）。返回取消函数。 */
export function subscribeMatch(id: string, onMessage: (msg: Record<string, unknown>) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/matches/${encodeURIComponent(id)}`)
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as Record<string, unknown>)
    } catch {
      /* 坏帧丢弃 */
    }
  }
  return () => ws.close()
}

/**
 * WS console 订阅（M2/S2，替换 2s 轮询）。服务端 per-user 单定时器分发（内部游标），
 * 多订阅者不互吞；HTTP 降级口必须显式传 since，前端不再走 HTTP。
 */
export function subscribeConsole(
  id: string,
  user: string,
  onMessage: (msg: { lines: string[]; bound: boolean }) => void,
): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/matches/${encodeURIComponent(id)}`)
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe_console', user }))
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; user?: string; lines?: unknown[]; bound?: boolean }
      if (msg.type === 'console_lines' && msg.user === user && Array.isArray(msg.lines)) {
        onMessage({
          lines: msg.lines.filter((l): l is string => typeof l === 'string'),
          bound: msg.bound ?? true,
        })
      }
    } catch {
      /* 坏帧丢弃 */
    }
  }
  return () => {
    try {
      ws.send(JSON.stringify({ type: 'unsubscribe_console' }))
    } catch {
      /* 已关 */
    }
    ws.close()
  }
}
