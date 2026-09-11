/**
 * A0 — spawn-Agent 玩家闭环（用户拍板：人类建赛 → host spawn N 个 Agent 会话为玩家）。
 *
 * 定位（plan-M3 A0）：
 * - 人类点「新建对局」→ 本模块经 DSH AgentRegistry.create 程序化 spawn N 个 Agent 会话
 *   （Arena=2 / World=可配置数量、模型可配）——不预入座，会话是真实 DSH Agent；
 * - **驱动机制（审查阻塞 1 钉死）**：create() 后 Agent 不会自动开首 turn（publish 只 enter/
 *   announce/emit session-start，不开 driver；setup 明令 "composes, it never drives"）——
 *   唯一驱动口是 create resolve 后逐 handle `agent.followup(message)`；
 * - **编排链（用户指正定案 = 方案 B：起名即 create/join 的 username 参数，零新机制）**：
 *   followup A1「起名+create」→ host 观察到新 match → 打标 spawnedBy='agents' →
 *   followup A2..N「起名+join」→ followup「写脚本」（暂存式 submit 回填 submitted）→
 *   全就绪 → 人类点「开始」（lifecycle.start 门槛见 lifecycle.ts）；
 * - **失败/超时（四审阻塞 2 钉死）**：每阶段 deadline（默认 180s，Config agentRecruitTimeoutMs）、
 *   一次重试 → 仍失败 dispose 全部已 spawn 会话 + 抛错；轮询间隔 2-5s（测试可注入小值）。
 *
 * 依赖最小化：不安装 dsh-agent devDep——声明 AgentRegistry 的最小结构化接口（运行时从
 * ctx.agents 取，DSH 一定有），单测用 fake registry。
 */
import { randomUUID } from 'node:crypto'
import type { MatchService } from './match/match-service.ts'
import type { MatchPreset, MatchState } from './match/model.ts'
import { configFromPreset } from './match/model.ts'
import { MatchError } from './match/store.ts'

/** 会话 id 前缀（可读、不与 __bot__ 保留名前缀冲突）。 */
export const SPAWN_SESSION_PREFIX = 'screeps-player-'

/** 起名规则（与 tools.ts USERNAME_RE 对齐；非 __bot__ 前缀）。 */
export const SPAWN_USERNAME_RE = /^[A-Za-z0-9_-]{1,30}$/

/**
 * DSH AgentRegistry 的最小结构化接口（正式包 dsh-agent 类型见
 * /usr/lib/.../dsh-agent/lib/types/index.d.ts L65-158：create/create 选项/AgentHandle.dispose）。
 * 形状子集：create({sessionId, agentOptions:{model,provider}, meta}) → 带 agent.followup() 的 handle。
 */
export interface AgentRegistryLike {
  create(options: {
    sessionId: string
    agentOptions?: { provider?: string; model?: string }
    meta?: { cwd?: string; agentPreset?: string; origin?: 'subagent' }
  }): Promise<AgentHandleLike>
}

/** create() 返回的 owned handle：dispose 是 CAPABILITY（停 loop→退出→unregister→移除 session→unwind scope）。 */
export interface AgentHandleLike {
  agent: { id: string; followup(message: unknown): void }
  dispose(): Promise<void>
}

export interface SpawnAgentOptions {
  preset: MatchPreset
  /** 座位数：Arena 强制 =2（B 节只支持 base+mirror 两房）；World [2, seats]。 */
  count: number
  /** 模型型号（可选；缺省用 config.agentModel 或全局）。 */
  model?: string
  /** Provider 路由（可选；集成验收 stub lane 显式传 stub provider 名）。 */
  provider?: string
  /** 单阶段超时毫秒（Config agentRecruitTimeoutMs 注入）。 */
  timeoutMs: number
}

export type SpawnStage = 'create' | 'join' | 'script'

/** 构造 createUserMessage 失败时的兜底消息形状（与 dsh-llm UserMessage 一致：
 *  {id, role, content:[{type:'text',text}], source:{kind:'user'}}）。 */
