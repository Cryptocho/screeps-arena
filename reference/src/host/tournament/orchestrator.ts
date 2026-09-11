/**
 * TournamentOrchestrator（M4-C.3/C.4）—— 赛事推进编排：ready → start（激活首 slot）→
 * 每 slot 激活 attempt（建 MatchState + prompt 两 Agent + roundToken）→ submitted CAS →
 * lifecycle.start → settle（经 MatchLifecycle journal，唯一顺序）→ onSettled hook 推进
 * 下一 slot/attempt（draw rematch）→ completed/draw/dispose handles。
 *
 * 语义（plan §4.2/§4.3，测试钉死）：
 *   - 一次一个 slot 的 attempt 处于 active（单活跃席位：MatchStore 同时只允许一场 active）；
 *   - attempt 激活顺序：slot 的 attempts[] 中第一个 phase=pending 的（attempt0 或 draw 后的
 *     attempt1）→ 先建 MatchState（host 内部 createTournamentAttempt）再 CAS slot
 *     attempt.phase=running + matchId → 向该 slot 两 Agent handle followup（含 roundToken）；
 *   - 其余 roster Agent 保持空闲（不唤醒），等轮次到达；
 *   - 两玩家 submitted=true（工具 screeps_submit_code(roundToken) 校验通过写入）→
 *     CAS slot ready → lifecycle.start()（arena 部署复用 M3 镜像）→ running；
 *   - match settle（外部/轮询触发，走 MatchLifecycle journal）commit 后经 onSettled 回调本
 *     orchestrator → 读 slot 结果：won → 若赛事未 completed 则推进下一 slot/attempt；
 *     draw → attempt0 已自动建 attempt1（applySlotResult）→ 编排激活 attempt1；赛事已完成/
 *     draw → dispose 该赛事全部 handle（参赛 Agent 终态回收）。
 *
 * roundToken：每次 attempt 生成新明文（newRoundToken），hash 进 MatchState，明文仅本类内存
 * 与 prompt；工具校验见 tools（明文 → hash 比对 state.roundTokenHash）。
 */
import { sha256Hex } from '../canonical.ts'
import { buildInitialSlots, newRoundToken, tournamentUsername, type TournamentParticipant, type TournamentSlot, type TournamentState } from './model.ts'
import type { MatchService } from '../match/match-service.ts'
import type { MatchState } from '../match/model.ts'
import type { AgentHandleLike } from '../agents.ts'
import type { TournamentStore } from './store.ts'

/** 给参赛 Agent 的 round prompt（plan §4.2：唯一动作是 submit_code(roundToken)）。 */
export function buildRoundPrompt(opts: {
  tournamentId: string
  round: number
  slotId: string
  attempt: 0 | 1
  matchId: string
  displayName: string
  opponentDisplayName: string
  roundToken: string
}): string {
  return (
    `你是赛事 ${opts.tournamentId} 第 ${opts.round} 轮（slot ${opts.slotId}，attempt ${opts.attempt}）的参赛者 ${opts.displayName}。\n` +
    `本场 matchId=${opts.matchId}，你的对手是 ${opts.opponentDisplayName}。\n` +
    `现在编写你的 Screeps 脚本并提交：调用 screeps_submit_code(roundToken="${opts.roundToken}", modules={"main": "<完整的 main 模块源码>"})。\n` +
    `main 必须导出 module.exports.loop = function () { ... }（engine 4.3.x 只执行这种形状）。\n` +
    `提交后本回合结束；对局由赛事方自动推进，你会在轮到你的下一场时被唤醒。不要调用 schedule_create 自续跑。`
  )
}

export interface OrchestratorDeps {
  store: TournamentStore
  match: MatchService
  /** 获取该 tournament 当前登记的 handle（service 持有；按 participant sessionId 查）。 */
  handlesOf: (tournamentId: string) => AgentHandleLike[]
  log?: (msg: string) => void
  tickDuration?: number
}

export interface ActivatedAttempt {
  matchId: string
  roundToken: string
  match: MatchState
}

