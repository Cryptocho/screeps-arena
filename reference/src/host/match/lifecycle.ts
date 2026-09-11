/**
 * 对局生命周期编排（S9a + M4-B）—— 把 MatchStore（状态机/持久化）和 Arena 后端
 * （Screeps 私服控制面）粘成"创建 → 编队 → 部署 → 运行 → 结算"的流程。
 *
 * 只依赖 ArenaBackend 接口，不 import ScreepsService 运行时——编排逻辑可用
 * 假后端全量单测；真实接线（S9b）只是把 service 适配进来。
 *
 * 部署顺序（S7a 实证结论驱动）：
 *   ensureRunning → resetArena（干净世界）→ 逐玩家 generateRoom + createUser
 *   → restart（runner 地形缓存是进程级的，新房间必须重启刷新）
 *   → setTickDuration → resume → 记 startTick。
 *
 * M4-B：settle 走唯一 journal 顺序（plan §3.2/§6.1）——
 *   observe 一次固定 candidate → beginSettlement(durable) → backend pause（失败记
 *   journal.error 保持 settling）→ replay drain/stop marker（赛事局；普通局 na）
 *   → HistoryStore put + history marker → TournamentGateway.applyResult + tournament marker
 *   → commitSettlement →（由 MatchService）await hook + markCleanup。
 *   settle 失败保持 settling（reconcile 幂等重放，绝不重算 candidate / 不重复推进 slot）。
 */
import type { ScreepsWorldSnapshot } from '../service.ts'
import { buildMatchResult, toResultHash, type MatchResult } from '../history/model.ts'
import {
  computeScore,
  isActivePhase,
  type CandidateParticipantSnapshot,
  type MatchPhase,
  type MatchPreset,
  type MatchState,
  type PlayerCounters,
  type SettlementJournal,
  type SettleReason,
  type WinnerRef,
} from './model.ts'
import { MatchError, MatchStore, type BeginCandidate, type BeginModes, type MarkReceipt } from './store.ts'
import { attributeTick, type ArenaEvent, type EventTick } from './attribution.ts'

export type { SettleReason }

/** M4 赛事推进网关（唯一 applyResult 入口；由 MatchService/ScreepsService 构造时注入，
 * 允许经 ScreepsService 接 TournamentService）。 */
export interface TournamentGateway {
  applyResult(matchId: string, result: MatchResult): Promise<{
    outcome: 'won' | 'draw' | 'conflict'
    slotRevision: number
    /** conflict 原因（诊断/reconcile 决策用）。 */
    reason?: string
  }>
}

/** settle 的外部 IO 驱动（B.4 由调用方注入；缺失的驱动对应 marker 初值为 not-applicable）。 */
export interface SettlementDrivers {
  /** 赛事/录制局 final replay：drain/stop + ReplayStore finalize；返回 mark 用 receipt。 */
  replay?: (match: MatchState) => Promise<{
    receipt: MarkReceipt
    completeness: 'complete' | 'partial'
    gapReasons: string[]
  }>
  /** HistoryStore.put（幂等）→ {resultId=matchId, resultHash}。 */
  history?: (match: MatchState, journal: SettlementJournal) => Promise<{ resultId: string; resultHash: string }>
  /** TournamentGateway（赛事局专属）。 */
  tournament?: TournamentGateway
  /** M5 §3.5：roundBreak 唤醒钩子（host 对每个 Agent handle 发周期战报 + 提交邀请；
   *  spawn-Agent 局有 handle；self 续跑/测试场景可不注入——drive 循环靠全员 ready 检测续跑）。 */
  roundBreak?: (match: MatchState) => Promise<void> | void
}

export interface ArenaBackend {
  ensureRunning(): Promise<unknown>
  system(cmd: string, value?: unknown): Promise<Record<string, unknown>>
  createUser(input: { username: string; room: string; code: Record<string, string>; cpu?: number }): Promise<{ username: string; id?: string }>
  restart(options?: { resume?: boolean }): Promise<unknown>
  getWorld(): Promise<ScreepsWorldSnapshot>
  /** 事件流增量拉取（M2 B 步）：since=ring 下标；bound=false = ring 溢出过。 */
  eventLog(since?: number): Promise<{ events: unknown[]; cursor: number; bound: boolean }>
  /** M5 §3.3：resumeNextRound 真传下一轮代码（唯一上传通道 svc.submitCode → POST /api/user/code）。 */
  submitCode?(username: string, modules: Record<string, string>, branch?: string): Promise<{ timestamp: number }>
}

/** start 的房间形状（M2 战斗 IT）：`string`（旧）或 `{room, exits?}`（带出口）。 */
export type StartRoom = string | { room: string; exits?: Record<string, number[]> }

export interface MatchObservation {
  match: MatchState
  gameTime: number
  ticksElapsed: number | null
  /** sessionId → 当前记分投影（每次观察现算，不落盘；落盘只在 settle）。 */
  scoreboard: Record<string, { score: number; counters: PlayerCounters; eliminated: boolean }>
  /** 自动终止条件是否满足（调用方决定是否真的 settle）。 */
  autoSettle: { due: boolean; reason?: SettleReason }
  /** M5 world-rounds：周期边界是否到点（running 且 roundTicks>0 且 gameTime-phaseTick>=roundTicks）。
   * 只读探测（observe 无副作用）；只有 drive 循环调 enterRoundBreak（single-writer，与 settle 同构）。 */
  autoRound: { due: boolean; index?: number }
}

