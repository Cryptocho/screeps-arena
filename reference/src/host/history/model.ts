/**
 * 历史比分模型（M4-B.1）—— MatchResult 不可变记录、canonical resultHash、leaderboard 聚合、
 * 公开 redaction。纯数据/纯函数，不碰 fs/网络（HistoryStore 在 B.3 消费这些）。
 *
 * 语义（plan-M4 §6.2，测试钉死）：
 *   - MatchResult 主键固定 resultId=matchId；每个 rematch attempt 单独一条 result；
 *   - 只有 commit 成功的 settled attempt 进入公开历史/榜单；put 在 commit 之前 → abort 路径
 *     可能留下孤儿 result：不可变不删除，标 diagnostics:'settlement-aborted'，不计入 leaderboard、
 *     不出现在公开 history DTO；
 *   - 两次 draw 都是 settled attempt：matches++/draws++，不增加 wins/losses；
 *   - leaderboard 只聚合带 participantId 的赛事结果（普通 M3 match 无 participantId，不进榜）；
 *   - participantId 是公开历史身份；displayName 是赛事内快照，重名不合并；
 *   - tie rank 共享 + hasMore，limit 按稳定排序截断，不把并列组拦腰切开。
 *
 * resultHash 字段集（plan §3.2，固定这组，不允许把 MatchState 私有字段塞进 MatchResult）：
 *   { resultId, tournamentId?, slotId?, attempt?, preset, phase,
 *     winner: {kind, participantId?}, scores, participantSnapshot, kills, losses,
 *     endTick, replayCompleteness }
 */
import type { MatchPreset, MatchState, SettlementJournal } from '../match/model.ts'
import { hashV1 } from '../canonical.ts'

export type HistoryDiagnostics = 'settlement-aborted'

export interface ResultPlayerSnapshot {
  /** 赛事参与者公开身份；普通 M3 match 无 participantId。 */
  participantId?: string
  /** 赛事内 alias 快照。 */
  displayName?: string
  /** host 私有会话 id；公开 DTO 必须剥离。 */
  sessionId?: string
  /** host 生成的 Screeps username；公开 DTO 按投影规则处理（赛事侧不保留）。 */
  username?: string
}

export type ResultWinner =
  | { kind: 'participant'; participantId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'draw' }

export interface MatchResult {
  /** = matchId。 */
  resultId: string
  tournamentId?: string
  slotId?: string
  attempt?: 0 | 1
  preset: MatchPreset
  /** 只有 commit 成功的 result 为 settled；abort 孤儿保留 settled + diagnostics（不可变不删）。 */
  phase: 'settled'
  winner: ResultWinner
  /** key：赛事 = participantId；普通局 = sessionId（host 内部）。 */
  scores: Record<string, number>
  participantSnapshot: ResultPlayerSnapshot[]
  /** key 同 scores。 */
  kills: Record<string, number>
  losses: Record<string, number>
  endTick: number
  replayCompleteness?: 'complete' | 'partial'
  replayId?: string
  scoreWarning?: string
  diagnostics?: HistoryDiagnostics
  createdAt: number
}

/** canonical resultHash（hashVersion=1）：history marker 与 tournament receipt 共享同一份哈希来源。 */
export function toResultHash(result: MatchResult): string {
  const winner = result.winner.kind === 'participant'
    ? { kind: 'participant' as const, participantId: result.winner.participantId }
    : result.winner.kind === 'draw'
      ? { kind: 'draw' as const }
      : { kind: 'session' as const }
  const payload: Record<string, unknown> = {
    resultId: result.resultId,
    preset: result.preset,
    phase: result.phase,
    winner,
    scores: result.scores,
    participantSnapshot: result.participantSnapshot,
    kills: result.kills,
    losses: result.losses,
    endTick: result.endTick,
  }
  if (result.tournamentId !== undefined) payload.tournamentId = result.tournamentId
  if (result.slotId !== undefined) payload.slotId = result.slotId
  if (result.attempt !== undefined) payload.attempt = result.attempt
  if (result.replayCompleteness !== undefined) payload.replayCompleteness = result.replayCompleteness
  return hashV1(payload)
}

/**
 * 从 committed MatchState + journal 构造 MatchResult（M4-B；唯一构造点——history put 与
 * tournament gateway apply 共用同一对象/同一 resultHash）。
 *
 * key 语义（plan §6.2）：赛事局 scores/kills/losses 用 participantId；普通局用 sessionId。
 * winner：赛事局 → participant（session 经 participantMapping 映射）；普通局 → session/draw。
 * participantSnapshot：sessionId/username/participantId/displayName（快照不可变）。
 */
