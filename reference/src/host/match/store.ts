/**
 * 对局持久化（S8 + M4-B）—— 每场对局一个目录 <dir>/<matchId>/state.json。
 *
 * 可靠性约定（AGENTS.md 持久化节）：临时文件 + fsync + 原子发布（rename）；
 * 不碰 DSH 的 session 存储；store 不解释业务，只做读改写与状态机校验。
 * 单进程 host 假设下不做文件锁——同一 host 内由 MatchStore 实例串行化（M3 实证：
 * 并发 update/transition 的「读-改写」若不串行，晚写者基于旧快照覆盖先写者的
 * phase 变更；修复 = 全部写操作经内部 promise 链串行，每个操作读到的是上一个
 * 操作落盘后的最新 state）。
 *
 * M4-B settling（plan §3.2，测试钉死）：
 *   - running/paused ──beginSettlement──> settling ──commitSettlement──> settled；
 *     settling 只可 commitSettlement 或显式 abortSettlement 离开（recovery 专用）；
 *   - 通用 transition() 拒绝 settling→interrupted（防覆盖）与 running/paused→settled
 *     （settled 只能经 settlement 流程到达）；
 *   - markInterrupted 跳过 settling（recovery reconcile 收敛，不直接覆盖）；
 *   - 新写 API（begin/mark/commit/markCleanup/abort）全部 revision CAS；
 *     旧 state 无 revision 读作 0，首个新写操作落盘升级；
 *   - 旧 API（create/transition/update/addPlayer/settle/markInterrupted）语义保持 M3，
 *     legacy settle 仍可直接 running/paused → settled（供旧测试/工具面兼容路径；
 *     lifecycle 一律走新 journal 流程）。
 */
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { hashV1 } from '../canonical.ts'
import {
  canTransition,
  isActivePhase,
  isMatchConfig,
  newMatchId,
  type CandidateParticipantSnapshot,
  type JournalMarker,
  type MatchConfig,
  type MatchPhase,
  type MatchPlayer,
  type MatchState,
  type MarkerStatus,
  type ReplayJournalMarker,
  type SettleReason,
  type SettlementJournal,
  type SettlementReceiptRef,
  type WinnerRef,
  type CodeMode,
  configFromPreset,
} from './model.ts'

const STATE_FILE = 'state.json'

export class MatchError extends Error {
  constructor(
    public code:
      | 'activeExists'
      | 'notFound'
      | 'badTransition'
      | 'full'
      | 'badPhase'
      | 'duplicatePlayer'
      | 'corrupt'
      | 'conflict'
      | 'badRevision',
    message: string,
  ) {
    super(message)
    this.name = 'MatchError'
  }
}

export type SettlementMarkerName = 'replay' | 'history' | 'tournament'

export interface BeginCandidate {
  reason: SettleReason
  winner: WinnerRef
  scores: Record<string, number>
  kills: Record<string, number>
  losses: Record<string, number>
  endTick: number
  participantMapping: CandidateParticipantSnapshot[]
}

/** begin 时各外部 marker 的预期模式（调用方（lifecycle）按是否装配 driver/是否赛事局决策）。 */
export interface BeginModes {
  replay: 'enabled' | 'na'
  history: 'enabled' | 'na'
  tournament: 'enabled' | 'na'
}

export interface MarkReceipt {
  resultId: string
  payloadHash: string
  storeRevision?: number
  replayId?: string
}

export class MatchStore {
  constructor(readonly dir: string) {}

