/**
 * 工具面最小集单测（M0/S2，plan-M0 §4）。
 *
 * 公平边界负向测试（红线）：
 *   - 席位 A 的工具操作只落在 A 的映射用户上，席位 B 的数据零触碰（跨席位落位隔离）；
 *   - 未映射席位的三工具全部拒绝；
 *   - schema 层无身份通道（无 username 类参数）——LLM 结构性无法指定他人。
 */
import { describe, expect, it } from 'vitest'
import { MemoryArena } from '../src/agent/memory-backend.js'
import { buildSeatTools } from '../src/agent/tools.js'

/** 独立依赖组：MemoryArena 同时充当 registry 与 backend（同内存实例，映射一致性可断言）。 */
function makeDeps() {
  const arena = new MemoryArena()
  return { registry: arena, backend: arena, arena }
}

function toolMap(seatId: string) {
  const deps = makeDeps()
  return { deps, tools: Object.fromEntries(buildSeatTools(deps, seatId).map((t) => [t.name, t])) }
}

/** Pi 工具回执形状（本仓库工具只用 content/details 两个字段）。 */
interface ToolResultLike {
  content: Array<{ type: string; text?: string }>
  details: unknown
}

/** 调 defineTool 的 execute（Pi 执行口；execute 实际 5 参——可变尾参保证签名兼容）。 */
async function run(
  tool: { execute: (id: string, params: any, ...rest: never[]) => Promise<ToolResultLike> },
  params: unknown = {},
): Promise<ToolResultLike> {
  return await tool.execute('call_test', params)
}

describe('M6/D5 公平边界：工具面恰三件（无 replay/战报类新增）', () => {
  it('buildSeatTools 名单恰为 {submit_code, report, console}', () => {
    const names = buildSeatTools(makeDeps(), 'seat-a')
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(['console', 'report', 'submit_code'])
  })
})

describe('工具面公平边界（红线）', () => {
  it('席位 A 的 submit 落位在 userA 名下，userB 零触碰（跨席位隔离）', async () => {
    const { deps, tools } = toolMap('seat-a')
    deps.arena.bindUser('seat-a', 'userA')
    deps.arena.bindUser('seat-b', 'userB') // 同一 arena 里的对手席位

    await run(tools.submit_code!, { modules: { main: 'module.exports.loop = function(){}' } })

    expect(deps.arena.getCode('userA')).toBeDefined()
    expect(deps.arena.getCode('userB')).toBeUndefined() // 对手数据零触碰
    expect(deps.arena.getConsoleLog('userB')).toHaveLength(0)
  })

  it('未映射席位：三工具全部拒绝（not bound）', async () => {
    const { tools } = toolMap('seat-x') // 不落任何映射
    await expect(run(tools.submit_code!, { modules: { main: 'module.exports.loop = function(){}' } })).rejects.toThrow(
      /not bound/,
    )
    await expect(run(tools.report!)).rejects.toThrow(/not bound/)
    await expect(run(tools.console!, { expression: 'Game.time' })).rejects.toThrow(/not bound/)
  })

  it('schema 层无身份通道：参数名不含 username/user/seat（LLM 结构性无法指定他人）', () => {
    const { tools } = toolMap('seat-a')
    for (const tool of Object.values(tools)) {
      const schema = JSON.stringify(tool.parameters)
      expect(schema).not.toMatch(/"username"/)
      expect(schema).not.toMatch(/"user"/)
      expect(schema).not.toMatch(/"seatId"/)
    }
  })

  it('console / report 只走自己映射用户的通道', async () => {
    const { deps, tools } = toolMap('seat-b')
    deps.arena.bindUser('seat-b', 'userB')
    deps.arena.bindUser('seat-a', 'userA')

    const out = await run(tools.console!, { expression: 'Game.time' })
    expect(out.content[0]?.text).toContain('[console:userB]')
    const rep = await run(tools.report!)
    expect(rep.content[0]?.text).toContain('user=userB')

    expect(deps.arena.getConsoleLog('userA')).toHaveLength(0)
  })
})

describe('submit_code 语义（对照旧 tools.ts 校验分支）', () => {
  it('结构校验：空 modules / 缺 main / 缺 module.exports.loop 逐项拒绝', async () => {
    const { deps, tools } = toolMap('seat-a')
    deps.arena.bindUser('seat-a', 'userA')

    await expect(run(tools.submit_code!, { modules: {} })).rejects.toThrow(/non-empty object/)
    await expect(run(tools.submit_code!, { modules: { lib: 'x' } })).rejects.toThrow(/modules\.main is required/)
    await expect(
      run(tools.submit_code!, { modules: { main: 'module.exports = function(){}' } }),
    ).rejects.toThrow(/module\.exports\.loop/)
    expect(deps.arena.getCode('userA')).toBeUndefined() // 拒绝的提交不落位
  })

  it('合法提交：落位 + 回执含用户名与 seq（seq 单调）', async () => {
    const { deps, tools } = toolMap('seat-a')
    deps.arena.bindUser('seat-a', 'userA')

    const r1 = await run(tools.submit_code!, { modules: { main: 'module.exports.loop = function(){}' } })
    const r2 = await run(tools.submit_code!, { modules: { main: 'module.exports.loop = function(){ // v2' } })
    const text = String(r2.content[0]?.text ?? '')
    expect(text).toContain('userA')
    const seqOf = (r: ToolResultLike) => (r.details as { seq: number }).seq
    expect(seqOf(r2)).toBeGreaterThan(seqOf(r1))
    expect(deps.arena.getCode('userA')?.seq).toBe((r2.details as { seq: number }).seq)
  })

  it('backend 拒绝（ok:false）时异常上抛、文案透传', async () => {
    const arena = new MemoryArena()
    // 模拟 S3 接线后的 phase 拒绝：backend 侧返回 ok:false
    const deps = {
      registry: arena,
      backend: {
        submitCode: async () => ({ ok: false as const, reason: 'code is frozen during a round' }),
        runConsole: arena.runConsole.bind(arena),
        report: arena.report.bind(arena),
      },
      arena,
    }
    arena.bindUser('seat-a', 'userA')
    const [submitCode] = buildSeatTools(deps, 'seat-a')
    await expect(run(submitCode!, { modules: { main: 'module.exports.loop = function(){}' } })).rejects.toThrow(
      /code is frozen during a round/,
    )
  })
})

describe('MemoryArena（M0 假实现）', () => {
  it('report 默认投影：codeSeq / consoleCalls 随操作推进', async () => {
    const arena = new MemoryArena()
    arena.bindUser('seat-a', 'userA')
    const deps = { registry: arena, backend: arena, arena }
    const [submitCode, report, consoleTool] = buildSeatTools(deps, 'seat-a')

    expect((await run(report!)).content[0]?.text).toContain('codeSeq=0')
    await run(submitCode!, { modules: { main: 'module.exports.loop = function(){}' } })
    await run(consoleTool!, { expression: 'Memory.stats' })
    const line = (await run(report!)).content[0]?.text ?? ''
    expect(line).toMatch(/codeSeq=\d+/)
    expect(line).toContain('consoleCalls=1')
  })
})
