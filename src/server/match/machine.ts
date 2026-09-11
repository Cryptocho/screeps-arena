/**
 * 对局状态机（M0/S3）—— creating→running⇄roundBreak→settled 最小闭环。
 *
 * 语义对照（平移自 reference/src/host/match 的 rounds 分支，plan-M0 §5 风险表）：
 *   - running 期提交 → 拒（文案对照旧 tools.ts L364 frozen 分支）；
 *   - roundBreak 期提交 → 暂存 code + ready=true（对照旧 tools.ts rounds 分支）；
 *   - 超时兜底：roundBreakTimeoutMs 到点未提交 → 沿用上轮代码自动 ready + error 落盘 + 续跑
 *     （对照旧 roundBreakTimeoutMs 语义）；
 *   - resume 时 ready 清 false、roundIndex+1（对照旧 resumeNextRound）；
 *   - maxRounds：resume 将超出时自动 settle(roundsExhausted)。
 *
 * 时间显式注入（now 参数）保证可测；真实时钟由驱动方（M1 HTTP 桥 / S4 IT）接线。
 * 唤醒 = 本机在 roundBreak 边界发 MatchEvent，由外部把事件转成 AgentRunner.prompt()。
 */
import { canTransition, DEFAULT_MATCH_CONFIG, newMatchId } from './model.js'
import type {
  MatchConfig,
  MatchPhase,
  MatchPlayer,
  MatchState,
  SettleReason,
  WinnerRef,
} from './model.js'

export type MatchEvent =
  | { type: 'started'; round: number }
  | { type: 'round_break'; round: number }
  | { type: 'round_resume'; round: number; autoReadySeats: string[] }
  | { type: 'settled'; reason: SettleReason; winner: WinnerRef }

export interface MatchMachineOptions {
  id?: string
  config?: Partial<MatchConfig>
  players: Array<{ seatId: string; username: string }>
  onEvent?: (event: MatchEvent) => void
}

/** running 期提交的拒绝文案（对照旧 tools.ts rounds 分支——frozen during a round）。 */
export const FROZEN_DURING_ROUND =
  'submit_code rejected: code is frozen during a round (rounds preset). Commit at the next round boundary instead.'

export class MatchMachine {
  readonly id: string
  readonly config: MatchConfig
  readonly players: MatchPlayer[]
  readonly state: MatchState
  private readonly onEvent: ((event: MatchEvent) => void) | undefined

  constructor(opts: MatchMachineOptions) {
    this.id = opts.id ?? newMatchId()
    this.config = { ...DEFAULT_MATCH_CONFIG, ...opts.config }
    if (opts.players.length !== this.config.seats) {
      throw new Error(`match ${this.id}: expected ${this.config.seats} seats, got ${opts.players.length}`)
    }
    this.players = opts.players.map((p) => ({ seatId: p.seatId, username: p.username, ready: false }))
    this.state = {
      id: this.id,
      createdAt: Date.now(),
      phase: 'creating',
      config: this.config,
      players: this.players,
      roundIndex: -1,
      errors: [],
    }
    this.onEvent = opts.onEvent
  }

  get phase(): MatchPhase {
    return this.state.phase
  }

  /** 席位提交（三工具 submit_code 的落点；phase 语义在此收口）。 */
  submitCode(seatId: string, modules: Record<string, string>, now = Date.now()): void {
    const player = this.requireSeat(seatId)
    switch (this.state.phase) {
      case 'creating':
      case 'roundBreak':
        player.code = { ...modules }
        player.ready = true
        player.submittedAt = now
        break
      case 'running':
        throw new Error(FROZEN_DURING_ROUND)
      case 'settled':
        throw new Error(`submit_code rejected: match ${this.id} already settled`)
    }
  }

  /** 开局（creating→running）。门槛：全员已暂存代码（对照 A0 全就绪门槛）。 */
  start(now = Date.now()): void {
    this.assertTransition('running')
    const notReady = this.players.filter((p) => !p.code)
    if (notReady.length > 0) {
      throw new Error(`match ${this.id}: cannot start, seats without committed code: ${notReady.map((p) => p.seatId).join(', ')}`)
    }
    this.state.phase = 'running'
    this.state.roundIndex = 0
    this.state.roundStartedAt = now
    this.emit({ type: 'started', round: 0 })
  }

  /** 时钟驱动：running 周期到点 → roundBreak；roundBreak 超时/全员就绪 → resume。幂等。
   *  scores（M2/S1）透传 resume → roundsExhausted settle；缺席维持 M0 全 0 draw。 */
  advance(now = Date.now(), scores?: { scores: Record<string, number>; winner: WinnerRef }): void {
    if (this.state.phase === 'running' && this.state.roundStartedAt !== undefined) {
      if (now - this.state.roundStartedAt >= this.config.roundMs) {
        this.enterRoundBreak(now)
      }
    }
    if (this.state.phase === 'roundBreak' && this.state.roundBreakSince !== undefined) {
      if (this.allReady()) {
        this.resume(now, [], scores)
        return
      }
      if (now - this.state.roundBreakSince >= this.config.roundBreakTimeoutMs) {
        const round = this.state.roundIndex
        const autoReadySeats: string[] = []
        for (const p of this.players) {
          if (!p.ready) {
            p.ready = true // 沿用上轮 code（p.code 本身就是上轮提交）
            p.autoReady = { round, reason: 'timeout' }
            this.state.errors.push(`seat ${p.seatId}: round ${round} commit timeout — auto-ready with last submitted code`)
            autoReadySeats.push(p.seatId)
          }
        }
        this.resume(now, autoReadySeats, scores)
      }
    }
  }

