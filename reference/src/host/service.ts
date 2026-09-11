/**
 * ScreepsService — dsh-screeps 的宿主核心（S6）。
 *
 * 职责：
 * - managed 模式：便携 Node 供给 → 私服安装 → 进程组拉起 → 健康就绪（S1-S3 的编排层）；
 * - external 模式：只探测既有私服的 arena API；
 * - 对上（路由/工具/对局控制器）暴露 ensureRunning() 与 arena 客户端方法。
 *
 * 生命周期：Service.init 只做快速校验并启动后台 ensure 任务；
 * ensure 失败不吞——状态置 failed 并在 ensureRunning() 调用点抛出。
 * 停服顺序（AGENTS.md）：pause → SIGTERM 进程组 → SIGKILL 兜底。
 */
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ensureNodeRuntime, type NodeRuntime } from '../runtime/node-runtime.ts'
import { ensureScreepsServer, readArenaSecret } from '../runtime/server-installer.ts'
import { launchScreepsServer, type RunningServer } from '../runtime/server-launcher.ts'
import { MatchService } from './match/match-service.ts'
import { registerHttp } from './http.ts'
import { registerTools } from './tools.ts'
import { SpawnOrchestrator, type AgentRegistryLike, type SpawnResult } from './agents.ts'
import type { MatchPreset } from './match/model.ts'
import { configFromPreset } from './match/model.ts'
import { AdmissionStore } from './admission/store.ts'
import { AdmissionGate } from './admission/gate.ts'
import { TournamentStore } from './tournament/store.ts'
import { TournamentService } from './tournament/service.ts'
import { TournamentGateway } from './tournament/gateway.ts'
import { HistoryStore } from './history/store.ts'
import { buildMatchResult } from './history/model.ts'
import { ReplayStore } from './replay/store.ts'
import { ReplayRecorder } from './replay/recorder.ts'
import { RecoveryCoordinator } from './recovery-coordinator.ts'

export interface Config {
  serverMode: 'managed' | 'external'
  /** 插件数据目录（运行时缓存 + 私服 + 对局记录）。 */
  dataDir: string
  /** external 模式的私服地址。 */
  externalUrl: string
  /** managed 模式监听端口；0 = 自动选空闲端口。 */
  port: number
  /** 便携 Node 主版本（'22' | '24' | 完整版本号）。 */
  nodeVersion: string
  nodeDistMirror: string
  /** 覆盖：直接使用指定 node 可执行文件（ABI 必须匹配）。 */
  externalNodeBin?: string
  /** 对局默认 tick 间隔（ms）。 */
  tickDuration: number
  readyTimeoutMs: number
  /** A0 spawn-Agent：玩家会话缺省模型型号（spawn 请求体可逐局覆盖）。 */
  agentModel?: string
  /** A0 spawn-Agent：recruit 单阶段超时（ms，默认 180s；120-300s 窗口）。 */
  agentRecruitTimeoutMs: number
  /** M4-F：赛事自动编排驱动周期（ms）。 */
  driveIntervalMs?: number
  /** M5：world-rounds 周期边界（roundBreak）超时（ms，默认 300s；到点未 commit 沿用旧代码续跑）。 */
  roundBreakTimeoutMs?: number
}

export type ScreepsServiceStatus = 'provisioning' | 'running' | 'stopped' | 'failed'

export interface ScreepsWorldSnapshot {
  ok: boolean
  gameTime: number
  users: Array<{
    id: string
    username: string
    badge?: unknown
    isBot: boolean
    cpu: number
    /** 引擎每 tick 更新的实测 CPU 用量（M2 D 步：report 趋势数据源；配额是 cpu）。 */
    lastUsedCpu?: number
    gcl: number
    ownedRooms: number
    rclTotal: number
    spawns: number
    /** M3 A 节：该用户当前存活 creep 数（eliminated 判据 spawns+creeps 用）；外部旧版 server 缺。 */
    creeps?: number
    /** M3 A 节：该用户所有 spawn 的 store.energy 总和（能量对称断言用）；外部旧版 server 缺。 */
    spawnEnergy?: number
    rooms: Array<{ room: string; level: number; progress: number; spawns?: Array<{ x: number; y: number }> }>
  }>
}

export class ScreepsService extends Service {
  static Config: z<Config> = z.object({
    serverMode: z.union([z.const('managed'), z.const('external')]).default('managed'),
    dataDir: z.string().default(path.join(homedir(), '.dsh-screeps')),
    externalUrl: z.string().default('http://127.0.0.1:21025'),
    port: z.natural().max(65535).default(0),
    nodeVersion: z.string().default('22'),
    nodeDistMirror: z.string().default('https://nodejs.org/dist'),
    externalNodeBin: z.string(),
    tickDuration: z.natural().default(200),
    readyTimeoutMs: z.natural().default(180_000),
    agentModel: z.string(),
    agentRecruitTimeoutMs: z.natural().min(120_000).max(300_000).default(180_000),
    /** M4-F：赛事自动编排驱动周期（ms）。测试可注入小值加速。 */
    driveIntervalMs: z.natural().min(50).max(60_000).default(1_000),
    /** M5：world-rounds 周期边界（roundBreak）超时（ms，默认 300s）。 */
    roundBreakTimeoutMs: z.natural().default(300_000),
  })

