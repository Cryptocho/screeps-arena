/**
 * 对局领域模型（M0/S3）—— 纯类型与纯函数，不碰 fs / 网络 / Pi / 时钟。
 * 语义对照 `reference/src/host/match/model.ts` 裁剪到 M0 所需：
 *   - phase 裁剪为 creating→running⇄roundBreak→settled（无 placing/paused/settling/interrupted，
 *     M0 无真实私服建号 / 无暂停 / 无结算 journal）；
 *   - roundIndex 0 起；roundBreak 期间 per-player ready；超时兜底沿用上轮代码；
 *   - 记分：M0 内存世界无计数器来源，全 0 → winner=draw（computeScore 纯算术保留形状，
 *     M1 接真实事件流后原样接上）。
 */

export type MatchPhase = 'creating' | 'running' | 'roundBreak' | 'settled'
export type SettleReason = 'manual' | 'roundsExhausted'
export type WinnerRef = { kind: 'seat'; seatId: string } | { kind: 'draw' }

/** M0 内存世界：周期与超时都是墙钟（真实世界 tick 流 M1 接私服后引入）。 */
export interface MatchConfig {
  seats: number
  /** 每周期（round）时长（墙钟 ms）；到点进入 roundBreak。 */
  roundMs: number
  /** roundBreak 超时：到点未提交的席位沿用上轮代码自动 ready（不卡死）。 */
  roundBreakTimeoutMs: number
  /** 最大周期数：resume 将超出时自动 settle（0 = 不限）。 */
  maxRounds: number
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  seats: 2,
  roundMs: 60_000,
  roundBreakTimeoutMs: 300_000,
  maxRounds: 8,
}

export interface MatchPlayer {
  seatId: string
  username: string
  /** 最近一次提交的代码（creating 暂存 = start 门槛；roundBreak 提交 = 下轮生效；超时兜底沿用）。 */
  code?: Record<string, string>
  /** roundBreak 期是否已 commit（resume 时清 false）。 */
  ready: boolean
  /** 超时兜底记录（沿用上轮代码自动 ready）。 */
  autoReady?: { round: number; reason: 'timeout' }
  submittedAt?: number
}

export interface MatchState {
  id: string
  createdAt: number
  phase: MatchPhase
  config: MatchConfig
  players: MatchPlayer[]
  /** 当前周期序号（0 起；creating 期为 -1）。 */
  roundIndex: number
  /** 进入 roundBreak 的墙钟时间戳（超时计费基准）。 */
  roundBreakSince?: number
  /** 进入当前 running 周期的时间戳（roundMs 计费基准）。 */
  roundStartedAt?: number
  settledAt?: number
  settleReason?: SettleReason
  winner?: WinnerRef
  scores?: Record<string, number>
  /** 对局级错误记录（超时兜底等；只追加）。 */
  errors: string[]
}

const TRANSITIONS: Record<MatchPhase, readonly MatchPhase[]> = {
  creating: ['running', 'settled'],
  running: ['roundBreak', 'settled'],
  roundBreak: ['running', 'settled'],
  settled: [],
}

export function canTransition(from: MatchPhase, to: MatchPhase): boolean {
  return TRANSITIONS[from].includes(to)
}

export function newMatchId(now = Date.now()): string {
  return `m${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
