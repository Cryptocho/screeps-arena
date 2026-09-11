/**
 * AdmissionGate（M4-C.1）—— 单活跃不变量（进程同时最多一场 tournament/legacy spawn/普通对局
 * 正在建或跑）的进程内互斥入口（plan §3.3）。
 *
 * 职责：
 * - runExclusive：acquire(持久 reservation) → 执行 owner 编排 → finally release；
 * - 普通 create/join（HTTP POST /matches 与工具面 screeps_match create/join）必须先过
 *   active 检查：任一 held/recovery reservation、recruiting/ready/running tournament 或
 *   活跃 match 存在 → 409/503（补 http.ts 只看 MatchState active、看不见 recruiting
 *   tournament 的缺口，plan §3.3）；
 * - recovery 期间所有 create/start/spawn 返回 503/409 `recovery in progress`。
 *
 * 单 host 单 writer；AdmissionStore 本身串行化所有 reservation 写。
 */
import { AdmissionError, AdmissionStore, type AdmissionKind, type AdmissionReservation } from './store.ts'
import type { MatchStore } from '../match/store.ts'
import type { TournamentStore } from '../tournament/store.ts'
import type { TournamentState } from '../tournament/model.ts'

export class AdmissionGateError extends Error {
  constructor(
    public code: 'conflict' | 'recovery' | 'activeTournament' | 'activeMatch' | 'io',
    message: string,
  ) {
    super(message)
    this.name = 'AdmissionGateError'
  }
}

export class AdmissionGate {
  constructor(
    private readonly deps: {
      admission: AdmissionStore
      matches?: MatchStore
      tournaments?: TournamentStore
      log?: (msg: string) => void
    },
  ) {}

  private log(msg: string): void {
    this.deps.log?.(`admission: ${msg}`)
  }

  /** 当前是否有任何占用（held/recovery）。 */
  async isHeld(): Promise<boolean> {
    return (await this.deps.admission.currentLock()) !== null
  }

  /**
   * 排他执行：acquire → fn → finally release。
   * kind='recovery' 时跳过 held 业务锁检查（由 RecoveryCoordinator 独占）。
   */
  async runExclusive<T>(
    kind: AdmissionKind,
    operationId: string,
    ownerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let reservation: AdmissionReservation
    try {
      reservation = await this.deps.admission.acquire(kind, operationId, ownerId)
    } catch (err) {
      if (err instanceof AdmissionError && err.code === 'conflict') {
        const lock = await this.deps.admission.currentLock()
        if (lock?.kind === 'recovery') throw new AdmissionGateError('recovery', 'recovery in progress')
        throw new AdmissionGateError('conflict', `admission busy: ${lock ? `${lock.kind}:${lock.ownerId}` : 'unknown'}`)
      }
      throw err
    }
    try {
      return await fn()
    } finally {
      try {
        await this.deps.admission.release(reservation.reservationId, reservation.ownerId)
        this.log(`released ${reservation.kind}:${reservation.ownerId} (${reservation.operationId})`)
      } catch (err) {
        // release 失败：保留 recovery diagnostics，不能放开并发
        this.log(`release failed for ${reservation.reservationId}: ${(err as Error).message}`)
      }
    }
  }

  /**
   * 普通 create/join/start 入口的 active 检查（M3 缺口闭合，plan §3.3）：
   * 任一 held/recovery reservation、active tournament（recruiting/ready/running）或活跃
   * match → 抛 gate 错误（HTTP 层映射 409/503）。
   */
  async assertIdle(): Promise<void> {
    const lock = await this.deps.admission.currentLock()
    if (lock) {
      if (lock.kind === 'recovery' || lock.state === 'recovery') {
        throw new AdmissionGateError('recovery', 'recovery in progress; try again later')
      }
      throw new AdmissionGateError('conflict', `another admission in progress (${lock.kind}:${lock.ownerId})`)
    }
    if (this.deps.tournaments) {
      const active = await this.deps.tournaments.listActive()
      if (active.length > 0) {
        const t: TournamentState = active[0]!
        throw new AdmissionGateError('activeTournament', `tournament ${t.id} is ${t.phase}; settle or interrupt it first`)
      }
    }
    if (this.deps.matches) {
      const activeMatch = await this.deps.matches.active()
      if (activeMatch) {
        throw new AdmissionGateError('activeMatch', `active match ${activeMatch.id} (${activeMatch.phase}) must settle first`)
      }
    }
  }
}
