import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/\/server$/, '')
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-consoleprobe-'))
mkdirSync(dataDir, { recursive: true })
symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

const ctx = new Context()
const fiber = await ctx.plugin(ScreepsService, ScreepsService.Config({
  serverMode: 'managed', dataDir, externalUrl: 'http://127.0.0.1:21025', port: 0,
  nodeVersion: '22', nodeDistMirror: 'https://nodejs.org/dist', tickDuration: 150, readyTimeoutMs: 180_000, agentRecruitTimeoutMs: 180_000,
}))
const svc = ctx.screeps
try {
  await svc.ensureRunning()
  await svc.system('resetArena')
  await svc.system('generateRoom', 'W45N74')
  const user = await svc.createUser({ username: 'probe_a', room: 'W45N74' })
  console.log('created user:', JSON.stringify(user))
  // 触发一个 console 表达式
  const fired = await svc.runConsole('probe_a', 'console.log("PROBE_OUT", Game.time); 1+1')
  console.log('fired:', fired)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 600))
    const out = await svc.consoleOutput('probe_a')
    console.log(`poll ${i}: lines=${out.lines.length} cursor=${out.cursor} bound=${out.bound} pubsubTicks=${(out as any).pubsubTicks} selfLoop=${(out as any).selfLoop}`)
    if (out.lines.length > 0) { console.log('LINES:', JSON.stringify(out.lines)); break }
  }
} finally {
  await fiber.dispose()
}
