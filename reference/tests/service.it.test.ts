/**
 * S6 ScreepsService managed 模式集成测试。
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=/tmp/dsh-screeps-server-smoke/server npm run test:it
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

describe.skipIf(!provisioned)('ScreepsService (managed, real server)', () => {
  it('provisions (cached), launches, exposes arena client and cleans up on dispose', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-service-'))
    const ctx = new Context()
    const config = ScreepsService.Config({
      serverMode: 'managed',
      dataDir,
      port: 0,
      nodeVersion: '22',
      // 直接复用已 provision 的 server 目录（fingerprint 命中 → 跳过 npm install）：
      // 通过软链把 server/runtime 放进临时 dataDir，验证 ensure 链但不重复下载
      tickDuration: 250,
    })
    // 预置复用：把已 provision 的 server 与 runtime 链接进 dataDir
    const { mkdirSync, symlinkSync } = await import('node:fs')
    mkdirSync(dataDir, { recursive: true })
    symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
    symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

    const fiber = await ctx.plugin(ScreepsService, config)
    const svc = ctx.screeps
    const { port } = await svc.ensureRunning()
    expect(port).toBeGreaterThan(0)
    expect(svc.getStatus().status).toBe('running')

    const world = await svc.getWorld()
    expect(world.ok).toBe(true)
    expect(typeof world.gameTime).toBe('number')

    const tick = await svc.system('getTickDuration')
    expect(tick.ok).toBe(true)

    await fiber.dispose()
  }, 300_000)
})
