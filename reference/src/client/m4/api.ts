/**
 * M4-E.1 — client API guard：只消费 host 公开 DTO，丢弃未知字段。
 *
 * plan §7.1：现有 M3 client 直轮询 `/matches` 原始形状，扩展前必须先接 strict
 * DTO guard，避免 settlement/journal/session 内部字段进入 browser state。
 * 这里统一收口 fetch + 白名单字段抽取（未知字段一律丢弃）。
 */

/** 轮询 JSON（no-store、in-flight guard、失败保留快照）——与 board.tsx 同款但带 guard。 */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | undefined> {
  try {
    const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5000), ...init })
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

/* ------------------------------ 公开 DTO 白名单（strict guard） ------------------------------ */

/** 普通 M3 match 的公开形状（sessionId 仅普通局保留——plan §7.1 兼容例外）。 */
export interface PublicMatchView {
  id: string
  phase: string
  preset: string
  players: Array<{ sessionId?: string; username: string; submitted?: boolean; ready?: boolean }>
  createdAt: number
  /** M5 world-rounds：当前周期序号（0 起；缺省非 rounds 局）。 */
  roundIndex?: number
  /** M5 world-rounds：maxRounds（0/缺省 = 不限；对局配置，公开可见）。 */
  maxRounds?: number
  /** M5 world-rounds：周期边界态只读提示（phase === 'roundBreak' 时由 board 渲染）。 */
  roundBreak?: boolean
}

/** 从任意 JSON 抽取公开字段（未知字段丢弃；缺省给安全空值）。 */
export function guardMatch(raw: unknown): PublicMatchView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.phase !== 'string') return undefined
  const players = Array.isArray(o.players)
    ? o.players
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map(p => ({
          // sessionId 仅普通 M3 保留（信任边界文档化）；tournament 局无此字段
          sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
          username: typeof p.username === 'string' ? p.username : '',
          submitted: p.submitted === true ? true : undefined,
          // M5 world-rounds：周期边界是否已 commit（公开就绪状态，与 submitted 同级）
          ready: p.ready === true ? true : undefined,
        }))
    : []
  return {
    id: o.id,
    phase: o.phase,
    preset: typeof o.preset === 'string' ? o.preset : 'unknown',
    players,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    roundIndex: typeof o.roundIndex === 'number' ? o.roundIndex : undefined,
    // M5：maxRounds 在 config 里（对局配置公开可见；0/缺省 = 不限）
    maxRounds:
      typeof (o.config as Record<string, unknown> | undefined)?.maxRounds === 'number'
        ? ((o.config as Record<string, unknown>).maxRounds as number)
        : undefined,
    roundBreak: o.phase === 'roundBreak' ? true : undefined,
  }
}

export function guardMatchList(raw: unknown): PublicMatchView[] {
  if (typeof raw !== 'object' || raw === null) return []
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.matches)) return []
  return o.matches.map(guardMatch).filter((m): m is PublicMatchView => m !== undefined)
}

/** tournament 公开视图（绝不含 sessionId——host 已剥离，client 再 guard 一次）。 */
export interface PublicTournamentView {
  tournamentId: string
  requestId: string
  phase: string
  revision: number
  config?: {
    preset: string
    seats: number
    maxAttempts?: number
    tickDuration?: number
    model?: string
    provider?: string
  }
  participants: Array<{ participantId: string; displayName: string; seed: number }>
  slots: Array<{
    slotId: string
    round: number
    index: number
    participantIds: [string, string]
    phase: string
    winnerParticipantId?: string
    attempts: Array<{ attempt: number; matchId?: string; replayId?: string; phase: string }>
  }>
  currentSlotId?: string
  championParticipantId?: string
  error?: string
  retryable: boolean
  createdAt: number
  updatedAt: number
}

