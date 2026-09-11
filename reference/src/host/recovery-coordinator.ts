/**
 * RecoveryCoordinator（M4-B.5）—— boot recovery 的固定顺序（plan §3.3 RecoveryCoordinator
 * 1-6；此文件实现 match/tournament store 侧的恢复与级联中断；handles 判定与 AdmissionGate
 * 编排入口在 M4-C 接入 ScreepsService/TournamentService 时复用）。
 *
 * 顺序：
 *   0. 独占 recovery reservation（AdmissionStore.acquireRecovery）——未完成前任何新 admission
 *      （create/start/spawn）由 gate 挡回 503/409；
 *   1. 扫描 MatchStore（scanActive/scanDiagnostics）与 TournamentStore（list/scanDiagnostics），
 *      不改状态；
 *   2. settling match → reconcileSettlement（读已固定 journal，replay→history→tournament→commit）；
 *      成功才 commit；失败保持 settling + journal.error（不做无界 retry，single-flight）；
 *   3. tournament 赛事：
 *      - recruiting/ready 且无 handle（重启即无）→ interrupted + cleanupUnknown（不伪造 resume）；
 *      - running 且无 handle → 级联终态化其 owned attempt MatchState（creating/placing/
 *        running/paused → interrupted；settling → reconcile，reconcile 失败 → abort），
 *        slot 标 interrupted，赛事标 interrupted + cleanupUnknown；单活跃席位立即释放；
 *      - completed/draw/failed/interrupted → 只诊断，不动作；
 *   4. 普通 active（无 tournamentId）→ markInterrupted（settling 绝不覆盖）；
 *   5. 诊断合并进 report（可查询后 recovery reservation 才释放）。
 *
 * 不变量：recovery 永不重新 observe/重算 candidate；settling 不被普通 markInterrupted 覆盖。
 */
import type { MatchService } from './match/match-service.ts'
import type { TournamentStore } from './tournament/store.ts'
import { AdmissionStore, type AdmissionReservation } from './admission/store.ts'
import type { TournamentState } from './tournament/model.ts'
import type { MatchState } from './match/model.ts'

export interface RecoveryReport {
  lockAcquired: boolean
  releaseError?: string
  reconciled: string[]
  reconcileFailed: string[]
  interruptedOrdinary: string[]
  tournamentInterrupted: string[]
  tournamentCascade: Array<{ tournamentId: string; matches: string[] }>
  tournamentAborted: string[]
  diagnostics: Array<{ scope: 'match' | 'tournament' | 'admission'; id: string; reason: string }>
}

export interface RecoveryDeps {
  admission: AdmissionStore
  matches: MatchService
  tournaments?: TournamentStore
  log?: (msg: string) => void
}

export class RecoveryCoordinator {
  constructor(private readonly deps: RecoveryDeps) {}

  private log(msg: string): void {
    this.deps.log?.(msg)
  }

