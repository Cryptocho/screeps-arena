/**
 * S3 起停集成测试（需要已 provision 的私服目录）。
 * 运行：DSH_SCREEPS_IT=1 DSH_SCREEPS_SERVER_DIR=/tmp/dsh-screeps-server-smoke npm run test:it
 * 未 provision 时自动跳过。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'
import { launchScreepsServer } from '../src/runtime/server-launcher.ts'
import { readArenaSecret } from '../src/runtime/server-installer.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

describe.skipIf(!provisioned)('launchScreepsServer (real)', () => {
  it('boots, serves game time + arena world, applies tick duration, stops cleanly', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-launch-'))
    const runtime = await ensureNodeRuntime({ runtimeDir: join(dataDir, 'runtime'), versionSpec: '22' })
    const server = await launchScreepsServer({ serverDir, runtime, readyTimeoutMs: 180_000 })
    try {
      await server.waitReady()
      expect(server.isAlive()).toBe(true)

      const time = await fetch(`http://127.0.0.1:${server.port}/api/game/time`).then(r => r.json() as Promise<{ time: number }>)
      expect(time.time).toBeGreaterThan(0)

      const secret = await readArenaSecret(serverDir)
      const world = (await fetch(`http://127.0.0.1:${server.port}/api/arena/world`, {
        headers: secret ? { 'x-arena-secret': secret } : {},
      }).then(r => r.json())) as { ok: boolean; gameTime: number; users: unknown[] }
      expect(world.ok).toBe(true)
      expect(Array.isArray(world.users)).toBe(true)

      const tick = (await fetch(`http://127.0.0.1:${server.port}/api/arena/system`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret ? { 'x-arena-secret': secret } : {}) },
        body: JSON.stringify({ cmd: 'setTickDuration', value: 250 }),
      }).then(r => r.json())) as { ok: boolean; tickDuration: number }
      expect(tick.ok).toBe(true)
      expect(tick.tickDuration).toBe(250)

      const denied = await fetch(`http://127.0.0.1:${server.port}/api/arena/world`)
      expect(denied.status).toBe(403)
    } finally {
      await server.stop()
    }
    expect(server.isAlive()).toBe(false)
  }, 300_000)
})