  /**
   * 结算（running / roundBreak / creating 均可）。
   * outcome 缺席 → M0 行为（全 0 → draw，既有测试基线不破）；给入 → 真实计分
   * （M2/S1：scores 保留真实计数，winner 由 computeOutcome 判定，编排层预取注入）。
   */
  settle(
    reason: SettleReason = 'manual',
    now = Date.now(),
    outcome?: { scores: Record<string, number>; winner: WinnerRef },
  ): void {
    this.assertTransition('settled')
    this.state.phase = 'settled'
    this.state.settledAt = now
    this.state.settleReason = reason
    if (outcome) {
      this.state.scores = { ...outcome.scores }
      this.state.winner = outcome.winner
    } else {
      const scores: Record<string, number> = {}
      for (const p of this.players) scores[p.seatId] = 0
      this.state.scores = scores
      this.state.winner = { kind: 'draw' }
    }
    this.emit({ type: 'settled', reason, winner: this.state.winner })
  }

  /**
   * journal 恢复（M2/S5）：灌回 per-player code/ready 与 state 元数据，不触发事件。
   * 仅用于未 settled 的对局（journal 扫描方过滤）；roundBreakSinceResetTo 把
   * roundBreakSince 重置为恢复时刻（否则超时兜底立即触发）。
   */
  static restore(opts: {
    id: string
    config: MatchConfig
    players: MatchPlayer[]
    state: Pick<MatchState, 'createdAt' | 'phase' | 'roundIndex' | 'errors'> &
      Partial<Pick<MatchState, 'roundBreakSince' | 'roundStartedAt' | 'settledAt' | 'settleReason' | 'winner' | 'scores'>>
    roundBreakSinceResetTo?: number
    onEvent?: (event: MatchEvent) => void
  }): MatchMachine {
    const m = new MatchMachine({
      id: opts.id,
      config: opts.config,
      players: opts.players.map((p) => ({ seatId: p.seatId, username: p.username })),
      onEvent: opts.onEvent,
    })
    for (const saved of opts.players) {
      const p = m.players.find((x) => x.seatId === saved.seatId)
      if (!p) continue
      if (saved.code) p.code = { ...saved.code }
      p.ready = saved.ready
      if (saved.autoReady) p.autoReady = saved.autoReady
      if (saved.submittedAt !== undefined) p.submittedAt = saved.submittedAt
    }
    Object.assign(m.state, {
      createdAt: opts.state.createdAt,
      phase: opts.state.phase,
      roundIndex: opts.state.roundIndex,
      errors: [...opts.state.errors],
      ...(opts.state.roundBreakSince !== undefined ? { roundBreakSince: opts.state.roundBreakSince } : {}),
      ...(opts.state.roundStartedAt !== undefined ? { roundStartedAt: opts.state.roundStartedAt } : {}),
      ...(opts.state.settledAt !== undefined ? { settledAt: opts.state.settledAt } : {}),
      ...(opts.state.settleReason !== undefined ? { settleReason: opts.state.settleReason } : {}),
      ...(opts.state.winner !== undefined ? { winner: opts.state.winner } : {}),
      ...(opts.state.scores !== undefined ? { scores: opts.state.scores } : {}),
    })
    if (opts.roundBreakSinceResetTo !== undefined) m.state.roundBreakSince = opts.roundBreakSinceResetTo
    return m
  }

  private allReady(): boolean {
    return this.players.every((p) => p.ready)
  }

  private enterRoundBreak(now: number): void {
    this.assertTransition('roundBreak')
    this.state.phase = 'roundBreak'
    this.state.roundBreakSince = now
    for (const p of this.players) p.ready = false
    this.emit({ type: 'round_break', round: this.state.roundIndex })
  }

  private resume(
    now: number,
    autoReadySeats: string[] = [],
    scores?: { scores: Record<string, number>; winner: WinnerRef },
  ): void {
    const nextRound = this.state.roundIndex + 1
    if (this.config.maxRounds > 0 && nextRound >= this.config.maxRounds) {
      this.settle('roundsExhausted', now, scores)
      return
    }
    this.assertTransition('running')
    this.state.phase = 'running'
    this.state.roundIndex = nextRound
    this.state.roundStartedAt = now
    this.state.roundBreakSince = undefined
    for (const p of this.players) p.ready = false
    this.emit({ type: 'round_resume', round: nextRound, autoReadySeats })
  }

  private requireSeat(seatId: string): MatchPlayer {
    const player = this.players.find((p) => p.seatId === seatId)
    if (!player) throw new Error(`seat ${seatId}: not a player of match ${this.id}`)
    return player
  }

  private assertTransition(to: MatchPhase): void {
    if (!canTransition(this.state.phase, to)) {
      throw new Error(`match ${this.id}: ${this.state.phase} → ${to} not allowed`)
    }
  }

  private emit(event: MatchEvent): void {
    this.onEvent?.(event)
  }
}
