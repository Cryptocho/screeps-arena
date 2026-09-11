/**
 * TournamentStore（M4-B.2）—— 赛事持久化：<dataDir>/tournaments/<id>/state.json +
 * 共享 <dataDir>/tournaments/requests.json 索引 + <id>/receipts/<resultId>.json 结算收据。
 *
 * 可靠性/并发（AGENTS.md 持久化节 + plan-M4 §3.3 唯一 owner）：
 *   - 所有写操作经内部 promise 链 serialize() 串行（读改写排队，杜绝晚写覆盖早写，同 MatchStore）；
 *   - 原子写 = 同目录临时文件 + fsync + rename（随机后缀），复用 store-io.atomicWriteJson；
 *   - 单 host 单 writer；跨进程并发不在承诺范围。
 *
 * 幂等语义（plan-M4 §4.1 step2/step5）：
 *   - createRecruiting(requestId, config)：同 requestId + 同 requestConfigHash → 返回原
 *     tournament（含 failed/interrupted/ready，不创建新 id）；同 requestId + 不同 hash → 409；
 *     无索引 → no-clobber 建 recruiting state + 更新 request index（index 更新失败则回滚
 *     已发布的 state，不留下无索引孤儿）。
 *
 * applyResult（plan-M4 §3.1/§3.2 receipt 语义）：
 *   - 输入完整 MatchResult；resultId = matchId；resultHash = toResultHash(result)（与
 *     HistoryStore 同一份 canonical result 的同一哈希）；
 *   - 先查 receipts/<resultId>.json（prior），经纯引擎 applySlotResult 判定：
 *       ok        → 无 receipt 则 no-clobber 写 receipt（{resultId,resultHash,slotId,
 *                    fromRevision,toRevision}），再发布新 state；prior 同 hash（崩溃窗口，
 *                    state 未发布成功）→ 幂等跳过 receipt 写只发布 state；
 *       idempotent→ 返回当前 state（revision 不变）；
 *       conflict  → 409 不写任何状态（revision/attempt/phase/winner 不匹配）；
 *       corrupt   → 同 resultId 不同 hash → 赛事置 failed + error（禁止继续推进）。
 */
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { toResultHash, type MatchResult } from '../history/model.ts'
import { atomicWriteJson, readJson } from '../store-io.ts'
import {
  applySlotResult,
  isTournamentConfig,
  newTournamentId,
  tournamentRequestConfigHash,
  type TournamentConfig,
  type TournamentState,
} from './model.ts'

const STATE_FILE = 'state.json'
const REQUESTS_FILE = 'requests.json'

export class TournamentError extends Error {
  constructor(
    public code: 'notFound' | 'conflict' | 'badRevision' | 'corrupt' | 'duplicate' | 'io',
    message: string,
  ) {
    super(message)
    this.name = 'TournamentError'
  }
}

export interface RequestIndexEntry {
  tournamentId: string
  requestConfigHash: string
}

export interface TournamentReceipt {
  resultId: string
  resultHash: string
  slotId: string
  fromRevision: number
  toRevision: number
}

export interface ApplyResultOutcome {
  kind: 'ok' | 'idempotent' | 'conflict' | 'corrupt'
  state: TournamentState
  slotRevision: number
  reason?: string
}

export interface ApplyResultInput {
  tournamentId: string
  slotId: string
  expectedSlotRevision: number
  attempt: 0 | 1
  /** resultId 必须 === result.resultId === 结算的 matchId。 */
  result: MatchResult
}

export interface StoreDiagnostic {
  id: string
  reason: string
}

export class TournamentStore {
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

  /* ------------------------------ 路径 ------------------------------ */

  private tournamentDir(id: string): string {
    return path.join(this.dir, id)
  }

  private statePath(id: string): string {
    return path.join(this.tournamentDir(id), STATE_FILE)
  }

  private requestsPath(): string {
    return path.join(this.dir, REQUESTS_FILE)
  }

  private receiptsDir(id: string): string {
    return path.join(this.tournamentDir(id), 'receipts')
  }

  private receiptPath(id: string, resultId: string): string {
    return path.join(this.receiptsDir(id), `${resultId}.json`)
  }

  /* ------------------------------ 读写 ------------------------------ */

  private async readState(id: string): Promise<TournamentState> {
    const parsed = await readJson<TournamentState>(this.statePath(id))
    if (!parsed) throw new TournamentError('notFound', `tournament ${id} not found`)
    if (
      typeof parsed?.id !== 'string' ||
      !isTournamentConfig(parsed.config) ||
      typeof parsed.phase !== 'string' ||
      typeof parsed.revision !== 'number'
    ) {
      throw new TournamentError('corrupt', `tournament ${id}: state.json failed schema check`)
    }
    return parsed
  }