const EMPTY_CODE: Record<string, string> = { main: 'module.exports.loop = function () {}' }

/** 世界模式默认随机选房（同参数生成 = S7d 的公平基线）；调用方可用 opts.rooms 显式指定。 */
export function pickRoomName(rand: () => number = Math.random): string {
  const axis = (min: number) => min + Math.floor(rand() * 50)
  return `W${axis(40)}N${axis(40)}`
}

export class MatchLifecycle {
  /** 事件流消费游标（matchId → ring 下标）；跨 tick 累积的击杀/损失（M2 B 步）。 */
  private eventCursor = new Map<string, number>()
  private killLossByMatch = new Map<string, Map<string, { kills: number; losses: number }>>()
  /** consumeEvents 最近一次看到的 ring bound（false = 溢出过，事件段缺失）。 */
  private eventBoundByMatch = new Map<string, boolean>()
  /** per-match 单飞锁（P0 设计审查次要 2）：observe/settle 可被 client GET 轮询与 Agent
   * 工具并发触发，若各自消费同一批事件 → kills/losses 双计。同一 match 的消费/观察串行化。 */
  private observeLocks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: MatchStore,
    private readonly backend: ArenaBackend,
    private readonly log: (msg: string) => void = () => {},
    private readonly drivers: SettlementDrivers = {},
    /** M5：start 前 pause 后的在途 tick 落拍等待（ms）；单测假后端无 tick 可置 0 免拖慢。 */
    private readonly startPauseSettleMs = 1_200,
    /** M6 记录点 4：start 注入（botCode/staged/空壳）落提交流水；缺省（直构单测）不记录。 */
    private readonly codeLog?: import('./code-log.ts').CodeLog,
  ) {}

  /** 同 match 的并发 observe/settle 排队执行（前一个完成后一个再跑，cursor 已被推进 → 不双计）。 */
  private async withMatchLock<T>(matchId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.observeLocks.get(matchId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.observeLocks.set(matchId, run)
    try {
      return (await run) as T
    } finally {
      if (this.observeLocks.get(matchId) === run) this.observeLocks.delete(matchId)
    }
  }

  /** host 启动时调用：上次进程中断留下的活跃对局全部标记 interrupted。 */
  async boot(): Promise<MatchState[]> {
    return this.store.markInterrupted()
  }

  async createMatch(input: { preset: MatchPreset; sessionId: string; username: string; tickDuration?: number; roundTicks?: number; maxRounds?: number }): Promise<MatchState> {
    const { configFromPreset } = await import('./model.ts')
    // M2 E 步（八审 N3）+ M5：显式覆盖透传进 config（复盖 preset 默认；未提供省略 key）。
    const overrides: { tickDuration?: number; roundTicks?: number; maxRounds?: number } = {}
    if (input.tickDuration !== undefined && Number.isFinite(input.tickDuration) && input.tickDuration > 0) {
      overrides.tickDuration = input.tickDuration
    }
    // M5：roundTicks/maxRounds 可选覆盖（IT/测试指小值加速周期；产品用 preset 默认）。
    if (input.roundTicks !== undefined && Number.isFinite(input.roundTicks) && input.roundTicks > 0) {
      overrides.roundTicks = Math.floor(input.roundTicks)
    }
    if (input.maxRounds !== undefined && Number.isFinite(input.maxRounds) && input.maxRounds > 0) {
      overrides.maxRounds = Math.floor(input.maxRounds)
    }
    // M5（二审提示 1）：store.create 按 frozenCode 默认派 codeMode——world-rounds（frozenCode:false）
    // 会得 'live' 掉进立即热更分支 → 显式传 meta.codeMode='rounds'（第八轮提交语义：roundBreak commit）。
    const meta = input.preset === 'world-rounds' ? { codeMode: 'rounds' as const } : undefined
    return this.store.create(configFromPreset(input.preset, overrides), { sessionId: input.sessionId, username: input.username }, meta)
  }

  async join(matchId: string, player: { sessionId: string; username: string }): Promise<MatchState> {
    return this.store.addPlayer(matchId, player)
  }

  /**
   * 部署并开跑：creating/placing → running。
   * opts.rooms[i] 显式指定第 i 个玩家的房间（公平对局由调用方按 S7d 选房；
   * M2 战斗 IT 用 {room, exits} 生成带出口的相邻房）。
   */
  async start(matchId: string, opts: { rooms?: StartRoom[] } = {}): Promise<MatchState> {
    let match = await this.store.get(matchId)
    if (!match) throw new MatchError('notFound', `match ${matchId} not found`)
    if (match.players.length < 2) throw new MatchError('full', `match ${matchId}: need at least 2 players to start`)
    // A0/M4 全就绪门槛：spawn-Agent 局（spawnedBy==='agents'）与 tournament 局
    // （spawnedBy==='tournament'）都要求所有玩家 submitted===true 才放行；普通 create/join
    // 局（工具/HTTP 直连，IT 用）无门槛，零回归。
    if (
      (match.spawnedBy === 'agents' || match.spawnedBy === 'tournament') &&
      !match.players.every(p => p.submitted === true)
    ) {
      throw new MatchError(
        'badPhase',
        `match ${matchId}: ${match.spawnedBy} match must have all players ready (submitted=true) before start`,
      )
    }
    if (match.phase !== 'creating' && match.phase !== 'placing') {
      throw new MatchError('badPhase', `match ${matchId}: cannot start from ${match.phase}`)
    }
    // A0 起名查重（七审提示 5）：start 前查重，重名 throw → 409，不烧到 resetArena/建号
    // （否则 realCreateUser 会抛 'user already exists'，resetArena 已执行、部分用户已建，中途炸）。
    const { assertUniqueUsernames } = await import('../agents.ts')
    assertUniqueUsernames(match.players.map(p => p.username))
    // M3 B 节：arena 模式拒收 rooms（镜像由 mod arenaGen 保证对称，不随机选房）——同样在
    // resetArena 之前抛（未烧到部署）。
    if (match.config.form === 'arena' && opts.rooms && opts.rooms.length > 0) {
      throw new MatchError(
        'badPhase',
        `match ${matchId}: arena matches do not accept rooms (mirror W15N15/W14N15 is automatic)`,
      )
    }

    await this.backend.ensureRunning()
    match = await this.store.transition(matchId, 'placing')

    // M5 收尾加固（IT 尾段竞态实证，2026-09-09）：上一进程遗留的活世界（前局收尾时 pause HTTP
    // 失败 → SIGKILL 后 db.json 里 mainLoopPaused=false）在本进程加载后继续 tick；若不先停拍
    // 就 resetArena，在途 tick 的房间数据写回会把旧 controller.user「复活」→ createUser 撞
    // "already owned"（arena-mod realCreateUser reservation 注释同族现象）。先 pause（尽力而为
    // ——后端已停则跳过）+ 短等待让在途 tick 落完，再清场；restart(resume:false) 部署完成后放行。
    try {
      await this.backend.system('pause')
      if (this.startPauseSettleMs > 0) await new Promise(r => setTimeout(r, this.startPauseSettleMs))
    } catch {
      /* 后端不可达：后续 resetArena/建号阶段会给出可读错误 */
    }
    await this.backend.system('resetArena')
    const assignments: Record<string, string> = {}
    if (match.config.form === 'arena') {
      // A 节：单房 1v1 镜像 —— 固定基准房 W15N15 + 东邻镜像 W14N15（B3 推导：东邻 =
      // roomNameFromXY(x+1,y)；固定房名复用安全 = resetArena 每次 start 清场）。不随机选房：
      // arena 模式拒收 rooms（已在 start 前置校验；客户端 start 不传 rooms）。
      const base = 'W15N15'
      const mirror = 'W14N15'
      await this.backend.system('arenaGen', { room: base, sources: 2 })
      for (const [index, player] of match.players.entries()) {
        assignments[player.sessionId] = index === 0 ? base : mirror
      }
    } else {
      // world 原路径零改动（回归保护）：逐玩家 generateRoom
      for (const [index, player] of match.players.entries()) {
        const spec = opts.rooms?.[index]
        const room = typeof spec === 'string' ? spec : spec?.room ?? pickRoomName()
        assignments[player.sessionId] = room
        // M2 E 步：{room, exits} 形状带 exits 透传（arena-mod generateRoom 已支持）
        if (spec && typeof spec === 'object' && spec.exits) {
          await this.backend.system('generateRoom', { room, exits: spec.exits })
        } else {
          await this.backend.system('generateRoom', room)
        }
      }
    }
    for (const player of match.players) {
      // bot 座位（2026-09-09：仅测试/内部链路注入的 botCode 直接建号；普通 Agent 玩家空壳起步（submit_code 热更））
      // A0 暂存式 submit（plan v5.3）：creating 阶段 Agent 提交的脚本存进 player.code，start 建号注入——
      // 与 botCode 同构先例（realCreateUser 写 users.code branch:'default'+activeWorld，开赛后 live 热更
      // 默认 $activeWorld 替换同一激活分支 → 同分支不冲突）。
      const code = player.botCode ?? player.code ?? EMPTY_CODE
      const created = await this.backend.createUser({ username: player.username, room: assignments[player.sessionId]!, code })
      await this.store.update(matchId, state => {
        const mine = state.players.find(p => p.sessionId === player.sessionId)
        if (mine && created.id) mine.userId = created.id
      })
      // M6 记录点 4（plan-M6 §3.1）：start 注入即该座位「生效代码 v0」——botCode/空壳都记
      // （观战完整性，空壳一眼可辨）。phase=placing（transition('placing') 先于本循环）。
      // append 永不 reject（失败只 log），不阻塞 start 编排。
      await this.codeLog?.append(matchId, {
        username: player.username,
        phase: 'placing',
        source: 'start-injected',
        modules: code,
      })
    }

    // 保持新进程暂停：restart 默认会 resume，但此处必须先写元数据，再放行 VM。
    await this.backend.restart({ resume: false })
    // [M2 fix] 兜底 backend.restart() 后新进程 accessibleRoomsCache 初始 undefined：
    // 显式把对局房名列表 set 回 env，VM start 时 data.accessibleRooms 必定非空。
    await this.backend.system('setAccessibleRooms', Object.values(assignments))
    await this.backend.system('setTickDuration', match.config.tickDuration)
    await this.backend.system('resume', Object.values(assignments))
    const snapshot = await this.backend.getWorld()

    return this.store.transition(matchId, 'running', { startTick: snapshot.gameTime, phaseTick: snapshot.gameTime, assignments })
  }

  /**
   * M5 §3.4：进入周期边界（running → roundBreak）。配 world-rounds 局使用：
   *   pause 世界（失败只记 error——round 边界语义成立，下一周期从 pause 前 worldTime 续跑）
   *   → transition('roundBreak')（roundBreakSince 墙钟戳 = 超时计时基准）→ 唤醒 handle（由调用方注
   *   followup，见 §3.5）→ botCode 座位自动置 ready=true（bot 无提交能力，沿用原代码，次要②）。
   * single-writer：只有 drive 循环调本方法（与 settle 同构）；observe 只返回 autoRound.due。
   */
  async enterRoundBreak(matchId: string): Promise<MatchState> {
    return this.withMatchLock(matchId, async () => {
      const match = await this.get(matchId)
      if (match.phase !== 'running') {
        // 幂等：已在边界 / 已结算 → 直接返回现状（不抛，drive 循环可安全重入）
        return match
      }
      let error: string | undefined
      try {
        await this.backend.system('pause')
      } catch (err) {
        error = `enterRoundBreak: pause failed (${(err as Error).message})`
        this.log(error)
      }
      const entered = await this.store.update(matchId, state => {
        state.phase = 'roundBreak'
        state.roundBreakSince = Date.now()
        state.roundIndex = state.roundIndex ?? 0
        // bot 座位自动 ready（无提交能力，沿用原代码）
        for (const p of state.players) {
          if (p.botCode && p.ready === undefined) p.ready = true
        }
        if (error) state.error = error
      })
      // 唤醒 handle（spawn-Agent 局有 handle；调用方经 onRoundBreak 钩子 followup，见 §3.5）
      await this.drivers.roundBreak?.(entered)
      return entered
    })
  }

  /**
   * M5 §3.3/3.4：全员 commit 后续跑（roundBreak → running）。**resume 世界之前**对每个
   * ready 玩家无条件重传当前 code（阻塞 1 修复：唯一通道 svc.submitCode...$activeWorld；
   * 幂等覆盖上一轮分支；user.js 上传后清 VM 缓存 → resume 首 tick 读新代码）。
   * 失败降级（二审次要 3）：任一失败 → 该玩家沿用旧代码+已成功玩家保持新代码，照常 resume，
   * match.error 落盘（部分更新混合跑；不做整轮不 resume——会与世界 pause 死锁）。
   */
  async resumeNextRound(matchId: string): Promise<MatchState> {
    return this.withMatchLock(matchId, async () => {
      let match = await this.get(matchId)
      if (match.phase !== 'roundBreak') {
        // 幂等：已续跑 / 已结算 → 返回现状
        return match
      }
      // 全员 ready 才续跑（drive 循环会在未全齐时跳过；bot 已自动 ready）
      if (!match.players.every(p => p.ready === true)) {
        return match
      }
      // 1) resume 前真传代码（仅对 ready 玩家；无条件重传当前 code）
      const errors: string[] = []
      for (const player of match.players) {
        if (player.ready !== true || !player.code || !player.userId) continue
        try {
          await this.backend.submitCode?.(player.username, player.code, '$activeWorld')
        } catch (err) {
          errors.push(`${player.username}: ${(err as Error).message}`)
          this.log(`resumeNextRound submitCode failed for ${player.username}: ${(err as Error).message}`)
        }
      }
      // 2) 记 roundIndex+1、清 ready（phaseTick 在 resume 后用冻结的 worldTime 更新——下一轮起点）
      match = await this.store.update(matchId, state => {
        state.roundIndex = (state.roundIndex ?? 0) + 1
        state.roundReady = true
        for (const p of state.players) p.ready = false
        const err = errors.length > 0 ? `resumeNextRound: submit failed for [${errors.join('; ')}] (those keep last-round code)` : undefined
        if (err) state.error = err
      })
      // 3) resume 世界 → running；phaseTick 更新为 resume 时的 worldTime（下一轮起点）。
      //    世界 pause 期间 gameTime 冻结 → snapshot 与 pause 前一致；resume 后首 tick 才算新一轮。
      const worldNow = (await this.backend.getWorld()).gameTime
      await this.backend.system('resume')
      match = await this.store.transition(matchId, 'running', { phaseTick: worldNow })
      return match
    })
  }

  /**
   * M5 §3.4：world-rounds 单拍驱动（幂等；drive 循环每 tick 调一次）：
   *   running + autoRound.due          → enterRoundBreak（周期边界暂停 + 唤醒）
   *   roundBreak + 全员 ready           → resumeNextRound（真传代码 + 续跑）
   *   roundBreak + maxRounds 已尽       → settle（maxRounds 终止）
   *   roundBreak + 超时（roundBreakSince）→ 未 commit 沿用旧代码自动 ready + 续跑（坑④兜底）
   * 返回 'break' | 'resumed' | 'settled' | 'idle'（幂等：无 pending 时 idle，不重复推进）。
   */
  async driveNextRound(matchId: string, opts: { roundBreakTimeoutMs?: number; now?: number } = {}): Promise<'break' | 'resumed' | 'settled' | 'idle'> {
    const match = await this.store.get(matchId)
    if (!match || match.config.form !== 'world' || (match.config.roundTicks ?? 0) <= 0) return 'idle'
    // 1) running：autoRound 探测（无副作用——reuse observe 的只读探测路径）
    if (match.phase === 'running') {
      const obs = await this.observe(matchId).catch(() => null)
      if (obs && obs.autoRound.due) {
        await this.enterRoundBreak(matchId)
        return 'break'
      }
      return 'idle'
    }
    // 2) roundBreak：maxRounds 终止 → settle（记分制；人工/接口也可早 settle）。
    // roundIndex = 已进入的周期边界序号（enterRoundBreak 置 0，resumeNextRound 时 +1）；
    // 「已完成 maxRounds 轮」= roundIndex+1 >= maxRounds（第 0 轮 break 后即满 1 轮）。
    if (match.phase === 'roundBreak') {
      const maxRounds = match.config.maxRounds ?? 0
      if (maxRounds > 0 && (match.roundIndex ?? 0) + 1 >= maxRounds) {
        await this.settle(matchId, 'ticksExhausted')
        return 'settled'
      }
      // 3) 超时兜底（坑④）：roundBreakSince + timeout 到点 → 未 commit 玩家沿用上一轮代码自动 ready
      const timeoutMs = opts.roundBreakTimeoutMs ?? 0
      const since = match.roundBreakSince ?? 0
      if (timeoutMs > 0 && since > 0 && (opts.now ?? Date.now()) - since >= timeoutMs) {
        await this.store.update(matchId, state => {
          for (const p of state.players) {
            if (p.ready !== true) {
              p.ready = true
              state.error = (state.error ? state.error + '; ' : '') + `round break timeout: ${p.username} kept last-round code`
            }
          }
        })
      }
      // 4) 全员 ready → 续跑
      const fresh = await this.store.get(matchId)
      if (fresh && fresh.phase === 'roundBreak' && fresh.players.every(p => p.ready === true)) {
        await this.resumeNextRound(matchId)
        return 'resumed'
      }
      return 'idle'
    }
    return 'idle'
  }

  async pause(matchId: string): Promise<MatchState> {
    await this.assertRunning(matchId)
    await this.backend.system('pause')
    return this.store.transition(matchId, 'paused')
  }

  async resume(matchId: string): Promise<MatchState> {
    const match = await this.store.get(matchId)
    if (!match) throw new MatchError('notFound', `match ${matchId} not found`)
    if (match.phase !== 'paused') throw new MatchError('badPhase', `match ${matchId}: cannot resume from ${match.phase}`)
    await this.backend.system('resume')
    return this.store.transition(matchId, 'running')
  }

  /** 观察点：消费事件增量（kills/losses 累积）→ 世界快照 → 记分投影 + 自动终止判定。不落盘。
   * 并发安全：per-match 单飞锁，client 轮询与 Agent 工具并发时事件不双计（P0 审查次要 2）。
   * M4-B：settling 是 active phase——公开 observe 在读锁前先做 phase check 直接 409
   * （plan §3.2：锁内才检查会让并发轮询全部串行等待后拿到同一 409；M3 client 3s 轮询
   * 下一轮自然恢复）。 */
  async observe(matchId: string): Promise<MatchObservation> {
    const probe = await this.store.get(matchId)
    if (probe?.phase === 'settling') {
      throw new MatchError('badPhase', `match ${matchId}: settlement in progress`)
    }
    return this.withMatchLock(matchId, () => this.observeUnlocked(matchId))
  }

  /** 无锁观察（调用方必须已持 withMatchLock）。observe 与 settle 共享。 */
  private async observeUnlocked(matchId: string): Promise<MatchObservation> {
    const match = await this.get(matchId)
    await this.consumeEvents(matchId)
    const snapshot = await this.backend.getWorld()
    const byName = new Map(snapshot.users.map(u => [u.username, u]))
    const kills = this.killLossByMatch.get(matchId) ?? new Map()
    const scoreboard: MatchObservation['scoreboard'] = {}
    let eliminatedCount = 0
    for (const player of match.players) {
      const user = byName.get(player.username)
      const kl = player.userId !== undefined ? kills.get(player.userId) : undefined
      const counters: PlayerCounters = {
        territory: user?.ownedRooms ?? 0,
        rclTotal: user?.rclTotal ?? 0,
        // 击杀/损失来自事件流累积（M2 B 步）；老死/自杀等非战斗死亡不计 loss
        kills: kl?.kills ?? 0,
        losses: kl?.losses ?? 0,
        energy: 0,
      }
      // M3 A 节 eliminated 双分支：
      //   arena：拆光对方 spawn 即出局（ownedRooms 各 1 恒成立无意义，controller 不可毁且
      //         各属一方；对方无 spawn 即无法再生产——RCL1 上限 1 个 spawn）；
      //   world：spawns==0 && creeps==0（战斗意义上失去生产力+战力即出局；controller 不可毁，
      //         判据不含 ownedRooms——AGENTS 玩法节已回写）。外部旧版 worldSnapshot 缺 creeps
      //         （undefined → ??0 → ===0）→ 自动降级为 spawns==0，不炸。
      const eliminated =
        match.config.form === 'arena'
          ? (user?.spawns ?? 0) === 0
          : (user?.spawns ?? 0) === 0 && (user?.creeps ?? 0) === 0
      if (eliminated) eliminatedCount++
      scoreboard[player.sessionId] = { score: computeScore(counters, match.config.scoring), counters, eliminated }
    }

    const ticksElapsed = match.startTick === undefined ? null : snapshot.gameTime - match.startTick
    let reason: SettleReason | undefined
    if (match.config.maxTicks > 0 && ticksElapsed !== null && ticksElapsed >= match.config.maxTicks) {
      reason = 'ticksExhausted'
    } else if (match.players.length >= 2 && eliminatedCount >= match.players.length - 1) {
      reason = 'lastStanding'
    }

    // M5 §3.4：autoRound 探测（只读、无副作用）——running + roundTicks>0 + 本轮 tick 尽。
    // phaseTick 是进入当前 phase/running 段的 worldTime（start/resumeNextRound 写入）；
    // roundBreak 期间世界 pause（gameTime 冻结），phaseTick 保持本轮起点，不会误触发。
    let roundDue: { due: boolean; index?: number } = { due: false }
    if (
      match.config.form === 'world' &&
      (match.config.roundTicks ?? 0) > 0 &&
      match.phase === 'running' &&
      snapshot.gameTime - (match.phaseTick ?? match.startTick ?? snapshot.gameTime) >= (match.config.roundTicks ?? 0)
    ) {
      roundDue = { due: true, index: match.roundIndex ?? 0 }
    }

    return { match, gameTime: snapshot.gameTime, ticksElapsed, scoreboard, autoSettle: { due: reason !== undefined, reason }, autoRound: roundDue }
  }

  /**
   * 消费自上次游标以来的事件增量并累积到 killLoss（matchId → userId → {kills, losses}）。
   * 归因合并点（九审次要 1）：settle 内部调 observe → 复用同一路径，终局分数含全程。
   * bound=false（ring 溢出）不在这里落盘，settle 时记 scoreWarning。
   */
  private async consumeEvents(matchId: string): Promise<void> {
    const match = await this.store.get(matchId)
    if (!match) {
      // 对局已删除：清内存状态，防泄漏（九审次要 3）
      this.eventCursor.delete(matchId)
      this.killLossByMatch.delete(matchId)
      this.eventBoundByMatch.delete(matchId)
      return
    }
    const from = this.eventCursor.get(matchId) ?? 0
    const page = await this.backend.eventLog(from)
    this.eventBoundByMatch.set(matchId, page.bound)
    if (page.cursor <= from) return
    this.eventCursor.set(matchId, page.cursor)
    const events = (page.events ?? []) as EventTick[]
    if (events.length === 0) return
    let bucket = this.killLossByMatch.get(matchId)
    if (!bucket) {
      bucket = new Map()
      this.killLossByMatch.set(matchId, bucket)
    }
    const flat: ArenaEvent[] = []
    for (const tick of events) {
      for (const roomEvents of Object.values(tick.eventsByRoom)) {
        for (const ev of roomEvents) flat.push(ev)
      }
    }
    for (const attribution of attributeTick(flat)) {
      if (attribution.killerUserId !== null) {
        const kl = bucket.get(attribution.killerUserId) ?? { kills: 0, losses: 0 }
        kl.kills += 1
        bucket.set(attribution.killerUserId, kl)
      }
      if (attribution.combat && attribution.ownerUserId !== null) {
        const kl = bucket.get(attribution.ownerUserId) ?? { kills: 0, losses: 0 }
        kl.losses += 1
        bucket.set(attribution.ownerUserId, kl)
      }
    }
  }

  /* ================================ M4-B：journal 结算 ================================ */

  /**
   * 结算（终局一次；唯一 journal 顺序 plan §6.1）。并发安全同 observe。
   *   observe 一次固定 candidate → beginSettlement(durable) → pause（失败记 journal.error 保持
   *   settling）→ replay marker（赛事局）/na（普通局）→ history marker → tournament marker →
   *   commitSettlement。任何失败保持 settling（reconcile 幂等重放；普通网络错误不允许直接
   *   abort——丢 candidate）。
   * 外部语义保持 M3：settled/terminal → badPhase 409；settling（并发第二次）→ 409。
   */
  async settle(matchId: string, reason: SettleReason): Promise<MatchState> {
    return this.withMatchLock(matchId, async () => {
      const pre = await this.store.get(matchId)
      if (!pre) throw new MatchError('notFound', `match ${matchId} not found`)
      if (pre.phase === 'settling') throw new MatchError('badPhase', `match ${matchId}: settlement in progress`)
      if (pre.phase !== 'running' && pre.phase !== 'paused' && pre.phase !== 'roundBreak') {
        throw new MatchError('badPhase', `match ${matchId}: cannot settle from ${pre.phase}`)
      }

      const observation = await this.observeUnlocked(matchId)
      const { candidate, scoreWarning } = this.buildCandidate(observation, reason)
      // 事件 ring 溢出 → 记缺陷到对局状态，不静默错分（consumEvents 已记录 bound）
      if (scoreWarning !== undefined) {
        await this.store.update(matchId, state => {
          state.scoreWarning = scoreWarning
        })
      }
      const modes = this.modesFor(pre)
      const begun = await this.store.beginSettlement(matchId, candidate, modes)

      try {
        // 2. backend pause；失败只记 journal.error，保持 settling（reconcile 会重试）
        try {
          await this.backend.system('pause')
        } catch (err) {
          await this.journalError(matchId, `pause failed: ${(err as Error).message}`)
        }
        await this.runSettlementMarkers(matchId, modes)
        const committed = await this.store.commitSettlement(matchId, (await this.store.get(matchId))!.revision!)
        this.clearMatchCursor(matchId)
        return committed
      } catch (err) {
        await this.journalError(matchId, `settlement step failed: ${(err as Error).message}`).catch(() => {})
        throw err
      }
    })
  }

  /**
   * reconcileSettlement（plan API 5；仅供恢复器调用，幂等）——只读取已固定 journal，
   * 按 replay → history → tournament → commit 顺序重试；先查 receipt 再决定是否重新调用
   * 外部 put/apply，绝不重新 observe/重算 winner。已 settled/interrupted → 幂等返回。
   */
  async reconcileSettlement(matchId: string): Promise<MatchState> {
    return this.withMatchLock(matchId, async () => {
      let state = await this.store.get(matchId)
      if (!state) throw new MatchError('notFound', `match ${matchId} not found`)
      if (state.phase !== 'settling' || !state.settlement) return state // settled/interrupted 幂等
      const j = state.settlement

      // replay（pending 才做；drivers 缺失 = 该 marker 本就不可能 enabled）
      if (j.replay.status === 'pending') {
        if (!this.drivers.replay) throw new MatchError('corrupt', `match ${matchId}: replay marker pending but no replay driver`)
        const r = await this.drivers.replay(state)
        state = await this.store.markSettlement(matchId, state.revision!, 'replay', r.receipt, {
          completeness: r.completeness,
          gapReasons: r.gapReasons,
        })
      }
      if (j.history.status === 'pending') {
        if (!this.drivers.history) throw new MatchError('corrupt', `match ${matchId}: history marker pending but no history driver`)
        const h = await this.drivers.history(state, state.settlement!)
        state = await this.store.markSettlement(matchId, state.revision!, 'history', { resultId: h.resultId, payloadHash: h.resultHash })
      }
      if (j.tournament.status === 'pending') {
        if (!this.drivers.tournament) throw new MatchError('corrupt', `match ${matchId}: tournament marker pending but no tournament driver`)
        const { result, resultHash } = await this.buildMatchResultInput(state)
        const g = await this.drivers.tournament.applyResult(matchId, result)
        if (g.outcome === 'conflict') {
          // gateway conflict（revision/attempt 不匹配）→ 记 error 并让上层（恢复器）决策 abort
          throw new MatchError('conflict', `match ${matchId}: tournament applyResult conflict${g.reason ? ` (${g.reason})` : ''}`)
        }
        // tournament receipt 的 payloadHash = 与 HistoryStore 同一 MatchResult 的同一 resultHash
        // （不依赖 gateway 返回值——gateway 只负责推进 slot/写 store receipt，hash 由本地算）
        state = await this.store.markSettlement(matchId, state.revision!, 'tournament', {
          resultId: matchId,
          payloadHash: resultHash,
          storeRevision: g.slotRevision,
        })
      }
      // commit（settled → 幂等）
      state = await this.store.commitSettlement(matchId, state.revision!)
      this.clearMatchCursor(matchId)
      return state
    })
  }

  /** markCleanup 透传（settled 后记录 hook 结果；tournament 局为 not-applicable）。 */
  async markCleanup(matchId: string, expectedRevision: number, status: 'committed' | 'unknown' | 'not-applicable', error?: string): Promise<MatchState> {
    return this.store.markCleanup(matchId, expectedRevision, status, error)
  }

  /** settle 步骤 3-5：按 modes 跑 replay/history/tournament 外部 IO 并写 marker。 */
  private async runSettlementMarkers(matchId: string, modes: BeginModes): Promise<void> {
    const state = await this.store.get(matchId)
    if (!state || !state.settlement) throw new MatchError('corrupt', `match ${matchId}: settlement journal missing`)

    if (modes.replay === 'enabled') {
      if (!this.drivers.replay) throw new MatchError('corrupt', `match ${matchId}: replay driver missing for tournament settlement`)
      const r = await this.drivers.replay(state)
      await this.store.markSettlement(matchId, state.revision!, 'replay', r.receipt, { completeness: r.completeness, gapReasons: r.gapReasons })
    }
    if (modes.history === 'enabled') {
      if (!this.drivers.history) throw new MatchError('corrupt', `match ${matchId}: history driver missing`)
      const s1 = await this.store.get(matchId)
      const h = await this.drivers.history(s1!, s1!.settlement!)
      await this.store.markSettlement(matchId, s1!.revision!, 'history', { resultId: h.resultId, payloadHash: h.resultHash })
    }
    if (modes.tournament === 'enabled') {
      if (!this.drivers.tournament) throw new MatchError('corrupt', `match ${matchId}: tournament gateway missing`)
      const s2 = await this.store.get(matchId)
      const { result, resultHash } = await this.buildMatchResultInput(s2!)
      const g = await this.drivers.tournament.applyResult(matchId, result)
      if (g.outcome === 'conflict') {
        // gateway 已把赛事置 failed/conflict（receipt/revision 冲突）→ 本局不能 commit
        throw new MatchError('conflict', `match ${matchId}: tournament applyResult conflict${g.reason ? ` (${g.reason})` : ''}`)
      }
      await this.store.markSettlement(matchId, s2!.revision!, 'tournament', {
        resultId: matchId,
        payloadHash: resultHash,
        storeRevision: g.slotRevision,
      })
    }
  }

  /** 从观察构造 begin candidate（与 M3 相同的 winner/scores 判定 + kills/losses + 快照）。 */
  private buildCandidate(
    observation: MatchObservation,
    reason: SettleReason,
  ): { candidate: BeginCandidate; scoreWarning: string | undefined } {
    const { match } = observation
    const alive = match.players.filter(p => !observation.scoreboard[p.sessionId]!.eliminated)
    let winner: WinnerRef
    if (reason === 'lastStanding') {
      winner = alive.length === 1 ? { kind: 'session', id: alive[0]!.sessionId } : { kind: 'draw' }
    } else {
      const ranked = [...match.players].sort(
        (a, b) => observation.scoreboard[b.sessionId]!.score - observation.scoreboard[a.sessionId]!.score,
      )
      const top = ranked[0]!
      const second = ranked[1]!
      winner =
        observation.scoreboard[top.sessionId]!.score === observation.scoreboard[second.sessionId]!.score
          ? { kind: 'draw' }
          : { kind: 'session', id: top.sessionId }
    }
    const scores = Object.fromEntries(Object.entries(observation.scoreboard).map(([sid, s]) => [sid, s.score]))
    // kills/losses 归因按 userId 累积 → 映射回 session（player.userId 回填后才可归因）
    const userIdToSession = new Map<string, string>()
    for (const p of match.players) if (p.userId) userIdToSession.set(p.userId, p.sessionId)
    const bucket = this.killLossByMatch.get(match.id) ?? new Map()
    const kills: Record<string, number> = {}
    const losses: Record<string, number> = {}
    for (const [userId, kl] of bucket) {
      const session = userIdToSession.get(userId)
      if (!session) continue
      kills[session] = kl.kills
      losses[session] = kl.losses
    }
    const participantMapping: CandidateParticipantSnapshot[] = match.players.map(p => ({
      sessionId: p.sessionId,
      username: p.username,
      ...(p.participantId !== undefined ? { participantId: p.participantId } : {}),
    }))
    return {
      candidate: {
        reason,
        winner,
        scores,
        kills,
        losses,
        endTick: observation.gameTime,
        participantMapping,
      },
      scoreWarning: this.eventBoundByMatch.get(match.id) === false ? '事件流 ring 溢出，kills/losses 可能缺失' : undefined,
    }
  }

  /** 按赛事/普通 + drivers 装配决策 marker 初值模式。 */
  private modesFor(match: MatchState): BeginModes {
    if (match.tournamentId !== undefined) {
      // 赛事局：replay/history/tournament 三 marker 全 enabled；任一 driver 缺失 → 不可 settle
      if (!this.drivers.replay || !this.drivers.history || !this.drivers.tournament) {
        throw new MatchError('badPhase', `match ${match.id}: tournament settlement requires replay/history/tournament drivers`)
      }
      return { replay: 'enabled', history: 'enabled', tournament: 'enabled' }
    }
    return { replay: 'na', history: this.drivers.history ? 'enabled' : 'na', tournament: 'na' }
  }

  /** 把 journal 组装成 MatchResult（canonical 字段集见 history/model；scores/kills/losses 映射
   *  participant key——赛事局）。供 history put 与 tournament gateway apply 共用同一对象。 */
  private async buildMatchResultInput(state: MatchState): Promise<{ result: MatchResult; resultHash: string }> {
    const result = buildMatchResult(state, state.settlement!)
    return { result, resultHash: toResultHash(result) }
  }

  /** 把失败记进 journal.error（保持 settling；不覆盖既有错误——追加）。 */
  private async journalError(matchId: string, message: string): Promise<void> {
    await this.store.update(matchId, state => {
      if (!state.settlement) return
      state.settlement.error = state.settlement.error ? `${state.settlement.error}; ${message}` : message
    })
  }

  private clearMatchCursor(matchId: string): void {
    this.eventCursor.delete(matchId)
    this.killLossByMatch.delete(matchId)
    this.eventBoundByMatch.delete(matchId)
  }

  private async assertRunning(matchId: string): Promise<MatchState> {
    const match = await this.store.get(matchId)
    if (!match) throw new MatchError('notFound', `match ${matchId} not found`)
    if (match.phase !== 'running') throw new MatchError('badPhase', `match ${matchId}: not running (phase=${match.phase})`)
    return match
  }

  private async get(matchId: string): Promise<MatchState> {
    const match = await this.store.get(matchId)
    if (!match) throw new MatchError('notFound', `match ${matchId} not found`)
    if (!isActivePhase(match.phase)) throw new MatchError('badPhase', `match ${matchId}: phase ${match.phase as MatchPhase} is terminal`)
    return match
  }
}
