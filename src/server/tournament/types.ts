/**
 * 锦标赛领域类型（plan-M4/D1）——纯类型，编排层与 store 共享。
 * errors 为届级错误可查面（初始 prompt 超界等；plan-M4 v3 D1）。
 */
import type { MatchConfig } from '../match/model.js'

export interface TournamentParticipant {
  seatId: string
  username: string
}

export interface TournamentMatchResult {
  /** 胜者 seatId；null = draw。 */
  winner: string | null
  scores: Record<string, number>
  settledAt: number
}

export type TournamentMatchStatus = 'scheduled' | 'created' | 'settled'

export interface TournamentMatch {
  pair: [string, string]
  /** scheduled = 尚未建局（先落盘后 createMatch，D3 建局时序）；created 起有 matchId。 */
  status: TournamentMatchStatus
  matchId?: string
  result?: TournamentMatchResult
}

export interface Tournament {
  id: string
  name: string
  createdAt: number
  format: 'round-robin'
  participants: TournamentParticipant[]
  matchConfig?: Partial<MatchConfig>
  matches: TournamentMatch[]
  finishedAt?: number
  errors: string[]
}

export function newTournamentId(now = Date.now()): string {
  return `t${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 全部 pair 是否都已 settle（届终局判定）；settled 但 result 未回填不算终局
 *  （恢复路径 D3-③ 要能进这类届做回填）。 */
export function tournamentFinished(t: Tournament): boolean {
  return t.matches.length > 0 && t.matches.every((m) => m.status === 'settled' && m.result)
}