export function buildMatchResult(match: MatchState, journal: SettlementJournal): MatchResult {
  const isTournament = match.tournamentId !== undefined
  const sessionByParticipant = new Map<string, string>()
  for (const mp of journal.participantMapping) {
    if (mp.participantId !== undefined) sessionByParticipant.set(mp.participantId, mp.sessionId)
  }
  const key = (sessionId: string): string => {
    if (isTournament) {
      const found = journal.participantMapping.find(mp => mp.sessionId === sessionId)
      if (!found?.participantId) throw new Error(`buildMatchResult: session ${sessionId} has no participantId in tournament match`)
      return found.participantId
    }
    return sessionId
  }
  const scores: Record<string, number> = {}
  for (const [sid, v] of Object.entries(journal.scores)) scores[key(sid)] = v
  const kills: Record<string, number> = {}
  for (const [sid, v] of Object.entries(journal.kills)) kills[key(sid)] = v
  const losses: Record<string, number> = {}
  for (const [sid, v] of Object.entries(journal.losses)) losses[key(sid)] = v

  let winner: ResultWinner
  const w = journal.winner
  if (w.kind === 'draw') {
    winner = { kind: 'draw' }
  } else if (isTournament) {
    const pid = journal.participantMapping.find(mp => mp.sessionId === w.id)?.participantId
    if (!pid) throw new Error(`buildMatchResult: winner session ${w.id} missing participantId`)
    winner = { kind: 'participant', participantId: pid }
  } else {
    winner = { kind: 'session', sessionId: w.id }
  }

  const participantSnapshot: ResultPlayerSnapshot[] = journal.participantMapping.map(mp => ({
    ...(mp.participantId !== undefined ? { participantId: mp.participantId } : {}),
    ...(mp.displayName !== undefined ? { displayName: mp.displayName } : {}),
    sessionId: mp.sessionId,
    username: mp.username,
  }))

  const result: MatchResult = {
    resultId: match.id,
    ...(match.tournamentId !== undefined ? { tournamentId: match.tournamentId } : {}),
    ...(match.tournamentSlotId !== undefined ? { slotId: match.tournamentSlotId } : {}),
    ...(match.attempt !== undefined ? { attempt: match.attempt } : {}),
    preset: match.config.preset,
    phase: 'settled',
    winner,
    scores,
    kills,
    losses,
    participantSnapshot,
    endTick: journal.endTick,
    ...(journal.replay.completeness !== undefined ? { replayCompleteness: journal.replay.completeness } : {}),
    ...(journal.replay.receipt?.replayId !== undefined ? { replayId: journal.replay.receipt.replayId } : {}),
    ...(match.scoreWarning !== undefined ? { scoreWarning: match.scoreWarning } : {}),
    createdAt: Date.now(),
  }
  return result
}

/* ------------------------------ leaderboard ------------------------------ */

export interface LeaderboardRow {
  participantId: string
  displayName: string
  wins: number
  losses: number
  draws: number
  matches: number
  scoreTotal: number
  kills: number
  lossesTaken: number
  /** 1-based；tie（scoreTotal+wins 相等）共享同一 rank。 */
  rank: number
}

export interface LeaderboardPage {
  rows: LeaderboardRow[]
  hasMore: boolean
}

export interface LeaderboardOptions {
  /** 只聚合该赛事 participantId 的结果。 */
  tournamentId?: string
  /** 稳定排序截断；并列组共享 rank，hasMore=true。 */
  limit?: number
}

function addOrInit(map: Map<string, LeaderboardRow>, pid: string, displayName: string): LeaderboardRow {
  let row = map.get(pid)
  if (!row) {
    row = {
      participantId: pid,
      displayName,
      wins: 0,
      losses: 0,
      draws: 0,
      matches: 0,
      scoreTotal: 0,
      kills: 0,
      lossesTaken: 0,
      rank: 0,
    }
    map.set(pid, row)
  }
  return row
}

/**
 * leaderboard 纯聚合（plan §6.2）：
 *   - 输入只取 settled 且无 'settlement-aborted' diagnostics 的赛事结果（带 participantId）；
 *   - 每 attempt 每个参赛 participant：matches++；winner → wins++；draw → 双方 draws++；
 *     loser → losses++；scores/kills/losses 按 participantId 聚合；
 *   - 排序固定 scoreTotal desc, wins desc, participantId asc；rank 按 (scoreTotal,wins)
 *     tie 共享；limit 截断不切并列组，剩余用 hasMore 表达。
 */
