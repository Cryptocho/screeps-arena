/**
 * 赛事领域模型（M4-B.1）—— 纯数据与纯函数：不碰 fs / 网络 / AgentRegistry / ScreepsService。
 *
 * 对局分层（plan-M4 §3.1，不可偏离）：Tournament seats=4|8 与单场 Match seats=2 严格分层；
 * participantId 是稳定公开身份（绝不使用 sessionId 作公开 key）；displayName 是赛事内 alias，
 * 跨赛事可重复；跨赛事 leaderboard 以 participantId 聚合。
 *
 * slot/attempt 状态语义（本文件锁定，测试钉死）：
 *   - slot.phase：pending（等待编排创建首 attempt MatchState）→ running（首场编排中/结算中，
 *     两 attempt 之间的 rematch 窗口仍为 running）→ won | draw | interrupted；
 *   - attempt.phase：pending（已排队、MatchState 未建）→ running → settling → settled | draw
 *     | interrupted；attempt0 apply draw 成功后才可创建 attempt1；
 *   - attempt1（= maxAttempts-1）apply draw → slot=draw 且 tournament=draw（无 champion，
 *     晋级图断裂无法继续，plan §4.3）；
 *   - 非末轮 slot won → 该轮全部 slot 均为 won 时由 winners（按 slot.index 升序）两两配对生成
 *     下一轮 slot（纯函数输入相同 → bracket 唯一，确定性 seed 配对）；
 *   - 末轮（round == roundsFor(seats)）slot won → tournament completed + championParticipantId。
 */
import { hashV1 } from '../canonical.ts'

export const TOURNAMENT_PRESET = 'arena-blitz' as const
export type TournamentPreset = typeof TOURNAMENT_PRESET

export type TournamentPhase =
  | 'recruiting'
  | 'ready'
  | 'running'
  | 'completed'
  | 'draw'
  | 'failed'
  | 'interrupted'
export type SlotPhase = 'pending' | 'running' | 'won' | 'draw' | 'interrupted'
export type AttemptPhase = 'pending' | 'running' | 'settling' | 'settled' | 'draw' | 'interrupted'

export interface TournamentConfig {
  preset: TournamentPreset
  seats: 4 | 8
  /** draw rematch 上限：attempt 0/1（两次 draw 即赛事 draw）。 */
  maxAttempts: 2
  tickDuration?: number
  model?: string
  provider?: string
}

export interface TournamentParticipant {
  /** 稳定公开 id；永不使用 sessionId 作公开 key。 */
  participantId: string
  /** host 私有；HTTP/client/history projection 必须剥离。 */
  sessionId: string
  /** 赛事内公开 alias（如 Agent 1）；允许跨赛事重复。 */
  displayName: string
  seed: number
}

export interface BracketAttempt {
  attempt: 0 | 1
  /** 对应 MatchState id。attempt0 在 slot 进入编排时回填；attempt1 在 draw 后由 host 创建
   *  rematch MatchState 时回填——pending 阶段可为 undefined。 */
  matchId?: string
  replayId?: string
  phase: AttemptPhase
  /** 成功 apply 的 MatchResult.resultId（=matchId）；幂等/冲突判定的唯一锚。 */
  resultId?: string
  winnerParticipantId?: string
}

export interface TournamentSlot {
  slotId: string
  round: number
  index: number
  participantIds: [string, string]
  attempts: BracketAttempt[]
  phase: SlotPhase
  /** slot 级 CAS 版本：每次 apply / 编排状态变更 +1（plan §3.1 CAS 语义）。 */
  revision: number
  winnerParticipantId?: string
}

