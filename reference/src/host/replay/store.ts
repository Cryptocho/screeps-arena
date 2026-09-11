/**
 * ReplayStore（M4-B.3）—— canonical 公开回放持久化，单 host 单 writer（plan §5.3）。
 *
 * 布局：<dir>/replays/<matchId>/{meta.json, frames.jsonl, checkpoint.json, batches/<batchId>.json}
 *
 * 可见水位契约（测试钉死）：
 *   - checkpoint.lastPersistedSeq 是唯一可见水位；reader 只返回 seq <= lastPersistedSeq；
 *   - append 顺序：frames 行 append + fsync → 原子写 batch manifest（commit marker）→
 *     最后原子写 checkpoint。崩溃在 frames 后 manifest 前 → 该批无 marker，recovery 截断；
 *     崩溃在 manifest 后 checkpoint 前 → marker 在，recovery 校验行数/hash 后推进水位；
 *   - torn tail：最后一行 JSON 不完整 → recovery 截断丢弃；
 *   - 重复 drain 以 (sourceGeneration,seq) 幂等：append 已覆盖的 seq 范围返回既有水位。
 *
 * append 每次一批（drain 分批提交），batch manifest 的 payloadHash = hashV1(该批 records
 * 数组)（canonical key 排序 → JSON 重排后 hash 稳定，recovery 可复算校验）。
 */
import { access, open, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, readJson } from '../store-io.ts'
import { hashV1 } from '../canonical.ts'
import {
  toReplayMetaHash,
  type ReplayBatchManifest,
  type ReplayCheckpoint,
  type ReplayMeta,
  type ReplayRecord,
} from './model.ts'

export class ReplayError extends Error {
  constructor(
    public code: 'notFound' | 'conflict' | 'corrupt' | 'badSeq' | 'io',
    message: string,
  ) {
    super(message)
    this.name = 'ReplayError'
  }
}

export interface ReplayReadPage {
  unavailable: boolean
  matchId: string
  meta?: ReplayMeta
  records: ReplayRecord[]
  /** 下一要读的 record seq（= 最后返回 seq+1；空页 = 入参 cursor）。 */
  nextCursor: number
  /** 可见水位 +1（= 当前已落盘记录总数）。 */
  availableCount: number
  complete: boolean
  status: 'live' | 'complete' | 'partial'
  gapReasons: string[]
}

export interface RecoverReport {
  replayId: string | null
  watermark: number
  truncated: number
  advanced: number
  issues: string[]
}

const FRAMES = 'frames.jsonl'
const CHECKPOINT = 'checkpoint.json'
const META = 'meta.json'
const BATCHES = 'batches'

export class ReplayStore {
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

  private matchDir(matchId: string): string {
    return path.join(this.dir, matchId)
  }

  private framesPath(matchId: string): string {
    return path.join(this.matchDir(matchId), FRAMES)
  }

  private checkpointPath(matchId: string): string {
    return path.join(this.matchDir(matchId), CHECKPOINT)
  }

  private metaPath(matchId: string): string {
    return path.join(this.matchDir(matchId), META)
  }

  private batchesDir(matchId: string): string {
    return path.join(this.matchDir(matchId), BATCHES)
  }

  private batchPath(matchId: string, batchId: string): string {
    return path.join(this.batchesDir(matchId), `${batchId}.json`)
  }

  /* ------------------------------ 文件读 ------------------------------ */

  private async readCheckpoint(matchId: string): Promise<ReplayCheckpoint | null> {
    return readJson<ReplayCheckpoint>(this.checkpointPath(matchId))
  }

  private async readMeta(matchId: string): Promise<ReplayMeta | null> {
    return readJson<ReplayMeta>(this.metaPath(matchId))
  }

