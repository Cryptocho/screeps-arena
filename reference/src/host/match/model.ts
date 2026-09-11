/**
 * 对局领域模型（S8）—— 纯函数与纯数据，不碰 fs / 网络 / ScreepsService。
 *
 * 状态机（AGENTS.md 持久化节 + plan-M4 §3.2 settling + plan-M5 §3.2 rounds）：
 *   creating → placing → running ⇄ paused → settled
 *   running ⇄ roundBreak（world-rounds 回合制周期边界：世界已 pause，等待全员 commit）→ running
 *   running/paused/roundBreak ──beginSettlement──> settling ──commitSettlement──> settled
 *   settling 只可 commitSettlement 或显式 abortSettlement 离开（recovery 专用）
 *   任何非终态 → interrupted（host 启动扫描时打标，见 store.markInterrupted；
 *   settling 除外——它由 recovery reconcile/abort 收敛，不被 markInterrupted 覆盖）
 *
 * 不变量：
 *   - 一台服务器同时最多一场活跃对局（creating/placing/running/paused/roundBreak/settling 算活跃）；
 *   - settled / interrupted 是终态；
 *   - 记分公式 v1 = territory×w1 + ΣRCL×w2 + kills×w3 − losses×w4 (+energy×w5，默认关)。
 */

export type MatchForm = 'world' | 'arena'
export type MatchPhase = 'creating' | 'placing' | 'running' | 'paused' | 'roundBreak' | 'settling' | 'settled' | 'interrupted'
export type MatchPreset = 'world-rounds' | 'world-frozen' | 'arena-blitz'
export type WinnerRef = { kind: 'session'; id: string } | { kind: 'draw' }
/** 代码模式：live（普通热更，仅 arena-blitz）/ frozen（预设拒 submit）/ round（赛事轮，roundToken 门槛）/
 * rounds（world-rounds 回合制周期提交：周期边界 commit=就绪，running 拒）。 */
export type CodeMode = 'live' | 'frozen' | 'round' | 'rounds'
export type SettleReason = 'ticksExhausted' | 'lastStanding' | 'scoreTarget' | 'manual'

/** 记分权重（进对局配置，所有玩家可见；AGENTS.md 红线：不改规则偏袒任何一方）。 */
export interface ScoringWeights {
  /** 每控制 1 个房间加分。 */
  territory: number
  /** 每级 RCL 加分（Σ 玩家所有房间的 controller level）。 */
  rcl: number
  /** 击杀分：host 从事件流聚合的战果值（creep/建筑）。 */
  kills: number
  /** 损失扣分：同 kills 口径。 */
  losses: number
  /** 能量采集分：默认 0（防龟缩可关 → 开了才有激励差异）。 */
  energy: number
}

/** 默认权重：领地与 RCL 主导，击杀/损失按数值 1:1 对冲，能量分关闭。 */
export const DEFAULT_SCORING: ScoringWeights = {
  territory: 100,
  rcl: 50,
  kills: 1,
  losses: 1,
  energy: 0,
}

/** 各形态默认参数（规则预设都是数据不是代码分支，AGENTS.md 玩法节）。
 * world-rounds = 产品主线回合制（删 world-live 后 M5）；world-frozen 保留（BotArena 式）；
 * arena-blitz 保留（1v1 镜像歼灭，live 热更唯一承载）。 */
export const PRESETS: Record<MatchPreset, { form: MatchForm; frozenCode: boolean; tickDuration: number; maxTicks: number; seats: number; roundTicks?: number; maxRounds?: number; scoring: ScoringWeights }> = {
  'world-rounds': { form: 'world', frozenCode: false, tickDuration: 400, maxTicks: 20_000, seats: 4, roundTicks: 1000, maxRounds: 8, scoring: { ...DEFAULT_SCORING } },
  'world-frozen': { form: 'world', frozenCode: true, tickDuration: 300, maxTicks: 20_000, seats: 4, scoring: { ...DEFAULT_SCORING } },
  'arena-blitz': { form: 'arena', frozenCode: false, tickDuration: 150, maxTicks: 2_000, seats: 2, scoring: { territory: 0, rcl: 0, kills: 1, losses: 1, energy: 0 } },
}

export interface MatchConfig {
  form: MatchForm
  preset: MatchPreset
  /** 每 tick 毫秒数（world 300-500 / arena 100-200）。 */
  tickDuration: number
  /** tick 预算，0 = 不限（由手动/last standing 终止）。 */
  maxTicks: number
  /** 座位数（arena 固定 2，world 2-8）。 */
  seats: number
  /** frozen 预设下 submit_code 被拒（BotArena 式纯 AI 对撞）。 */
  frozenCode: boolean
  /** 回合制周期边界（world-rounds）：每周期 tick 数；0 = 不启用周期边界（默认 0）。 */
  roundTicks?: number
  /** 回合制最大周期数：0 = 不限（默认 0）；>0 时 ∈[1,100]。 */
  maxRounds?: number
  scoring: ScoringWeights
}