export interface TournamentState {
  id: string
  requestId: string
  config: TournamentConfig
  phase: TournamentPhase
  /** 赛事级 CAS 版本：任何持久化状态变更 +1。 */
  revision: number
  participants: TournamentParticipant[]
  slots: TournamentSlot[]
  currentSlotId?: string
  championParticipantId?: string
  error?: string
  /** 无法在进程内清理的资源（handle/user），公开为可查询诊断（不阻塞 admission 语义）。 */
  cleanupUnknown?: string[]
  operations: Array<{ operationId: string; kind: 'recruit' | 'start' | 'retry' | 'advance'; at: number; note?: string }>
  createdAt: number
  updatedAt: number
}

export class TournamentModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TournamentModelError'
  }
}

/* ------------------------------ 常量与守卫 ------------------------------ */

/** recruiting/ready/running 占用单活跃席位（普通 create/join 与建赛互斥的判定面）。 */
export const ACTIVE_TOURNAMENT_PHASES: readonly TournamentPhase[] = ['recruiting', 'ready', 'running']
export const TERMINAL_TOURNAMENT_PHASES: readonly TournamentPhase[] = ['completed', 'draw', 'failed', 'interrupted']
/** 允许显式 retry（新 operationId）重入 recruiting 的 phase（plan §4.1 step5）。 */
export const RETRYABLE_TOURNAMENT_PHASES: readonly TournamentPhase[] = ['failed', 'interrupted']

export function isTournamentPhaseActive(phase: TournamentPhase): boolean {
  return (ACTIVE_TOURNAMENT_PHASES as readonly string[]).includes(phase)
}

export function isTournamentPhaseRetryable(phase: TournamentPhase): boolean {
  return (RETRYABLE_TOURNAMENT_PHASES as readonly string[]).includes(phase)
}

export function totalRounds(seats: number): number {
  if (seats !== 4 && seats !== 8) throw new TournamentModelError(`seats must be 4 or 8, got ${seats}`)
  return Math.log2(seats)
}

export function validateTournamentConfig(config: TournamentConfig): void {
  if (config.preset !== TOURNAMENT_PRESET) {
    throw new TournamentModelError(`preset must be ${TOURNAMENT_PRESET}, got ${String(config.preset)}`)
  }
  if (config.seats !== 4 && config.seats !== 8) {
    throw new TournamentModelError(`seats must be 4 or 8, got ${String(config.seats)}`)
  }
  if (config.maxAttempts !== 2) {
    throw new TournamentModelError(`maxAttempts must be 2, got ${String(config.maxAttempts)}`)
  }
  if (config.tickDuration !== undefined && (!Number.isFinite(config.tickDuration) || config.tickDuration <= 0)) {
    throw new TournamentModelError(`tickDuration must be a positive finite number, got ${String(config.tickDuration)}`)
  }
}

export function isTournamentConfig(value: unknown): value is TournamentConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.preset === TOURNAMENT_PRESET &&
    (v.seats === 4 || v.seats === 8) &&
    v.maxAttempts === 2 &&
    (v.tickDuration === undefined || (typeof v.tickDuration === 'number' && Number.isFinite(v.tickDuration) && v.tickDuration > 0))
  )
}

export function defaultTournamentConfig(seats: 4 | 8): TournamentConfig {
  return { preset: TOURNAMENT_PRESET, seats, maxAttempts: 2 }
}

/* ------------------------------ id 生成 ------------------------------ */

