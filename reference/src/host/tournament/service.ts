/**
 * TournamentService（M4-C.1/C.2）—— 赛事生命周期服务：唯一 owner 持有 TournamentStore 与
 * 本赛事编排器；经 shared AdmissionGate 进入；recruit/start/dispose。
 *
 * 结构（plan §3.3）：
 *   ScreepsService
 *   ├─ MatchService / MatchStore
 *   ├─ TournamentService
 *   │  ├─ TournamentStore
 *   │  └─ TournamentOrchestrator (handlesByTournament)
 *   └─ shared AdmissionGate (AdmissionStore)
 *
 * 建赛语义（plan §4.1，测试钉死）：
 *   - createTournament(requestId, config, operationId)：先 AdmissionGate
 *     'tournament-create' 排他 → TournamentStore.createRecruiting（requestId/configHash
 *     幂等）→ recruiting state 持久化后才 fire-and-forget recruit；HTTP 层（M4-D）对
 *     create 返回 202 后再轮询 state，本 service 不承诺同步 recruit 完成；
 *   - recruit(operationId, tournamentId)：roster = seats 个会话按 config/operation 派生
 *     （sessionId 预分配，participant 身份由 store CAS 写 participants）→ 逐个
 *     registry.create + handle 即时登记 → 全部成功 CAS recruiting→ready → 任意失败
 *     CAS failed + dispose 已登记 handles → finally release reservation；
 *   - retry（plan §4.1 step5）：同 requestId+同 config 默认返回原 state；仅显式
 *     retry:true + 新 operationId 时 CAS failed/interrupted→recruiting 复用原身份；
 *   - dispose()：停止新编排、dispose 全部 handles、按 finally 语义让位。
 *
 * registry/AgentRegistryLike 惰性获取（同 M3 SpawnOrchestrator 模式：单测直接注入 fake
 * registry，真实运行时从 ctx.agents 取）——本类构造不要求 registry 存在。
 */
import { randomUUID } from 'node:crypto'
import type { AgentHandleLike, AgentRegistryLike } from '../agents.ts'
import type { MatchService } from '../match/match-service.ts'
import type { TournamentConfig, TournamentState } from './model.ts'
import { allocateParticipants } from './model.ts'
import { TournamentError, TournamentStore } from './store.ts'
import type { AdmissionGate } from '../admission/gate.ts'
import { TournamentOrchestrator } from './orchestrator.ts'
import type { MatchState } from '../match/model.ts'

export interface TournamentServiceOptions {
  store: TournamentStore
  gate: AdmissionGate
  match: MatchService
  /** 获取 DSH AgentRegistry；未装 dsh-agent 时返回 null（recruit 时报可读错）。 */
  registry: () => AgentRegistryLike | null
  /** 编排阶段轮询超时（ms；C.4 start/advance 用）。 */
  timeoutMs: number
  log?: (msg: string) => void
  /** roster session 前缀（可读、不与 __bot__ 保留名前缀冲突）。 */
  sessionPrefix?: string
}

export interface TournamentCreateResult {
  tournamentId: string
  operationId: string
  recruiting: boolean
  state: TournamentState
}

export class TournamentService {
  private readonly store: TournamentStore
  private readonly gate: AdmissionGate
  private readonly match: MatchService
  private readonly registry: () => AgentRegistryLike | null
  private readonly timeoutMs: number
  private readonly log: (msg: string) => void
  private readonly sessionPrefix: string
  /** tournamentId → 已登记 handle（registry.create 成功后立即登记；dispose 时统一回收）。 */
  private readonly handlesByTournament = new Map<string, AgentHandleLike[]>()
  /** 推进编排器（start/激活/onMatchSettled）。 */
  private readonly orchestrator: TournamentOrchestrator

  constructor(opts: TournamentServiceOptions) {
    this.store = opts.store
    this.gate = opts.gate
    this.match = opts.match
    this.registry = opts.registry
    this.timeoutMs = opts.timeoutMs
    this.log = opts.log ?? (() => {})
    this.sessionPrefix = opts.sessionPrefix ?? 'screeps-tournament-'
    this.orchestrator = new TournamentOrchestrator({
      store: this.store,
      match: this.match,
      handlesOf: tournamentId => this.handlesByTournament.get(tournamentId) ?? [],
      log: msg => this.log(msg),
    })
  }

