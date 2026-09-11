/**
 * AgentRunner（M0/S1）—— Pi SDK 薄封装。`src/agent/` 是全仓库唯一 Pi 触面
 * （plan-M0 §5：Pi 0.85.x API 漂移风险 → 升级只动这一层）。
 *
 * 职责（plan-M0 §3 S1）：
 *   - 会话创建：每席位隔离 cwd/agentDir（席位工作区 + models.json/auth.json；
 *     席位 → Screeps 用户的映射只存在于 host 侧，本层只见 seatId）
 *   - 工具注册：仅注册调用方传入的 customTools，`tools` 白名单 = 名单全集，禁用全部
 *     Pi 内置工具（read/bash/edit/write…）——公平边界第一道门；行为由 spike S3（SDK 层）与
 *     `tests/agent-runner.test.ts`（封装层）双保险钉死
 *   - prompt() 唤醒：world-rounds 周期唤醒 = 后端时钟 → 本方法
 *     （spike 结论 3：followUp 对空闲会话是 no-op，不用于唤醒）
 *   - 事件归集：订阅 Pi 事件流，归一化为 RunnerEvent 后回调
 *   - disposal：dispose() 幂等；disposed 后 prompt/getter 拒绝
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { seatSlug } from '../shared/seat-slug.js'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

/** LLM provider 配置（写入席位 agentDir/models.json）。M0 = stub lane 的 mock；
 * M1 接真实 provider 时只换这里的 baseUrl/apiKey，不动封装层。 */
export interface AgentProviderConfig {
  /** provider id（models.json key，如 `mock`）。 */
  name: string
  /** 模型 id（如 `mock-1`）。 */
  model: string
  baseUrl: string
  apiKey: string
  /** spike 实测口径：openai-completions + SSE。 */
  api?: 'openai-completions'
  contextWindow?: number
  maxTokens?: number
}

/** 归一化运行事件（Pi 事件流的内部投影；session 层专有事件不投影）。 */
export type RunnerEventType =
  | 'agent_start'
  | 'agent_end'
  | 'turn_start'
  | 'turn_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_start'
  | 'tool_update'
  | 'tool_end'

export interface RunnerEvent {
  type: RunnerEventType
  toolName?: string
  toolCallId?: string
  args?: unknown
  result?: unknown
  isError?: boolean
}

export interface AgentRunnerOptions {
  /** 席位标识（= 对局玩家 id）。决定隔离目录名，非 [A-Za-z0-9_-] 字符折叠为 `_`。 */
  seatId: string
  /** 工具白名单全集（defineTool 产物）。会话工具面 = 恰好这份名单，零内置工具。 */
  tools: ToolDefinition[]
  provider: AgentProviderConfig
  /** 事件回调（同步调用；归集/断言/转发都在这里做）。 */
  onEvent?: (event: RunnerEvent) => void
  /** 隔离目录根。默认 `<os.tmpdir()>/screeps-arena-agents`。 */
  baseDir?: string
}

type PiSession = Awaited<ReturnType<typeof createAgentSession>>['session']

export class AgentRunner {
  readonly seatId: string
  /** 席位工作区（Pi cwd）。 */
  readonly cwd: string
  /** 席位配置目录（Pi agentDir，含 models.json）。 */
  readonly agentDir: string

  private session: PiSession | undefined
  private readonly onEvent: ((event: RunnerEvent) => void) | undefined
  private disposed = false
  private prompting = false

  private constructor(
    seatId: string,
    cwd: string,
    agentDir: string,
    onEvent: ((event: RunnerEvent) => void) | undefined,
  ) {
    this.seatId = seatId
    this.cwd = cwd
    this.agentDir = agentDir
    this.onEvent = onEvent
  }

