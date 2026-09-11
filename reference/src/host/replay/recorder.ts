/**
 * ReplayRecorder（M4-D.1）—— 把 A0 canonical bridge（ScreepsService.replayStart/Page/Stop）
 * 录制进 ReplayStore（B.3）：单 writer、cursor/generation、final drain/stop、gap/partial。
 *
 * 语义（plan §5.3/§6.1 step3，测试钉死）：
 *   - begin(match)：replayStart（sourceGeneration 由 bridge 发）→ ReplayStore.create；
 *     重复 begin 同 matchId 幂等（同 replayId/generation）；
 *   - drain(matchId)：replayPage 逐页（limit 200）→ store.append（checkpoint 水位推进）；
 *     多页直到 nextCursor 稳定 / complete；live 局录制循环负责持续消费防 bridge fatal；
 *   - finish(match)：final replayStop（幂等）→ 残余 records append → ReplayStore.finalize
 *     （meta 字段集 = replayMetaHash 权威来源）→ 返回 replay marker receipt
 *     （payloadHash = replayMetaHash，plan §3.2 唯一权威定义）；
 *   - gap/partial：bridge 有 gap/fatal → meta.status='partial' + gapReasons（可 commit，
 *     标 completeness='partial'，不假装完整）；
 *   - 未 begin（无 checkpoint）时 finish 自动 begin（从当前起录）——编排层保证 begin 在
 *     match running 后尽快调；这里兜底不抛，语义 = 只有 stop 后一段时间内的帧。
 */
import type { MatchState } from '../match/model.ts'
import { toReplayMetaHash, type ReplayMeta, type ReplayRecord } from './model.ts'
import type { ReplayStore } from './store.ts'

export interface ReplayBridgeLike {
  replayStart(input: { replayId: string; matchId: string; rooms: string[] }): Promise<{
    schemaVersion: number
    sourceGeneration: string
    cursor: number
    acceptedGameTime: number | null
    queueCapacity: number
  }>
  replayPage(input: {
    replayId: string
    sourceGeneration: string
    cursor?: number
    limit?: number
  }): Promise<{
    replayId: string
    sourceGeneration: string
    cursor: number
    nextCursor: number
    records: unknown[]
    status: 'live' | 'complete' | 'partial'
    complete: boolean
    finalCursor?: number
    gapReasons: string[]
    fatalBackpressure: boolean
  }>
  replayStop(input: { replayId: string; sourceGeneration: string }): Promise<{
    replayId: string
    sourceGeneration: string
    finalCursor: number
    finalGameTime: number | null
    status: 'complete' | 'partial'
    complete: boolean
    gapReasons: string[]
    fatalBackpressure: boolean
    records: unknown[]
  }>
}

export interface FinishOutcome {
  receipt: { resultId: string; payloadHash: string; replayId: string }
  completeness: 'complete' | 'partial'
  gapReasons: string[]
}

export class ReplayRecorder {
  constructor(
    private readonly deps: {
      bridge: ReplayBridgeLike
      store: ReplayStore
      log?: (msg: string) => void
    },
  ) {}

  private log(msg: string): void {
    this.deps.log?.(`replay: ${msg}`)
  }

  /** replayId 派生：attempt 独立 matchId → 独立 replayId（rematch 互不干扰）。 */
  replayIdFor(matchId: string): string {
    return `r-${matchId}`
  }

  async begin(match: MatchState): Promise<{ sourceGeneration: string; replayId: string }> {
    const replayId = this.replayIdFor(match.id)
    const rooms = Object.values(match.assignments ?? {})
    const started = await this.deps.bridge.replayStart({ replayId, matchId: match.id, rooms })
    // create 幂等（同 matchId 同 generation no-op；异 generation conflict 抛）
    await this.deps.store.create(match.id, { replayId, sourceGeneration: started.sourceGeneration })
    this.log(`begin ${match.id}: gen=${started.sourceGeneration} rooms=${rooms.join(',') || '(none)'}`)
    return { sourceGeneration: started.sourceGeneration, replayId }
  }