  /** 测试/编排可见：当前登记的 handle 数（dispose 后归零）。 */
  get handleCount(): number {
    return [...this.handlesByTournament.values()].reduce((n, hs) => n + hs.length, 0)
  }

  /** 只读 store 引用（测试/恢复协调器用）。 */
  get storeRef(): TournamentStore {
    return this.store
  }

  /** 测试可见：某赛事登记的 handle id。 */
  handlesOf(tournamentId: string): string[] {
    return (this.handlesByTournament.get(tournamentId) ?? []).map(h => h.agent.id)
  }

  /* ------------------------------ 建赛入口 ------------------------------ */

  /**
   * 建赛（plan §4.1）：gate 排他 'tournament-create' → createRecruiting 幂等。
   * recruiting state 落盘后才启动 recruit 编排（fire-and-forget 由调用方决定；
   * 本方法提供 awaitRecruit=false 语义返回，HTTP 层拿 202）。
   */
  async create(
    requestId: string,
    config: TournamentConfig,
    operationId: string,
    opts: { awaitRecruit?: boolean } = {},
  ): Promise<TournamentCreateResult> {
    const { state, created } = await this.gate.runExclusive('tournament-create', operationId, requestId, async () =>
      this.store.createRecruiting(requestId, config),
    )
    if (created && opts.awaitRecruit) {
      // recruiting 已持久化 → 编排 recruit（失败写 state，抛错让调用方可见）
      await this.recruit(operationId, state.id)
    }
    const latest = await this.store.get(state.id)
    const current = latest ?? state
    return {
      tournamentId: current.id,
      operationId,
      recruiting: current.phase === 'recruiting',
      state: current,
    }
  }

  /**
   * recruit 编排（plan §4.1 step4）：roster 会话按 config.seats 派生（preassigned
   * sessionId），participant 身份（participantId/displayName/seed）由 CAS 写 state；
   * 逐个 registry.create + 即时登记 → 全成功 CAS ready；失败 CAS failed + dispose。
   * 幂等：state 已 ready/running 时直接返回当前；operationId 与进行中不符时观察不重复。
   */
  async recruit(operationId: string, tournamentId: string): Promise<TournamentState> {
    const existing = await this.store.get(tournamentId)
    if (!existing) throw new TournamentError('notFound', `tournament ${tournamentId} not found`)
    if (existing.phase === 'ready' || existing.phase === 'running') return existing
    if (existing.phase !== 'recruiting') {
      // failed/interrupted：不自动 recruit；显式 retry（见 retry()）
      return existing
    }

    const registry = this.registry()
    if (!registry) {
      throw new Error('tournament recruit: ctx.agents (DSH AgentRegistry) unavailable — recruit needs a real DSH runtime')
    }

    const seats = existing.config.seats
    // 派生 roster sessionId（稳定；retry 复用同一批 session 身份）
    const rosterSessions = Array.from({ length: seats }, (_, i) => `${this.sessionPrefix}${tournamentId.slice(-6)}-${i + 1}-${randomUUID().slice(0, 8)}`)

    // 1) CAS 写 participants（仅首次；retry 复用原 participant 身份，不重复分配）
    const pre = await this.store.get(tournamentId)
    if (!pre) throw new TournamentError('notFound', `tournament ${tournamentId} not found`)
    let state = pre
    if (state.participants.length === 0) {
      state = await this.store.update(tournamentId, state.revision, s => {
        s.participants = allocateParticipants(rosterSessions, seats)
      })
    }

    const handles: AgentHandleLike[] = []
    try {
      // 2) 逐个 create + 即时登记（model/provider 取自 tournament.config——create body 可带）
      for (const participant of state.participants) {
        const agentOptions: { provider?: string; model?: string } = {}
        if (state.config.provider) agentOptions.provider = state.config.provider
        if (state.config.model) agentOptions.model = state.config.model
        const handle = await registry.create({
          sessionId: participant.sessionId,
          agentOptions,
          meta: { cwd: process.cwd(), origin: 'subagent', agentPreset: 'screeps-tournament' },
        })
        handles.push(handle)
        this.handlesByTournament.set(tournamentId, [...(this.handlesByTournament.get(tournamentId) ?? []), handle])
        this.log(`recruit ${tournamentId}: session ${participant.sessionId} registered`)
      }
      // 3) 全成功 → CAS ready
      const afterCreate = await this.store.get(tournamentId)
      if (!afterCreate) throw new TournamentError('notFound', `tournament ${tournamentId} disappeared during recruit`)
      state = await this.store.update(tournamentId, afterCreate.revision, s => {
        s.phase = 'ready'
        s.operations.push({ operationId, kind: 'recruit', at: Date.now() })
        s.error = undefined
      })
      return state
    } catch (err) {
      // 4) 失败 → CAS failed（记录 error/operation）+ dispose 本次已登记 handles
      const latest = await this.store.get(tournamentId).catch(() => null)
      if (latest && (latest.phase === 'recruiting' || latest.phase === 'ready')) {
        await this.store
          .update(tournamentId, latest.revision, s => {
            s.phase = 'failed'
            s.error = `recruit failed: ${(err as Error).message}`
            s.operations.push({ operationId, kind: 'recruit', at: Date.now(), note: 'failed' })
          })
          .catch(() => {})
      }
      await this.disposeHandles(tournamentId)
      throw err
    }
  }

