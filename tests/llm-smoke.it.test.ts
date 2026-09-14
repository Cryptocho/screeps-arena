/**
 * S6 真实 LLM 冒烟 IT（test:smoke lane，plan-M1 §3）——OpenRouter + qwen/qwen3.7-flash（2026-09-14 起用户拍板默认）。
 *
 * 定位（M1 复审问题 6 施工决定）：本 IT 是「真实 provider 行为探针」，钉的是真实 LLM 的
 * SSE / 工具调用行为差异；`test:live` 钉的是「代码真落私服」链路。plan §4 的
 * 「代码真落私服」由 test:live 承担，本 lane 不重复（跑私服 6 分钟成本不进冒烟）。
 *
 * 回归性（M1 复审问题 2）：断言「submit_code 工具调用确实发生」——按 tool_end 事件计数，
 * 并有界重试（真实 LLM 偶发只回文本不调工具；mimo 为 reasoning 模型时更常见）。
 * 重试耗尽仍无调用 = 确定性失败（显式报错），不再是「跑满 230s 后静默失败」。
 *
 * 跑法：OPENROUTER_API_KEY=… npm run test:smoke
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentRunner } from '../src/agent/runner.js'
import type { AgentProviderConfig } from '../src/agent/runner.js'
import { MemoryArena } from '../src/agent/memory-backend.js'
import { buildSeatTools } from '../src/agent/tools.js'
import { MatchMachine } from '../src/server/match/machine.js'
import type { MatchEvent } from '../src/server/match/machine.js'

const MODEL = process.env.SMOKE_MODEL ?? 'qwen/qwen3.7-flash'
const KEY = process.env.OPENROUTER_API_KEY

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screeps-arena-smoke-'))
const runners: AgentRunner[] = []
const events: MatchEvent[] = []
/** 每席位真实发生的 submit_code 工具调用次数（回归性断言锚点）。 */
const submitCalls = new Map<string, number>()

afterAll(() => {
  for (const r of runners) r.dispose()
  fs.rmSync(tmpRootSafe(), { recursive: true, force: true })
})
function tmpRootSafe(): string {
  return tmpRoot
}

describe.skipIf(!KEY)('S6 真实 LLM 冒烟（OpenRouter）', () => {
  it(
    '2 席位 1 轮：真实 LLM 提交代码 → 状态机闭环',
    async () => {
      const arena = new MemoryArena()
      arena.bindUser('seat-a', 'userA')
      arena.bindUser('seat-b', 'userB')
      // 状态机收口层（对照 S4 IT 的 machineBackend）：submitCode 走 machine（phase 语义生效）
      const backendFor = (seatId: string) => ({
        async submitCode(username: string, modules: Record<string, string>) {
          machine.submitCode(seatId, modules)
          return await arena.submitCode(username, modules)
        },
        runConsole: (u: string, e: string) => arena.runConsole(u, e),
        report: (u: string) => arena.report(u),
      })
      const machine = new MatchMachine({
        id: 'smoke-match',
        config: { roundMs: 30_000, roundBreakTimeoutMs: 120_000, maxRounds: 2 },
        players: [
          { seatId: 'seat-a', username: 'userA' },
          { seatId: 'seat-b', username: 'userB' },
        ],
        onEvent: (e) => events.push(e),
      })

      const provider: AgentProviderConfig = {
        name: 'openrouter',
        model: MODEL,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: KEY!,
        contextWindow: 128_000,
        maxTokens: 4_096,
      }

      for (const seatId of ['seat-a', 'seat-b']) {
        const runner = await AgentRunner.create({
          seatId,
          tools: buildSeatTools({ registry: arena, backend: backendFor(seatId) }, seatId),
          provider,
          baseDir: tmpRoot,
          onEvent: (e) => {
            if (e.type === 'tool_end') {
              console.log(`[${seatId}] tool_end`, e.toolName, e.isError ? 'ERR' : 'OK', JSON.stringify(e.result ?? '').slice(0, 200))
              if (e.toolName === 'submit_code' && !e.isError) {
                submitCalls.set(seatId, (submitCalls.get(seatId) ?? 0) + 1)
              }
            }
          },
        })
        runners.push(runner)
        expect([...runner.toolNames].sort()).toEqual(['console', 'report', 'submit_code'])
      }

      // 唤醒：提交初始代码（真实 LLM 自主决策调用 submit_code）。
      // 有界重试：reasoning 模型偶发只回文本不调工具 → 追问（最多 3 次），
      // 让「工具调用确实发生」成为确定性断言（复审问题 2）。
      const maxAttempts = 3
      const seatUsers = ['userA', 'userB']
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const prompt =
          'You are playing a Screeps arena match. ' +
          'Commit your initial bot code NOW by CALLING the submit_code tool (do not just reply with text). ' +
          'Pass modules as an object: {"main": "module.exports.loop = function () { /* your strategy */ }"}. ' +
          'main must contain module.exports.loop. Call the tool in this turn.'
        // 只追问尚未落位的席位（已落位的不再唤醒，省 token 与时间）
        const pending = runners.filter((_r, i) => !arena.getCode(seatUsers[i]!))
        if (pending.length === 0) break
        for (const r of pending) await r.prompt(prompt)
      }

      // 回归性断言：两个席位都真实发起过成功的 submit_code 工具调用
      expect(submitCalls.get('seat-a') ?? 0, 'seat-a 真实 submit_code 工具调用次数').toBeGreaterThan(0)
      expect(submitCalls.get('seat-b') ?? 0, 'seat-b 真实 submit_code 工具调用次数').toBeGreaterThan(0)

      expect(machine.phase).toBe('creating')
      const codeA = arena.getCode('userA')
      const codeB = arena.getCode('userB')
      expect(codeA, 'seat-a code landed').toBeDefined()
      expect(codeB, 'seat-b code landed').toBeDefined()
      expect(codeA!.modules.main).toContain('module.exports.loop')
      expect(codeB!.modules.main).toContain('module.exports.loop')

      // start → running
      machine.start()
      expect(machine.phase).toBe('running')

      // settle（冒烟只验证提交链路；完整对局由 S4 IT + live IT 钉住）
      machine.settle('manual')
      expect(events.at(-1)).toMatchObject({ type: 'settled' })
    },
    600_000,
  )
})
