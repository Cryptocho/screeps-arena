/**
 * S4 stub 对局 IT（plan-M0 §3/§4）：2 个 mock LLM 席位完整 1 轮闭环。
 *
 * 链路：MatchMachine（双席位）→ 每席位 AgentRunner（mock provider）+ buildSeatTools
 * → submit_code 经状态机收口落位 → start → advance 到 roundBreak → round_break 事件
 * 触发两席位 prompt() 唤醒 → mock LLM 第 2 次回 submit_code → 全员 ready → resume。
 *
 * 断言（plan-M0 §4 判据）：状态机迁移序列、MemoryArena 落位内容、事件顺序、
 * 工具白名单（公平边界）。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentRunner } from '../src/agent/runner.js'
import type { AgentProviderConfig } from '../src/agent/runner.js'
import { MemoryArena } from '../src/agent/memory-backend.js'
import { buildSeatTools } from '../src/agent/tools.js'
import type { ArenaBackend } from '../src/agent/tools.js'
import { MatchMachine } from '../src/server/match/machine.js'
import type { MatchEvent } from '../src/server/match/machine.js'
import { startMockOpenAI } from './helpers/mock-openai.js'
import type { MockOpenAI, MockReply } from './helpers/mock-openai.js'

const SUBMIT_A_R1 = { modules: { main: 'module.exports.loop = function () { /* A r1 */ }' } }
const SUBMIT_A_R2 = { modules: { main: 'module.exports.loop = function () { /* A r2 */ }' } }
const SUBMIT_B_R1 = { modules: { main: 'module.exports.loop = function () { /* B r1 */ }' } }
const SUBMIT_B_R2 = { modules: { main: 'module.exports.loop = function () { /* B r2 */ }' } }

/** 每席位脚本：唤醒1=submit(r1)+收尾文本；唤醒2=submit(r2)+收尾文本。 */
function seatReplies(r1: { modules: Record<string, string> }, r2: { modules: Record<string, string> }): MockReply[] {
  return [
    { kind: 'tool_calls', calls: [{ name: 'submit_code', args: r1 }] },
    { kind: 'text', text: 'initial code committed' },
    { kind: 'tool_calls', calls: [{ name: 'submit_code', args: r2 }] },
    { kind: 'text', text: 'next round code committed' },
  ]
}

/** 状态机收口层：submitCode 走 machine（phase 语义在此生效），其余透传 MemoryArena。 */
function machineBackend(machine: MatchMachine, seatId: string, arena: MemoryArena): ArenaBackend {
  return {
    async submitCode(username, modules) {
      machine.submitCode(seatId, modules)
      const r = await arena.submitCode(username, modules)
      return r
    },
    runConsole: (user, expr) => arena.runConsole(user, expr),
    report: (user) => arena.report(user),
  }
}