export function newTournamentId(now = Date.now()): string {
  return `t${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function newParticipantId(): string {
  return `p${Math.random().toString(36).slice(2, 10)}`
}

/** roundToken 明文生成（仅 host 内存持有/下发 prompt；MatchState 只存 sha256 hash，plan §4.2）。 */
export function newRoundToken(): string {
  return `rt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * tournament attempt 的 Screeps username（host 生成）：≤30 字符、仅 [A-Za-z0-9_-]、
 * 含 tournament/participant/attempt 可追溯短码（plan §3.1；reset 后重新创建，username
 * 不是公开 participantId）。示例：`t_ab12cd_pa34_a0`。
 */
export function tournamentUsername(tournamentId: string, participantId: string, attempt: 0 | 1): string {
  const t = tournamentId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 't'
  const p = participantId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'p'
  const raw = `t_${t}_p_${p}_a${attempt}`
  return raw.length <= 30 ? raw : raw.slice(0, 30)
}

/** slotId 确定性生成：round/index 决定唯一 id（bracket 可追溯）。 */
export function slotIdFor(round: number, index: number): string {
  return `r${round}s${index}`
}

/* ------------------------------ roster / pairing 纯函数 ------------------------------ */

/**
 * 为 roster 分配 participant 身份：session 按序获得 seed 0..n-1 与赛事内 alias Agent N。
 * 相同 sessions 顺序 → 相同 seed/displayName（participantId 仍为新随机——身份只在
 * recruit 首建时生成一次，retry 复用旧 participantId，不重复创建）。
 */
export function allocateParticipants(sessions: readonly string[], seats: 4 | 8): TournamentParticipant[] {
  if (sessions.length !== seats) {
    throw new TournamentModelError(`roster size ${sessions.length} does not match seats ${seats}`)
  }
  return sessions.map((sessionId, i) => ({
    participantId: newParticipantId(),
    sessionId,
    displayName: `Agent ${i + 1}`,
    seed: i,
  }))
}

/**
 * 确定性 pairing：按 seed 升序相邻配对（seed 0 vs 1、2 vs 3…），一轮的 slot 数 = seats/2^round。
 * 输入必须是 2 的幂长度的有序 participantId 列表；纯函数 → 相同输入唯一 bracket。
 */
export function pairIntoSlots(orderedParticipantIds: readonly string[], round: number): TournamentSlot[] {
  if (orderedParticipantIds.length === 0 || orderedParticipantIds.length % 2 !== 0) {
    throw new TournamentModelError(`cannot pair ${orderedParticipantIds.length} participants into ${round > 1 ? 'advance' : 'initial'} slots`)
  }
  const slots: TournamentSlot[] = []
  for (let i = 0; i < orderedParticipantIds.length; i += 2) {
    slots.push({
      slotId: slotIdFor(round, i / 2),
      round,
      index: i / 2,
      participantIds: [orderedParticipantIds[i]!, orderedParticipantIds[i + 1]!],
      attempts: [{ attempt: 0, phase: 'pending' }],
      phase: 'pending',
      revision: 0,
    })
  }
  return slots
}

/** 首轮 slot：participants 按 seed 升序成对（seed 0 vs 1…）。 */
export function buildInitialSlots(participants: readonly TournamentParticipant[]): TournamentSlot[] {
  const sorted = [...participants].sort((a, b) => a.seed - b.seed)
  return pairIntoSlots(sorted.map(p => p.participantId), 1)
}

/* ------------------------------ slot result / bracket 推进 ------------------------------ */

export type SlotOutcome = { winnerParticipantId: string } | { draw: true }

export interface ApplySlotResultInput {
  slotId: string
  expectedSlotRevision: number
  expectedAttempt: 0 | 1
  /** 成功 apply 的 MatchResult.resultId（=matchId）。 */
  resultId: string
  /** 该 MatchResult 的 canonical resultHash（hashVersion=1）。 */
  resultHash: string
  outcome: SlotOutcome
  /** 同一 resultId 已成功 apply 过的既有 resultHash（store 从 receipts 读入后传入；
   *  首次 apply 或 store 侧尚无 receipt 时为 undefined）。 */
  priorResultHash?: string
}

export type SlotAdvanceResult =
  | { kind: 'ok'; state: TournamentState }
  | { kind: 'idempotent'; state: TournamentState }
  | { kind: 'conflict'; reason: string }
  | { kind: 'corrupt'; reason: string }

function cloneState(state: TournamentState): TournamentState {
  return JSON.parse(JSON.stringify(state)) as TournamentState
}

/**
 * slot 结果推进纯引擎（plan §3.1 TournamentStore.applyResult 的判定语义）：
 *   - 相同 resultId + 相同 hash → idempotent（返回原 state，不改动）——判定在 revision/
 *     phase 校验之前：reconcile 重放携带的 expectedSlotRevision 可能落后/前进，只要结果已
 *     成功绑定就幂等收敛，不会因 stale revision 卡死在 409；
 *   - 相同 resultId + 不同 hash → corrupt（调用方（store）据此把赛事置 failed，禁止继续推进）；
 *   - attempt 已绑不同 resultId → conflict；
 *   - expectedSlotRevision/attempt/phase 不匹配 → conflict（409），不产生任何变更；
 *   - attempt0 draw 只在 apply 成功后创建 attempt1（phase=pending，等待编排回填 matchId）；
 *   - attempt1 draw → slot + tournament draw（无 champion）；
 *   - winner 必须 ∈ slot.participantIds，否则 conflict；
 *   - 非末轮 won 且本轮全部 slot 均 won → winners 两两配对生成下一轮 slot；
 *   - 末轮 won → tournament completed + championParticipantId。
 */
export function applySlotResult(state: TournamentState, input: ApplySlotResultInput): SlotAdvanceResult {
  const slot = state.slots.find(s => s.slotId === input.slotId)
  if (!slot) return { kind: 'conflict', reason: `slot ${input.slotId} not found` }
  const attempt = slot.attempts.find(a => a.attempt === input.expectedAttempt)
  if (!attempt) {
    return { kind: 'conflict', reason: `attempt ${input.expectedAttempt} not present on slot ${input.slotId}` }
  }

  // 幂等 / corrupt 判定（先于 revision/phase 校验：结果已绑定即按 hash 收敛，不因 stale
  // revision 卡死；reconcile 对已 won/draw 的 slot 重放走这里）
  if (attempt.resultId !== undefined && attempt.resultId !== input.resultId) {
    return { kind: 'conflict', reason: `attempt already bound to result ${attempt.resultId}, got ${input.resultId}` }
  }
  if (attempt.resultId === input.resultId) {
    if (input.priorResultHash !== undefined && input.priorResultHash !== input.resultHash) {
      return { kind: 'corrupt', reason: `same resultId ${input.resultId} with different resultHash` }
    }
    return { kind: 'idempotent', state }
  }

  // 首次 apply 的 CAS 面
  if (slot.revision !== input.expectedSlotRevision) {
    return { kind: 'conflict', reason: `slot revision mismatch: expected ${input.expectedSlotRevision}, actual ${slot.revision}` }
  }
  if (attempt.phase !== 'running' && attempt.phase !== 'settling') {
    return { kind: 'conflict', reason: `attempt ${input.expectedAttempt} phase ${attempt.phase} cannot accept a new result` }
  }
  // 只有 running slot 能收新结果（won/draw/interrupted 已终态；pending 未编排）
  if (slot.phase !== 'running') {
    return { kind: 'conflict', reason: `slot ${input.slotId} phase ${slot.phase} cannot accept a new result` }
  }

  // 首次 apply：winner 必须属于本 slot
  if (!('draw' in input.outcome)) {
    if (!slot.participantIds.includes(input.outcome.winnerParticipantId)) {
      return { kind: 'conflict', reason: `winner ${input.outcome.winnerParticipantId} is not in slot ${input.slotId} participants` }
    }
  }

  const next = cloneState(state)
  const nextSlot = next.slots.find(s => s.slotId === input.slotId)!
  const nextAttempt = nextSlot.attempts.find(a => a.attempt === input.expectedAttempt)!

  nextAttempt.resultId = input.resultId
  if ('draw' in input.outcome) {
    nextAttempt.phase = 'draw'
    const isLastAttempt = input.expectedAttempt === next.config.maxAttempts - 1
    if (isLastAttempt) {
      // attempt1 draw → slot + tournament draw（plan §4.3：不创建后续 slot，无 champion）
      nextSlot.phase = 'draw'
      next.phase = 'draw'
    } else {
      // attempt0 draw → 仅在此 apply 成功后创建 attempt1（等编排回填 matchId）
      nextSlot.attempts.push({ attempt: (input.expectedAttempt + 1) as 1, phase: 'pending' })
    }
  } else {
    nextAttempt.phase = 'settled'
    nextAttempt.winnerParticipantId = input.outcome.winnerParticipantId
    nextSlot.phase = 'won'
    nextSlot.winnerParticipantId = input.outcome.winnerParticipantId
    if (nextSlot.round === totalRounds(next.config.seats)) {
      // 决赛 won → completed + champion
      next.phase = 'completed'
      next.championParticipantId = input.outcome.winnerParticipantId
    } else {
      // 非末轮：本轮全部 won → winners（按 slot.index 升序）生成下一轮 slots
      const roundSlots = next.slots.filter(s => s.round === nextSlot.round).sort((a, b) => a.index - b.index)
      if (roundSlots.every(s => s.phase === 'won')) {
        const winners = roundSlots.map(s => s.winnerParticipantId!) // 全 won 必有值
        next.slots.push(...pairIntoSlots(winners, nextSlot.round + 1))
      }
    }
  }

  nextSlot.revision += 1
  next.revision += 1
  return { kind: 'ok', state: next }
}

/* ------------------------------ 公开投影（redaction） ------------------------------ */

export interface TournamentPublicSlotAttempt {
  attempt: 0 | 1
  matchId?: string
  replayId?: string
  phase: AttemptPhase
  resultId?: string
  winnerParticipantId?: string
}

export interface TournamentPublicSlot {
  slotId: string
  round: number
  index: number
  participantIds: [string, string]
  phase: SlotPhase
  revision: number
  winnerParticipantId?: string
  attempts: TournamentPublicSlotAttempt[]
}

/** 赛事公开视图：剥离 sessionId/handle 的一切痕迹（plan §7.1：Tournament endpoints 绝不返回 sessionId）。 */
export interface TournamentPublicView {
  tournamentId: string
  requestId: string
  config: Pick<TournamentConfig, 'preset' | 'seats' | 'maxAttempts' | 'tickDuration' | 'model' | 'provider'>
  phase: TournamentPhase
  revision: number
  participants: Array<{ participantId: string; displayName: string; seed: number }>
  slots: TournamentPublicSlot[]
  currentSlotId?: string
  championParticipantId?: string
  error?: string
  cleanupUnknown?: string[]
  operations: Array<{ operationId: string; kind: string; at: number; note?: string }>
  retryable: boolean
  createdAt: number
  updatedAt: number
}

export function toTournamentPublicView(state: TournamentState): TournamentPublicView {
  const participants = state.participants.map(({ participantId, displayName, seed }) => ({ participantId, displayName, seed }))
  const slots: TournamentPublicSlot[] = state.slots.map(s => ({
    slotId: s.slotId,
    round: s.round,
    index: s.index,
    participantIds: s.participantIds,
    phase: s.phase,
    revision: s.revision,
    winnerParticipantId: s.winnerParticipantId,
    attempts: s.attempts.map(a => ({
      attempt: a.attempt,
      matchId: a.matchId,
      replayId: a.replayId,
      phase: a.phase,
      resultId: a.resultId,
      winnerParticipantId: a.winnerParticipantId,
    })),
  }))
  return {
    tournamentId: state.id,
    requestId: state.requestId,
    config: { ...state.config },
    phase: state.phase,
    revision: state.revision,
    participants,
    slots,
    currentSlotId: state.currentSlotId,
    championParticipantId: state.championParticipantId,
    error: state.error,
    cleanupUnknown: state.cleanupUnknown,
    operations: state.operations.map(op => ({ ...op })),
    retryable: isTournamentPhaseRetryable(state.phase),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  }
}

/**
 * requestConfigHash（plan §4.1 step1）—— requestId 幂等键的组成部分。
 * canonical hash v1，含 seats/preset/model/provider/tickDuration（maxAttempts 固定 2 不入 hash；
 * 可选键未提供时显式省略，不塞 undefined——canonical 拒绝 undefined）。
 */
export function tournamentRequestConfigHash(config: TournamentConfig): string {
  const payload: Record<string, unknown> = { preset: config.preset, seats: config.seats }
  if (config.model !== undefined) payload.model = config.model
  if (config.provider !== undefined) payload.provider = config.provider
  if (config.tickDuration !== undefined) payload.tickDuration = config.tickDuration
  return hashV1(payload)
}

/* ------------------------------ bracket 公开投影（§7.1 契约） ------------------------------ */

/** bracket 中一个槽位的公开投影：参与者与 winner 用 displayName alias，绝不含 sessionId。 */
export interface TournamentBracketSlotView {
  slotId: string
  round: number
  index: number
  participants: Array<{ participantId: string; displayName: string }>
  phase: SlotPhase
  /** 已落定槽位：split / byes 尚未配对时为 undefined。 */
  winner?: { participantId: string; displayName: string }
  /** 该槽最近的 attempt 摘要（matchId/replayId 供 client 进入回放）。 */
  attempts: TournamentPublicSlotAttempt[]
  /** 可进入回放的 replayId（有已结算/进行中 attempt 时）。 */
  replayId?: string
  matchId?: string
  gap?: boolean
}

export interface TournamentBracketRoundView {
  round: number
  slots: TournamentBracketSlotView[]
}

/** bracket 公开视图：纯投影，剥离 sessionId/handle/stack（plan §7.1）。 */
export interface TournamentBracketView {
  tournamentId: string
  phase: TournamentPhase
  seats: number
  participants: Array<{ participantId: string; displayName: string; seed: number }>
  rounds: TournamentBracketRoundView[]
  champion?: { participantId: string; displayName: string }
  currentSlotId?: string
  error?: string
}

export function toTournamentBracketView(state: TournamentState): TournamentBracketView {
  const alias = new Map(state.participants.map(p => [p.participantId, p.displayName]))
  const nameOf = (pid: string): { participantId: string; displayName: string } => ({
    participantId: pid,
    displayName: alias.get(pid) ?? pid,
  })
  const byRound = new Map<number, TournamentBracketSlotView[]>()
  for (const s of state.slots) {
    const attempts: TournamentPublicSlotAttempt[] = s.attempts.map(a => ({
      attempt: a.attempt,
      matchId: a.matchId,
      replayId: a.replayId,
      phase: a.phase,
      resultId: a.resultId,
      winnerParticipantId: a.winnerParticipantId,
    }))
    const latest = s.attempts[s.attempts.length - 1]
    const view: TournamentBracketSlotView = {
      slotId: s.slotId,
      round: s.round,
      index: s.index,
      participants: s.participantIds.map(nameOf),
      phase: s.phase,
      winner: s.winnerParticipantId ? nameOf(s.winnerParticipantId) : undefined,
      attempts,
      replayId: latest?.replayId,
      matchId: latest?.matchId,
      gap: undefined,
    }
    const arr = byRound.get(s.round) ?? []
    arr.push(view)
    byRound.set(s.round, arr)
  }
  const rounds: TournamentBracketRoundView[] = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, slots]) => ({ round, slots }))
  return {
    tournamentId: state.id,
    phase: state.phase,
    seats: state.config.seats,
    participants: state.participants.map(({ participantId, displayName, seed }) => ({ participantId, displayName, seed })),
    rounds,
    champion: state.championParticipantId ? nameOf(state.championParticipantId) : undefined,
    currentSlotId: state.currentSlotId,
    error: state.error,
  }
}


