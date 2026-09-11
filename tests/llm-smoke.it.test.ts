/**
 * S6 真实 LLM 冒烟 IT（test:smoke lane，plan-M1 §3）——OpenRouter + xiaomi/mimo-v2.5。
 * 复用 S4 IT 链路：2 席位经 AgentRunner + buildSeatTools + MatchMachine 1 轮闭环，
 * 换真实 provider。断言：工具调用被真实执行、代码真落 MemoryArena（M1 冒烟不接私服——
 * 私服链路已由 test:live 钉住，本 IT 钉的是「真实 LLM 的 SSE/工具调用行为差异」）。
 * 失败退路（二审建议 2）：限流/格式差异 → 记差异进 LOG，不阻塞 S7。
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

const MODEL = process.env.SMOKE_MODEL ?? 'xiaomi/mimo-v2.5'
const KEY = process.env.OPENROUTER_API_KEY

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screeps-arena-smoke-'))
const runners: AgentRunner[] = []
const events: MatchEvent[] = []

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
            }
          },
        })
        runners.push(runner)
        expect([...runner.toolNames].sort()).toEqual(['console', 'report', 'submit_code'])
      }

      // 唤醒 1：提交初始代码（真实 LLM 自主决策调用 submit_code）
      const prompt1 =
        'You are playing a Screeps arena match (seat seat-a / seat-b). ' +
        'Commit your initial bot code NOW using the submit_code tool: modules={"main": "module.exports.loop = function () { /* your strategy */ }"}. ' +
        'main must contain module.exports.loop. Do it in this turn.'
      for (const r of runners) await r.prompt(prompt1)

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