export class TournamentOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private log(msg: string): void {
    this.deps.log?.(`orchestrator: ${msg}`)
  }

  /** participant sessionId → handle（未登记返回 undefined）。 */
  private handleBySession(tournamentId: string, sessionId: string): AgentHandleLike | undefined {
    return this.deps.handlesOf(tournamentId).find(h => h.agent.id === sessionId)
  }

  /* ------------------------------ start / 首场 ------------------------------ */

  /**
   * start（ready → running）：建首轮 slots（若缺）→ 设 currentSlotId → 激活当前 slot 的
   * 首个 pending attempt。重复 start 幂等（已 running 直接返回）。
   */
  async start(tournamentId: string, expectedRevision: number): Promise<TournamentState> {
    let state = await this.deps.store.get(tournamentId)
    if (!state) throw new Error(`orchestrator: tournament ${tournamentId} not found`)
    if (state.phase === 'running') return state
    if (state.phase !== 'ready') throw new Error(`orchestrator: tournament ${tournamentId} cannot start from ${state.phase}`)
    if (state.participants.length !== state.config.seats) {
      throw new Error(`orchestrator: tournament ${tournamentId} roster incomplete (${state.participants.length}/${state.config.seats})`)
    }
    state = await this.deps.store.update(tournamentId, expectedRevision, s => {
      s.phase = 'running'
      if (s.slots.length === 0) s.slots = buildInitialSlots(s.participants)
      if (!s.currentSlotId) s.currentSlotId = s.slots[0]?.slotId
      s.operations.push({ operationId: `start-${Date.now().toString(36)}`, kind: 'start', at: Date.now() })
    })
    // 激活当前 slot（首个 pending attempt）；无 pending → 纯引擎已把赛事置终态，不该发生
    await this.activateCurrent(state.id)
    return (await this.deps.store.get(state.id))!
  }

  /* ------------------------------ attempt 激活 ------------------------------ */

  /**
   * 激活 tournament 的下一个工作项：
   *   1. 找 currentSlotId 的 slot 中第一个 pending attempt（draw rematch 优先原地重开）；
   *   2. 否则找所有 slot 中 phase='pending' 的最小 (round, index) slot（轮间推进/引擎生成的
   *      下一轮）→ 设 currentSlotId；
   *   3. 无 pending → 返回 null（赛事应由纯引擎置终态）。
   * 建 attempt MatchState（host 内部）→ CAS slot attempt running + matchId → 向两 Agent
   * followup prompt。返回激活信息。
   */
  async activateCurrent(tournamentId: string): Promise<ActivatedAttempt | null> {
    const state = await this.deps.store.get(tournamentId)
    if (!state) return null
    if (state.phase !== 'running') return null

    // 单活跃不变量：已有 active match（本赛事或别场）在跑/结算时，不建第二个 attempt
    // （MatchStore.createTournament 会抛 activeExists；这里提前判 null = "等当前场 settle"）。
    const activeMatch = await this.deps.match.store.active()
    if (activeMatch) {
      this.log(`active match ${activeMatch.id} (${activeMatch.phase}) present; deferring activation`)
      return null
    }

    // 1) 当前 slot 的 draw-rematch（attempt1 pending）
    let slot: TournamentSlot | undefined = state.slots.find(s => s.slotId === state.currentSlotId)
    let attempt = slot?.attempts.find(a => a.phase === 'pending')

    // 2) 找最早未决 slot（跨轮推进）
    if (!attempt) {
      const next = [...state.slots]
        .filter(s => s.phase === 'pending')
        .sort((a, b) => a.round - b.round || a.index - b.index)[0]
      if (next) {
        slot = next
        attempt = next.attempts.find(a => a.phase === 'pending')
      }
    }
    if (!slot || !attempt) return null

    const participantIds = slot.participantIds
    const byId = new Map(state.participants.map(p => [p.participantId, p]))
    const p0 = byId.get(participantIds[0]!)
    const p1 = byId.get(participantIds[1]!)
    if (!p0 || !p1) throw new Error(`orchestrator: slot ${slot.slotId} participants missing from roster`)

    const roundToken = newRoundToken()
    const attemptNo = attempt.attempt
    const username0 = tournamentUsername(state.id, p0.participantId, attemptNo)
    const username1 = tournamentUsername(state.id, p1.participantId, attemptNo)

    const match = await this.deps.match.createTournamentAttempt({
      tournamentId: state.id,
      slotId: slot.slotId,
      attempt: attemptNo,
      roundTokenHash: sha256Hex(roundToken),
      players: [
        { sessionId: p0.sessionId, username: username0, participantId: p0.participantId },
        { sessionId: p1.sessionId, username: username1, participantId: p1.participantId },
      ],
      tickDuration: this.deps.tickDuration,
    })

    // CAS slot：attempt 置 running + matchId；phase pending→running；currentSlotId 指向本 slot
    await this.deps.store.update(tournamentId, (await this.deps.store.get(tournamentId))!.revision, s => {
      const s2 = s.slots.find(x => x.slotId === slot!.slotId)
      const a = s2?.attempts.find(x => x.attempt === attemptNo)
      if (a) {
        a.phase = 'running'
        a.matchId = match.id
      }
      if (s2) s2.phase = 'running'
      s.currentSlotId = slot!.slotId
    })

    // 只唤醒本 slot 两 Agent
    const pairing: Array<[TournamentParticipant, TournamentParticipant]> = [
      [p0, p1],
      [p1, p0],
    ]
    for (const [p, opp] of pairing) {
      const handle = this.handleBySession(state.id, p.sessionId)
      const prompt = buildRoundPrompt({
        tournamentId: state.id,
        round: slot.round,
        slotId: slot.slotId,
        attempt: attemptNo,
        matchId: match.id,
        displayName: p.displayName,
        opponentDisplayName: opp.displayName,
        roundToken,
      })
      if (handle) {
        this.log(`prompt -> ${p.displayName} (${p.sessionId}) for match ${match.id}`)
        handle.agent.followup(this.makeUserMessage(prompt))
      } else {
        this.log(`WARN: no handle for ${p.sessionId} — attempt ${match.id} may stall (no followup)`)
      }
    }
    return { matchId: match.id, roundToken, match }
  }

  /** 与 agents.ts 的 makeUserMessage 同构（dsh-llm UserMessage；避免跨模块私有依赖）。 */
  private makeUserMessage(text: string): unknown {
    return {
      id: `dsh-screeps-orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  /* ------------------------------ submitted → start ------------------------------ */

  /** 轮询：match 两玩家均 submitted=true 后调用 lifecycle.start（arena 部署）。 */
  async waitSubmittedAndStart(matchId: string, deadline = Date.now() + 5_000): Promise<MatchState | null> {
    while (Date.now() < deadline) {
      const m = await this.deps.match.store.get(matchId)
      if (!m) return null
      if (m.players.length === 2 && m.players.every(p => p.submitted === true)) {
        this.log(`match ${matchId} all submitted; starting`)
        return this.deps.match.start(matchId)
      }
      await new Promise(r => setTimeout(r, 100))
    }
    return null
  }

  /* ------------------------------ settled hook → 推进 ------------------------------ */

  /**
   * MatchService settle commit 后回调（ScreepsService onSettled 对 tournament 局转发到这里）：
   * 读 slot 最新结果推进。
   *   - 赛事 completed/draw：回收全部 handle（终态）→ 返回 'terminal'；
   *   - 仍 running：slot 可能有 draw 后新 push 的 attempt1（pending）或下一 slot 已由纯引擎
   *     生成且 currentSlotId 未推进 → 激活当前 pending attempt → 返回 'advanced'；
   *   - 无 pending（理论上不该发生；纯引擎已完成推进）→ 返回 'idle'。
   */
  async onMatchSettled(matchId: string): Promise<'terminal' | 'advanced' | 'idle'> {
    const match = await this.deps.match.store.get(matchId)
    if (!match?.tournamentId) return 'idle'
    const tournamentId = match.tournamentId
    const latest = await this.deps.store.get(tournamentId)
    if (!latest) return 'idle'

    if (latest.phase === 'completed' || latest.phase === 'draw') {
      this.log(`tournament ${tournamentId} ${latest.phase}; disposing participant handles`)
      await this.disposeHandlesOf(latest)
      return 'terminal'
    }

    // 仍是 running：激活当前 slot 的下一个 pending attempt（draw rematch）或纯引擎生成的下轮 slot
    const activated = await this.activateCurrent(tournamentId)
    if (activated) {
      this.log(`advanced: activated attempt for match ${activated.matchId}`)
      return 'advanced'
    }
    // 决赛 winner 已把赛事置 completed？重读确认
    const after = await this.deps.store.get(tournamentId)
    if (after && (after.phase === 'completed' || after.phase === 'draw')) {
      await this.disposeHandlesOf(after)
      return 'terminal'
    }
    return 'idle'
  }

  /** 终态回收该赛事全部 handle（service 的 handlesOf 登记由 service.disposeTournament 清）。 */
  private async disposeHandlesOf(_state: TournamentState): Promise<void> {
    // handles 归 TournamentService 持有（deps.handlesOf 只读引用）；终态回收由 service
    // 的 disposeTournament 负责（避免双 owner）。这里仅日志提示。
    this.log('participant handles disposal is owned by TournamentService.disposeTournament')
  }
}

/** 供单测：判定某 slot 是否还能接受结算推进（有 running attempt）。 */
export function slotHasRunningAttempt(slot: TournamentSlot): boolean {
  return slot.attempts.some(a => a.phase === 'running' || a.phase === 'settling')
}