  /**
   * retry（plan §4.1 step5）：显式 retry:true + 新 operationId 才可把 failed/interrupted
   * 赛事 CAS 回 recruiting 并重新 recruit；复用 participant/session 身份；ready/running/
   * completed/draw 一律拒绝。
   */
  async retry(tournamentId: string, operationId: string): Promise<TournamentState> {
    const state = await this.store.get(tournamentId)
    if (!state) throw new TournamentError('notFound', `tournament ${tournamentId} not found`)
    if (state.phase !== 'failed' && state.phase !== 'interrupted') {
      throw new TournamentError('conflict', `tournament ${tournamentId} is ${state.phase}; retry only for failed/interrupted`)
    }
    await this.store.update(tournamentId, state.revision, s => {
      s.phase = 'recruiting'
      s.error = undefined
      s.cleanupUnknown = undefined
      s.operations.push({ operationId, kind: 'retry', at: Date.now() })
    })
    // 旧 handles 必须先已无 owner（dispose 已随失败路径回收）；重新登记
    return this.recruit(operationId, tournamentId)
  }

  /* ------------------------------ start / 编排推进（orchestrator 转调） ------------------------------ */

  /**
   * start（HTTP 观战者触发，plan §4.2）：只允许 ready；经 AdmissionGate
   * 'tournament-advance' 排他；重复 start 幂等/409。running 后 orchestrator 激活首场。
   */
  async start(tournamentId: string, operationId: string): Promise<TournamentState> {
    return this.gate.runExclusive('tournament-advance', operationId, tournamentId, async () => {
      const state = await this.store.get(tournamentId)
      if (!state) throw new TournamentError('notFound', `tournament ${tournamentId} not found`)
      if (state.phase === 'running') return state // 幂等
      if (state.phase !== 'ready') {
        throw new TournamentError('conflict', `tournament ${tournamentId} is ${state.phase}; only ready can start`)
      }
      return this.orchestrator.start(tournamentId, state.revision)
    })
  }

  /** MatchService settled hook 转发（commit 后；推进下一 slot/attempt 或终态回收）。 */
  async onMatchSettled(matchId: string): Promise<void> {
    const match = await this.match.store.get(matchId)
    if (!match?.tournamentId) return
    const result = await this.orchestrator.onMatchSettled(matchId)
    if (result === 'terminal') {
      // 终态：回收该赛事 handles（幂等）
      await this.disposeTournament(match.tournamentId)
    }
  }

  /** 编排直通（供编排测试/HTTP advance）：显式让 orchestrator 找下一个工作项。 */
  async activateNext(tournamentId: string) {
    return this.orchestrator.activateCurrent(tournamentId)
  }

