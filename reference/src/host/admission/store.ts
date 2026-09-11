/**
 * AdmissionStore（M4-B.5）—— 单活跃不变量（一个进程同时最多一场 tournament / legacy spawn /
 * recovery）的持久化底座。共享 admission 不是只有内存锁，而是持久 reservation + 进程内互斥
 * （plan §3.3）。layout：<dataDir>/admission/state.json。
 *
 * AdmissionReservation（plan §3.3）：
 *   { reservationId, operationId, kind:'tournament-create'|'legacy-spawn'|'tournament-advance',
 *     ownerId, state:'held'|'released'|'recovery', createdAt, releasedAt?, error? }
 *
 * acquire(kind,operationId,ownerId)：同一写操作检查没有 held/recovery reservation →
 * no-clobber 写 reservation（state=held）。同 operationId+kind+ownerId → 幂等返回原 reservation；
 * 不同 operation → conflict。
 * release(reservationId,status,error?)：owner 在 finally 或 recovery 调；已 released/不匹配 →
 * 幂等/conflict。
 *
 * 崩溃恢复：Service init 第一阶段独占 recovery reservation（kind='recovery' 是状态而非 kind——
 * 用独立 kind 字段区分持有者）；扫描 admission/Tournament/Match diagnostics；held 且无可恢复
 * owner → 改 state='recovery' + error；只有清理检查完成后 release。recovery 期间所有
 * create/start/spawn 返回 503/409。
 *
 * 单 host 单 writer：写操作经内部 promise 链串行。
 */
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { atomicWriteJson, readJson } from '../store-io.ts'

export type AdmissionKind = 'tournament-create' | 'legacy-spawn' | 'tournament-advance' | 'recovery'
export type AdmissionState = 'held' | 'released' | 'recovery'

export interface AdmissionReservation {
  reservationId: string
  operationId: string
  kind: AdmissionKind
  /** tournamentId 或 legacy operation id；recovery = 'recovery'。 */
  ownerId: string
  state: AdmissionState
  createdAt: number
  releasedAt?: number
  error?: string
}

export class AdmissionError extends Error {
  constructor(
    public code: 'conflict' | 'notFound' | 'badState' | 'io',
    message: string,
  ) {
    super(message)
    this.name = 'AdmissionError'
  }
}

export class AdmissionStore {
  constructor(readonly dir: string) {}

  private chain: Promise<unknown> = Promise.resolve()
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn())
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private statePath(): string {
    return path.join(this.dir, 'state.json')
  }

  private async readAll(): Promise<AdmissionReservation[]> {
    const data = await readJson<AdmissionReservation[]>(this.statePath())
    return data ?? []
  }

  private async writeAll(reservations: AdmissionReservation[]): Promise<void> {
    await atomicWriteJson(this.statePath(), reservations)
  }

  /** 当前持锁者（held/recovery 任意一个；单活跃不变量靠它）。 */
  async currentLock(): Promise<AdmissionReservation | null> {
    const all = await this.readAll()
    return all.find(r => r.state === 'held' || r.state === 'recovery') ?? null
  }

  /** 全量（含已释放；诊断用）。 */
  async list(): Promise<AdmissionReservation[]> {
    return this.readAll()
  }

  /**
   * acquire：无 held/recovery 锁才可写新 held reservation。
   * 同 operationId+kind+ownerId（已 held）→ 幂等返回原 reservation（不重复占锁）。
   * 已被别的 operation 持锁 → conflict。
   */
  acquire(kind: AdmissionKind, operationId: string, ownerId: string): Promise<AdmissionReservation> {
    return this.serialize(async () => {
      const all = await this.readAll()
      const active = all.find(r => r.state === 'held' || r.state === 'recovery')
      if (active) {
        // 幂等：同一操作重试 → 返回原锁
        if (active.operationId === operationId && active.kind === kind && active.ownerId === ownerId && active.state === 'held') {
          return active
        }
        throw new AdmissionError('conflict', `admission held by ${active.kind}:${active.ownerId} (${active.operationId})`)
      }
      const now = Date.now()
      const reservation: AdmissionReservation = {
        reservationId: `ar${now.toString(36)}${randomBytes(4).toString('hex')}`,
        operationId,
        kind,
        ownerId,
        state: 'held',
        createdAt: now,
      }
      await this.writeAll([...all, reservation])
      return reservation
    })
  }

  /** recovery：把 held 且 owner 丢失的 reservation 标 recovery（崩溃恢复专用）。 */
  async markRecovery(reservationId: string, error: string): Promise<AdmissionReservation> {
    return this.serialize(async () => {
      const all = await this.readAll()
      const r = all.find(x => x.reservationId === reservationId)
      if (!r) throw new AdmissionError('notFound', `admission ${reservationId} not found`)
      if (r.state === 'recovery') return r // 幂等
      r.state = 'recovery'
      r.error = error
      await this.writeAll(all)
      return r
    })
  }

  /** 显式占 recovery 锁（Service init 第一阶段独占；已占则幂等）。 */
  acquireRecovery(operationId = 'boot-recovery'): Promise<AdmissionReservation> {
    return this.serialize(async () => {
      const all = await this.readAll()
      const active = all.find(r => r.state === 'held' || r.state === 'recovery')
      if (active) {
        if (active.kind === 'recovery') return active // 幂等
        // 有 held 业务锁残留但 owner 已不可达（进程重启场景不会发生——新进程 readAll 时
        // 旧 held 视为 owner lost）；这里保守 conflict，由 recovery 流程 markRecovery
        throw new AdmissionError('conflict', `admission held by ${active.kind}:${active.ownerId}`)
      }
      const now = Date.now()
      const reservation: AdmissionReservation = {
        reservationId: `recovery${now.toString(36)}`,
        operationId,
        kind: 'recovery',
        ownerId: 'recovery',
        state: 'held',
        createdAt: now,
      }
      await this.writeAll([...all, reservation])
      return reservation
    })
  }

  /**
   * release：owner 在 finally / recovery 清理完成后调用。
   * state=held/recovery → released + releasedAt；已 released → 幂等；不存在 → notFound。
   * ownerId 必须匹配（防误释放）。
   */
  release(reservationId: string, ownerId: string, error?: string): Promise<AdmissionReservation> {
    return this.serialize(async () => {
      const all = await this.readAll()
      const r = all.find(x => x.reservationId === reservationId)
      if (!r) throw new AdmissionError('notFound', `admission ${reservationId} not found`)
      if (r.state === 'released') return r // 幂等
      if (r.ownerId !== ownerId && !(r.kind === 'recovery' && ownerId === 'recovery')) {
        throw new AdmissionError('badState', `admission ${reservationId}: owner ${r.ownerId} != ${ownerId}`)
      }
      r.state = 'released'
      r.releasedAt = Date.now()
      if (error !== undefined) r.error = error
      await this.writeAll(all)
      return r
    })
  }

  /** 删除（测试/运维）。 */
  async removeAll(): Promise<void> {
    return this.serialize(async () => {
      await atomicWriteJson(this.statePath(), [])
    })
  }
}