  private async writeState(state: TournamentState): Promise<void> {
    await atomicWriteJson(this.statePath(state.id), state)
  }

  private async readRequestIndex(): Promise<Record<string, RequestIndexEntry>> {
    const idx = await readJson<Record<string, RequestIndexEntry>>(this.requestsPath())
    return idx ?? {}
  }

  /* ------------------------------ 查询面 ------------------------------ */

  async get(id: string): Promise<TournamentState | null> {
    try {
      return await this.readState(id)
    } catch (err) {
      if (err instanceof TournamentError && err.code === 'notFound') return null
      throw err
    }
  }

  /** 经 requests.json 索引按 requestId 查赛事；索引命中但 state 缺失返回 null。 */
  async getByRequestId(requestId: string): Promise<TournamentState | null> {
    const idx = await this.readRequestIndex()
    const entry = idx[requestId]
    if (!entry) return null
    return this.get(entry.tournamentId)
  }

  async list(): Promise<TournamentState[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const out: TournamentState[] = []
    for (const entry of entries) {
      if (entry === REQUESTS_FILE) continue
      try {
        out.push(await this.readState(entry))
      } catch {
        // 半写入/损坏的赛事目录不拖垮 list；terminal 化清理由 recovery/运维显式做
      }
    }
    return out.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
  }

  /** recruiting/ready/running 赛事（单活跃判定面之一；AdmissionGate 汇总）。 */
  async listActive(): Promise<TournamentState[]> {
    const all = await this.list()
    return all.filter(s => s.phase === 'recruiting' || s.phase === 'ready' || s.phase === 'running')
  }