export function guardTournament(raw: unknown): PublicTournamentView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.tournamentId !== 'string') return undefined
  const participants = Array.isArray(o.participants)
    ? o.participants
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map(p => ({
          participantId: typeof p.participantId === 'string' ? p.participantId : '',
          displayName: typeof p.displayName === 'string' ? p.displayName : '',
          seed: typeof p.seed === 'number' ? p.seed : 0,
        }))
    : []
  const slots = Array.isArray(o.slots)
    ? o.slots
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map(s => ({
          slotId: typeof s.slotId === 'string' ? s.slotId : '',
          round: typeof s.round === 'number' ? s.round : 0,
          index: typeof s.index === 'number' ? s.index : 0,
          participantIds: Array.isArray(s.participantIds) && s.participantIds.length === 2
            ? [String(s.participantIds[0]), String(s.participantIds[1])] as [string, string]
            : ['', ''] as [string, string],
          phase: typeof s.phase === 'string' ? s.phase : 'pending',
          winnerParticipantId: typeof s.winnerParticipantId === 'string' ? s.winnerParticipantId : undefined,
          attempts: Array.isArray(s.attempts)
            ? s.attempts
                .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
                .map(a => ({
                  attempt: typeof a.attempt === 'number' ? a.attempt : 0,
                  matchId: typeof a.matchId === 'string' ? a.matchId : undefined,
                  replayId: typeof a.replayId === 'string' ? a.replayId : undefined,
                  phase: typeof a.phase === 'string' ? a.phase : 'pending',
                }))
            : [],
        }))
    : []
  return {
    tournamentId: o.tournamentId,
    requestId: typeof o.requestId === 'string' ? o.requestId : '',
    phase: typeof o.phase === 'string' ? o.phase : 'recruiting',
    revision: typeof o.revision === 'number' ? o.revision : 0,
    config: typeof o.config === 'object' && o.config !== null
      ? {
          preset: typeof (o.config as Record<string, unknown>).preset === 'string' ? String((o.config as Record<string, unknown>).preset) : 'arena-blitz',
          seats: typeof (o.config as Record<string, unknown>).seats === 'number' ? Number((o.config as Record<string, unknown>).seats) : 4,
          maxAttempts: typeof (o.config as Record<string, unknown>).maxAttempts === 'number' ? Number((o.config as Record<string, unknown>).maxAttempts) : 2,
          tickDuration: typeof (o.config as Record<string, unknown>).tickDuration === 'number' ? Number((o.config as Record<string, unknown>).tickDuration) : undefined,
          model: typeof (o.config as Record<string, unknown>).model === 'string' ? String((o.config as Record<string, unknown>).model) : undefined,
          provider: typeof (o.config as Record<string, unknown>).provider === 'string' ? String((o.config as Record<string, unknown>).provider) : undefined,
        }
      : undefined,
    participants,
    slots,
    currentSlotId: typeof o.currentSlotId === 'string' ? o.currentSlotId : undefined,
    championParticipantId: typeof o.championParticipantId === 'string' ? o.championParticipantId : undefined,
    error: typeof o.error === 'string' ? o.error : undefined,
    retryable: o.retryable === true,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  }
}

export function guardTournamentList(raw: unknown): PublicTournamentView[] {
  if (typeof raw !== 'object' || raw === null) return []
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.tournaments)) return []
  return o.tournaments.map(guardTournament).filter((t): t is PublicTournamentView => t !== undefined)
}

/** GET /tournaments/:id 响应是 {ok, tournament:{...}}——先解包再 guard。 */
export function guardTournamentDetail(raw: unknown): PublicTournamentView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  return guardTournament(o.tournament)
}

/** replay 页公开形状（sanitized records）。 */
export interface PublicReplayPage {
  matchId: string
  replayId?: string
  status: 'live' | 'complete' | 'partial'
  complete: boolean
  gapReasons: string[]
  nextCursor: number
  availableCount: number
  records: Array<{
    kind: 'frame' | 'gap'
    seq: number
    gameTime?: number
    fromTick?: number
    toTick?: number
    reason?: string
    /** frame 公开摘要（只保留房间归属/事件计数，不碰内部字段）。 */
    frameSummary?: {
      rooms: Array<{ room: string; owner?: string; objectCount: number }>
      eventCount: number
    }
  }>
  unavailable?: boolean
  reason?: string
}

