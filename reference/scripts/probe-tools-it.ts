/**
 * 诊断 tools.it 回归：复现 create→join→start→submit→runConsole，dump env accessibleRooms / memory。
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=/tmp/dsh-screeps-server-smoke/server npx tsx scripts/probe-tools-it.ts
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))
if (!provisioned) {
  console.error('not provisioned')
  process.exit(2)
}

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-probe-'))
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
    agentRecruitTimeoutMs: 180_000,
  }),
)
const svc = ctx.screeps
try {
  await svc.ensureRunning()
  const created = await svc.match.createMatch({ preset: 'world-rounds', sessionId: 'sess-a', username: 'tool_a' })
  await svc.match.join(created.id, { sessionId: 'sess-b', username: 'tool_b' })
  await svc.match.start(created.id)

  // dump env accessibleRooms & roomStatusData（源码视角）
  const sys = async (cmd: string, value?: unknown) => {
    try {
      const r = await svc.system(cmd, value)
      return JSON.stringify(r)
    } catch (e) {
      return 'ERR ' + String(e)
    }
  }
  console.log('envProbe sys:', await sys('envProbe'))
  console.log('world:', JSON.stringify((await svc.getWorld()).users.map(u => `${u.username}:${u.ownedRooms}`)))

  // submit TOOL_E2E
  await svc.submitCode('tool_a', { main: 'module.exports.loop = function () { console.log("TOOL_E2E", Game.time) }' })
  console.log('submitted TOOL_E2E for tool_a')

  // 模拟 tools.it 的 console 工具轮询（最多 6s，等跨进程 pubsub 扇出）
  let lines: unknown[] = []
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 500))
    const out = await svc.consoleOutput('tool_a', 0)
    if (out.lines.length > 0) {
      lines = out.lines
      console.log(`[poll ${i}] got ${out.lines.length} lines:`, JSON.stringify(out.lines).slice(0, 600))
      break
    }
  }
  if (lines.length === 0) console.log('[poll] NO CONSOLE LINES in 6s')
  const out = await svc.consoleOutput('tool_a', 0)
  console.log('consoleOutput tool_a FULL:', JSON.stringify(out))
  console.log('pubsubTicks:', out.pubsubTicks)

  // 复现 tools.it 的 console execute('1+1')：执行后轮询 buffer
  const fired = await svc.runConsole('tool_a', '1+1')
  console.log('runConsole fired:', fired)
  await new Promise(r => setTimeout(r, 1500))
  const out2 = await svc.consoleOutput('tool_a', 0)
  console.log('consoleOutput after 1+1 FULL:', JSON.stringify(out2))
  // 若逐行渲染：error 帧会显现
  const rendered = (out2.lines ?? []).map(l => {
    const m = l as { messages?: unknown; error?: string }
    if (m.error) return 'error: ' + m.error.split('\n')[0]
    if (Array.isArray(m.messages)) return (m.messages as unknown[]).join(',')
    if (m.messages && typeof m.messages === 'object') {
      const mm = m.messages as { log?: string[]; results?: string[] }
      return [...(mm.log ?? []), ...(mm.results ?? [])].join(',')
    }
    return JSON.stringify(l)
  })
  console.log('rendered lines:', JSON.stringify(rendered))

  // read memory（是否 "undefined"）
  const mem = (await svc.readMemoryPath('tool_a')) as { data?: unknown }
  console.log('tool_a memory raw:', JSON.stringify(mem).slice(0, 300))

  await svc.match.settle(created.id, 'manual')
} finally {
  await fiber.dispose()
}