  /**
   * 执行一次 recovery（幂等：可重复调用；已 settle/已 interrupted 的局自然跳过）。
   * 返回 report；调用方据此决定何时释放 recovery reservation（或本方法 finally 释放
   * 当 releaseOwnership=true）。
   */
  async run(opts: { releaseOwnership?: boolean } = {}): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      lockAcquired: false,
      reconciled: [],
      reconcileFailed: [],
      interruptedOrdinary: [],
      tournamentInterrupted: [],
      tournamentCascade: [],
      tournamentAborted: [],
      diagnostics: [],
    }
    let lock: AdmissionReservation | null = null
    try {
      lock = await this.deps.admission.acquireRecovery()
      report.lockAcquired = true
    } catch (err) {
      // 已有业务锁（held）——recovery 由 owner 流程负责；记录诊断并继续只读扫描
      report.diagnostics.push({ scope: 'admission', id: 'recovery', reason: (err as Error).message })
    }

    try {
      // ---- 1. 扫描（不改状态）----
      const matchScan = await this.deps.matches.store.scanActive()
      const matchDiags = await this.deps.matches.store.scanDiagnostics()
      for (const d of matchDiags) report.diagnostics.push({ scope: 'match', id: d.id, reason: d.reason })

      let tournaments: TournamentState[] = []
      let tournamentDiags: Array<{ id: string; reason: string }> = []
      if (this.deps.tournaments) {
        tournaments = await this.deps.tournaments.list()
        tournamentDiags = await this.deps.tournaments.scanDiagnostics()
        for (const d of tournamentDiags) report.diagnostics.push({ scope: 'tournament', id: d.id, reason: d.reason })
      }
      const tournamentById = new Map(tournaments.map(t => [t.id, t]))
      // 重启场景无 handle：recruiting/ready/running 赛事均视为 owner lost
      const ownerLost = new Set(tournaments.filter(t => t.phase === 'recruiting' || t.phase === 'ready' || t.phase === 'running').map(t => t.id))

      // ---- 2. settling matches：reconcile（读 journal，绝不重算 candidate）----
      for (const m of matchScan.settling) {
        try {
          await this.deps.matches.reconcileSettlement(m.id)
          report.reconciled.push(m.id)
        } catch (err) {
          report.reconcileFailed.push(m.id)
          this.log(`reconcile ${m.id} failed: ${(err as Error).message}`)
        }
      }

      // ---- 3. tournament 级联 ----
      for (const tournament of tournaments) {
        if (!ownerLost.has(tournament.id)) continue
        const owned = matchScan.tournamentOwned.filter(m => m.tournamentId === tournament.id)
        const cascade: string[] = []
        let abortedAny = false
        for (const m of owned) {
          if (m.phase === 'settling') {
            // settling：先 reconcile；失败才 abort（不可恢复）
            try {
              await this.deps.matches.reconcileSettlement(m.id)
              report.reconciled.push(m.id)
            } catch {
              abortedAny = true
              const latest = await this.deps.matches.store.get(m.id)
              if (latest) {
                await this.deps.matches.store.abortSettlement(m.id, latest.revision!, 'recovery: tournament owner lost, bridge not recoverable')
                report.tournamentAborted.push(m.id)
              }
            }
            continue
          }
          if (m.phase === 'creating' || m.phase === 'placing' || m.phase === 'running' || m.phase === 'paused') {
            // 单活跃席位立即释放：owned attempt 安全终态化
            await this.deps.matches.store.transition(m.id, 'interrupted')
            cascade.push(m.id)
          }
        }
        // slot + 赛事标 interrupted + cleanupUnknown
        if (tournament.phase === 'recruiting' || tournament.phase === 'ready' || tournament.phase === 'running') {
          await this.interruptTournament(tournament, cascade, abortedAny)
          if (cascade.length > 0 || abortedAny) report.tournamentCascade.push({ tournamentId: tournament.id, matches: cascade })
          else report.tournamentInterrupted.push(tournament.id)
        }
      }

      // ---- 4. 普通 active（无 tournament 归属）→ interrupted（settling 绝不覆盖）----
      const flagged = await this.deps.matches.store.markInterrupted()
      report.interruptedOrdinary = flagged.filter(m => m.tournamentId === undefined).map(m => m.id)
    } catch (err) {
      report.diagnostics.push({ scope: 'match', id: 'recovery-run', reason: (err as Error).message })
    }

    // ---- 5. 释放（failure 保留 diagnostics；release 失败也记入，不放开并发）----
    if (opts.releaseOwnership !== false && lock) {
      try {
        await this.deps.admission.release(lock.reservationId, lock.ownerId)
      } catch (err) {
        report.releaseError = (err as Error).message
        report.diagnostics.push({ scope: 'admission', id: lock.reservationId, reason: `release failed: ${(err as Error).message}` })
      }
    }
    return report
  }

  /** 赛事标 interrupted + cleanupUnknown（revision CAS）。 */
  private async interruptTournament(t: TournamentState, cascade: string[], aborted: boolean): Promise<void> {
    const latest = await this.deps.tournaments!.get(t.id)
    if (!latest) return
    // 若赛事已不再是 active（并发收敛），跳过
    if (latest.phase !== 'recruiting' && latest.phase !== 'ready' && latest.phase !== 'running') return
    await this.deps.tournaments!.update(t.id, latest.revision, s => {
      s.phase = 'interrupted'
      s.cleanupUnknown = [...(s.cleanupUnknown ?? []), ...(aborted ? ['settling-match-aborted'] : [])]
      s.error = s.error ?? `recovery: tournament owner lost (${cascade.length} owned attempt match(es) interrupted)`
    })
  }
}