function makeUserMessage(text: string): unknown {
  return {
    id: `dsh-screeps-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A1 create 引导：自起名 → screeps_match create（用户名即名字，方案 B）。 */
export function buildCreatePrompt(opts: { preset: MatchPreset; count: number }): string {
  return (
    `你是本局斗蛐蛐对局的玩家 1（共 ${opts.count} 人，preset=${opts.preset}）。现在你需要为自己取一个用户名并入座：\n` +
    `1. 取名规则：1-30 字符，仅允许 [A-Za-z0-9_-]，不以 __bot__ 开头，且不能与任何现有玩家昵称相同；\n` +
    `2. 调用 screeps_match(action="create", username="<你起的名字>", preset="${opts.preset}") 创建对局并入座。\n` +
    `完成后报告你的用户名与 matchId。`
  )
}

/** A2..N join 引导：matchId 已由 A1 产生，其余玩家自起名后 join。 */
export function buildJoinPrompt(opts: { preset: MatchPreset; count: number; matchId: string; index: number; names: string[] }): string {
  return (
    `你是本局斗蛐蛐对局的玩家 ${opts.index}（共 ${opts.count} 人，preset=${opts.preset}，matchId=${opts.matchId}）。\n` +
    `已有玩家昵称：${opts.names.join(', ') || '(无)'}。\n` +
    `请为自己取一个 1-30 字符、仅 [A-Za-z0-9_-]、不以 __bot__ 开头、且与上面列表互不相同的用户名，` +
    `然后调用 screeps_match(action="join", matchId="${opts.matchId}", username="<你起的名字>") 入座。\n` +
    `完成后报告你的用户名。`
  )
}

/** 写脚本引导：暂存式 submit（creating 阶段由 tools.ts 拦截回填 submitted）+ 开局后运行期协议。 */
export function buildScriptPrompt(opts: { username: string; matchId: string; preset: MatchPreset }): string {
  return (
    `你是本局玩家 ${opts.username}（matchId=${opts.matchId}，preset=${opts.preset}）。现在编写你的 Screeps 脚本并提交：\n` +
    `调用 screeps_submit_code(modules={"main": "<完整的 main 模块源码>"})。main 必须导出 module.exports.loop = function () { ... }（engine 4.3.x 只执行这种形状）。\n` +
    `提交完成后报告。对局开始后的循环节奏：screeps_report 看战报 → 分析 → screeps_submit_code 热更代码，或 screeps_wait 等待下一观察点；` +
    `回合制约定：在 turn 末可用 schedule_create(after_seconds=<下一观察间隔>, prompt="查看战报并继续对局循环") 自唤醒继续。`
  )
}

export interface SpawnResult {
  matchId: string
  sessionIds: string[]
}

/**
 * spawn-Agent 编排器。对外语义（plan A0）：
 * - HTTP 端点触发时 fire-and-forget（202 + recruiting），前端轮询 GET /matches；
 * - 测试/集成验收直调 spawn() 等待完成（stub provider 零额度）。
 * 任一步超时 → 一次重试 → 仍失败 dispose 全部已 spawn 会话 + 抛错（原子性）。
 */
export class SpawnOrchestrator {
  /** matchId → 该局 spawn 的全部 handle（对局结束/删除时 dispose 防泄漏）。 */
  private readonly spawnedByMatch = new Map<string, AgentHandleLike[]>()

  constructor(
    private readonly deps: {
      registry: AgentRegistryLike
      match: MatchService
      log?: (msg: string) => void
      /** 轮询间隔（默认 2500ms；测试注入小值）。 */
      intervalMs?: number
    },
  ) {}

  private get interval(): number {
    return this.deps.intervalMs ?? 2500
  }

  private log(msg: string): void {
    this.deps.log?.(`spawn-agent: ${msg}`)
  }

  /** 对局结束/删除时回收该局 spawn 的全部 Agent 会话（幂等）。 */
  async disposeMatchAgents(matchId: string): Promise<void> {
    const handles = this.spawnedByMatch.get(matchId)
    if (!handles) return
    this.spawnedByMatch.delete(matchId)
    await disposeAll(handles, msg => this.log(msg))
  }

  /** 服务卸载：dispose 全部在册局的 Agent 会话（防泄漏）。 */
  async disposeAllMatches(): Promise<void> {
    const ids = [...this.spawnedByMatch.keys()]
    for (const id of ids) {
      await this.disposeMatchAgents(id)
    }
  }

  /**
   * M5 §3.5：roundBreak 唤醒——对该局每个 Agent handle 发周期战报 + 提交邀请（followup 主通道；
   *  self 续跑/测试局无 handle 时返回 false，靠全员 ready 检测续跑兜底）。
   */
  async followupMatchAgents(matchId: string, message: string): Promise<number> {
    const handles = this.spawnedByMatch.get(matchId)
    if (!handles || handles.length === 0) return 0
    for (const h of handles) {
      try {
        h.agent.followup({ id: `dsh-screeps-round-${randomUUID()}`, role: 'user', content: [{ type: 'text', text: message }], source: { kind: 'user' } })
      } catch (err) {
        this.log(`followup ${h.agent.id} failed: ${(err as Error).message}`)
      }
    }
    return handles.length
  }

  /**
   * 全流程编排：spawn N 会话 → A1 create → 打标 → A2..N join → 写脚本 → 全就绪。
   * 返回时对局处于 creating + spawnedBy='agents' + 全员 submitted（可点「开始」）。
   */
  async spawn(opts: SpawnAgentOptions): Promise<SpawnResult> {
    // --- 预检（spawn 前先查，避免 spawn 完才 409）---
    const preset = configFromPreset(opts.preset)
    if (preset.form === 'arena' && opts.count !== 2) {
      throw new MatchError('full', 'arena matches require exactly 2 agents (base + mirrored room)')
    }
    if (preset.form === 'world' && (opts.count < 2 || opts.count > preset.seats)) {
      throw new MatchError('full', `world matches allow ${2}-${preset.seats} agents (got ${opts.count})`)
    }
    const active = await this.deps.match.store.active()
    if (active) throw new MatchError('activeExists', `active match ${active.id} (${active.phase}) must settle first`)

    // 真实 Agent 玩家必须有模型：persona 组装要 {{model}} 变量，缺失 → 子会话 turn 直接
    // error（`prompt variable "{{model}}" has no value`），对局永不建出（M3 血泪教训同族；
    // 真实链路实测实锤 2026-09-09：未配 model 的 spawn 静默崩 turn、无任何可读报错）。
    // 未配 → 抛可读错误且不创建任何会话（HTTP 层另有同步 400 预检，此处兜防工具面直调）。
    if (!opts.model) {
      throw new Error(
        'agent spawn requires a model: pass model (e.g. "openrouter/deepseek/deepseek-v4-flash-0731") ' +
          'or set Config agentModel; without it the spawned Agent persona cannot assemble ({{model}} has no value)',
      )
    }

    // --- spawn N 个 Agent 会话（不入座）---
    const handles: AgentHandleLike[] = []
    const sessionIds: string[] = []
    try {
      for (let i = 0; i < opts.count; i++) {
        const sessionId = `${SPAWN_SESSION_PREFIX}${i + 1}-${randomUUID().slice(0, 8)}`
        sessionIds.push(sessionId)
        const agentOptions: { provider?: string; model?: string } = {}
        if (opts.provider) agentOptions.provider = opts.provider
        if (opts.model) agentOptions.model = opts.model
        const handle = await this.deps.registry.create({
          sessionId,
          agentOptions,
          // create 必须带 meta.cwd（persona 组装要 {{cwd}}；缺失 → turn 报 prompt variable 无值）
          meta: { cwd: process.cwd(), origin: 'subagent', agentPreset: 'screeps-player' },
        })
        handles.push(handle)
        this.log(`spawned session ${sessionId}${opts.model ? ` model=${opts.model}` : ''}${opts.provider ? ` provider=${opts.provider}` : ''}`)
      }
    } catch (err) {
      await disposeAll(handles, msg => this.log(msg))
      throw new Error(`spawn-agent: session create failed: ${(err as Error).message}`)
    }

    try {
      // --- 阶段 1：A1 起名+create（followup 驱动；create resolve 后恰一次）---
      const matchId = await this.phaseCreate(handles, opts)

      // 打标写点（七审提示 4）：host 观察到 A1 create 后立即 store.update 打 sourcesubject
      await this.deps.match.store.update(matchId, s => {
        s.spawnedBy = 'agents'
      })
      this.log(`match ${matchId} marked spawnedBy=agents`)

      // --- 阶段 2：A2..N 起名+join ---
      await this.phaseJoin(handles, matchId, opts)

      // --- 阶段 3：写脚本（暂存式 submit → 全就绪）---
      await this.phaseScript(handles, matchId, opts)

      this.spawnedByMatch.set(matchId, handles)
      return { matchId, sessionIds }
    } catch (err) {
      await disposeAll(handles, msg => this.log(msg))
      throw err
    }
  }

  /** 轮询 helper：deadline 内周期取样直到 test 通过；超时返回 undefined。 */
  private async pollUntil<T>(
    stage: SpawnStage,
    deadline: number,
    sample: () => Promise<T | undefined>,
    test: (value: T) => boolean,
  ): Promise<T | undefined> {
    while (Date.now() < deadline) {
      const value = await sample()
      if (value !== undefined && test(value)) return value
      await sleep(this.interval)
    }
    void stage
    return undefined
  }

  private async phaseCreate(handles: AgentHandleLike[], opts: SpawnAgentOptions): Promise<string> {
    const first = handles[0]!
    await this.drive(first, buildCreatePrompt({ preset: opts.preset, count: opts.count }))
    let matchId = (
      await this.pollUntil(
        'create',
        Date.now() + opts.timeoutMs,
        () => this.deps.match.store.active().then(a => a ?? undefined),
        () => true,
      )
    )?.id
    if (!matchId) {
      // 一次重试：先确认 active 确实没出现（可能刚出现就不重发，防 activeExists 误伤）
      const now = await this.deps.match.store.active()
      if (now) {
        matchId = now.id
      } else {
        this.log('phase create timed out; retrying A1 once')
        await this.drive(first, buildCreatePrompt({ preset: opts.preset, count: opts.count }))
        const retried = await this.pollUntil(
          'create',
          Date.now() + opts.timeoutMs,
          () => this.deps.match.store.active().then(a => a ?? undefined),
          () => true,
        )
        matchId = retried?.id
      }
    }
    if (!matchId) throw new Error('spawn-agent: player 1 did not create a match in time')
    return matchId
  }

  private async phaseJoin(handles: AgentHandleLike[], matchId: string, opts: SpawnAgentOptions): Promise<void> {
    const state = await this.deps.match.store.get(matchId)
    const names0 = (state?.players ?? []).map(p => p.username)
    const joiners = handles.slice(1)
    for (const [i, handle] of joiners.entries()) {
      await this.drive(
        handle,
        buildJoinPrompt({ preset: opts.preset, count: opts.count, matchId, index: i + 2, names: names0 }),
      )
    }
    const joined = await this.pollUntil(
      'join',
      Date.now() + opts.timeoutMs,
      () => this.deps.match.store.get(matchId).then(m => m ?? undefined),
      m => m.players.length === opts.count,
    )
    if (!joined) {
      const current = await this.deps.match.store.get(matchId)
      const seats = current?.players ?? []
      const missing = joiners.filter(h => !seats.some(p => p.sessionId === h.agent.id))
      if (missing.length > 0) {
        this.log(`phase join timed out; retrying ${missing.length} joiner(s) once`)
        for (const handle of missing) {
          await this.drive(
            handle,
            buildJoinPrompt({
              preset: opts.preset,
              count: opts.count,
              matchId,
              index: 2 + joiners.indexOf(handle),
              names: seats.map(p => p.username),
            }),
          )
        }
        const retried = await this.pollUntil(
          'join',
          Date.now() + opts.timeoutMs,
          () => this.deps.match.store.get(matchId).then(m => m ?? undefined),
          m => m.players.length === opts.count,
        )
        if (!retried) throw new Error('spawn-agent: players did not all join in time')
      } else {
        // players 已满但轮询没看到（不应该）；保守重查一次
        throw new Error('spawn-agent: join state inconsistent (players missing while seats claimed)')
      }
    }
  }

  private async phaseScript(handles: AgentHandleLike[], matchId: string, opts: SpawnAgentOptions): Promise<void> {
    const state = await this.deps.match.store.get(matchId)
    const nameBy = new Map((state?.players ?? []).map(p => [p.sessionId, p.username]))
    for (const handle of handles) {
      await this.drive(
        handle,
        buildScriptPrompt({ username: nameBy.get(handle.agent.id) ?? handle.agent.id, matchId, preset: opts.preset }),
      )
    }
    const ready = await this.pollUntil(
      'script',
      Date.now() + opts.timeoutMs,
      () => this.deps.match.store.get(matchId).then(m => m ?? undefined),
      m => m.players.length === opts.count && m.players.every(p => p.submitted === true),
    )
    if (!ready) {
      const current = await this.deps.match.store.get(matchId)
      const unsubmitted = (current?.players ?? []).filter(p => p.submitted !== true)
      if (unsubmitted.length > 0) {
        this.log(`phase script timed out; retrying ${unsubmitted.length} agent(s) once`)
        for (const player of unsubmitted) {
          const handle = handles.find(h => h.agent.id === player.sessionId)
          if (handle) await this.drive(handle, buildScriptPrompt({ username: player.username, matchId, preset: opts.preset }))
        }
        const retried = await this.pollUntil(
          'script',
          Date.now() + opts.timeoutMs,
          () => this.deps.match.store.get(matchId).then(m => m ?? undefined),
          m => m.players.length === opts.count && m.players.every(p => p.submitted === true),
        )
        if (!retried) throw new Error('spawn-agent: agents did not all submit scripts in time')
      } else if ((current?.players.length ?? 0) < opts.count) {
        throw new Error('spawn-agent: script stage reached with incomplete roster')
      }
    }
  }

  private async drive(handle: AgentHandleLike, prompt: string): Promise<void> {
    handle.agent.followup(makeUserMessage(prompt))
    this.log(`followup -> ${handle.agent.id}: ${prompt.split('\n')[0]!.slice(0, 60)}`)
  }
}

/** dispose 全部 handle（逐个容错，一个失败不阻断其余）。 */
export async function disposeAll(handles: AgentHandleLike[], log?: (msg: string) => void): Promise<void> {
  for (const handle of handles) {
    try {
      await handle.dispose()
      log?.(`disposed session ${handle.agent.id}`)
    } catch (err) {
      log?.(`dispose ${handle.agent.id} failed: ${(err as Error).message}`)
    }
  }
}

/** 起名查重（plan A0：start 前查重防 realCreateUser 'user already exists' 中途炸）。 */
export function assertUniqueUsernames(names: string[]): void {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) {
      throw new MatchError('full', `duplicate usernames in roster: ${name}`)
    }
    seen.add(name)
  }
}

/** 供 lifecycle/测试复用：spawn 局的 MatchState 形状判定。 */
export function isSpawnedByAgents(match: Pick<MatchState, 'spawnedBy'>): boolean {
  return match.spawnedBy === 'agents'
}