  /** 写操作串行链：每个读改写排队执行，杜绝「晚写覆盖早写」竞态（见文件头注释）。 */
  private chain: Promise<unknown> = Promise.resolve()

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn())
    // 链上吞掉错误：每个调用者拿到自己的 rejection，不污染后续排队操作
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private matchDir(id: string): string {
    return path.join(this.dir, id)
  }

  private statePath(id: string): string {
    return path.join(this.matchDir(id), STATE_FILE)
  }

  /** 原子写：同目录临时文件 → fsync → rename。tmp 名带随机后缀（同一进程内并发写
   *  不共用 tmp——start 编排与 spawn 收尾可能并发 update，固定 pid 后缀会互相 rename 踩踏） */
  private async writeState(state: MatchState): Promise<void> {
    await mkdir(this.matchDir(state.id), { recursive: true })
    const tmp = path.join(this.matchDir(state.id), `${STATE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    const json = JSON.stringify(state)
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(json, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, this.statePath(state.id))
  }

  private async readState(id: string): Promise<MatchState> {
    let parsed: MatchState
    try {
      parsed = JSON.parse(await readFile(this.statePath(id), 'utf8')) as MatchState
    } catch (err) {
      throw new MatchError('corrupt', `match ${id}: state.json unreadable (${(err as Error).message})`)
    }
    if (typeof parsed?.id !== 'string' || !isMatchConfig(parsed.config) || typeof parsed?.phase !== 'string') {
      // M5 升级迁移（二审次要 2）：旧 world-live 预设已从 PRESETS 删除，存量 state.json 无法通过
      // isMatchConfig（preset 硬校验）→ 就地改写为 world-rounds + 标 interrupted + error 注明，
      // 落盘一次（幂等：改写后 preset 已非 world-live，不再触发）。不破坏 list()/active()。
      const legacy = parsed as unknown as { config?: { preset?: unknown }; phase?: unknown; id?: unknown } | undefined
      if (legacy?.config?.preset === 'world-live') {
        const migrated = parsed as MatchState
        migrated.config.preset = 'world-rounds'
        if (isActivePhase(migrated.phase)) migrated.phase = 'interrupted'
        migrated.error = (migrated.error ? migrated.error + '; ' : '') + 'legacy world-live retired (M5): marked interrupted'
        migrated.revision = (migrated.revision ?? 0) + 1
        migrated.updatedAt = Date.now()
        await this.writeState(migrated)
        // 改写后 config 已合法，走正常返回路径
        if (migrated.revision === undefined) migrated.revision = 0
        return migrated
      }
      throw new MatchError('corrupt', `match ${id}: state.json failed schema check`)
    }
    // 旧 state 无 revision：归一为 0（首个新写操作落盘升级为显式字段）
    if (parsed.revision === undefined) parsed.revision = 0
    return parsed
  }

  /** 新建对局；同目录已有活跃对局时拒绝（一台服务器一场）。 */
  create(config: MatchConfig, firstPlayer?: Omit<MatchPlayer, 'joinedAt'>, meta?: { codeMode?: CodeMode }): Promise<MatchState> {
    return this.serialize(async () => {
      const existing = await this.list()
      const active = existing.find(m => isActivePhase(m.phase))
      if (active) throw new MatchError('activeExists', `active match ${active.id} (${active.phase}) must settle first`)
      const now = Date.now()
      const state: MatchState = {
        id: newMatchId(now),
        createdAt: now,
        updatedAt: now,
        phase: 'creating',
        config,
        codeMode: meta?.codeMode ?? (config.frozenCode ? 'frozen' : 'live'),
        revision: 0,
        players: [],
      }
      if (firstPlayer) this.addPlayerInPlace(state, { ...firstPlayer, joinedAt: now })
      await this.writeState(state)
      return state
    })
  }

  /**
   * M4-C 赛事 attempt 专用：一次 serialized 操作创建完整两席 MatchState（plan §4.2——
   * 不调用普通 create/join，不会出现半个 roster）。config 固定 arena-blitz（Match seats=2）。
   * roundToken 只存 hash（SHA-256，hashVersion=1）；明文只在 orchestrator 内存/prompt。
   */
  createTournament(input: {
    tournamentId: string
    slotId: string
    attempt: 0 | 1
    roundTokenHash: string
    players: Array<Omit<MatchPlayer, 'joinedAt'>>
    tickDuration?: number
    codeMode?: 'round'
  }): Promise<MatchState> {
    return this.serialize(async () => {
      const existing = await this.list()
      const active = existing.find(m => isActivePhase(m.phase))
      if (active) throw new MatchError('activeExists', `active match ${active.id} (${active.phase}) must settle first`)
      if (input.players.length !== 2) {
        throw new MatchError('full', `tournament attempt requires exactly 2 players (got ${input.players.length})`)
      }
      const now = Date.now()
      const config = configFromPreset('arena-blitz')
      if (input.tickDuration !== undefined && Number.isFinite(input.tickDuration) && input.tickDuration > 0) {
        config.tickDuration = input.tickDuration
      }
      const state: MatchState = {
        id: newMatchId(now),
        createdAt: now,
        updatedAt: now,
        phase: 'creating',
        config,
        codeMode: input.codeMode ?? 'round',
        revision: 0,
        spawnedBy: 'tournament',
        tournamentId: input.tournamentId,
        tournamentSlotId: input.slotId,
        attempt: input.attempt,
        roundTokenHash: input.roundTokenHash,
        players: input.players.map(p => ({ ...p, joinedAt: now })),
      }
      await this.writeState(state)
      return state
    })
  }

  async get(id: string): Promise<MatchState | null> {
    try {
      await stat(this.statePath(id))
    } catch {
      return null
    }
    return this.readState(id)
  }

  /** 列出全部对局（目录序）；单个坏文件跳过不拖垮列表。 */
  async list(): Promise<MatchState[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const states: MatchState[] = []
    for (const entry of entries) {
      try {
        states.push(await this.readState(entry))
      } catch {
        // 半写入/损坏的对局目录不拖垮 list；terminal 化清理由运维显式做
      }
    }
    return states.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
  }

  async active(): Promise<MatchState | null> {
    const all = await this.list()
    return all.find(m => isActivePhase(m.phase)) ?? null
  }

  /** M4-B recovery 扫描：不改状态，分类返回 active / settling / tournament-owned active。 */
  async scanActive(): Promise<{
    /** 普通 + tournament 的 creating/placing/running/paused（不含 settling）。 */
    active: MatchState[]
    /** settling（只能 reconcile/abort 收敛）。 */
    settling: MatchState[]
    /** 带 tournamentId 的 active（含 settling；级联中断候选）。 */
    tournamentOwned: MatchState[]
  }> {
    const all = await this.list()
    const active = all.filter(m => isActivePhase(m.phase) && m.phase !== 'settling')
    const settling = all.filter(m => m.phase === 'settling')
    const tournamentOwned = all.filter(m => isActivePhase(m.phase) && m.tournamentId !== undefined)
    return { active, settling, tournamentOwned }
  }

  /** M4-B recovery 诊断：坏目录/缺 state 不静默消失（plan §3.3 step6）。 */
  async scanDiagnostics(): Promise<Array<{ id: string; reason: string }>> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const out: Array<{ id: string; reason: string }> = []
    for (const entry of entries) {
      try {
        await this.readState(entry)
      } catch (err) {
        out.push({ id: entry, reason: (err as Error).message })
      }
    }
    return out
  }

  /** 通用字段变更（players/userId 回填等）；不改 phase——阶段流转走 transition()。 */
  update(id: string, mutate: (state: MatchState) => void): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(id)
      mutate(state)
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /** 阶段流转。M4-B：settling 只可经 commitSettlement/abortSettlement 离开（通用 transition 全拒）；
   * running/paused/roundBreak→settled 仅经 settlement journal。 */
  transition(id: string, to: MatchPhase, extra?: Partial<Pick<MatchState, 'startTick' | 'phaseTick' | 'endTick' | 'winner' | 'scores' | 'assignments'>>): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(id)
      if (state.phase === 'settling' && (to === 'interrupted' || to === 'settled')) {
        throw new MatchError('badTransition', `match ${id}: settling can only leave via commitSettlement or abortSettlement`)
      }
      if ((state.phase === 'running' || state.phase === 'paused' || state.phase === 'roundBreak') && to === 'settled') {
        throw new MatchError('badTransition', `match ${id}: settled can only be reached through the settlement journal (begin → commit)`)
      }
      if (!canTransition(state.phase, to)) {
        throw new MatchError('badTransition', `match ${id}: ${state.phase} → ${to} not allowed`)
      }
      state.phase = to
      if (extra) Object.assign(state, extra)
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /** 报名（creating/placing 阶段）；座位满、重复会话均拒绝。 */
  addPlayer(id: string, player: Omit<MatchPlayer, 'joinedAt'>): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(id)
      this.addPlayerInPlace(state, { ...player, joinedAt: Date.now() })
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  private addPlayerInPlace(state: MatchState, player: MatchPlayer): void {
    if (!isActivePhase(state.phase)) throw new MatchError('badPhase', `match ${state.id}: cannot join in ${state.phase}`)
    if (state.players.some(p => p.sessionId === player.sessionId)) {
      throw new MatchError('duplicatePlayer', `match ${state.id}: session ${player.sessionId} already joined`)
    }
    if (state.players.length >= state.config.seats) throw new MatchError('full', `match ${state.id}: seats full (${state.config.seats})`)
    state.players.push(player)
  }

  /** host 启动时调用：把上次进程死掉时留下的活跃对局打上 interrupted（AGENTS.md 恢复约定）。
   * M4-B：settling 不被覆盖（recovery reconcile 收敛），只处理其余 active。 */
  markInterrupted(): Promise<MatchState[]> {
    return this.serialize(async () => {
      const all = await this.list()
      const hit: MatchState[] = []
      for (const state of all) {
        if (!isActivePhase(state.phase) || state.phase === 'settling') continue
        state.phase = 'interrupted'
        state.updatedAt = Date.now()
        await this.writeState(state)
        hit.push(state)
      }
      return hit
    })
  }

  /** legacy 结算写分（M3 语义；新流程一律走 beginSettlement → … → commitSettlement）。
   * 只接受 running/paused/roundBreak（settling 由 journal 收敛，settled/interrupted 终态）。 */
  settle(id: string, winner: WinnerRef, scores: Record<string, number>, endTick: number): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(id)
      if (state.phase !== 'running' && state.phase !== 'paused' && state.phase !== 'roundBreak') {
        throw new MatchError('badTransition', `match ${id}: settle only allowed from running/paused/roundBreak (phase=${state.phase})`)
      }
      state.phase = 'settled'
      state.winner = winner
      state.scores = scores
      state.endTick = endTick
      state.revision = (state.revision ?? 0) + 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /** 删除一场对局（含目录）；测试与运维用。 */
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      await rm(this.matchDir(id), { recursive: true, force: true })
    })
  }

  /* ================================ M4-B：settlement journal API ================================ */

  private assertRevision(state: MatchState, expectedRevision: number | undefined, id: string): void {
    if (expectedRevision === undefined) return
    if (state.revision !== expectedRevision) {
      throw new MatchError('badRevision', `match ${id}: expected revision ${expectedRevision}, actual ${state.revision}`)
    }
  }

  private candidateHash(matchId: string, candidate: BeginCandidate, attempt: 0 | 1 | undefined): string {
    const payload: Record<string, unknown> = {
      matchId,
      reason: candidate.reason,
      winner: candidate.winner,
      scores: candidate.scores,
      endTick: candidate.endTick,
      participantMapping: candidate.participantMapping,
    }
    if (attempt !== undefined) payload.attempt = attempt
    return hashV1(payload)
  }

  /**
   * beginSettlement（plan API 1）：running/paused/roundBreak → settling，固定 journal（candidateHash 不可改写）。
   * 无 journal → 按 modes 预置 marker 初值 + phase=settling + revision+1。
   * 已 settling 且同 candidateHash → 幂等返回；异 candidate → conflict（不重算/不覆盖）。
   */
  beginSettlement(matchId: string, candidate: BeginCandidate, modes: BeginModes, expectedRevision?: number): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(matchId)
      if (state.phase !== 'running' && state.phase !== 'paused' && state.phase !== 'roundBreak') {
        if (state.phase === 'settling') {
          // 幂等 / conflict
          const existingHash = state.settlement?.candidateHash
          const hash = this.candidateHash(matchId, candidate, state.attempt)
          if (existingHash === hash) return state
          throw new MatchError('conflict', `match ${matchId}: already settling with a different candidate`)
        }
        throw new MatchError('badTransition', `match ${matchId}: beginSettlement only from running/paused/roundBreak (phase=${state.phase})`)
      }
      this.assertRevision(state, expectedRevision, matchId)
      const journal: SettlementJournal = {
        settlementId: matchId,
        candidateHash: this.candidateHash(matchId, candidate, state.attempt),
        hashVersion: 1,
        reason: candidate.reason,
        winner: candidate.winner,
        scores: candidate.scores,
        kills: candidate.kills,
        losses: candidate.losses,
        endTick: candidate.endTick,
        participantMapping: candidate.participantMapping,
        replay: modes.replay === 'enabled' ? { status: 'pending' } : { status: 'not-applicable' },
        history: modes.history === 'enabled' ? { status: 'pending' } : { status: 'not-applicable' },
        tournament: modes.tournament === 'enabled' ? { status: 'pending' } : { status: 'not-applicable' },
        cleanup: state.tournamentId !== undefined ? { status: 'not-applicable' } : { status: 'pending' },
      }
      state.settlement = journal
      state.phase = 'settling'
      state.revision = (state.revision ?? 0) + 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /**
   * markSettlement（plan API 2）：写单个外部 marker（replay/history/tournament）→ committed。
   * 前置：settling、expectedRevision、marker 当前 pending、receipt.resultId === matchId。
   * 幂等：marker 已 committed 且 receipt.payloadHash 相同 → 返回；异 → conflict。
   * marker 只能 pending → committed 一次，不能回退。
   */
  markSettlement(
    matchId: string,
    expectedRevision: number,
    markerName: SettlementMarkerName,
    receipt: MarkReceipt,
    extra?: { completeness?: 'complete' | 'partial'; gapReasons?: string[] },
  ): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(matchId)
      if (state.phase !== 'settling' || !state.settlement) {
        throw new MatchError('badPhase', `match ${matchId}: markSettlement only while settling`)
      }
      this.assertRevision(state, expectedRevision, matchId)
      const marker: JournalMarker | ReplayJournalMarker = state.settlement[markerName]
      if (marker.status === 'not-applicable') {
        throw new MatchError('badTransition', `match ${matchId}: marker ${markerName} is not-applicable for this settlement`)
      }
      if (marker.status === 'committed') {
        if (marker.receipt?.payloadHash === receipt.payloadHash && marker.receipt.resultId === receipt.resultId) return state
        throw new MatchError('conflict', `match ${matchId}: marker ${markerName} already committed with a different receipt`)
      }
      if (receipt.resultId !== matchId) {
        throw new MatchError('conflict', `match ${matchId}: receipt resultId ${receipt.resultId} != matchId`)
      }
      marker.status = 'committed'
      marker.receipt = {
        resultId: receipt.resultId,
        payloadHash: receipt.payloadHash,
        ...(receipt.storeRevision !== undefined ? { storeRevision: receipt.storeRevision } : {}),
        ...(receipt.replayId !== undefined ? { replayId: receipt.replayId } : {}),
      }
      if (markerName === 'replay' && extra) {
        const rm = marker as ReplayJournalMarker
        if (extra.completeness) rm.completeness = extra.completeness
        if (extra.gapReasons) rm.gapReasons = extra.gapReasons
      }
      state.revision = (state.revision ?? 0) + 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /**
   * commitSettlement（plan API 3）：settling → settled。要求 replay/history/tournament 均
   * committed/not-applicable；把 journal candidate 复制到 state.winner/scores/endTick。
   * 已 settled（reconcile 重复 commit）→ 幂等返回。
   */
  commitSettlement(matchId: string, expectedRevision: number): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(matchId)
      if (state.phase === 'settled') return state // 幂等
      if (state.phase !== 'settling' || !state.settlement) {
        throw new MatchError('badPhase', `match ${matchId}: commitSettlement only while settling`)
      }
      this.assertRevision(state, expectedRevision, matchId)
      const j = state.settlement
      for (const name of ['replay', 'history', 'tournament'] as SettlementMarkerName[]) {
        const s = j[name].status
        if (s !== 'committed' && s !== 'not-applicable') {
          throw new MatchError('badPhase', `match ${matchId}: cannot commit with marker ${name}=${s}`)
        }
      }
      state.phase = 'settled'
      state.winner = j.winner
      state.scores = j.scores
      state.endTick = j.endTick
      state.revision = (state.revision ?? 0) + 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /**
   * markCleanup（plan API 4）：settled 后记录 hook 结果。hook 成功 → committed；失败 →
   * unknown + error；tournament 局 → not-applicable。cleanup 不影响已提交的 winner/history/tournament。
   */
  markCleanup(matchId: string, expectedRevision: number, status: 'committed' | 'unknown' | 'not-applicable', error?: string): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(matchId)
      if (state.phase !== 'settled' || !state.settlement) {
        throw new MatchError('badPhase', `match ${matchId}: markCleanup only after commit (settled)`)
      }
      this.assertRevision(state, expectedRevision, matchId)
      const cleanup = state.settlement.cleanup
      if (cleanup.status === 'committed' || cleanup.status === 'unknown') {
        if (cleanup.status === status && (cleanup.error ?? undefined) === error) return state // 幂等
        // 已 unknown 可再尝试 → 允许更新为 committed/unknown
      }
      cleanup.status = status
      if (error !== undefined) cleanup.error = error
      else delete cleanup.error
      state.revision = (state.revision ?? 0) + 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }

  /**
   * abortSettlement（plan API 6）：仅供恢复器在确认 receipt 冲突 / 不可修复 host 错误 /
   * 清理策略明确放弃时使用。settling → interrupted + journal.error。普通网络错误不允许直接
   * abort（丢 candidate）——由 reconcile 重试。
   */
  abortSettlement(matchId: string, expectedRevision: number, error: string): Promise<MatchState> {
    return this.serialize(async () => {
      const state = await this.readState(matchId)
      if (state.phase !== 'settling' || !state.settlement) {
        throw new MatchError('badPhase', `match ${matchId}: abortSettlement only while settling`)
      }
      this.assertRevision(state, expectedRevision, matchId)
      state.settlement.error = error
      state.phase = 'interrupted'
      state.revision = (state.revision ?? 0) + 1
      state.updatedAt = Date.now()
      await this.writeState(state)
      return state
    })
  }
}