/** 从 sanitized frame 里抽公开摘要（host 已 sanitize，这里再白名单一层）。 */
function guardFrameSummary(raw: unknown): PublicReplayPage['records'][number]['frameSummary'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const f = raw as Record<string, unknown>
  const rooms = Array.isArray(f.rooms)
    ? f.rooms
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map(r => ({
          room: typeof r.room === 'string' ? r.room : '',
          owner: typeof r.own === 'object' && r.own !== null && typeof (r.own as Record<string, unknown>).username === 'string'
            ? ((r.own as Record<string, unknown>).username as string)
            : undefined,
          objectCount: Array.isArray(r.publicObjects) ? r.publicObjects.length : 0,
        }))
    : []
  const eventCount = Array.isArray(f.events) ? f.events.length : 0
  return { rooms, eventCount }
}

export function guardReplayPage(raw: unknown): PublicReplayPage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.matchId !== 'string') return undefined
  if (o.unavailable === true) {
    return {
      matchId: o.matchId,
      unavailable: true,
      reason: typeof o.reason === 'string' ? o.reason : undefined,
      status: 'partial',
      complete: false,
      gapReasons: [],
      nextCursor: 0,
      availableCount: 0,
      records: [],
    }
  }
  const records = Array.isArray(o.records)
    ? o.records
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map(r => ({
          kind: r.kind === 'gap' ? ('gap' as const) : ('frame' as const),
          seq: typeof r.seq === 'number' ? r.seq : 0,
          gameTime: typeof r.gameTime === 'number' ? r.gameTime : undefined,
          fromTick: typeof r.fromTick === 'number' ? r.fromTick : undefined,
          toTick: typeof r.toTick === 'number' ? r.toTick : undefined,
          reason: typeof r.reason === 'string' ? r.reason : undefined,
          frameSummary: guardFrameSummary(r.frame),
        }))
    : []
  return {
    matchId: o.matchId,
    replayId: typeof o.replayId === 'string' ? o.replayId : undefined,
    status: o.status === 'complete' || o.status === 'partial' || o.status === 'live' ? o.status : 'live',
    complete: o.complete === true,
    gapReasons: Array.isArray(o.gapReasons) ? o.gapReasons.filter((g): g is string => typeof g === 'string') : [],
    nextCursor: typeof o.nextCursor === 'number' ? o.nextCursor : 0,
    availableCount: typeof o.availableCount === 'number' ? o.availableCount : 0,
    records,
  }
}

/** leaderboard 公开形状。 */
export interface PublicLeaderboardPage {
  rows: Array<{
    participantId: string
    displayName: string
    wins: number
    losses: number
    draws: number
    matches: number
    scoreTotal: number
    rank: number
  }>
  hasMore: boolean
}

export function guardLeaderboard(raw: unknown): PublicLeaderboardPage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.leaderboard !== 'object' || o.leaderboard === null) return undefined
  const lb = o.leaderboard as Record<string, unknown>
  const rows = Array.isArray(lb.rows)
    ? lb.rows
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map(r => ({
          participantId: typeof r.participantId === 'string' ? r.participantId : '',
          displayName: typeof r.displayName === 'string' ? r.displayName : '',
          wins: typeof r.wins === 'number' ? r.wins : 0,
          losses: typeof r.losses === 'number' ? r.losses : 0,
          draws: typeof r.draws === 'number' ? r.draws : 0,
          matches: typeof r.matches === 'number' ? r.matches : 0,
          scoreTotal: typeof r.scoreTotal === 'number' ? r.scoreTotal : 0,
          rank: typeof r.rank === 'number' ? r.rank : 0,
        }))
    : []
  return {
    rows,
    hasMore: lb.hasMore === true,
  }
}