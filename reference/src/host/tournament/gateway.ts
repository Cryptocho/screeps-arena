/**
 * TournamentGateway 实现（M4-C.1）—— MatchLifecycle/MatchService 构造时注入的赛事推进网关
 * （plan §3.2/§3.3，唯一 applyResult 入口）。内部转调 TournamentStore.applyResult。
 *
 * 语义（plan §3.1/§3.2，测试钉死）：
 *   - 只接受带 tournamentId/slotId/attempt 的赛事 MatchResult（session winner 拒绝 → conflict）；
 *   - 校验 matchId 绑定在该 slot 的对应 attempt 上（match.tournamentId/slotId/attempt 三字段
 *     与 result 一致，且 slot 的 attempt.matchId === matchId）；
 *   - expectedSlotRevision 取 TournamentStore 当前 slot revision（gateway 读取，不是调用方传）；
 *   - outcome：winner participant → 'won'；draw → 'draw'；store conflict/corrupt → 'conflict'
 *     （不抛——settle 上层据此保持 settling 并记 error，recovery 决策 abort）；
 *   - 不返回 resultHash：tournament marker 的 payloadHash 与 history marker 同源，由 settle
 *     流程用同一份 MatchResult 的 toResultHash 计算（plan §3.2 receipt hash 只校验自己来源）。
 */
import type { MatchResult } from '../history/model.ts'
import type { MatchStore } from '../match/store.ts'
import { TournamentStore } from './store.ts'

export interface GatewayApplyOutcome {
  outcome: 'won' | 'draw' | 'conflict'
  slotRevision: number
  /** conflict 原因（诊断/reconcile 决策用；won/draw 为 undefined）。 */
  reason?: string
}

export class TournamentGateway {
  constructor(
    private readonly deps: {
      tournaments: TournamentStore
      /** 延迟 getter：ScreepsService 构造顺序里 MatchService 晚于 gateway 创建，apply 时才取。 */
      matches: () => MatchStore
      log?: (msg: string) => void
    },
  ) {}

  private log(msg: string): void {
    this.deps.log?.(`gateway: ${msg}`)
  }

  async applyResult(matchId: string, result: MatchResult): Promise<GatewayApplyOutcome> {
    const { tournamentId, slotId, attempt } = result
    if (!tournamentId || !slotId || attempt === undefined) {
      this.log(`match ${matchId} result lacks tournamentId/slotId/attempt; refusing`)
      return { outcome: 'conflict', slotRevision: -1 }
    }
    // session-kind winner：赛事结果必须 participant/draw（redaction 与 leaderboard 依赖）
    if (result.winner.kind === 'session') {
      this.log(`match ${matchId}: session winner not allowed in tournament result`)
      return { outcome: 'conflict', slotRevision: -1, reason: 'session winner not allowed in tournament result' }
    }

    const match = await this.deps.matches().get(matchId)
    if (!match) {
      this.log(`match ${matchId} not found`)
      return { outcome: 'conflict', slotRevision: -1, reason: 'match not found' }
    }
    if (match.tournamentId !== tournamentId || match.tournamentSlotId !== slotId || match.attempt !== attempt) {
      this.log(`match ${matchId} is not bound to ${tournamentId}/${slotId} attempt ${attempt}`)
      return { outcome: 'conflict', slotRevision: -1, reason: `match not bound to ${tournamentId}/${slotId} attempt ${attempt}` }
    }

    const tournament = await this.deps.tournaments.get(tournamentId)
    if (!tournament) {
      this.log(`tournament ${tournamentId} not found`)
      return { outcome: 'conflict', slotRevision: -1, reason: 'tournament not found' }
    }
    if (tournament.phase !== 'running') {
      this.log(`tournament ${tournamentId} is ${tournament.phase}; refusing applyResult`)
      return { outcome: 'conflict', slotRevision: this.slotRevisionOf(tournament, slotId), reason: `tournament is ${tournament.phase}` }
    }
    const slot = tournament.slots.find(s => s.slotId === slotId)
    if (!slot) {
      this.log(`slot ${slotId} not found in tournament ${tournamentId}`)
      return { outcome: 'conflict', slotRevision: -1, reason: `slot ${slotId} not found` }
    }
    const bound = slot.attempts.some(a => a.matchId === matchId && a.attempt === attempt)
    if (!bound) {
      const boundIds = slot.attempts.map(a => a.matchId).filter(Boolean).join(', ')
      this.log(`match ${matchId} is not bound to slot ${slotId} attempt ${attempt} (bound: ${boundIds || 'none'})`)
      return { outcome: 'conflict', slotRevision: slot.revision, reason: `match not bound to slot attempt (bound: ${boundIds || 'none'})` }
    }

    const storeOutcome = await this.deps.tournaments.applyResult({
      tournamentId,
      slotId,
      expectedSlotRevision: slot.revision,
      attempt,
      result,
    })
    if (storeOutcome.kind === 'ok' || storeOutcome.kind === 'idempotent') {
      return {
        outcome: result.winner.kind === 'participant' ? 'won' : 'draw',
        slotRevision: storeOutcome.slotRevision,
      }
    }
    this.log(`applyResult ${matchId} -> ${storeOutcome.kind} (${storeOutcome.reason ?? 'no reason'})`)
    return { outcome: 'conflict', slotRevision: storeOutcome.slotRevision, reason: storeOutcome.reason ?? 'store conflict' }
  }

  private slotRevisionOf(state: { slots: Array<{ slotId: string; revision: number }> } | null, slotId: string): number {
    return state?.slots.find(s => s.slotId === slotId)?.revision ?? -1
  }
}
