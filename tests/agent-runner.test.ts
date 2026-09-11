/**
 * AgentRunner 封装层单测（M0/S1，plan-M0 §4）。
 *
 * 与 spike 的分工：spike 锁 Pi SDK 0.85.x 行为，这里锁封装层行为——
 *   - 会话生命周期：创建 / 隔离 / disposal
 *   - 工具面公平边界：会话可用工具 = 白名单全集，无任何 Pi 内置工具（双保险之一）
 *   - prompt 唤醒：工具调用闭环 / 事件归集 / 多轮唤醒 / 并发拒绝
 * 全程离线：mock OpenAI SSE server（tests/helpers/mock-openai.ts，spike 装置复用）。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { AgentRunner, type RunnerEvent } from '../src/agent/runner.js'
import { startMockOpenAI, type MockOpenAI, type MockReply } from './helpers/mock-openai.js'

const PROVIDER = { name: 'mock', model: 'mock-1', apiKey: 'test-key' } as const

/** submit_code 形状的测试工具：记录收到的 modules（工具执行断言口）。 */
function makeSubmitTool(sink: { modules: Array<Record<string, string>> }) {
  return defineTool({
    name: 'submit_code',
    label: 'Submit Code',
    description: 'Upload your Screeps bot code (modules keyed by filename)',
    parameters: Type.Object({ modules: Type.Record(Type.String(), Type.String()) }),
    execute: async (_toolCallId, params) => {
      sink.modules.push(params.modules)
      return { content: [{ type: 'text', text: 'code accepted' }], details: {} }
    },
  })
}

/** 第二个不同名的工具：白名单整表相等断言用（ >1 才能证明「全集」而非「仅一个」）。 */
function makeReportTool() {
  return defineTool({
    name: 'report',
    label: 'Report',
    description: 'Request the current world report delta',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'no delta' }], details: {} }),
  })
}

interface Harness {
  mock: MockOpenAI
  baseDir: string
  events: RunnerEvent[]
  submitted: { modules: Array<Record<string, string>> }
}

async function makeHarness(replies?: MockReply[]): Promise<Harness> {
  const mock = await startMockOpenAI(replies)
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-test-'))
  const events: RunnerEvent[] = []
  const submitted: Harness['submitted'] = { modules: [] }
  return { mock, baseDir, events, submitted }
}

