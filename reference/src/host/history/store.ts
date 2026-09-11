/**
 * HistoryStore（M4-B.3）—— 不可变 MatchResult 归档 + leaderboard 查询。
 *
 * 布局：<dir>/history/<matchId>.json（主键 = matchId；每个 rematch attempt 独立一条）。
 *
 * 语义（plan §6.2，测试钉死）：
 *   - put(result)：no-clobber 不可变；同 resultId 同 resultHash → 幂等返回既有；
 *     同 resultId 异 hash → corrupt（不覆盖既有结果）；
 *   - abort 孤儿（put 在 commit 前、abort 后落盘）→ updateDiagnostics 加标
 *     'settlement-aborted'：不可变结果的核心内容（resultHash 字段集）不含 diagnostics，
 *     加标不改 hash → 外部 receipt 校验不受影响；加标结果不计入 leaderboard、不出现在
 *     公开 DTO（聚合纯函数 + HTTP 层过滤）；
 *   - leaderboard/公开 history 只读已 commit（无 aborted diagnostics）的结果；
 *   - 单 host 单 writer，写操作串行链。
 */
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, readJson } from '../store-io.ts'
import {
  aggregateLeaderboard,
  toResultHash,
  type HistoryDiagnostics,
  type LeaderboardPage,
  type LeaderboardOptions,
  type MatchResult,
} from './model.ts'

export class HistoryError extends Error {
  constructor(
    public code: 'notFound' | 'conflict' | 'corrupt' | 'io',
    message: string,
  ) {
    super(message)
    this.name = 'HistoryError'
  }
}

export interface PutResultOutcome {
  kind: 'ok' | 'idempotent'
  result: MatchResult
  resultHash: string
}

export interface StoreDiagnostic {
  id: string
  reason: string
}

export class HistoryStore {
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

  private resultPath(matchId: string): string {
    return path.join(this.dir, `${matchId}.json`)
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 幂等不可变 put。 */
  put(result: MatchResult): Promise<PutResultOutcome> {
    return this.serialize(async () => {
      const resultHash = toResultHash(result)
      const existing = await readJson<MatchResult>(this.resultPath(result.resultId))
      if (existing) {
        if (toResultHash(existing) !== resultHash) {
          throw new HistoryError('corrupt', `history ${result.resultId}: existing result has different hash`)
        }
        return { kind: 'idempotent', result: existing, resultHash }
      }
      await atomicWriteJson(this.resultPath(result.resultId), result)
      return { kind: 'ok', result, resultHash }
    })
  }

  /**
   * 给 abort 孤儿加 diagnostics 标（幂等）。核心内容 hash 不变（diagnostics 不在 resultHash
   * 字段集），因此历史里不可变结果仍与 receipt 一致。
   */
  markDiagnostics(resultId: string, diagnostics: HistoryDiagnostics): Promise<MatchResult> {
    return this.serialize(async () => {
      const existing = await readJson<MatchResult>(this.resultPath(resultId))
      if (!existing) throw new HistoryError('notFound', `history ${resultId} not found`)
      if (existing.diagnostics === diagnostics) return existing
      const marked = { ...existing, diagnostics }
      await atomicWriteJson(this.resultPath(resultId), marked)
      return marked
    })
  }

  /** 测试/运维删除（真实删除前必须先确认已 committed 归档语义，见 plan §6.2 DELETE）。 */
  remove(matchId: string): Promise<void> {
    return this.serialize(async () => {
      await rm(this.resultPath(matchId), { force: true })
    })
  }

  /* ------------------------------ 读取 ------------------------------ */

  async get(matchId: string): Promise<MatchResult | null> {
    return readJson<MatchResult>(this.resultPath(matchId))
  }

  async list(): Promise<MatchResult[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const out: MatchResult[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const r = await readJson<MatchResult>(path.join(this.dir, entry)).catch(() => null)
      if (r) out.push(r)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.resultId.localeCompare(b.resultId))
  }

  /** leaderboard 聚合（过滤 abort 孤儿与无 participantId 的普通局由纯函数内部完成）。 */
  async leaderboard(opts: LeaderboardOptions = {}): Promise<LeaderboardPage> {
    const all = await this.list()
    return aggregateLeaderboard(all, opts)
  }

  async scanDiagnostics(): Promise<StoreDiagnostic[]> {
    const out: StoreDiagnostic[] = []
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return out
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const r = await readJson<MatchResult>(path.join(this.dir, entry)).catch(() => null)
      if (!r) out.push({ id: entry.replace(/\.json$/, ''), reason: 'unreadable or failed schema check' })
    }
    return out
  }
}
