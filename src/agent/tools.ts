/**
 * Agent 工具面最小集（M0/S2，plan-M0 §3）——`submit_code` / `report` / `console` 三工具。
 * 逻辑对照 `reference/src/host/tools.ts` 去 DSH 化裁剪；两类依赖均以接口注入：
 *   ① `SeatRegistry`：席位 → Screeps 用户映射（映射只存在于 host 侧，AGENTS.md 红线）；
 *   ② `ArenaBackend`：数据/执行面（提交落位 / console 执行 / 世界投影），
 *      M0 = `src/agent/memory-backend.ts` 内存假实现，M1 换真实 arena API。
 *
 * 公平边界（收口在工具内）：
 *   - 工具 schema 一律没有 username/身份类参数（结构性：LLM 无法指定他人）；
 *   - 执行身份 = `registry.resolveUser(seatId)`，未映射席位全部拒绝；
 *   - 工具闭包只持有本席位 seatId，不存在触达他人映射的代码路径。
 * 负向测试：`tests/agent-tools.test.ts`（跨席位落位隔离 / 未映射拒绝 / schema 无身份通道）。
 */
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

/** 席位 → Screeps 用户映射（只存在于 host 侧）。 */
export interface SeatRegistry {
  /** 未映射席位返回 undefined（工具内拒绝，绝不猜）。 */
  resolveUser(seatId: string): string | undefined
}

/** 数据/执行面最小子集（对应旧 ScreepsService 的 M0 裁剪；phase 语义由实现内部收口，
 * running 期拒提交等边界在 S3 状态机接线时钉死）。 */
export interface ArenaBackend {
  /** 提交落位。ok=false 时 reason 为给 LLM 的拒绝文案。 */
  submitCode(
    username: string,
    modules: Record<string, string>,
  ): Promise<{ ok: true; seq: number } | { ok: false; reason: string }>
  /** 以用户身份执行 console 并取回输出。 */
  runConsole(username: string, expression: string): Promise<string>
  /** 战报投影（公开 ∪ 己方完整视图；有游戏内视野的对手动向——不透视，AGENTS.md 观察分层）。 */
  report(username: string): Promise<string>
}

export interface SeatToolDeps {
  registry: SeatRegistry
  backend: ArenaBackend
}

/** 解析席位映射；未映射 = 公平边界拒绝（对照旧 tools.ts requireUser 的 M0 裁剪）。 */
function requireUser(deps: SeatToolDeps, seatId: string): string {
  const user = deps.registry.resolveUser(seatId)
  if (!user) {
    throw new Error(`seat ${seatId}: not bound to a Screeps user — operation rejected (fair boundary)`)
  }
  return user
}

/** 提交结构校验（文案对照旧 tools.ts：modules 非空 + main 存在 + 含 module.exports.loop）。 */
function validateModules(modules: Record<string, string>): string | undefined {
  if (!modules || typeof modules !== 'object' || Object.keys(modules).length === 0) {
    return 'modules must be a non-empty object keyed by filename'
  }
  const main = modules.main
  if (typeof main !== 'string' || main.length === 0) {
    return 'modules.main is required'
  }
  if (!main.includes('module.exports.loop')) {
    return "modules.main must contain 'module.exports.loop = function () { ... }' (the old module.exports = function () {} form is not executed by engine 4.3.x)"
  }
  return undefined
}

/** 按席位闭包构建三工具（每席位一个独立集合，注入进 AgentRunner）。 */
export function buildSeatTools(deps: SeatToolDeps, seatId: string): ToolDefinition[] {
  const submitCode = defineTool({
    name: 'submit_code',
    label: 'Submit Code',
    description:
      'Upload/replace your Screeps bot code. modules maps module name (main required) to source; main must export module.exports.loop. Commit = ready for the current round in world-rounds semantics.',
    parameters: Type.Object({
      modules: Type.Record(Type.String(), Type.String(), {
        description: 'Module sources keyed by filename; main module required',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const invalid = validateModules(params.modules)
      if (invalid) throw new Error(`submit_code rejected: ${invalid}`)
      const user = requireUser(deps, seatId)
      const result = await deps.backend.submitCode(user, params.modules)
      if (!result.ok) throw new Error(`submit_code rejected: ${result.reason}`)
      return {
        content: [{ type: 'text', text: `code accepted for ${user} (seq ${result.seq}); takes effect at the next round start` }],
        details: { user, seq: result.seq },
      }
    },
  })

  const report = defineTool({
    name: 'report',
    label: 'World Report',
    description:
      'Get your world report: public projection + your own full view (score delta, own console/errors, opponent movements visible in game). Deltas only — full history stays host-side.',
    parameters: Type.Object({}),
    execute: async () => {
      const user = requireUser(deps, seatId)
      const text = await deps.backend.report(user)
      return { content: [{ type: 'text', text }], details: {} }
    },
  })

  const consoleTool = defineTool({
    name: 'console',
    label: 'Console',
    description: 'Run a JavaScript expression as your own user and get the output back. Use for telemetry and emergency fixes.',
    parameters: Type.Object({
      expression: Type.String({ description: 'JavaScript expression, max 1KB (official limit)' }),
    }),
    execute: async (_toolCallId, params) => {
      if (params.expression.length > 1024) {
        throw new Error('console rejected: expression exceeds 1KB (official limit)')
      }
      const user = requireUser(deps, seatId)
      const out = await deps.backend.runConsole(user, params.expression)
      return { content: [{ type: 'text', text: out }], details: {} }
    },
  })

  return [submitCode, report, consoleTool]
}