  /** recovery/诊断：坏目录、缺 state 的索引条目不静默消失（plan §3.3 step6）。 */
  async scanDiagnostics(): Promise<StoreDiagnostic[]> {
    const out: StoreDiagnostic[] = []
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return out
    }
    for (const entry of entries) {
      if (entry === REQUESTS_FILE) continue
      try {
        await this.readState(entry)
      } catch (err) {
        out.push({ id: entry, reason: (err as Error).message })
      }
    }
    // 索引指向缺失 state（index 写成功、state 发布失败/被删的孤儿）
    const idx = await this.readRequestIndex()
    for (const [requestId, entry] of Object.entries(idx)) {
      try {
        await this.readState(entry.tournamentId)
      } catch {
        out.push({ id: entry.tournamentId, reason: `request index ${requestId} → missing state` })
      }
    }
    return out
  }

  /* ------------------------------ 创建/索引（createRecruiting） ------------------------------ */

  /**
   * 幂等建赛（plan §4.1 step2/step3）：recruiting state 与 request index 双写。
   * 返回 {state, created}；created=false 表示命中既有同 requestId 同 config 赛事（任意 phase）。
   */
  createRecruiting(requestId: string, config: TournamentConfig): Promise<{ state: TournamentState; created: boolean }> {
    return this.serialize(async () => {
      const requestConfigHash = tournamentRequestConfigHash(config)
      const idx = await this.readRequestIndex()
      const existing = idx[requestId]
      if (existing) {
        if (existing.requestConfigHash !== requestConfigHash) {
          throw new TournamentError(
            'conflict',
            `requestId ${requestId}: same id with a different config hash (${existing.requestConfigHash} vs ${requestConfigHash})`,
          )
        }
        const state = await this.readState(existing.tournamentId) // 缺 state → corrupt 抛出
        return { state, created: false }
      }

      const now = Date.now()
      const state: TournamentState = {
        id: newTournamentId(now),
        requestId,
        config,
        phase: 'recruiting',
        revision: 0,
        participants: [],
        slots: [],
        operations: [],
        createdAt: now,
        updatedAt: now,
      }
      // 先发布 state（state 是事实），再更新 index；index 更新失败 → 回滚 state，不留无索引孤儿
      try {
        await this.writeState(state)
        const nextIdx = { ...idx, [requestId]: { tournamentId: state.id, requestConfigHash } }
        await atomicWriteJson(this.requestsPath(), nextIdx)
      } catch (err) {
        await rm(this.tournamentDir(state.id), { recursive: true, force: true }).catch(() => {})
        throw new TournamentError('io', `createRecruiting ${requestId}: ${(err as Error).message}`)
      }
      return { state, created: true }
    })
  }

  /* ------------------------------ 受控写（revision CAS） ------------------------------ */

  /**
   * revision CAS 更新：读 state → 校验 revision === expectedRevision → mutate → revision+1 → 发布。
   * mutate 不得改写 id/config/createdAt（复制防呆在调用方；此处只保证 revision 单调）。
   */
  update(id: string, expectedRevision: number, mutate: (state: TournamentState) => void): Promise<TournamentState> {
    return this.serialize(async () => {
      const state = await this.readState(id)
      if (state.revision !== expectedRevision) {
        throw new TournamentError('badRevision', `tournament ${id}: expected revision ${expectedRevision}, actual ${state.revision}`)
      }
      mutate(state)
      state.revision += 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /**
   * applyResult（唯一结算入口在 gateway——本方法只被注入的 TournamentGateway 转调）：
   * 校验 → 幂等/冲突/corrupt 判定 → receipt no-clobber → 发布新 state。
   */
  applyResult(input: ApplyResultInput): Promise<ApplyResultOutcome> {
    return this.serialize(async () => {
      const state = await this.readState(input.tournamentId)
      const resultId = input.result.resultId
      const resultHash = toResultHash(input.result)
      const prior = await readJson<TournamentReceipt>(this.receiptPath(input.tournamentId, resultId))

      let outcome: SlotOutcomeLike
      if (input.result.winner.kind === 'participant') {
        outcome = { winnerParticipantId: input.result.winner.participantId }
      } else if (input.result.winner.kind === 'draw') {
        outcome = { draw: true }
      } else {
        return {
          kind: 'conflict',
          state,
          slotRevision: slotRevisionOf(state, input.slotId),
          reason: `tournament result winner must be participant or draw, got session`,
        }
      }

      const engineResult = applySlotResult(state, {
        slotId: input.slotId,
        expectedSlotRevision: input.expectedSlotRevision,
        expectedAttempt: input.attempt,
        resultId,
        resultHash,
        priorResultHash: prior?.resultHash,
        outcome,
      })

      if (engineResult.kind === 'conflict') {
        return { kind: 'conflict', state, slotRevision: slotRevisionOf(state, input.slotId), reason: engineResult.reason }
      }
      if (engineResult.kind === 'idempotent') {
        return { kind: 'idempotent', state, slotRevision: slotRevisionOf(state, input.slotId) }
      }
      if (engineResult.kind === 'corrupt') {
        // 同 resultId 不同 hash：赛事置 failed（engine 不产生 state 变更；revision+1 标记变化）
        const failed: TournamentState = {
          ...state,
          phase: 'failed',
          error: engineResult.reason,
          revision: state.revision + 1,
          updatedAt: Date.now(),
        }
        await this.writeState(failed)
        return { kind: 'corrupt', state: failed, slotRevision: slotRevisionOf(failed, input.slotId), reason: engineResult.reason }
      }

      // ok：先 receipt（无则写），再发布 state
      const nextState = engineResult.state
      const nextSlot = nextState.slots.find(s => s.slotId === input.slotId)
      if (nextSlot && prior && prior.resultHash !== resultHash) {
        // 崩溃窗口：receipt 已写但 state 未绑定，且 hash 冲突 → 真 corrupt
        const failed = { ...nextState, phase: 'failed' as const, error: `applyResult ${resultId}: receipt hash mismatch`, updatedAt: Date.now() }
        await this.writeState(failed)
        return { kind: 'corrupt', state: failed, slotRevision: slotRevisionOf(failed, input.slotId), reason: `receipt hash mismatch` }
      }
      if (!prior) {
        const receipt: TournamentReceipt = {
          resultId,
          resultHash,
          slotId: input.slotId,
          fromRevision: input.expectedSlotRevision,
          toRevision: nextSlot?.revision ?? input.expectedSlotRevision + 1,
        }
        await atomicWriteJson(this.receiptPath(input.tournamentId, resultId), receipt)
      }
      await this.writeState(nextState)
      return { kind: 'ok', state: nextState, slotRevision: nextSlot?.revision ?? input.expectedSlotRevision + 1 }
    })
  }

  /** 测试/运维：删除整个赛事目录（不做归档保护；HTTP 层无 DELETE tournament）。 */
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      await rm(this.tournamentDir(id), { recursive: true, force: true })
    })
  }
}

type SlotOutcomeLike = { winnerParticipantId: string } | { draw: true }

function slotRevisionOf(state: TournamentState, slotId: string): number {
  return state.slots.find(s => s.slotId === slotId)?.revision ?? -1
}
