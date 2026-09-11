/**
 * MatchService（S9b + M4-B）—— 对局层的运行时接缝：把 MatchStore（S8 持久化/状态机）、
 * MatchLifecycle（S9a 编排 + M4-B journal settle）与外部结算驱动（HistoryStore / Replay /
 * TournamentGateway）接到 ScreepsService（S6 私服生命周期 + arena 客户端）上。
 *
 * - ScreepsService 结构化满足 MatchLifecycle 的 ArenaBackend 接口，无需适配层；
 * - 生命周期归 ScreepsService fiber：match 层随私服 fiber 一起销毁，不持独立资源；
 * - store 落盘在 <dataDir>/matches/<matchId>/state.json（原子写见 store.ts）；
 * - M4-B settle 契约（plan §3.2/§6.1）：lifecycle.settle 返回时已 commit（settled）；
 *   随后 await hooks.onSettled(state)（普通局回收 spawn Agent / 赛事局转发通知——
 *   dispose 分支由 ScreepsService 按 state.tournamentId 决定）；hook 成功 → markCleanup
 *   committed；失败 → markCleanup unknown（不回滚已 committed 结果）；赛事局 cleanup
 *   初值 not-applicable，不重复写。
 */
import path from 'node:path'
import type { MatchPreset, MatchState } from './model.ts'
import { MatchLifecycle, type MatchObservation, type SettlementDrivers, type SettleReason } from './lifecycle.ts'
import { MatchStore } from './store.ts'
import { CodeLog } from './code-log.ts'
import type { ScreepsService } from '../service.ts'

export class MatchService {
  readonly store: MatchStore
  readonly lifecycle: MatchLifecycle
  /** M6：per-match 代码提交记录（观战代码查看器数据源；与 store.dir 同根，DELETE 连带清理）。 */
  readonly codeLog: CodeLog
  /** commit 后回调（只传完整 committed state；失败由本类 catch 并 markCleanup unknown）。 */
  private readonly onSettled?: (state: MatchState) => Promise<void> | void

  constructor(
    screeps: ScreepsService,
    dataDir: string,
    log: (msg: string, ...args: unknown[]) => void,
    hooks: { onSettled?: (state: MatchState) => Promise<void> | void } = {},
    drivers: SettlementDrivers = {},
  ) {
    this.store = new MatchStore(path.join(dataDir, 'matches'))
    this.codeLog = new CodeLog(this.store.dir, (msg: string) => log('%s', msg))
    this.lifecycle = new MatchLifecycle(this.store, screeps, (msg: string) => log('%s', msg), drivers, 1_200, this.codeLog)
    this.onSettled = hooks.onSettled
  }

  /** host 启动时调用：上次进程中断留下的活跃对局标记 interrupted（settling 留给 recovery）。 */
  boot(): Promise<MatchState[]> {
    return this.lifecycle.boot()
  }

  createMatch(input: { preset: MatchPreset; sessionId: string; username: string; tickDuration?: number; roundTicks?: number; maxRounds?: number }) {
    return this.lifecycle.createMatch(input)
  }

  /**
   * M4-C host 内部 API（不暴露 HTTP/tool）：一次 MatchStore serialized 操作创建完整
   * tournament attempt MatchState（两席、codeMode='round'、roundToken 只存 hash）。
   * 调用方（TournamentService）持有 roundToken 明文用于 prompt；本方法只收 hash。
   */
  createTournamentAttempt(input: {
    tournamentId: string
    slotId: string
    attempt: 0 | 1
    roundTokenHash: string
    players: Array<{ sessionId: string; username: string; participantId: string }>
    tickDuration?: number
  }): Promise<MatchState> {
    return this.store.createTournament({
      tournamentId: input.tournamentId,
      slotId: input.slotId,
      attempt: input.attempt,
      roundTokenHash: input.roundTokenHash,
      codeMode: 'round',
      tickDuration: input.tickDuration,
      players: input.players.map(p => ({ sessionId: p.sessionId, username: p.username, participantId: p.participantId, code: {} })),
    })
  }

  join(matchId: string, player: { sessionId: string; username: string }) {
    return this.lifecycle.join(matchId, player)
  }

  start(matchId: string, opts: { rooms?: Array<string | { room: string; exits?: Record<string, number[]> }> } = {}) {
    return this.lifecycle.start(matchId, opts)
  }

  pause(matchId: string) {
    return this.lifecycle.pause(matchId)
  }

  resume(matchId: string) {
    return this.lifecycle.resume(matchId)
  }

  observe(matchId: string): Promise<MatchObservation> {
    return this.lifecycle.observe(matchId)
  }

  /** M5：world-rounds 单拍驱动（autoRound→roundBreak / ready→resume / maxRounds/超时→终止）。 */
  driveNextRound(matchId: string, opts?: { roundBreakTimeoutMs?: number; now?: number }) {
    return this.lifecycle.driveNextRound(matchId, opts)
  }

  reconcileSettlement(matchId: string) {
    return this.lifecycle.reconcileSettlement(matchId)
  }

  /**
   * 结算（journal）：commit 成功 → await hook（失败 catch → markCleanup unknown）→ 普通局
   * markCleanup committed。赛事局 cleanup 初值 not-applicable，hook 由 ScreepsService 只转发。
   */
  async settle(matchId: string, reason: SettleReason): Promise<MatchState> {
    const committed = await this.lifecycle.settle(matchId, reason)
    const isTournament = committed.tournamentId !== undefined
    if (this.onSettled) {
      try {
        await this.onSettled(committed)
        if (!isTournament) {
          const latest = (await this.store.get(matchId)) ?? committed
          await this.lifecycle.markCleanup(matchId, latest.revision!, 'committed').catch(() => {})
        }
      } catch (err) {
        const latest = (await this.store.get(matchId)) ?? committed
        await this.lifecycle.markCleanup(matchId, latest.revision!, 'unknown', (err as Error).message).catch(() => {})
      }
    }
    return committed
  }
}