  readonly config: Config
  private readonly log: (msg: string, ...args: unknown[]) => void
  private status: ScreepsServiceStatus = 'stopped'
  private statusDetail = ''
  private ensurePromise: Promise<void> | undefined
  private runtime: NodeRuntime | undefined
  private server: RunningServer | undefined
  private secret: string | undefined
  private exitGuard: (() => void) | undefined
  /** 对局层（S9b）：store + lifecycle，接线本服务作为 ArenaBackend。 */
  readonly match: MatchService
  /** A0 spawn-Agent：惰性创建的编排器（持有各局 spawn 的 AgentHandle，结束/删除时 dispose 防泄漏）。 */
  private orchestrator: SpawnOrchestrator | undefined
  /** M4-F：赛事自动编排驱动循环（submitted→start→settle→推进；幂等单拍）。 */
  private driveTimer: ReturnType<typeof setInterval> | undefined
  private readonly dataDir: string
  /** M4-B/C 共享 AdmissionGate（legacy spawn + tournament create/start + recovery lock）。 */
  readonly admission: AdmissionGate
  /** M4-C 唯一 TournamentService（ScreepsService 构造并持有；含 TournamentStore + handles）。 */
  readonly tournaments: TournamentService
  readonly historyStore: HistoryStore
  readonly replayStore: ReplayStore
  readonly replayRecorder: ReplayRecorder
  private recoveryCoordinator: RecoveryCoordinator | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'screeps')
    this.config = config
    this.dataDir = config.dataDir.startsWith('~') ? path.join(homedir(), config.dataDir.slice(1)) : config.dataDir
    const logger = ctx.logger('dsh-screeps')
    this.log = (msg, ...args) => logger.info(msg, ...args)
    // ---- M4 共享持久层（在 dataDir 下）----
    const admissionStore = new AdmissionStore(path.join(this.dataDir, 'admission'))
    this.historyStore = new HistoryStore(path.join(this.dataDir, 'history'))
    this.replayStore = new ReplayStore(path.join(this.dataDir, 'replays'))
    const tournamentStore = new TournamentStore(path.join(this.dataDir, 'tournaments'))
    // ---- 结算 drivers：history/tournament 立即接；replay 由 M4-D ReplayRecorder 装配 ----
    const gateway = new TournamentGateway({
      tournaments: tournamentStore,
      matches: () => this.match.store,
      log: (msg: string) => this.log('%s', msg),
    })
    // replay 槽位：installReplayDriver 由 M4-D 注入；未注入时 tournament settle 的 replay
    // marker 会保持 pending（MatchLifecycle 运行时读 this.drivers.replay → 经 getter 拿最新值）。
    const replaySlot = { current: undefined as NonNullable<import('./match/lifecycle.ts').SettlementDrivers['replay']> | undefined }
    this.replayDriverSlot = replaySlot
    this.match = new MatchService(
      this,
      this.dataDir,
      this.log,
      {
        // A0 收尾：对局 commit 后回收该局 spawn 的全部 Agent 会话（防泄漏，Level 收尾核对）；
        // tournament 局由 orchestration handle 管理，此处 no-op（orchestrator 无该局记录）。
        onSettled: state => {
          // M4-C：tournament 局 commit 后由 orchestrator 推进（下一 slot/attempt 或终态回收）；
          // 普通 spawn-Agent 局回收该局会话；两者互斥分支。
          if (state.tournamentId) {
            void this.tournaments.onMatchSettled(state.id).catch(err => {
              this.log('tournament settle hook failed: %s', (err as Error).message)
            })
          } else {
            this.disposeAgentMatch(state.id)
          }
        },
      },
      {
        history: async (match, journal) => {
          const result = buildMatchResult(match, journal)
          const put = await this.historyStore.put(result)
          return { resultId: result.resultId, resultHash: put.resultHash }
        },
        tournament: gateway,
        // M5 §3.5：roundBreak 唤醒——spawn-Agent 局对每个 Agent handle followup 周期战报 + 提交邀请。
        // 用 this.orchestrator（lazy 建，此时可能还没有）；无 handle 的局（工具/IT 直连）返回 0，靠
        // drive 循环的全员 ready 检测续跑兜底。
        roundBreak: async (match) => {
          const count = await this.orchestrator?.followupMatchAgents(
            match.id,
            `对局 ${match.id} 第 ${(match.roundIndex ?? 0) + 1} 个周期结束，世界已暂停（周期边界）。` +
              '请用 screeps_report 查看本周期战报，必要时修改代码后用 screeps_submit_code 提交下一轮脚本（commit = 就绪）；' +
              '全员就绪后自动进入下一周期。',
          )
          if ((count ?? 0) === 0) {
            this.log(`roundBreak ${match.id}: no agent handles to wake — waiting for ready detection`)
          }
        },
        get replay() {
          return replaySlot.current
        },
      },
    )
    // ---- AdmissionGate：legacy spawn / tournament create/start / recovery 共享 ----
    this.admission = new AdmissionGate({
      admission: admissionStore,
      matches: this.match.store,
      tournaments: tournamentStore,
      log: (msg: string) => this.log('%s', msg),
    })
    // ---- 唯一 TournamentService ----
    this.tournaments = new TournamentService({
      store: tournamentStore,
      gate: this.admission,
      match: this.match,
      registry: () => this.agentRegistry(),
      timeoutMs: config.agentRecruitTimeoutMs,
      log: (msg: string) => this.log('%s', msg),
    })
    this.recoveryCoordinator = new RecoveryCoordinator({
      admission: admissionStore,
      matches: this.match,
      tournaments: tournamentStore,
      log: (msg: string) => this.log('%s', msg),
    })
    // ---- M4-D：ReplayRecorder（bridge = 本服务；store = replayStore）→ install replay driver ----
    this.replayRecorder = new ReplayRecorder({
      bridge: this as unknown as import('./replay/recorder.ts').ReplayBridgeLike,
      store: this.replayStore,
      log: (msg: string) => this.log('%s', msg),
    })
    this.installReplayDriver(async match => this.replayRecorder.finish(match))
  }

  /** 观测/编排循环的便捷入口：对已 begin 的局拉取一页（防 bridge queue 满 → fatal）。 */
  async drainReplay(matchId: string): Promise<void> {
    const meta = await this.replayStore.getMeta(matchId)
    if (!meta) return
    await this.replayRecorder.drain(matchId, { sourceGeneration: meta.sourceGeneration, replayId: meta.replayId })
  }

  /** 编排层在 attempt match 进入 running 时调用：起播 recorder（幂等）。 */
  async beginReplay(match: { id: string; assignments?: Record<string, string> }): Promise<void> {
    const state = await this.match.store.get(match.id)
    if (!state || !state.tournamentId) return
    await this.replayRecorder.begin(state)
  }

  /* ------------------------------ M4-D：HTTP 服务面 ------------------------------ */

  /** POST /tournaments：recruiting 持久化（fire-and-forget recruit）。operationId 由本服务生成。 */
  async httpCreateTournament(input: { requestId: string; config: import('./tournament/model.ts').TournamentConfig }) {
    const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // create() 默认 awaitRecruit=false：state recruiting 落盘后后台 recruit
    const res = await this.tournaments.create(input.requestId, input.config, operationId, { awaitRecruit: false })
    // fire-and-forget recruit（HTTP 202 立即返回；recruit 失败写 state 可查询，不阻塞建赛）
    // 幂等：recruit 对 ready/running 直接返回；对 recruiting 执行编排
    void this.tournaments.recruit(operationId, res.tournamentId).catch(err => {
      this.log('tournament recruit (fire-and-forget) failed: %s', (err as Error).message)
    })
    return {
      ok: true,
      tournamentId: res.tournamentId,
      recruiting: true,
      quotaWarning: true,
      operationId,
    }
  }

  async httpListTournaments(): Promise<import('./tournament/model.ts').TournamentPublicView[]> {
    const all = await this.tournaments.storeRef.list()
    const { toTournamentPublicView } = await import('./tournament/model.ts')
    return all.map(toTournamentPublicView)
  }

  async httpGetTournament(tournamentId: string): Promise<import('./tournament/model.ts').TournamentPublicView | null> {
    const state = await this.tournaments.storeRef.get(tournamentId)
    if (!state) return null
    const { toTournamentPublicView } = await import('./tournament/model.ts')
    return toTournamentPublicView(state)
  }

  /**
   * GET /tournaments/:id/bracket：纯投影的 bracket 视图（plan §7.1 契约）——
   * 公开 alias（displayName）、slot/attempt 摘要、winner/draw/gap，剥离 session/userId。
   */
  async httpGetTournamentBracket(
    tournamentId: string,
  ): Promise<import('./tournament/model.ts').TournamentBracketView | null> {
    const state = await this.tournaments.storeRef.get(tournamentId)
    if (!state) return null
    const { toTournamentBracketView } = await import('./tournament/model.ts')
    return toTournamentBracketView(state)
  }

  async httpStartTournament(tournamentId: string): Promise<{ ok: boolean; tournamentId: string; phase: string }> {
    const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const state = await this.tournaments.start(tournamentId, operationId)
    return { ok: true, tournamentId: state.id, phase: state.phase }
  }

  async httpRetryTournament(tournamentId: string): Promise<{ ok: boolean; tournamentId: string; phase: string }> {
    const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const state = await this.tournaments.retry(tournamentId, operationId)
    return { ok: true, tournamentId: state.id, phase: state.phase }
  }

  /** GET /matches/:id/replay：读 ReplayStore 页 → sanitize（username→participant）。 */
  async httpReadReplay(
    matchId: string,
    opts: { cursor?: number; limit?: number; afterTick?: number },
  ): Promise<import('./replay/store.ts').ReplayReadPage & { sanitized: import('./replay/model.ts').ReplayRecord[] }> {
    // 读前顺带 drain 已 begin 的 live 局一页（可见水位消费驱动，防 bridge queue 满 fatal）
    await this.drainReplay(matchId).catch(() => {})
    const page = await this.replayStore.read(matchId, opts)
    if (page.unavailable) return { ...page, sanitized: [] }
    const { sanitizeRecords, buildReplayNameMapping } = await import('./replay/sanitize.ts')
    const match = await this.match.store.get(matchId)
    const mapping = buildReplayNameMapping((match?.players ?? []).map(p => ({
      username: p.username,
      participantId: p.participantId,
      displayName: p.participantId,
    })))
    return { ...page, sanitized: sanitizeRecords(mapping, page.records) }
  }

  /** GET /history/leaderboard：公开 leaderboard。 */
  async httpLeaderboard(opts: { tournamentId?: string; limit?: number }): Promise<import('./history/model.ts').LeaderboardPage> {
    return this.historyStore.leaderboard(opts)
  }

  /** M4-D ReplayRecorder 装配点：final replay drain → ReplayStore finalize 的 driver。 */
  private readonly replayDriverSlot: {
    current?: NonNullable<import('./match/lifecycle.ts').SettlementDrivers['replay']>
  }
  installReplayDriver(driver: NonNullable<import('./match/lifecycle.ts').SettlementDrivers['replay']>): void {
    this.replayDriverSlot.current = driver
  }

  private agentRegistry(): AgentRegistryLike | null {
    const registry = (this.ctx.get?.('agents') as AgentRegistryLike | undefined) ?? (this.ctx as unknown as { agents?: AgentRegistryLike }).agents
    return registry ?? null
  }

  async [Service.init](): Promise<void> {
    const log = this.log
    log(`dataDir=%s mode=%s`, this.dataDir, this.config.serverMode)
    // 快速校验：数据目录可写（不吞错误，配置坏则 fiber 失败）
    const { mkdirSync } = await import('node:fs')
    mkdirSync(this.dataDir, { recursive: true })
    // M4-B/C boot recovery（plan §3.3）：独占 recovery reservation → reconcile settling →
    // 无 handle 赛事级联/普通 active interrupted → diagnostics → release。不自动 resume。
    const report = await this.recoveryCoordinator!.run({ releaseOwnership: true })
    if (report.interruptedOrdinary.length + report.tournamentInterrupted.length + report.tournamentCascade.length > 0) {
      log(
        'recovery: %d ordinary interrupted, %d tournaments interrupted, %d cascades, %d reconciled',
        report.interruptedOrdinary.length,
        report.tournamentInterrupted.length,
        report.tournamentCascade.length,
        report.reconciled.length,
      )
    }
    if (report.diagnostics.length > 0) log('recovery diagnostics: %d', report.diagnostics.length)
    // S11：webServer 就绪后挂 /dsh-screeps/* 控制面路由（headless profile 无 webServer
    // 时该子插件保持 pending，无副作用）；随本 fiber 注销
    registerHttp(this.ctx, this)
    // S13：tools 就绪后注册会话工具面（同理）
    registerTools(this.ctx, this)
    // M4-F：赛事自动编排驱动循环——周期扫描 running tournaments，对每场做
    // driveOnce（submitted→start / autoSettle→settle；幂等，无 pending 时零开销）。
    // 驱动循环不假设 submit 由本进程的 turn 完成（Agent turn 可能很慢），只轮询
    // MatchStore 的 submitted/phase CAS；终态/无赛事时退出。dispose 时 clearInterval。
    this.driveTimer = setInterval(() => {
      void this.driveAll().catch(err => {
        this.log('drive loop error: %s', (err as Error).message)
      })
    }, this.config.driveIntervalMs ?? 1_000)
    // 后台启动 ensure；失败在 ensureRunning() 调用点显式抛出
    void this.ensureRunning().catch(err => {
      log('ensure failed: %s', err)
    })
    // fiber 卸载时停服。必须返回 promise：cordis runDisposable 只 await disposer
    // 返回的 thenable（node_modules/@deepseek-ai/cordis/lib/index.js L963-966 与
    // L1178-1182），`void` 丢弃 promise → `await fiber.dispose()` 不等 ~14s 停服序列
    // （pause + 10.5s autosave 窗口 + SIGTERM）→ detached 进程组整体孤儿
    // （docs/spikes/m0-flake.md 第二节，根因已亲验）。
    this.ctx.effect(() => () => this.shutdown(), 'screeps: server lifecycle')
  }

  getStatus(): { status: ScreepsServiceStatus; detail: string; port?: number; mode: Config['serverMode'] } {
    return {
      status: this.status,
      detail: this.statusDetail,
      ...(this.server ? { port: this.server.port } : {}),
      mode: this.config.serverMode,
    }
  }

  /* ---------------- A0 spawn-Agent 玩家闭环 ---------------- */

  /**
   * 人类建赛入口（HTTP spawnAgents 端点的薄封装 + 测试/集成验收直调通道）。
   * 编排全流程（spawn N 会话 → A1 create → 打标 spawnedBy → A2..N join → 写脚本 → 全就绪）
   * 见 agents.ts SpawnOrchestrator。返回时对局 creating + spawnedBy='agents' + 全员 submitted。
   * 注意：spawn 出的是真实 Agent 会话（真 LLM，烧模型额度）——调用方需先向用户明示。
   * provider 显式传时（如集成验收 stub lane）不隐式 fallback；model 缺省用 config.agentModel。
   */
  async spawnAgentMatch(input: { preset: MatchPreset; count?: number; model?: string; provider?: string }): Promise<SpawnResult> {
    const orchestrator = this.getOrchestrator()
    const preset = configFromPreset(input.preset)
    return orchestrator.spawn({
      preset: input.preset,
      count: input.count ?? preset.seats,
      model: input.model ?? this.config.agentModel,
      provider: input.provider,
      timeoutMs: this.config.agentRecruitTimeoutMs,
    })
  }

  /** HTTP 同步预检用：Config agentModel 现值（无则 spawn-agents 400 明确指引，见 http.ts）。 */
  get agentModel(): string | undefined {
    return this.config.agentModel
  }

  /** 对局 settle/删除后回收该局 spawn 的全部 Agent 会话（幂等，无则 no-op）。 */
  async disposeAgentMatch(matchId: string): Promise<void> {
    await this.orchestrator?.disposeMatchAgents(matchId)
  }

  /**
   * 惰性取 DSH AgentRegistry 并创建编排器。agent 服务是可选依赖（headless 无 webServer 场景
   * 不应阻塞整个 plugin），通过 ctx.get 探测——裸 Context/单测环境无 ctx.agents → 明确报错。
   */
  private getOrchestrator(): SpawnOrchestrator {
    const registry = (this.ctx.get?.('agents') as AgentRegistryLike | undefined) ?? (this.ctx as unknown as { agents?: AgentRegistryLike }).agents
    if (!registry) {
      throw new Error(
        'spawn-agent: ctx.agents (DSH AgentRegistry) unavailable — spawn needs a real DSH runtime; ' +
          'unit tests drive SpawnOrchestrator with a stub registry directly',
      )
    }
    if (!this.orchestrator) {
      this.orchestrator = new SpawnOrchestrator({
        registry,
        match: this.match,
        log: (msg: string) => this.log('%s', msg),
      })
    }
    return this.orchestrator
  }

  /** 幂等：返回值时私服已就绪（arena API 可用）。 */
  async ensureRunning(): Promise<{ port: number; baseUrl: string }> {
    if (this.status === 'running' && this.server) {
      return { port: this.server.port, baseUrl: this.baseUrl() }
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.ensure().finally(() => {
        this.ensurePromise = undefined
      })
    }
    await this.ensurePromise
    if (this.status !== 'running' || !this.server) {
      throw new Error(`screeps server not running: ${this.status} ${this.statusDetail}`)
    }
    return { port: this.server.port, baseUrl: this.baseUrl() }
  }

  private baseUrl(): string {
    return this.config.serverMode === 'external'
      ? this.config.externalUrl.replace(/\/+$/, '')
      : `http://127.0.0.1:${this.server!.port}`
  }

  private async ensure(): Promise<void> {
    this.status = 'provisioning'
    this.statusDetail = ''
    const log = this.log
    try {
      if (this.config.serverMode === 'external') {
        await this.probeExternal()
      } else {
        await this.ensureManaged(log)
      }
      this.status = 'running'
    } catch (err) {
      this.status = 'failed'
      this.statusDetail = String(err)
      throw err
    }
  }

  protected async probeExternal(): Promise<void> {
    const res = await fetch(`${this.config.externalUrl.replace(/\/+$/, '')}/api/game/time`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`external screeps probe failed: HTTP ${res.status}`)
    const secret = await readArenaSecret(this.dataDir)
    this.secret = secret
  }

  protected async ensureManaged(log: (msg: string, ...args: unknown[]) => void): Promise<void> {
    const serverDir = path.join(this.dataDir, 'server')
    this.runtime = await this.createRuntime()
    log('runtime ready: %s', this.runtime.version)
    await this.runInstaller(serverDir, log)
    this.secret = await readArenaSecret(serverDir)
    this.server = await this.launch(serverDir)
    // 进程组已存在（spawn 已发生）：挂上宿主异常退出的 SIGKILL 兜底
    this.installExitGuard(this.server)
    await this.server.waitReady()
    log('server ready on port %s', this.server.port)
    // 服务已就绪：先置 running，让 ensureRunning 对并发调用方可用
    this.status = 'running'
    // 应用配置的默认 tick 间隔。
    // 注意：必须走直连 fetch——ensure 链内严禁经 ensureRunning()（会 await 自身的
    // ensurePromise 造成自死锁，这是 22:06 测试超时挂起的根因）。
    const body = (await this.arenaFetchDirect('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'setTickDuration', value: this.config.tickDuration }),
    })) as { ok?: boolean; error?: string }
    if (!body?.ok) {
      log('setTickDuration failed: %s', body?.error ?? 'unknown')
    }
  }

  protected async createRuntime(): Promise<NodeRuntime> {
    return ensureNodeRuntime({
      runtimeDir: path.join(this.dataDir, 'runtime'),
      versionSpec: this.config.nodeVersion,
      distMirror: this.config.nodeDistMirror,
      ...(this.config.externalNodeBin ? { externalNodeBin: this.config.externalNodeBin } : {}),
    })
  }

  protected async runInstaller(serverDir: string, log: (msg: string, ...args: unknown[]) => void): Promise<void> {
    if (!this.runtime) throw new Error('runtime missing')
    // arena mod 随插件分发：从本包定位 screeps-mod/arena-mod.cjs
    const modPath = path.join(this.modRoot(), 'screeps-mod', 'arena-mod.cjs')
    const { readFileSync } = await import('node:fs')
    const mods: Array<{ name: string; content: string }> = [
      { name: 'arena-mod.cjs', content: readFileSync(modPath, 'utf8') },
    ]
    // 可选调试 mod（runner/engine loop stage 追踪）：DSH_SCREEPS_DEBUG_MOD=1
    if (process.env.DSH_SCREEPS_DEBUG_MOD === '1') {
      const debugPath = path.join(this.modRoot(), 'scripts', 'debug-mod.cjs')
      mods.push({ name: 'debug-mod.cjs', content: readFileSync(debugPath, 'utf8') })
    }
    await ensureScreepsServer({
      serverDir,
      runtime: this.runtime,
      mods,
      onLog: log,
    })
  }

  protected async launch(serverDir: string): Promise<RunningServer> {
    if (!this.runtime) throw new Error('runtime missing')
    return launchScreepsServer({
      serverDir,
      runtime: this.runtime,
      ...(this.config.port > 0 ? { port: this.config.port } : {}),
      readyTimeoutMs: this.config.readyTimeoutMs,
      onLog: msg => this.log('%s', msg),
    })
  }

  /** 包根目录（lib/.. 的真实路径）；供定位随包资源。 */
  protected modRoot(): string {
    // 从当前文件向上探测随包资源（源码在 <pkg>/src/host，产物在 <pkg>/lib）
    let dir = path.dirname(new URL(import.meta.url).pathname)
    const start = dir
    for (let i = 0; i < 6; i++) {
      if (existsSync(path.join(dir, 'screeps-mod', 'arena-mod.cjs'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    throw new Error(`screeps-mod/arena-mod.cjs not found upward from ${start}`)
  }

  /* ---------------- arena 客户端 ---------------- */

  /**
   * 直连版 arena fetch：仅限 ensure 链内部使用（server 已就绪，不经 ensureRunning，
   * 避免自死锁）。外部一律走 arenaFetch。
   */
  private async arenaFetchDirect(pathname: string, init?: RequestInit): Promise<unknown> {
    if (!this.server) throw new Error('arenaFetchDirect called without a running server')
    return this.rawFetch(this.baseUrl(), pathname, init)
  }

  private async rawFetch(base: string, pathname: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.secret ? { 'x-arena-secret': this.secret } : {}),
        ...(init?.headers ?? {}),
      },
    })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`arena ${pathname} -> HTTP ${res.status} non-JSON: ${text.slice(0, 120)}`)
    }
    return body
  }

  private async arenaFetch(pathname: string, init?: RequestInit): Promise<unknown> {
    const { baseUrl } = await this.ensureRunning()
    return this.rawFetch(baseUrl, pathname, init)
  }

  async getWorld(): Promise<ScreepsWorldSnapshot> {
    return (await this.arenaFetch('/api/arena/world')) as ScreepsWorldSnapshot
  }

  /** M6：地形位域串（观战坐标地图；2500 字符/房，索引 y*50+x，bit1=wall bit2=swamp）。 */
  async getTerrain(rooms: string[]): Promise<{ terrain: Record<string, string> }> {
    if (rooms.length === 0 || rooms.length > 64) throw new Error('getTerrain: rooms must contain 1..64 names')
    const body = (await this.arenaFetch(`/api/arena/terrain?rooms=${encodeURIComponent(rooms.join(','))}`)) as {
      terrain?: Record<string, string>
    }
    return { terrain: body.terrain ?? {} }
  }

  async system(cmd: string, value?: unknown): Promise<Record<string, unknown>> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd, ...(value !== undefined ? { value } : {}) }),
    })) as Record<string, unknown>
    // mod 层把业务失败编码为 ok:false（HTTP 仍 400 经 rawFetch 解析成功）；
    // 不在此处熔断的话，半执行的命令（如 generateRoom 生成房间后子步骤失败）
    // 会被上游静默吞掉——m0-flake §三 的 accessibleRooms 断供正是这样藏了三个里程碑。
    if (body && body.ok === false) {
      throw new Error(`arena system ${cmd} failed: ${String(body.error ?? 'unknown')}`)
    }
    return body
  }

  async createUser(input: {
    username: string
    room: string
    code?: Record<string, string>
    cpu?: number
    gcl?: number
    x?: number
    y?: number
  }): Promise<{ id: string; username: string }> {
    const body = (await this.arenaFetch('/api/arena/users', {
      method: 'POST',
      body: JSON.stringify(input),
    })) as { ok: boolean; error?: string; user?: { id: string; username: string } }
    if (!body.ok || !body.user) throw new Error(`createUser failed: ${body.error ?? 'unknown'}`)
    return body.user
  }

  /** 以指定用户身份执行 console 表达式并取回输出（M2 会话映射后的官方通道）。 */
  async runConsole(username: string, expression: string): Promise<string> {
    const token = await this.getToken(username)
    const { baseUrl } = await this.ensureRunning()
    const res = await fetch(`${baseUrl}/api/user/console`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-username': username, 'x-token': token },
      body: JSON.stringify({ expression }),
    })
    return res.status === 200 ? 'ok' : `HTTP ${res.status}`
  }

  /** 读指定用户的 Memory（M2 会话映射后的官方通道）。 */
  async readMemory(username: string): Promise<unknown> {
    const token = await this.getToken(username)
    const { baseUrl } = await this.ensureRunning()
    const res = await fetch(`${baseUrl}/api/user/memory`, {
      headers: { 'x-username': username, 'x-token': token },
    })
    return res.json()
  }

  /** 读指定用户 Memory 的某个子路径（官方 ?path= 语义）。 */
  async readMemoryPath(username: string, path?: string): Promise<unknown> {
    const token = await this.getToken(username)
    const { baseUrl } = await this.ensureRunning()
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    const res = await fetch(`${baseUrl}/api/user/memory${query}`, {
      headers: { 'x-username': username, 'x-token': token },
    })
    return res.json()
  }

  /** 写指定用户 Memory（官方 POST /api/user/memory：value + 可选 path）。 */
  async writeMemory(username: string, value: unknown, path?: string): Promise<void> {
    const token = await this.getToken(username)
    const { baseUrl } = await this.ensureRunning()
    const res = await fetch(`${baseUrl}/api/user/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-username': username, 'x-token': token },
      body: JSON.stringify(path ? { path, value } : { value }),
    })
    if (!res.ok) throw new Error(`writeMemory failed: HTTP ${res.status}`)
  }

  /** 上传/热更指定用户的代码。branch 默认 '$activeWorld'（激活世界分支，下一 tick 生效）。 */
  async submitCode(username: string, modules: Record<string, string>, branch = '$activeWorld'): Promise<{ timestamp: number }> {
    const token = await this.getToken(username)
    const { baseUrl } = await this.ensureRunning()
    const res = await fetch(`${baseUrl}/api/user/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-username': username, 'x-token': token },
      body: JSON.stringify({ branch, modules }),
    })
    const body = (await res.json()) as { ok?: number; error?: string; timestamp?: number }
    if (!res.ok || body.ok !== 1) {
      throw new Error(`submitCode failed: ${body.error ?? `HTTP ${res.status}`}`)
    }
    return { timestamp: body.timestamp ?? Date.now() }
  }

  /** 取指定用户自上次游标以来的 console 消息（arena-mod ring buffer）。 */
  async consoleOutput(
    username: string,
    since?: number,
  ): Promise<{ lines: unknown[]; cursor: number; bound: boolean; pubsubTicks?: number; selfLoop?: boolean }> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'consoleOutput', value: { user: username, since } }),
    })) as { ok: boolean; lines?: unknown[]; cursor?: number; bound?: boolean; pubsubTicks?: number; selfLoop?: boolean; error?: string }
    if (body.ok !== true) throw new Error(`consoleOutput failed: ${body.error ?? 'unknown'}`)
    return { lines: body.lines ?? [], cursor: body.cursor ?? 0, bound: body.bound ?? false, pubsubTicks: body.pubsubTicks, selfLoop: body.selfLoop }
  }

  /** 事件流增量拉取（M2 B 步）：since=ring 下标；bound=false = ring 溢出过（事件段缺失）。 */
  async eventLog(
    since?: number,
  ): Promise<{ events: unknown[]; cursor: number; bound: boolean; ringFull?: boolean }> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'eventLog', value: since }),
    })) as { ok: boolean; events?: unknown[]; cursor?: number; bound?: boolean; ringFull?: boolean; error?: string }
    if (body.ok !== true) throw new Error(`eventLog failed: ${body.error ?? 'unknown'}`)
    return { events: body.events ?? [], cursor: body.cursor ?? 0, bound: body.bound ?? true, ringFull: body.ringFull }
  }

  /* ---------------- M4-A0：canonical replay bridge host 客户端 ---------------- */

  /** 启动一局 canonical replay（arena-mod replayStart）。单 host 单 active bridge。 */
  async replayStart(input: {
    replayId: string
    matchId: string
    rooms: string[]
    acceptedGameTime?: number
  }): Promise<{
    schemaVersion: number
    sourceGeneration: string
    cursor: number
    acceptedGameTime: number | null
    queueCapacity: number
  }> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'replayStart', value: input }),
    })) as {
      ok: boolean
      schemaVersion?: number
      sourceGeneration?: string
      cursor?: number
      acceptedGameTime?: number | null
      queueCapacity?: number
      error?: string
    }
    if (body.ok !== true) throw new Error(`replayStart failed: ${body.error ?? 'unknown'}`)
    return {
      schemaVersion: body.schemaVersion ?? 1,
      sourceGeneration: body.sourceGeneration!,
      cursor: body.cursor ?? 0,
      acceptedGameTime: body.acceptedGameTime ?? null,
      queueCapacity: body.queueCapacity ?? 256,
    }
  }

  /** 拉取 replay 页（record seq cursor 水位；generation 必须匹配当前 active）。 */
  async replayPage(input: {
    replayId: string
    sourceGeneration: string
    cursor?: number
    limit?: number
  }): Promise<{
    schemaVersion: number
    sourceGeneration: string
    replayId: string
    cursor: number
    nextCursor: number
    records: unknown[]
    status: 'live' | 'complete' | 'partial'
    complete: boolean
    finalCursor?: number
    gapReasons: string[]
    fatalBackpressure: boolean
  }> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'replayPage', value: input }),
    })) as {
      ok: boolean
      schemaVersion?: number
      sourceGeneration?: string
      replayId?: string
      cursor?: number
      nextCursor?: number
      records?: unknown[]
      status?: string
      complete?: boolean
      finalCursor?: number
      gapReasons?: string[]
      fatalBackpressure?: boolean
      error?: string
    }
    if (body.ok !== true) throw new Error(`replayPage failed: ${body.error ?? 'unknown'}`)
    return {
      schemaVersion: body.schemaVersion ?? 1,
      sourceGeneration: body.sourceGeneration!,
      replayId: body.replayId!,
      cursor: body.cursor ?? 0,
      nextCursor: body.nextCursor ?? body.cursor ?? 0,
      records: body.records ?? [],
      status: (body.status as 'live' | 'complete' | 'partial') ?? 'live',
      complete: body.complete ?? false,
      finalCursor: body.finalCursor,
      gapReasons: body.gapReasons ?? [],
      fatalBackpressure: body.fatalBackpressure ?? false,
    }
  }

  /** 停止 replay（idempotent；返回 final manifest + records）。 */
  async replayStop(input: {
    replayId: string
    sourceGeneration: string
  }): Promise<{
    schemaVersion: number
    sourceGeneration: string
    replayId: string
    finalCursor: number
    finalGameTime: number | null
    status: 'complete' | 'partial'
    complete: boolean
    gapReasons: string[]
    fatalBackpressure: boolean
    records: unknown[]
  }> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'replayStop', value: input }),
    })) as {
      ok: boolean
      schemaVersion?: number
      sourceGeneration?: string
      replayId?: string
      finalCursor?: number
      finalGameTime?: number | null
      status?: string
      complete?: boolean
      gapReasons?: string[]
      fatalBackpressure?: boolean
      records?: unknown[]
      error?: string
    }
    if (body.ok !== true) throw new Error(`replayStop failed: ${body.error ?? 'unknown'}`)
    return {
      schemaVersion: body.schemaVersion ?? 1,
      sourceGeneration: body.sourceGeneration!,
      replayId: body.replayId!,
      finalCursor: body.finalCursor ?? 0,
      finalGameTime: body.finalGameTime ?? null,
      status: (body.status as 'complete' | 'partial') ?? 'partial',
      complete: body.complete ?? false,
      gapReasons: body.gapReasons ?? [],
      fatalBackpressure: body.fatalBackpressure ?? false,
      records: body.records ?? [],
    }
  }

  /** 查询 replay bridge 状态（诊断用）。 */
  async replayStatus(): Promise<{
    schemaVersion: number
    active: boolean
    replayId: string | null
    sourceGeneration: string | null
    matchId: string | null
    status: string
    complete: boolean
    recordCount: number
    queueDepth: number
    gapReasons: string[]
    fatalBackpressure: boolean
  }> {
    const body = (await this.arenaFetch('/api/arena/system', {
      method: 'POST',
      body: JSON.stringify({ cmd: 'replayStatus' }),
    })) as Record<string, unknown> & { ok?: boolean }
    if (body.ok !== true) throw new Error('replayStatus failed')
    return body as never
  }

  private async getToken(username: string): Promise<string> {
    const body = (await this.arenaFetch('/api/arena/token', {
      method: 'POST',
      body: JSON.stringify({ username }),
    })) as { ok: boolean; token?: string }
    if (!body.ok || !body.token) throw new Error(`getToken failed for ${username}`)
    return body.token
  }

  /** M4-F + M5：驱动循环——扫描 running tournaments（driveOnce）+ 普通 running world-rounds 局
   * （driveNextRound：autoRound→roundBreak / 全员 ready→resumeNextRound / maxRounds 或超时→终止）。
   * 每场幂等；无 pending 时 no-op；终态/无双占用时退出。 */
  private async driveAll(): Promise<void> {
    // tournaments（M4 既有）
    const tStates = await this.tournaments.storeRef.list()
    for (const s of tStates.filter(x => x.phase === 'running')) {
      try {
        await this.tournaments.driveOnce(s.id)
      } catch (err) {
        this.log('drive %s failed: %s', s.id, (err as Error).message)
      }
    }
    // 普通 world-rounds 局（M5）：running/roundBreak 才值得驱动（creating 由 spawn 编排推进）
    const matches = await this.match.store.list()
    for (const m of matches) {
      if (m.config.form === 'world' && (m.config.roundTicks ?? 0) > 0 && (m.phase === 'running' || m.phase === 'roundBreak')) {
        try {
          const r = await this.match.driveNextRound(m.id, { roundBreakTimeoutMs: this.config.roundBreakTimeoutMs })
          if (r !== 'idle') this.log(`driveNextRound ${m.id}: ${r}`)
        } catch (err) {
          this.log('driveNextRound %s failed: %s', m.id, (err as Error).message)
        }
      }
    }
  }

  /** 测试辅助：停止驱动循环（unit tests 不想被 interval 打扰时）。 */
  stopDrive(): void {
    if (this.driveTimer !== undefined) {
      clearInterval(this.driveTimer)
      this.driveTimer = undefined
    }
  }

  async shutdown(): Promise<void> {
    // 先停驱动循环（不再调度新的 driveOnce），再 dispose 编排器。
    this.stopDrive()
    // M4-C dispose 顺序（plan §3.3）：先 TournamentService（停编排、dispose handles），
    // 后普通 orchestrator，最后停服；任何 handle dispose rejection 都先记录再继续。
    try {
      await this.tournaments.dispose()
    } catch (err) {
      this.log('tournament dispose failed: %s', (err as Error).message)
    }
    if (this.orchestrator) {
      await this.orchestrator.disposeAllMatches()
    }
    // 与在途 ensure 交接：dispose 可能早于就绪发生（Service.init 的后台 ensure）。
    // 若此刻不等待，本函数看到 server 未定义而 no-op，ensure 却继续把进程组拉起
    // → detached 组整体孤儿。等 ensure 落地：成功 → 下方停服；失败 → 半拉起的组
    // 同样被兜住（launch 已把 this.server 置位，waitReady 失败不清它）。
    if (this.ensurePromise) {
      await this.ensurePromise.catch(() => {})
    }
    const server = this.server
    if (!server) return
    this.server = undefined
    try {
      await server.stop()
    } finally {
      // 停服完成后才注销 exit guard。绝不能在 stop() 之前 remove：
      // stop() 内部有 ~10.5s 的 LokiJS autosave 数据安全窗口（launcher stop L153），
      // 而宿主（dsh headless 单任务）只给应用树 5s dispose 宽限（profile-boot
      // PROCESS_SHUTDOWN_TIMEOUT_MS），到点强制 process.exit() —— 若 guard 已被卸，
      // 无人再 SIGKILL 进程组 → 私服全套孤儿（S14 实测：C2 后 launcher+storage+
      // backend+engine 6 进程残留，server.log 只有启动无 stopped）。
      // guard 在 stop() 完成后注销：正常路径进程组已死，SIGKILL 命中空组被吞，无害。
      this.removeExitGuard()
      this.status = 'stopped'
    }
  }

  /**
   * 最后一道兜底：宿主进程未走 dispose 就退出（崩溃/信号）时，'exit' 回调必须
   * 同步执行，来不及走 pause→10.5s→SIGTERM 的优雅序列，直接 SIGKILL 整个进程组，
   * 不给 detached 组变成孤儿的机会（孤儿共享 db.json autosave 互踩，污染下一次运行）。
   * 正常路径 shutdown 会先注销它，不影响优雅停服。
   */
  private installExitGuard(server: RunningServer): void {
    this.removeExitGuard()
    const pgid = server.child.pid
    if (pgid === undefined) return
    const guard = (): void => {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        /* 进程组已不存在 */
      }
    }
    this.exitGuard = guard
    process.on('exit', guard)
  }

  private removeExitGuard(): void {
    if (this.exitGuard) {
      process.off('exit', this.exitGuard)
      this.exitGuard = undefined
    }
  }

  /**
   * 重启私服（仅 managed 模式；external 模式为 no-op）。
   *
   * 必要性（S7a spike 结论）：runner 进程把世界地形缓存进 staticTerrainData（make.js
   * 模块级，仅进程生命周期内有效），generateRoom 之后新建的房间不在缓冲区 → 该房间
   * 内所有用户每次 run 都抛 "Could not load terrain data" → 代码永远不执行。
   * 官方没有刷新钩子（runtimeRestart 只清 VM 不清地形），所以对局搭建完成后必须重启。
   *
   * M2 部署可传 `{ resume: false }`，让调用方先写入 accessibleRooms 等元数据，
   * 再显式 resume；默认仍恢复运行，保持既有 M0 调用语义。
   */
  async restart(options: { resume?: boolean } = {}): Promise<void> {
    if (this.config.serverMode === 'external') {
      return
    }
    this.log('restarting server to refresh runner terrain cache')
    // 只停私服进程，不 dispose tournament/orchestrator（它们在 restart 期间必须保持存活；
    // 之前的 shutdown() 会把 running 赛事标 interrupted——对局 start 的 restart 会误杀赛事）。
    const server = this.server
    this.server = undefined
    if (server) {
      try {
        await server.stop()
      } finally {
        this.removeExitGuard()
        this.status = 'stopped'
      }
    }
    this.ensurePromise = undefined
    await this.ensureRunning()
    // stop() 的 pause 写进 env 并持久化；重启后默认恢复，M2 部署可暂时保持暂停
    if (options.resume !== false) await this.system('resume')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    screeps: ScreepsService
  }
}