  /** 读全部可见行（<= 水位）；torn 尾行（解析失败）跳过并在 issues 记录。 */
  private async readVisibleFrames(matchId: string, watermark: number): Promise<{ rows: ReplayRecord[]; issues: string[] }> {
    const issues: string[] = []
    let raw: string
    try {
      raw = await readFile(this.framesPath(matchId), 'utf8')
    } catch {
      return { rows: [], issues }
    }
    const rows: ReplayRecord[] = []
    const lines = raw.split('\n')
    // 期望行数 = watermark+1；最后一行可能 torn（append 中途崩溃）
    const expected = watermark + 1
    for (let i = 0; i < lines.length && rows.length < expected; i++) {
      const line = lines[i]!
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line) as ReplayRecord)
      } catch {
        issues.push(`torn tail at line ${i}`)
        break
      }
    }
    return { rows, issues }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /** 开局时创建空 replay（meta 未 finalize，status 视为 live）。重复创建幂等。 */
  create(matchId: string, opts: { replayId: string; sourceGeneration: string }): Promise<void> {
    return this.serialize(async () => {
      const existing = await this.readCheckpoint(matchId)
      if (existing) {
        if (existing.replayId && existing.replayId !== opts.replayId) {
          throw new ReplayError('conflict', `replay ${matchId} already exists with replayId ${existing.replayId}`)
        }
        return // 同 replayId 幂等
      }
      await atomicWriteJson(this.checkpointPath(matchId), {
        lastPersistedSeq: -1,
        replayId: opts.replayId,
        sourceGeneration: opts.sourceGeneration,
      } satisfies ReplayCheckpoint)
    })
  }

  /**
   * append 一批 record（seq 必须 > 当前水位且连续）。返回新水位。
   * 崩溃窗口收敛：
   *   - 该批 manifest 已提交而 checkpoint 未推进（crash 在 checkpoint 前）→ 校验帧行数后
   *     推进 checkpoint，幂等返回（不重复 append）；
   *   - frames 含多于水位的无 manifest 残留行（crash 在 manifest 前）→ 先 recoverUnlocked
   *     截断残留再正常 append。
   */
  append(
    matchId: string,
    opts: { records: ReplayRecord[]; sourceGeneration: string; replayId: string },
  ): Promise<number> {
    return this.serialize(async () => {
      if (opts.records.length === 0) {
        const cp = await this.readCheckpoint(matchId)
        return cp?.lastPersistedSeq ?? -1
      }
      let checkpoint = await this.readCheckpoint(matchId)
      if (!checkpoint) throw new ReplayError('notFound', `replay ${matchId} not created`)
      if (checkpoint.sourceGeneration && checkpoint.sourceGeneration !== opts.sourceGeneration) {
        throw new ReplayError(
          'conflict',
          `replay ${matchId}: generation mismatch (${checkpoint.sourceGeneration} vs ${opts.sourceGeneration})`,
        )
      }
      const first = opts.records[0]!.seq
      const last = opts.records[opts.records.length - 1]!.seq
      // seq 连续校验
      for (let i = 0; i < opts.records.length; i++) {
        if (opts.records[i]!.seq !== first + i) {
          throw new ReplayError('badSeq', `replay ${matchId}: seq gap at index ${i} (expected ${first + i})`)
        }
      }
      const batchId = `b${first}-${last}`

      // 幂等重放：manifest 已提交而 checkpoint 未推进（崩溃窗口）
      if (await this.manifestExists(matchId, batchId)) {
        const lineCount = await this.countLines(matchId)
        if (lineCount < last + 1) {
          throw new ReplayError('corrupt', `replay ${matchId}: committed batch ${batchId} has incomplete frames`)
        }
        const next: ReplayCheckpoint = {
          lastPersistedSeq: last,
          replayId: opts.replayId,
          sourceGeneration: opts.sourceGeneration,
        }
        await atomicWriteJson(this.checkpointPath(matchId), next)
        return last
      }

      // 残留收敛：帧行多于可见水位（存在无 manifest 残留 或 已提交批未推进）
      const lineCount = await this.countLines(matchId)
      if (lineCount > checkpoint.lastPersistedSeq + 1) {
        await this.recoverUnlocked(matchId)
        checkpoint = (await this.readCheckpoint(matchId)) ?? checkpoint
        if (checkpoint.lastPersistedSeq >= last) return checkpoint.lastPersistedSeq // recover 已覆盖
      }
      if (first !== checkpoint.lastPersistedSeq + 1) {
        throw new ReplayError(
          'badSeq',
          `replay ${matchId}: first seq ${first} != watermark+1 (${checkpoint.lastPersistedSeq + 1})`,
        )
      }

      // frames 行 append + fsync
      const fh = await open(this.framesPath(matchId), 'a')
      try {
        const text = opts.records.map(r => JSON.stringify(r)).join('\n') + '\n'
        await fh.writeFile(text, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      // manifest（commit marker）
      const manifest: ReplayBatchManifest = {
        batchId,
        schemaVersion: 1,
        sourceGeneration: opts.sourceGeneration,
        replayId: opts.replayId,
        firstSeq: first,
        lastSeq: last,
        recordCount: opts.records.length,
        payloadHash: hashV1(opts.records),
      }
      await atomicWriteJson(this.batchPath(matchId, batchId), manifest)
      // checkpoint 最后推进（唯一可见水位）
      const next: ReplayCheckpoint = {
        lastPersistedSeq: last,
        replayId: opts.replayId,
        sourceGeneration: opts.sourceGeneration,
      }
      await atomicWriteJson(this.checkpointPath(matchId), next)
      return last
    })
  }

  private async manifestExists(matchId: string, batchId: string): Promise<boolean> {
    try {
      await access(this.batchPath(matchId, batchId))
      return true
    } catch {
      return false
    }
  }

  /** frames.jsonl 完整行数（record JSON 无内嵌换行 → 行数 = 非空行数）。 */
  private async countLines(matchId: string): Promise<number> {
    try {
      const raw = await readFile(this.framesPath(matchId), 'utf8')
      if (raw === '') return 0
      return raw.split('\n').filter(l => l.trim() !== '').length
    } catch {
      return 0
    }
  }

  /** finalize：写最终 meta（幂等：同内容返回；异内容 corrupt）。 */
  finalize(matchId: string, meta: ReplayMeta): Promise<void> {
    return this.serialize(async () => {
      const existing = await this.readMeta(matchId)
      if (existing) {
        if (toReplayMetaHash(existing) !== toReplayMetaHash(meta)) {
          throw new ReplayError('corrupt', `replay ${matchId}: meta already finalized with different content`)
        }
        return
      }
      await atomicWriteJson(this.metaPath(matchId), meta)
    })
  }

  /**
   * recovery（启动时对每个 match 目录调用）：
   *   1. 读全部行 + 全部 batch manifests + checkpoint；
   *   2. 从 manifests 推出最大已提交水位（行数覆盖 + payloadHash 匹配才算）；
   *   3. 水位 < checkpoint.lastPersistedSeq → issues（checkpoint 超前 = 目录被外部破坏），
   *      以 checkpoint 为准（它是已承诺水位，manifest 缺失不构成回滚依据）；
   *   4. 截断 frames 到水位（torn/无 marker 残留行丢弃），落后则推进 checkpoint。
   */
  recover(matchId: string): Promise<RecoverReport> {
    return this.serialize(() => this.recoverUnlocked(matchId))
  }

  private async recoverUnlocked(matchId: string): Promise<RecoverReport> {
      const report: RecoverReport = { replayId: null, watermark: -1, truncated: 0, advanced: 0, issues: [] }
      let rawLines: string[]
      try {
        rawLines = (await readFile(this.framesPath(matchId), 'utf8')).split('\n')
      } catch {
        return report // 无 frames → 空 replay，无动作
      }
      // 完整行（丢弃 torn 尾）
      const rows: ReplayRecord[] = []
      for (const line of rawLines) {
        if (line.trim() === '') continue
        try {
          rows.push(JSON.parse(line) as ReplayRecord)
        } catch {
          report.issues.push('torn tail line discarded')
          break
        }
      }
      const cp = await this.readCheckpoint(matchId)
      const priorWatermark = cp?.lastPersistedSeq ?? -1

      // 收集 manifests
      const manifests: ReplayBatchManifest[] = []
      try {
        const files = await readdir(this.batchesDir(matchId))
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          const m = await readJson<ReplayBatchManifest>(path.join(this.batchesDir(matchId), file))
          if (m) manifests.push(m)
        }
      } catch {
        // 无 batches 目录 → 无已提交批
      }
      manifests.sort((a, b) => a.firstSeq - b.firstSeq)

      let watermark = -1
      for (const m of manifests) {
        const slice = rows.slice(m.firstSeq, m.lastSeq + 1)
        if (slice.length !== m.recordCount) {
          report.issues.push(`batch ${m.batchId}: expected ${m.recordCount} rows, found ${slice.length}`)
          continue // 不完整 → 该批未提交可见（其行在截断时被丢弃）
        }
        let seqOk = true
        for (let i = 0; i < slice.length; i++) {
          if (slice[i]!.seq !== m.firstSeq + i) {
            seqOk = false
            break
          }
        }
        if (!seqOk) {
          report.issues.push(`batch ${m.batchId}: seq mismatch`)
          continue
        }
        if (hashV1(slice) !== m.payloadHash) {
          report.issues.push(`batch ${m.batchId}: payloadHash mismatch`)
          continue
        }
        watermark = Math.max(watermark, m.lastSeq)
        report.replayId = m.replayId
      }
      if (watermark < priorWatermark) {
        report.issues.push(`checkpoint (${priorWatermark}) ahead of committed batches (${watermark})`)
        watermark = Math.max(watermark, priorWatermark)
      }
      report.watermark = watermark

      // 截断 frames 到水位（保留已承诺行；torn/无 marker 残留行丢弃）
      if (rows.length > watermark + 1) {
        report.truncated = rows.length - (watermark + 1)
        await this.truncateRewrite(matchId, rows.slice(0, watermark + 1).map(r => JSON.stringify(r)))
      }
      // 推进 checkpoint（落后或缺失时）
      if (cp === null || cp.lastPersistedSeq !== watermark) {
        const meta = await this.readMeta(matchId)
        await atomicWriteJson(this.checkpointPath(matchId), {
          lastPersistedSeq: watermark,
          replayId: report.replayId ?? meta?.replayId ?? cp?.replayId,
          sourceGeneration: meta?.sourceGeneration ?? cp?.sourceGeneration,
        } satisfies ReplayCheckpoint)
        if (cp !== null && cp.lastPersistedSeq < watermark) report.advanced = watermark - cp.lastPersistedSeq
      }
      return report
  }

  /** 以保留行整体重写 frames.jsonl（open 'w' 截断 + fsync；frames 是行文本，非 JSON 文件）。 */
  private async truncateRewrite(matchId: string, lines: string[]): Promise<void> {
    const fh = await open(this.framesPath(matchId), 'w')
    try {
      if (lines.length > 0) await fh.writeFile(lines.join('\n') + '\n', 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
  }

  /* ------------------------------ 读取面 ------------------------------ */

  /**
   * 分页读取（reader 只返回 seq <= 可见水位）。不存在 → unavailable:true。
   * cursor 与 afterTick 二选一：afterTick 做 seek（跳过 gameTime/gap.toTick <= afterTick 的
   * 记录，返回其后的页）。
   */
  async read(
    matchId: string,
    opts: { cursor?: number; limit?: number; afterTick?: number } = {},
  ): Promise<ReplayReadPage> {
    const cp = await this.readCheckpoint(matchId)
    if (!cp) return { unavailable: true, matchId, records: [], nextCursor: 0, availableCount: 0, complete: false, status: 'live', gapReasons: [] }
    const meta = await this.readMeta(matchId)
    const watermark = cp.lastPersistedSeq
    const { rows } = await this.readVisibleFrames(matchId, watermark)
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 200))

    let start = opts.cursor ?? 0
    if (opts.afterTick !== undefined) {
      // seek：找第一个记录在其 afterTick 之后
      start = rows.findIndex(r => (r.kind === 'frame' ? r.gameTime : r.toTick) > opts.afterTick!)
      if (start === -1) start = rows.length
    }
    if (start < 0) start = 0
    const page = rows.slice(start, start + limit)
    const nextCursor = page.length > 0 ? page[page.length - 1]!.seq + 1 : start

    const status = meta ? meta.status : 'live'
    return {
      unavailable: false,
      matchId,
      meta: meta ?? undefined,
      records: page,
      nextCursor,
      availableCount: watermark + 1,
      complete: status === 'complete' && meta!.gapReasons.length === 0,
      status,
      gapReasons: meta?.gapReasons ?? [],
    }
  }

  async getMeta(matchId: string): Promise<ReplayMeta | null> {
    return this.readMeta(matchId)
  }

  /** 已 begin 的 sourceGeneration（checkpoint 有即 begin 过；未 begin 返回 null）。 */
  async getSourceGeneration(matchId: string): Promise<string | null> {
    const cp = await this.readCheckpoint(matchId)
    return cp?.sourceGeneration ?? null
  }

  /** 当前可见水位（lastPersistedSeq；未创建返回 -1）。 */
  async watermark(matchId: string): Promise<number> {
    const cp = await this.readCheckpoint(matchId)
    return cp?.lastPersistedSeq ?? -1
  }

  async exists(matchId: string): Promise<boolean> {
    return (await this.readCheckpoint(matchId)) !== null
  }

  async listReplayIds(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    return entries.sort()
  }

  /** 删除整个 match replay（删除 live match 前由 HTTP 层保证 meta 已 committed）。 */
  remove(matchId: string): Promise<void> {
    return this.serialize(async () => {
      await rm(this.matchDir(matchId), { recursive: true, force: true })
    })
  }
}
