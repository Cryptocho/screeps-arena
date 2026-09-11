/**
 * S13 — 工具面真实私服 e2e：会话映射 → report → submit_code（热更）→
 * console 捕获（arena-mod pubsub ring buffer 全链）→ read_memory。
 * 运行：DSH_SCREEPS_IT=1 npm run test:it
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'
import { buildTools } from '../src/host/tools.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

function makeExec(sessionId: string): never {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

describe.skipIf(!provisioned)('screeps tools (real server)', () => {
  it('report / submit_code / console capture / read_memory work end to end', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-tools-'))
    mkdirSync(dataDir, { recursive: true })
    symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
    symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

    const ctx = new Context()
    const fiber = await ctx.plugin(
      ScreepsService,
      ScreepsService.Config({
        serverMode: 'managed',
        dataDir,
        externalUrl: 'http://127.0.0.1:21025',
        port: 0,
        nodeVersion: '22',
        nodeDistMirror: 'https://nodejs.org/dist',
        tickDuration: 150,
        readyTimeoutMs: 180_000,
      }),
    )
    const svc = ctx.screeps
    try {
      await svc.ensureRunning()
      // M5：热更语义专用 IT 迁 arena-blitz（live 热更唯一承载；world-rounds running 拒 submit）
      const created = await svc.match.createMatch({ preset: 'arena-blitz', sessionId: 'sess-a', username: 'tool_a' })
      await svc.match.join(created.id, { sessionId: 'sess-b', username: 'tool_b' })
      await svc.match.start(created.id)

      // [M2 诊断] start 后立刻 probe env（resume 竞态：unpause 先于 refresh，第一 tick 可能读到坏 env）
      const envNow = (await svc.system('envProbe')) as Record<string, unknown>
      console.log('[tools-dump] env right after start:', JSON.stringify({ type: typeof envNow.accessibleRooms, value: String(envNow.accessibleRooms).slice(0, 100), gt: envNow.gameTime }))

      const tools = buildTools(svc) as Array<{ name: string; execute: (args: unknown, exec: never) => Promise<Record<string, unknown>> }>
      const tool = (name: string) => {
        const found = tools.find(t => t.name === name)
        if (!found) throw new Error(`tool not found: ${name}`)
        return found
      }

      // report：绑定 + 世界投影
      const report = (await tool('screeps_report').execute({}, makeExec('sess-a'))) as { text: string }
      expect(report.text).toContain('boundUser=tool_a')
      expect(report.text).toContain('gameTime=')

      // submit_code：热更一个会打 console 的 bot
      await tool('screeps_submit_code').execute(
        { modules: { main: 'module.exports.loop = function () { console.log("TOOL_E2E", Game.time) }' } },
        makeExec('sess-a'),
      )

      // console：表达式执行 + bot 日志都会经 pubsub ring buffer 取回
      const consoleResult = (await tool('screeps_console').execute(
        { expression: '1+1' },
        makeExec('sess-a'),
      )) as { text: string; lineCount: number }
      // [M2 诊断] 失败上下文：dump console 文本 / 用户 memory / world / env keys
      console.log('[tools-dump] console text:', JSON.stringify(consoleResult.text).slice(0, 500))
      const envProbe = (await svc.system('envProbe')) as Record<string, unknown>
      console.log('[tools-dump] env:', JSON.stringify({ type: typeof envProbe.accessibleRooms, value: String(envProbe.accessibleRooms).slice(0, 120), paused: envProbe.mainLoopPaused, gt: envProbe.gameTime }))
      for (const u of ['tool_a', 'tool_b']) {
        const mem = (await svc.readMemoryPath(u)) as { data?: unknown }
        console.log(`[tools-dump] ${u} memory:`, JSON.stringify(mem).slice(0, 120))
      }
      const worldDump = await svc.getWorld()
      console.log('[tools-dump] users:', JSON.stringify(worldDump.users.map(x => `${x.username}(id=${x.id},cpuUsed=${x.lastUsedCpu})`)))
      expect(consoleResult.lineCount).toBeGreaterThan(0)
      expect(consoleResult.text).toMatch(/TOOL_E2E|2/)

      // write_memory → 等一个 tick 生效 → read_memory 读回
      await tool('screeps_write_memory').execute({ value: { probe: 42 }, path: 'e2e' }, makeExec('sess-a'))
      await new Promise(r => setTimeout(r, 1_200))
      const memory = (await tool('screeps_read_memory').execute({ path: 'e2e' }, makeExec('sess-a'))) as { text: string }
      expect(memory.text).toContain('42')
    } finally {
      await fiber.dispose()
    }
  }, 300_000)
})