function runnerOpts(h: Harness, seatId: string) {
  return {
    seatId,
    tools: [makeSubmitTool(h.submitted), makeReportTool()],
    provider: { ...PROVIDER, baseUrl: h.mock.url },
    onEvent: (e: RunnerEvent) => h.events.push(e),
    baseDir: h.baseDir,
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe('AgentRunner（Pi SDK 封装层）', () => {
  it('工具面 = 白名单全集：零内置工具泄漏（公平边界，封装层断言）', async () => {
    const h = await makeHarness()
    cleanup.push(() => h.mock.close())
    const runner = await AgentRunner.create(runnerOpts(h, 'seat-wl'))
    cleanup.push(async () => {
      runner.dispose()
      await fs.promises.rm(h.baseDir, { recursive: true, force: true })
    })

    // 整表相等（非子集断言，零盲区——二审采纳的名单制排除）
    expect(runner.toolNames).toEqual(['submit_code', 'report'])
    for (const builtin of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']) {
      expect(runner.toolNames).not.toContain(builtin)
    }
  })

  it('prompt 驱动工具调用闭环并归集事件（1 工具 turn = 2 次 LLM 请求）', async () => {
    const h = await makeHarness()
    cleanup.push(() => h.mock.close())
    const runner = await AgentRunner.create(runnerOpts(h, 'seat-loop'))
    cleanup.push(async () => {
      runner.dispose()
      await fs.promises.rm(h.baseDir, { recursive: true, force: true })
    })

    await runner.prompt('Write your Screeps script and submit it with submit_code.')

    // 工具真实执行：LLM 参数 → execute 收到
    expect(h.submitted.modules).toHaveLength(1)
    expect(h.submitted.modules[0]?.main).toContain('module.exports.loop')
    // mock 侧记录一致
    expect(h.mock.toolRequests).toHaveLength(1)
    expect(h.mock.toolRequests[0]?.name).toBe('submit_code')
    // spike 结论 4：工具 turn + 收尾 = 2 次 LLM 请求
    expect(h.mock.llmCalls).toBe(2)
    // 事件归集：工具生命周期 + 一轮 agent_end
    expect(h.events.some((e) => e.type === 'tool_start' && e.toolName === 'submit_code')).toBe(true)
    const toolEnd = h.events.find((e) => e.type === 'tool_end')
    expect(toolEnd?.isError).toBe(false)
    expect(h.events.filter((e) => e.type === 'agent_end')).toHaveLength(1)
  })

  it('多轮唤醒：空闲后重复 prompt() 驱动新的一轮（周期唤醒语义）', async () => {
    const h = await makeHarness()
    cleanup.push(() => h.mock.close())
    const runner = await AgentRunner.create(runnerOpts(h, 'seat-multi'))
    cleanup.push(async () => {
      runner.dispose()
      await fs.promises.rm(h.baseDir, { recursive: true, force: true })
    })

    await runner.prompt('round 1: submit your code.')
    await runner.prompt('round 2: review the report and stand by.')

    // round1 = 2 次（工具 turn + 收尾），round2 = 1 次（纯文本）→ 共 3
    expect(h.mock.llmCalls).toBe(3)
    expect(h.events.filter((e) => e.type === 'agent_end').length).toBeGreaterThanOrEqual(2)
  })

  it('并发 prompt 拒绝（一轮唤醒结束后才允许下一轮）', async () => {
    // 第 1 响应延迟 300ms，制造可观测的 in-flight 窗口
    const h = await makeHarness([
      {
        kind: 'tool_calls',
        delayMs: 300,
        calls: [{ name: 'submit_code', args: { modules: { main: 'module.exports.loop = function () {}' } } }],
      },
    ])
    cleanup.push(() => h.mock.close())
    const runner = await AgentRunner.create(runnerOpts(h, 'seat-concurrent'))
    cleanup.push(async () => {
      runner.dispose()
      await fs.promises.rm(h.baseDir, { recursive: true, force: true })
    })

    const first = runner.prompt('round 1')
    await expect(runner.prompt('overlapping wake')).rejects.toThrow(/prompt already in flight/)
    await first
    expect(h.mock.llmCalls).toBe(2)
  })

  it('disposal：dispose 后 prompt/getter 拒绝，dispose 幂等', async () => {
    const h = await makeHarness()
    cleanup.push(() => h.mock.close())
    const runner = await AgentRunner.create(runnerOpts(h, 'seat-dispose'))
    cleanup.push(async () => {
      await fs.promises.rm(h.baseDir, { recursive: true, force: true })
    })

    runner.dispose()
    expect(() => runner.dispose()).not.toThrow() // 幂等
    await expect(runner.prompt('wake')).rejects.toThrow(/disposed/)
    expect(() => runner.toolNames).toThrow(/disposed/)
  })

  it('席位隔离：同 baseDir 下不同席位目录互不可见', async () => {
    const h = await makeHarness()
    cleanup.push(() => h.mock.close())
    const a = await AgentRunner.create(runnerOpts(h, 'seat-a'))
    const b = await AgentRunner.create(runnerOpts(h, 'seat-b'))
    cleanup.push(async () => {
      a.dispose()
      b.dispose()
      await fs.promises.rm(h.baseDir, { recursive: true, force: true })
    })

    expect(a.cwd).not.toBe(b.cwd)
    expect(fs.existsSync(path.join(a.cwd, 'agent', 'models.json'))).toBe(true)
    expect(fs.existsSync(path.join(b.cwd, 'agent', 'models.json'))).toBe(true)
    expect(a.agentDir).toBe(path.join(a.cwd, 'agent'))
  })
})