  /** 创建一个席位会话（隔离目录 + models.json + Pi session）。 */
  static async create(opts: AgentRunnerOptions): Promise<AgentRunner> {
    // M2/S7：sanitize + sha1 后缀 —— 仅特殊字符不同的 seatId（如 a:b / a_b）不再共目录碰撞
    const seatDirName = seatSlug(opts.seatId)
    const baseDir = opts.baseDir ?? path.join(os.tmpdir(), 'screeps-arena-agents')
    const cwd = path.join(baseDir, seatDirName)
    const agentDir = path.join(cwd, 'agent')
    fs.mkdirSync(agentDir, { recursive: true })

    const runner = new AgentRunner(opts.seatId, cwd, agentDir, opts.onEvent)
    await runner.startSession(opts.tools, opts.provider)
    return runner
  }

  private async startSession(tools: ToolDefinition[], provider: AgentProviderConfig): Promise<void> {
    const loader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir })
    await loader.reload()

    // provider 必须经 agentDir/models.json + ModelRuntime 解析后显式传 model
    // （spike 结论 2：extension registerProvider 不进入 createAgentSession 的解析/auth 链）。
    const models = {
      providers: {
        [provider.name]: {
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          api: provider.api ?? 'openai-completions',
          models: [
            {
              id: provider.model,
              name: provider.model,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: provider.contextWindow ?? 128_000,
              maxTokens: provider.maxTokens ?? 4_096,
            },
          ],
        },
      },
    }
    fs.writeFileSync(path.join(this.agentDir, 'models.json'), JSON.stringify(models, null, 2))

    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(this.agentDir, 'auth.json'),
      modelsPath: path.join(this.agentDir, 'models.json'),
    })
    const model = modelRuntime.getModel(provider.name, provider.model)
    if (!model) {
      throw new Error(`seat ${this.seatId}: model ${provider.name}/${provider.model} not resolvable (models.json invalid?)`)
    }

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      model,
      modelRuntime,
      resourceLoader: loader,
      // 白名单 = customTools 名单全集：禁全部内置工具，且自定义工具必须显式列名
      // 才启用（tools:[] 会连 custom 一起关——实测踩坑，spike S3 口径）。公平边界
      // 第一道门，名单外泄漏由封装层单测抓。
      tools: tools.map((t) => t.name),
      customTools: tools,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.inMemory({}),
    })
    if (modelFallbackMessage) {
      throw new Error(`seat ${this.seatId}: unexpected model fallback: ${modelFallbackMessage}`)
    }

    session.subscribe((event) => this.forwardEvent(event))
    this.session = session
  }

  private forwardEvent(event: {
    type: string
    toolName?: string
    toolCallId?: string
    args?: unknown
    result?: unknown
    isError?: boolean
  }): void {
    const cb = this.onEvent
    if (!cb) return
    switch (event.type) {
      case 'tool_execution_start':
        cb({ type: 'tool_start', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args })
        break
      case 'tool_execution_update':
        cb({ type: 'tool_update', toolName: event.toolName, toolCallId: event.toolCallId, args: event.args })
        break
      case 'tool_execution_end':
        cb({
          type: 'tool_end',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        })
        break
      case 'agent_start':
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'message_update':
      case 'message_end':
        cb({ type: event.type })
        break
      default:
        break
    }
  }

  /** 会话当前工具名全集（= 传入白名单；公平边界断言口）。 */
  get toolNames(): string[] {
    if (this.disposed || !this.session) throw new Error(`seat ${this.seatId}: runner disposed or not started`)
    return this.session.agent.state.tools.map((t) => t.name)
  }

  /** 唤醒一轮（world-rounds：后端时钟每个周期边界对每个席位调用一次）。
   *  并发调用拒绝——一轮唤醒结束后才允许下一轮，串行化由对局状态机保证。 */
  async prompt(text: string): Promise<void> {
    if (this.disposed || !this.session) throw new Error(`seat ${this.seatId}: runner disposed`)
    if (this.prompting) throw new Error(`seat ${this.seatId}: prompt already in flight`)
    this.prompting = true
    try {
      await this.session.prompt(text)
    } finally {
      this.prompting = false
    }
  }

  /** 释放会话。幂等；重复调用无害。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.session?.dispose()
    this.session = undefined
  }
}