export interface MatchPlayer {
  /** DSH 会话 id —— 一个会话 = 一个 Screeps 用户，映射只在 host 侧（AGENTS.md 红线）。 */
  sessionId: string
  /** host 创建的 Screeps 用户名。 */
  username: string
  /** Screeps user id（placing 阶段建号后回填）。 */
  userId?: string
  /** 测试 bot 座位的代码模块（2026-09-09：仅测试/内部链路注入；start 建号用，普通 Agent 玩家则 EMPTY_CODE）。 */
  botCode?: Record<string, string>
  /** A0 spawn-Agent 局：准备期暂存式 submit 的代码（creating 阶段拦截，start 建号注入；与 botCode 互斥来源）。 */
  code?: Record<string, string>
  /** A0 spawn-Agent 局：准备期是否已提交脚本（host 在暂存 submit 后置 true；start 门槛用）。 */
  submitted?: boolean
  /** world-rounds：周期边界（roundBreak）是否已 commit 本轮代码（resumeNextRound 时清空）。 */
  ready?: boolean
  /** 赛事局（tournament attempt）：该玩家在赛事中的公开 participantId（M4）。 */
  participantId?: string
  joinedAt: number
}

export interface PlayerCounters {
  territory: number
  rclTotal: number
  kills: number
  losses: number
  energy: number
}

/* ---------------- M4-B：settlement journal（plan §3.2） ---------------- */

/** marker 状态：pending → committed/not-applicable（一次转移，不回退）；cleanup 另有 unknown。 */
export type MarkerStatus = 'pending' | 'committed' | 'not-applicable' | 'unknown'

/** 外部 receipt 引用：所有外部 receipt 的幂等主键 = resultId = matchId。 */
export interface SettlementReceiptRef {
  resultId: string
  /** hashVersion=1 canonical payload hash（replay=replayMetaHash / history & tournament=resultHash）。 */
  payloadHash: string
  storeRevision?: number
  replayId?: string
}

export interface JournalMarker {
  status: MarkerStatus
  receipt?: SettlementReceiptRef
  error?: string
}

/** replay marker 附加：completeness/gap（partial 合法，不假装完整）。 */
export interface ReplayJournalMarker extends JournalMarker {
  completeness?: 'complete' | 'partial'
  gapReasons?: string[]
}

/** 结算 candidate 的 participant mapping 快照（session → participant/displayName；不可变）。 */
export interface CandidateParticipantSnapshot {
  sessionId: string
  participantId?: string
  displayName?: string
  username: string
}

export interface SettlementJournal {
  /** 固定等于 matchId。 */
  settlementId: string
  /** hashVersion=1；candidate 不可改写（begin 固定后任何异 hash 的 begin → conflict）。 */
  candidateHash: string
  hashVersion: 1
  reason: SettleReason
  /** 内部 winner 仍可用 session ref；participantMapping 供归档/gateway 转 participant。 */
  winner: WinnerRef
  /** key：本次 MatchState session（内部）；归档同时写 participant mapping。 */
  scores: Record<string, number>
  kills: Record<string, number>
  losses: Record<string, number>
  endTick: number
  participantMapping: CandidateParticipantSnapshot[]
  replay: ReplayJournalMarker
  history: JournalMarker
  tournament: JournalMarker
  cleanup: JournalMarker
  error?: string
}