  /** 拉取并 append 一页。 */
  async drain(
    matchId: string,
    opts: { sourceGeneration: string; replayId: string; cursor?: number },
  ): Promise<{ nextCursor: number; complete: boolean }> {
    const page = await this.deps.bridge.replayPage({
      replayId: opts.replayId,
      sourceGeneration: opts.sourceGeneration,
      cursor: opts.cursor ?? 0,
      limit: 200,
    })
    if (page.records.length > 0) {
      await this.deps.store.append(matchId, {
        records: page.records as ReplayRecord[],
        sourceGeneration: opts.sourceGeneration,
        replayId: opts.replayId,
      })
    }
    return { nextCursor: page.nextCursor, complete: page.complete }
  }

  /** 全量收敛：从 startCursor 起多页拉完直到 bridge complete 或页无进展。 */
  async drainAll(
    matchId: string,
    opts: { sourceGeneration: string; replayId: string },
    maxPages = 1_000,
    startCursor = 0,
  ): Promise<{ lastSeq: number; complete: boolean }> {
    let cursor = startCursor
    let complete = false
    for (let i = 0; i < maxPages; i++) {
      const page = await this.drain(matchId, { ...opts, cursor })
      complete = page.complete
      if (page.nextCursor <= cursor || complete) break
      cursor = page.nextCursor
    }
    return { lastSeq: cursor - 1, complete }
  }

  /**
   * finalize（settle step3 / replay driver）：先全量 drain（bridge 内所有可读页取完，
   * 防 queue 超限 fatal 前把已产帧落盘）→ bridge stop（幂等）→ 残余 append →
   * finalize meta（replayMetaHash 权威字段集）→ receipt。
   */
  async finish(match: MatchState): Promise<FinishOutcome> {
    const replayId = this.replayIdFor(match.id)
    // 有 checkpoint（begin 过）→ 用既有 generation；否则先 begin（兜底，从当前起录）
    let generation = await this.deps.store.getSourceGeneration(match.id)
    if (!generation) {
      generation = (await this.begin(match)).sourceGeneration
    }
    // 1) 全量 drain：从当前可见水位 +1 起拉（append 幂等，不重复落盘）
    const startCursor = (await this.deps.store.watermark(match.id)) + 1
    await this.drainAll(match.id, { sourceGeneration: generation, replayId }, 10_000, startCursor)
    // 2) final stop（幂等）→ 残余 records（seq > 水位）append
    const stopped = await this.deps.bridge.replayStop({ replayId, sourceGeneration: generation })
    const lastSeqBefore = await this.deps.store.watermark(match.id)
    const stoppedRecords = stopped.records as ReplayRecord[]
    const tail = stoppedRecords.filter(r => r.seq > lastSeqBefore)
    if (tail.length > 0) {
      await this.deps.store.append(match.id, {
        records: tail,
        sourceGeneration: generation,
        replayId,
      })
    }
    const lastSeq = await this.deps.store.watermark(match.id)
    const meta: ReplayMeta = {
      schemaVersion: 1,
      replayId,
      sourceGeneration: generation,
      matchId: match.id,
      participantSnapshot: match.players.map(p => ({
        participantId: p.participantId ?? `user-${p.username}`,
        displayName: p.participantId ? p.participantId : p.username,
      })),
      status: stopped.complete ? 'complete' : 'partial',
      recordCount: lastSeq + 1,
      firstSeq: 0,
      lastSeq,
      gapReasons: stopped.gapReasons as ReplayMeta['gapReasons'],
    }
    await this.deps.store.finalize(match.id, meta)
    this.log(`finish ${match.id}: ${meta.status} records=${meta.recordCount} gaps=${meta.gapReasons.join(',') || 'none'}`)
    return {
      receipt: { resultId: match.id, payloadHash: toReplayMetaHash(meta), replayId },
      completeness: stopped.complete ? 'complete' : 'partial',
      gapReasons: meta.gapReasons,
    }
  }
}