  /**
   * 驱动循环单拍（plan §4.2/§4.3 闭环：submitted → lifecycle.start → running →
   * autoSettle → settle → hook 推进下一场）。由 ScreepsService 的 interval 周期调用，
   * 幂等：无当前 attempt 或无需动作时返回 'idle'。
   *   - active attempt match 处于 creating/placing 且两 player submitted → start；
   *   - running/paused → observe autoSettle due → settle（journal 唯一顺序，commit 后
   *     经 onSettled → orchestrator 推进）。
   * 返回 'started' | 'settled' | 'idle'（供 IT/测试断言驱动发生过什么）。
   */
  async driveOnce(tournamentId: string): Promise<'started' | 'settled' | 'idle'> {
    const state = await this.store.get(tournamentId)
    if (!state || state.phase !== 'running') return 'idle'
    // 当前 active slot/attempt（running 或 settling 的 attempt → 找其 match）
    const slot = state.slots.find(s => s.phase === 'running' || (s.phase === 'won' && s.attempts.some(a => a.phase === 'settling')))
    const attempt = slot?.attempts.find(a => a.phase === 'running' || a.phase === 'settling')
    const matchId = attempt?.matchId
    if (!matchId) return 'idle'
    const match = await this.match.store.get(matchId)
    if (!match) return 'idle'

    // 1) creating/placing：两 player submitted 后 start（plan §4.2 "submitted CAS 后 start"）
    if (match.phase === 'creating' || match.phase === 'placing') {
      if (match.players.length === 2 && match.players.every(p => p.submitted === true)) {
        await this.match.start(matchId)
        this.log(`drive ${tournamentId}: match ${matchId} all submitted → started`)
        return 'started'
      }
      return 'idle'
    }
    // 2) running/paused：autoSettle due → settle（journal；commit 后 hook 推进）
    if (match.phase === 'running' || match.phase === 'paused') {
      const obs = await this.match.observe(matchId).catch(() => null)
      if (obs && obs.autoSettle.due && obs.autoSettle.reason) {
        await this.match.settle(matchId, obs.autoSettle.reason)
        this.log(`drive ${tournamentId}: match ${matchId} autoSettle -> settled`)
        return 'settled'
      }
    }
    return 'idle'
  }

  /* ------------------------------ handle 生命周期 ------------------------------ */

  private async disposeHandles(tournamentId: string): Promise<void> {
    const handles = this.handlesByTournament.get(tournamentId)
    if (!handles || handles.length === 0) return
    this.handlesByTournament.delete(tournamentId)
    for (const handle of handles) {
      try {
        await handle.dispose()
        this.log(`disposed tournament ${tournamentId} session ${handle.agent.id}`)
      } catch (err) {
        this.log(`dispose ${handle.agent.id} failed: ${(err as Error).message}`)
        // 记录 cleanupUnknown（见 store state；service 上层可查）
        const latest = await this.store.get(tournamentId).catch(() => null)
        if (latest) {
          await this.store
            .update(tournamentId, latest.revision, s => {
              s.cleanupUnknown = [...(s.cleanupUnknown ?? []), handle.agent.id]
            })
            .catch(() => {})
        }
      }
    }
  }

  /** 赛事终态（completed/draw/failed/interrupted）或 dispose 时回收该赛事全部 handle。 */
  async disposeTournament(tournamentId: string): Promise<void> {
    await this.disposeHandles(tournamentId)
  }

  /** 服务卸载：停止新编排、dispose 全部赛事 handle。 */
  async dispose(): Promise<void> {
    const ids = [...this.handlesByTournament.keys()]
    for (const id of ids) {
      await this.disposeHandles(id)
      const latest = await this.store.get(id).catch(() => null)
      if (latest && (latest.phase === 'recruiting' || latest.phase === 'ready' || latest.phase === 'running')) {
        await this.store
          .update(id, latest.revision, s => {
            s.phase = 'interrupted'
            s.error = s.error ?? 'service disposed'
            s.cleanupUnknown = [...(s.cleanupUnknown ?? []), 'service-disposed']
          })
          .catch(() => {})
      }
    }
  }
}