export function aggregateLeaderboard(results: readonly MatchResult[], opts: LeaderboardOptions = {}): LeaderboardPage {
  const rows = new Map<string, LeaderboardRow>()
  const displayNameById = new Map<string, string>()

  for (const result of results) {
    if (result.diagnostics === 'settlement-aborted') continue
    if (opts.tournamentId !== undefined && result.tournamentId !== opts.tournamentId) continue
    const byPid = result.participantSnapshot.filter(p => p.participantId !== undefined)
    if (byPid.length === 0) continue // 普通 M3 result 不进榜
    for (const snap of byPid) {
      displayNameById.set(snap.participantId!, snap.displayName ?? snap.participantId!)
    }
    if (result.winner.kind === 'participant') {
      addOrInit(rows, result.winner.participantId, displayNameById.get(result.winner.participantId) ?? result.winner.participantId).wins += 1
    } else if (result.winner.kind === 'draw') {
      for (const snap of byPid) {
        addOrInit(rows, snap.participantId!, displayNameById.get(snap.participantId!) ?? snap.participantId!).draws += 1
      }
    } else {
      continue // kind='session' 不可能出现在带 participantId 的结果里（防呆）
    }
    // matches/score/kills/losses 按参与者聚合；won 时另一名参与者计 losses
    for (const snap of byPid) {
      const row = addOrInit(rows, snap.participantId!, displayNameById.get(snap.participantId!) ?? snap.participantId!)
      row.matches += 1
      row.scoreTotal += result.scores[snap.participantId!] ?? 0
      row.kills += result.kills[snap.participantId!] ?? 0
      row.lossesTaken += result.losses[snap.participantId!] ?? 0
      if (result.winner.kind === 'participant' && result.winner.participantId !== snap.participantId) {
        row.losses += 1
      }
    }
  }

  const sorted = [...rows.values()].sort((a, b) => {
    if (b.scoreTotal !== a.scoreTotal) return b.scoreTotal - a.scoreTotal
    if (b.wins !== a.wins) return b.wins - a.wins
    return a.participantId.localeCompare(b.participantId)
  })

  // rank：tie = (scoreTotal, wins) 相同共享同一 rank；limit 截断不把并列组拦腰切开
  let prevKey = ''
  let prevRank = 0
  const out: LeaderboardRow[] = []
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!
    const key = `${row.scoreTotal}:${row.wins}`
    if (key === prevKey) {
      row.rank = prevRank
    } else {
      row.rank = i + 1
      prevRank = row.rank
      prevKey = key
    }
    if (opts.limit !== undefined && out.length >= opts.limit && !sameTieKeyAsLast(out, row)) {
      break // 剩余行（含完整并列组之外的部分）用 hasMore 表达
    }
    out.push(row)
  }

  return { rows: out, hasMore: out.length < sorted.length }
}

/** 与已收录最后一行是否共享 tie key（scoreTotal+wins）——并列组不拦腰截断。 */
function sameTieKeyAsLast(rows: LeaderboardRow[], row: LeaderboardRow): boolean {
  const last = rows[rows.length - 1]
  if (!last) return false
  return last.scoreTotal === row.scoreTotal && last.wins === row.wins
}

/* ------------------------------ 公开 redaction（M4-D HTTP 用） ------------------------------ */

export interface PublicResultPlayer {
  participantId?: string
  displayName?: string
}

/** 公开 winner：session 变体不暴露 sessionId（普通局只表达"分出胜负"语义）。 */
export type PublicResultWinner =
  | { kind: 'participant'; participantId: string }
  | { kind: 'draw' }
  | { kind: 'session' }

export interface PublicMatchResult {
  resultId: string
  tournamentId?: string
  slotId?: string
  attempt?: 0 | 1
  preset: MatchPreset
  phase: 'settled'
  winner: PublicResultWinner
  scores: Record<string, number>
  participants: PublicResultPlayer[]
  endTick: number
  replayId?: string
  replayCompleteness?: 'complete' | 'partial'
  scoreWarning?: string
  createdAt: number
}

/**
 * 公开历史 DTO：剥离 sessionId/username（host 私有）。赛事参与者保留
 * participantId/displayName；普通 M3 result（无 participantId）只给空参与者占位。
 * abort 孤儿（diagnostics='settlement-aborted'）不出现在公开 DTO——调用方先过滤。
 */
export function toPublicMatchResult(result: MatchResult): PublicMatchResult {
  const winner = result.winner.kind === 'session'
    ? { kind: 'session' as const } // 普通局 session winner 不对公开侧暴露 id；语义为"分出胜负"
    : result.winner
  const participants = result.participantSnapshot.map(({ participantId, displayName }) => ({ participantId, displayName }))
  return {
    resultId: result.resultId,
    ...(result.tournamentId !== undefined ? { tournamentId: result.tournamentId } : {}),
    ...(result.slotId !== undefined ? { slotId: result.slotId } : {}),
    ...(result.attempt !== undefined ? { attempt: result.attempt } : {}),
    preset: result.preset,
    phase: result.phase,
    winner,
    scores: result.scores,
    participants,
    endTick: result.endTick,
    ...(result.replayId !== undefined ? { replayId: result.replayId } : {}),
    ...(result.replayCompleteness !== undefined ? { replayCompleteness: result.replayCompleteness } : {}),
    ...(result.scoreWarning !== undefined ? { scoreWarning: result.scoreWarning } : {}),
    createdAt: result.createdAt,
  }
}
