/**
 * S11 — HTTP 桥真实接线 e2e：ScreepsService.init 经 ctx.inject 挂到 webServer 的
 * /dsh-screeps/* 前缀路由。本测试向 ctx.provide 一个最小 fake webServer（只捕获
 * 路由注册），用真实 node:http server 承载捕获到的 handler，验证 body 读取、
 * no-store 头、JSON 响应与控制面全链（world/matches/create/start/settle；M3 起 HTTP join 移除）。
 * 运行：DSH_SCREEPS_IT=1 npm run test:it
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const provisioned = existsSync(join(serverDir, 'node_modules', 'screeps'))

interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

describe.skipIf(!provisioned)('arena http bridge (real wiring)', () => {
  it('serves the control plane over /dsh-screeps/* with no-store', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-it-http-'))
    mkdirSync(dataDir, { recursive: true })
    symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
    symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

    const ctx = new Context()
    const captured: CapturedRoute[] = []
    ctx.provide('webServer', {
      register: (route: CapturedRoute) => {
        captured.push(route)
        return () => {}
      },
    })

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

    const httpServer = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const route = captured.find(r => r.kind === 'prefix' && pathname.startsWith(r.path))
      if (!route) {
        res.writeHead(404).end()
        return
      }
      void route.handler(req, res)
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`

    try {
      await svc.ensureRunning()
      // init 的 inject 子插件已在 webServer provide 后完成注册
      expect(captured.some(r => r.kind === 'prefix' && r.path === '/dsh-screeps')).toBe(true)

      // GET /world：公开投影 + no-store
      const worldRes = await fetch(`${base}/dsh-screeps/world`)
      expect(worldRes.headers.get('cache-control')).toBe('no-store')
      const world = (await worldRes.json()) as { ok: boolean; world: { gameTime: number } }
      expect(world.ok).toBe(true)
      expect(world.world.gameTime).toBeGreaterThan(0)

      // 控制面：create → join（M3 A0 移除 HTTP join 端点，join 只走工具面/内部链路）→ start
      const created = (await (
        await fetch(`${base}/dsh-screeps/matches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: 'world-rounds', sessionId: 'http-a', username: 'http_a' }),
        })
      ).json()) as { ok: boolean; match: { id: string; phase: string } }
      expect(created.ok).toBe(true)
      expect(created.match.phase).toBe('creating')
      const matchId = created.match.id

      // HTTP join 端点已移除：验证路由 404（不再暴露任意 sessionId 占座通道）
      const joinGone = await fetch(`${base}/dsh-screeps/matches/${matchId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'http-b', username: 'http_b' }),
      })
      expect(joinGone.status).toBe(404)
      // 玩家 2 经内部链路 join（与 http.test.ts 单测同口径；工具面 join 是唯一公开入座通道）
      await svc.match.join(matchId, { sessionId: 'http-b', username: 'http_b' })

      const started = (await (
        await fetch(`${base}/dsh-screeps/matches/${matchId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // M2 C 步：start 需 creator sessionId（http-b 的 join 先于 start，players[0] 是 creator http-a）
          body: JSON.stringify({ sessionId: 'http-a' }),
        })
      ).json()) as { ok: boolean; match: { phase: string; startTick: number; assignments: Record<string, string> } }
      expect(started.ok).toBe(true)
      expect(started.match.phase).toBe('running')
      expect(Object.keys(started.match.assignments)).toHaveLength(2)

      // settle → settled + winner
      const settled = (await (
        await fetch(`${base}/dsh-screeps/matches/${matchId}/settle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'manual', sessionId: 'http-a' }),
        })
      ).json()) as { ok: boolean; match: { phase: string; winner: { kind: string } } }
      expect(settled.ok).toBe(true)
      expect(settled.match.phase).toBe('settled')
      expect(settled.match.winner).toBeDefined()

      // 未知路由 404（webserver fallback 语义之外，本桥自己答 404）
      const missing = await fetch(`${base}/dsh-screeps/nope`)
      expect(missing.status).toBe(404)
    } finally {
      httpServer.close()
      await fiber.dispose()
    }
  }, 300_000)
})
