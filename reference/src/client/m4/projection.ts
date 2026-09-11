/**
 * M4-E.1 — client 纯投影函数（bracket / replay / leaderboard）。
 *
 * 全部是纯函数：同一输入恒同一输出，直接单测打表。输入是 host 公开 DTO
 * （plan §7.1：Tournament endpoints 绝不返回 sessionId；replay 已 sanitize），
 * client 侧只消费公开形状，绝不把 HTTP 内部 DTO 塞进 browser state。
 */

/* ------------------------------ bracket 投影 ------------------------------ */

/** host GET /tournaments/:id/bracket 的公开形状（与 TournamentBracketView 对齐）。 */
export interface BracketSlotView {
  slotId: string
  round: number
  index: number
  participants: Array<{ participantId: string; displayName: string }>
  phase: string
  winner?: { participantId: string; displayName: string }
  attempts: Array<{ attempt: number; matchId?: string; replayId?: string; phase: string; winnerParticipantId?: string }>
  replayId?: string
  matchId?: string
}

export interface BracketRoundView {
  round: number
  slots: BracketSlotView[]
}

export interface BracketView {
  tournamentId: string
  phase: string
  seats: number
  participants: Array<{ participantId: string; displayName: string; seed: number }>
  rounds: BracketRoundView[]
  champion?: { participantId: string; displayName: string }
  currentSlotId?: string
  error?: string
}

/** bracket 列布局：round 升序 → 每轮槽位（HTML/SVG 纯投影用）。 */
export interface BracketColumn {
  round: number
  slots: BracketSlotView[]
}

export function projectBracketColumns(view: BracketView): BracketColumn[] {
  return view.rounds
    .slice()
    .sort((a, b) => a.round - b.round)
    .map(r => ({ round: r.round, slots: r.slots.slice().sort((a, b) => a.index - b.index) }))
}

/** 槽位胜负文案（公开 alias）：'p1 vs p2' / '🏆 p1' / '平局' / '待定'。 */
export function slotLabel(slot: BracketSlotView): string {
  const names = slot.participants.map(p => p.displayName)
  if (slot.winner) return `${names[0] ?? '?'} vs ${names[1] ?? '?'} → 🏆 ${slot.winner.displayName}`
  if (slot.phase === 'draw') return `${names[0] ?? '?'} vs ${names[1] ?? '?'} → 平局`
  return names.join(' vs ') || '待配对'
}

/** 槽位是否可进入回放（有 attempt 的 replayId）。 */
export function slotReplayId(slot: BracketSlotView): string | undefined {
  return slot.replayId ?? slot.attempts.find(a => a.replayId)?.replayId
}

/* ------------------------------ replay 投影 ------------------------------ */

/** host GET /matches/:id/replay 的公开形状（sanitized records）。 */
export interface ReplayRecordView {
  kind: 'frame' | 'gap'
  seq: number
  gameTime?: number
  fromTick?: number
  toTick?: number
  reason?: string
  /** frame 公开摘要（房间归属/事件计数；gap 无此字段）。 */
  frameSummary?: {
    rooms: Array<{ room: string; owner?: string; objectCount: number }>
    eventCount: number
  }
}

export interface ReplayPageView {
  matchId: string
  replayId?: string
  status: 'live' | 'complete' | 'partial'
  complete: boolean
  gapReasons: string[]
  nextCursor: number
  availableCount: number
  records: ReplayRecordView[]
  unavailable?: boolean
  reason?: string
}

/** 帧序列 → 播放时间线（frame 升序；gap 折叠为区间）。 */
export interface ReplayTimeline {
  /** 有序帧（按 seq）。 */
  frames: ReplayRecordView[]
  /** gap 区间（frame 之间的缺失段）。 */
  gaps: Array<{ fromTick: number; toTick: number; reason?: string }>
  /** 覆盖的 tick 范围（无帧则 undefined）。 */
  tickRange?: { from: number; to: number }
  /** 是否完整（complete=false 时播放器显示 banner）。 */
  complete: boolean
}

export function projectReplayTimeline(page: ReplayPageView): ReplayTimeline {
  const frames = page.records.filter(r => r.kind === 'frame')
  const gaps = page.records
    .filter((r): r is ReplayRecordView & { fromTick: number; toTick: number } => r.kind === 'gap' && r.fromTick !== undefined && r.toTick !== undefined)
    .map(g => ({ fromTick: g.fromTick, toTick: g.toTick, reason: g.reason }))
  const tickRange = frames.length > 0
    ? { from: Math.min(...frames.map(f => f.gameTime ?? 0)), to: Math.max(...frames.map(f => f.gameTime ?? 0)) }
    : undefined
  return { frames, gaps, tickRange, complete: page.complete }
}

/** seek 目标：afterTick → 第一个 gameTime >= target 的帧 seq（无则 undefined）。 */
export function seekSeq(frames: ReplayRecordView[], afterTick: number): number | undefined {
  const hit = frames.find(f => (f.gameTime ?? 0) >= afterTick)
  return hit?.seq
}

/* ------------------------------ leaderboard 投影 ------------------------------ */

export interface LeaderboardRowView {
  participantId: string
  displayName: string
  wins: number
  losses: number
  draws: number
  matches: number
  scoreTotal: number
  rank: number
}

export interface LeaderboardView {
  rows: LeaderboardRowView[]
  hasMore: boolean
}

/** 稳定排序（rank 升序；tie 保持 host 顺序）。 */
export function projectLeaderboard(page: { rows: LeaderboardRowView[]; hasMore: boolean }): LeaderboardView {
  return {
    rows: page.rows.slice().sort((a, b) => a.rank - b.rank),
    hasMore: page.hasMore,
  }
}