describe('S4 stub 对局 IT：2 mock 席位 1 轮闭环', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screeps-arena-it-'))
  const cleanup: Array<() => Promise<void>> = []
  const mocks: MockOpenAI[] = []
  const runners: AgentRunner[] = []

  afterAll(async () => {
    for (const r of runners) r.dispose()
    for (const m of mocks) await m.close()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('创建→提交→start→roundBreak→再提交→resume→settle 全链路', async () => {
    const arena = new MemoryArena()
    arena.bindUser('seat-a', 'userA')
    arena.bindUser('seat-b', 'userB')

    const events: MatchEvent[] = []
    const machine = new MatchMachine({
      id: 'it-match',
      config: { roundMs: 50, roundBreakTimeoutMs: 5_000, maxRounds: 8 },
      players: [
        { seatId: 'seat-a', username: 'userA' },
        { seatId: 'seat-b', username: 'userB' },
      ],
      onEvent: (e) => events.push(e),
    })

    // 每席位独立 mock server，脚本互不干扰
    const seats = [
      { seatId: 'seat-a', r1: SUBMIT_A_R1, r2: SUBMIT_A_R2 },
      { seatId: 'seat-b', r1: SUBMIT_B_R1, r2: SUBMIT_B_R2 },
    ] as const
    for (const s of seats) {
      const mock = await startMockOpenAI(seatReplies(s.r1, s.r2))
      mocks.push(mock)
      const provider: AgentProviderConfig = {
        name: 'mock',
        model: 'mock-1',
        baseUrl: mock.url,
        apiKey: 'test-key',
      }
      const runner = await AgentRunner.create({
        seatId: s.seatId,
        tools: buildSeatTools(
          { registry: arena, backend: machineBackend(machine, s.seatId, arena) },
          s.seatId,
        ),
        provider,
        baseDir: tmpRoot,
      })
      runners.push(runner)

      // 公平边界：会话工具面 = 恰好三工具，零内置工具
      expect([...runner.toolNames].sort()).toEqual(['console', 'report', 'submit_code'])
    }

    // ---- 唤醒 1（creating 期暂存代码）----
    for (const runner of runners) {
      await runner.prompt('Round 0 is coming. Commit your initial code with submit_code.')
    }
    expect(machine.phase).toBe('creating')
    expect(arena.getCode('userA')?.modules).toEqual(SUBMIT_A_R1.modules)
    expect(arena.getCode('userB')?.modules).toEqual(SUBMIT_B_R1.modules)

    // ---- start：全员已暂存 → running ----
    machine.start()
    expect(machine.phase).toBe('running')
    expect(machine.state.roundIndex).toBe(0)

    // running 期提交被状态机拒（公平/冻结边界在真实链路上的负向断言）
    expect(() => machine.submitCode('seat-a', SUBMIT_A_R2.modules)).toThrow(/frozen during a round/)

    // ---- advance：roundMs 到点 → roundBreak ----
    machine.advance(Date.now() + 60)
    expect(machine.phase).toBe('roundBreak')
    expect(events.map((e) => e.type)).toEqual(['started', 'round_break'])

    // ---- 唤醒 2（round_break 事件 → prompt）----
    for (const runner of runners) {
      await runner.prompt('Round break. Submit your next-round code with submit_code.')
    }
    expect(machine.players.every((p) => p.ready)).toBe(true)
    expect(arena.getCode('userA')?.modules).toEqual(SUBMIT_A_R2.modules)
    expect(arena.getCode('userB')?.modules).toEqual(SUBMIT_B_R2.modules)

    // ---- advance：全员 ready → resume（roundIndex+1，ready 清位）----
    machine.advance()
    expect(machine.phase).toBe('running')
    expect(machine.state.roundIndex).toBe(1)
    expect(machine.players.every((p) => !p.ready)).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['started', 'round_break', 'round_resume'])

    // ---- settle：M0 记分全 0 → draw ----
    machine.settle('manual')
    expect(machine.phase).toBe('settled')
    expect(machine.state.winner).toEqual({ kind: 'draw' })
    expect(machine.state.scores).toEqual({ 'seat-a': 0, 'seat-b': 0 })
    expect(events.at(-1)).toMatchObject({ type: 'settled', reason: 'manual' })

    // ---- LLM 侧口径：每席位 4 次调用（2 工具 turn × 2 请求），submit 参数按序落位 ----
    for (const mock of mocks) {
      expect(mock.llmCalls).toBe(4)
      expect(mock.toolRequests).toHaveLength(2)
      expect(mock.toolRequests[0]?.name).toBe('submit_code')
      expect(mock.toolRequests[1]?.name).toBe('submit_code')
    }
    const mockA = mocks[0]!
    const mockB = mocks[1]!
    expect(mockA.toolRequests[0]?.args).toEqual(SUBMIT_A_R1)
    expect(mockA.toolRequests[1]?.args).toEqual(SUBMIT_A_R2)
    expect(mockB.toolRequests[0]?.args).toEqual(SUBMIT_B_R1)
    expect(mockB.toolRequests[1]?.args).toEqual(SUBMIT_B_R2)
  })
})