export interface MatchState {
  id: string
  createdAt: number
  updatedAt: number
  phase: MatchPhase
  config: MatchConfig
  players: MatchPlayer[]
  /** A0 spawn-Agent 局来源标记：`'agents'` = 人类建赛 spawn N Agent 玩家（start 走全就绪门槛）；
   *  缺省 = 普通 create/join 局（工具/HTTP 直连，无门槛，旧流程零回归）。 */
  spawnedBy?: 'agents' | 'tournament'
  /** M4-B revision CAS 版本（旧 state 缺省按 0；新写 API 用它做乐观并发）。 */
  revision?: number
  /** M4 赛事局归属（attempt MatchState 打标；settled hook 分支 / gateway 推进依据）。 */
  tournamentId?: string
  tournamentSlotId?: string
  /** 该局在 slot 中的 attempt 序号。 */
  attempt?: 0 | 1
  /** 代码模式（从 preset/来源派生；旧 state 缺省 live）。 */
  codeMode?: CodeMode
  /** M4 赛事局 roundToken 的 SHA-256（hashVersion=1）。明文只在构造 prompt/工具校验的
   *  瞬间位于 host 内存，永不落盘/进 DTO/replay/LOG（plan §4.2）。 */
  roundTokenHash?: string
  /** M4-B：结算 journal（beginSettlement 建立，commit 后保留供审计/reconcile）。 */
  settlement?: SettlementJournal
  /** 进入当前 phase 的世界 tick（worldTime），creating/placing 阶段为 undefined。 */
  phaseTick?: number
  /** world-rounds：当前周期序号（0 起；缺省 = 未进入周期循环）。 */
  roundIndex?: number
  /** world-rounds：roundBreak 期间全员是否已 commit（resume 时清空）。 */
  roundReady?: boolean
  /** world-rounds：进入 roundBreak 的墙钟时间戳（roundBreakTimeoutMs 计时基准；内存记录，重启标 interrupted）。 */
  roundBreakSince?: number
  /** 开局时的世界 gameTime；结束时 endTick - startTick 即消耗 tick 数。 */
  startTick?: number
  endTick?: number
  /** 房间分配（sessionId → roomName），placing 阶段落定。 */
  assignments?: Record<string, string>
  winner?: WinnerRef
  /** 终局各玩家记分明细（sessionId → breakdown）。 */
  scores?: Record<string, number>
  /** 结算时的记分完整性警告（如事件流 ring 溢出导致 kills/losses 可能缺失）。 */
  scoreWarning?: string
  /** 对局级错误/中断原因（M3 interrupted 打标、M5 旧 world-live 迁移、roundBreak 超时等记录）。 */
  error?: string
}

export const ACTIVE_PHASES: readonly MatchPhase[] = ['creating', 'placing', 'running', 'paused', 'roundBreak', 'settling']
export const TERMINAL_PHASES: readonly MatchPhase[] = ['settled', 'interrupted']

export function isActivePhase(phase: MatchPhase): boolean {
  return (ACTIVE_PHASES as readonly string[]).includes(phase)
}

const TRANSITIONS: Record<MatchPhase, readonly MatchPhase[]> = {
  creating: ['placing', 'interrupted'],
  placing: ['running', 'interrupted'],
  running: ['paused', 'roundBreak', 'settling', 'interrupted'],
  paused: ['running', 'settling', 'interrupted'],
  roundBreak: ['running', 'settling', 'interrupted'],
  settling: ['settled'], // interrupted 只可经显式 abortSettlement（store 层拦截通用 transition）
  settled: [],
  interrupted: [],
}

export function canTransition(from: MatchPhase, to: MatchPhase): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isMatchConfig(value: unknown): value is MatchConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.form === 'world' || v.form === 'arena') &&
    typeof v.preset === 'string' && v.preset in PRESETS &&
    typeof v.tickDuration === 'number' && v.tickDuration > 0 &&
    typeof v.maxTicks === 'number' && v.maxTicks >= 0 &&
    typeof v.seats === 'number' && Number.isInteger(v.seats) && v.seats >= 2 &&
    typeof v.frozenCode === 'boolean' &&
    (v.roundTicks === undefined || (typeof v.roundTicks === 'number' && v.roundTicks >= 0)) &&
    (v.maxRounds === undefined || (typeof v.maxRounds === 'number' && Number.isInteger(v.maxRounds) && v.maxRounds >= 0)) &&
    typeof v.scoring === 'object' && v.scoring !== null
  )
}

/** 记分 v1：纯算术，host 从公开投影 + 事件流喂 counters。 */
export function computeScore(c: PlayerCounters, w: ScoringWeights): number {
  return c.territory * w.territory + c.rclTotal * w.rcl + c.kills * w.kills - c.losses * w.losses + c.energy * w.energy
}

/** 生成 matchId：时间前缀便于目录排序，随机尾巴防碰撞。 */
export function newMatchId(now = Date.now()): string {
  return `m${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 从预设建配置；显式覆盖项优先。校验交给 isMatchConfig。 */
export function configFromPreset(preset: MatchPreset, overrides: Partial<MatchConfig> = {}): MatchConfig {
  const base = PRESETS[preset]
  return {
    form: base.form,
    preset,
    tickDuration: base.tickDuration,
    maxTicks: base.maxTicks,
    seats: base.seats,
    frozenCode: base.frozenCode,
    roundTicks: base.roundTicks,
    maxRounds: base.maxRounds,
    scoring: { ...base.scoring },
    ...overrides,
  }
}
