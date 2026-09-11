/**
 * e2e-stub-plugin（纯 JS ESM, M3 A0 集成验收装置，临时，验收后清理）.
 *
 * 用途（plan-M3 A0 集成验收 + 五审 S1 装置来源 (b)：全局 dsh CLI + stub 插件）：
 * - 注册 provider 路由 `stub` 的 LlmAdapter（零 token 确定性）——spawn 出的 Agent 会话由它驱动；
 * - 注册触发工具 `screeps_spawn_demo`：宿主 headless Agent 调它 → ctx.screeps.spawnAgentMatch
 *   ({preset, count, provider:'stub'}) → spawn N Agent 会话全链（A1 create → A2..N join → submit →
 *   全就绪）→ 返回结果。
 *
 * stub turn-script 契约（plan A0 钉死）：adapter 按 session 维护多轮答复序列——
 *   玩家 1：create → submit_code → 完成；玩家 2：join → submit_code → 完成。
 * 角色分配：首调 LLM 的 session = 玩家 1，次调 = 玩家 2（orchestrator 依序 followup A1→A2 保证）。
 * 参数提取：matchId/preset 从 system prompt 正则（orchestrator prompt 自带）。
 *
 * 临时装置说明：headless profile 的 node_modules 无 dsh-llm/dsh-tools（bundle 从全局 dsh 解析），
 * 本插件从全局 dsh 安装目录直接 import ESM —— 顶层 await 由 .mjs 提供。仅验收用，验收后清理。
 */
const LLM_URL = 'file:///usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const TOOLS_URL = 'file:///usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const llmMod = await import(LLM_URL)
const toolsMod = await import(TOOLS_URL)
const { LlmAdapter } = llmMod
const { defineTool } = toolsMod

const MINIMAL_LOOP = 'module.exports.loop = function () { Memory.stub = Game.time }'

/** 每 session 的答复序列：stream 每次调用取下一步（确定性，happy path）。 */
class StubAdapter extends LlmAdapter {
  constructor() {
    super()
    this.steps = new Map() // sessionId → 已消耗步骤数
    this.roles = new Map() // sessionId → 'one' | 'two'
  }

  providerInfo(provider) {
    return { id: provider, name: 'stub (e2e)', models: ['stub-model'] }
  }
  providerRetryPolicy() {
    return undefined
  }
  async listModels() {
    return [{ id: 'stub-model', name: 'stub-model' }]
  }
  async resolveModel(provider, model) {
    const id = model ?? 'stub-model' // 缺省兜底：config.agentModel 未配时也不炸 {{model}}
    return { provider, id, name: id }
  }

  roleFor(sid) {
    if (!this.roles.has(sid)) {
      // 未定向：orchestrator 先 followup 玩家 1 → 首调即玩家 1
      this.roles.set(sid, this.roles.size === 0 ? 'one' : 'two')
    }
    return this.roles.get(sid)
  }

  async *stream(options) {
    const sid = String(options.sessionId ?? 'anon')
    const role = this.roleFor(sid)
    // matchId/preset 在 followup 的 user message 里（system 是通用 system prompt，不含局内文案）
    const allText = [
      options.system ?? '',
      ...(Array.isArray(options.messages) ? options.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))) : []),
    ].join('\n')
    const matchId = /matchId=([A-Za-z0-9]+)/.exec(allText)?.[1]
    const preset = /preset="?([A-Za-z0-9-]+)"?/.exec(allText)?.[1] ?? 'arena-blitz'
    const username = role === 'one' ? 'stub_pa1' : 'stub_pa2'
    // 按消息内容判定阶段（不依赖 LLM 调用次数——DSH 一个 turn 内可能多次调 stream）：
    //  - 含「编写你的 Screeps 脚本」→ script 阶段 → submit_code
    //  - 否则（含「起名并入座」）→ create/join 阶段；已入座过（消息含工具结果）→ 纯文本结束
    const isScript = /编写你的 Screeps 脚本|screeps_submit_code/.test(allText)
    const alreadySeated = /match .* created|joined .* as /.test(allText)
    console.log(`[stub-e2e] stream sid=${sid} role=${role} script=${isScript} seated=${alreadySeated} msgs=${Array.isArray(options.messages) ? options.messages.length : '?'}`)

    let name = undefined
    let args = undefined
    if (isScript) {
      name = 'screeps_submit_code'
      args = { modules: { main: MINIMAL_LOOP } }
    } else if (!alreadySeated) {
      name = 'screeps_match'
      args = role === 'one' ? { action: 'create', username, preset } : { action: 'join', matchId, username }
    }

    if (name) {
      const id = `stub_call_${sid}_${name}`
      const argsStr = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argsStr }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argsStr } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = `${role} 准备就绪（stub 确定性答复）`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  }
}

export const name = 'dsh-screeps-stub-e2e'
export const inject = ['llm', 'tools', 'screeps']

export function apply(ctx) {
  const llm = ctx.llm
  llm.registerAdapter(['stub'], new StubAdapter())
  const tools = ctx.tools
  tools.register(
    defineTool({
      name: 'screeps_spawn_demo',
      description:
        '集成验收：spawn 2 个 stub-provider Agent 玩家（arena-blitz）并完成全链准备。返回 matchId/sessionIds/就绪状态。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => [{ type: 'text', text: String(v.text ?? '') }],
      },
      async execute() {
        // headless 单任务模式：宿主 Agent 工具内同步等子 Agent LLM 轮次会导致主 turn 阻塞超时，
        // 但编排是 fire-and-forget 异步推进（stub 秒答），本工具触发后短等（不阻塞宿主太久）
        // 再快照 store 最终状态——覆盖「host 观察 A1 create → 打标 spawnedBy → A2 join → submit →
        // 全就绪」全链，且不依赖宿主 turn 等子 Agent。
        const before = await ctx.screeps.match.store.active()
        if (before) {
          return { text: 'E2E-SPAWN-BLOCKED active match exists', ok: false, reason: 'active', matchId: before.id }
        }
        const started = Date.now()
        const promise = ctx.screeps.spawnAgentMatch({ preset: 'arena-blitz', count: 2, provider: 'stub' })
        void promise.catch(err => console.log('E2E-SPAWN-LATER ' + String(err && err.message ? err.message : err)))
        // 轮询 store：全链完成（A1 create → 打标 → A2..N join → submit → 全 submitted）
        let matchId = null
        let ready = false
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000))
          const m = await ctx.screeps.match.store.active()
          if (m && m.spawnedBy === 'agents' && m.players.length === 2 && m.players.every(p => p.submitted === true)) {
            matchId = m.id
            ready = true
            break
          }
          if (m && m.id) matchId = m.id // 已建局但未就绪
        }
        const m2 = await ctx.screeps.match.store.active()
        const summary = {
          ok: ready,
          elapsedMs: Date.now() - started,
          matchId: matchId ?? m2?.id ?? null,
          phase: m2 ? m2.phase : null,
          spawnedBy: m2 ? m2.spawnedBy : null,
          players: m2
            ? m2.players.map(p => ({ sessionId: p.sessionId, username: p.username, submitted: p.submitted === true }))
            : [],
          allReady: ready,
        }
        console.log('E2E-SPAWN-OK ' + JSON.stringify(summary))
        return { text: 'E2E-SPAWN-OK ' + JSON.stringify(summary), ...summary }
      },
    }),
  )
}