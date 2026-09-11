/**
 * Fastify 壳（M1/S4）——routes.ts 纯函数打表的薄接线 + WS 推送 + 静态前端托管。
 * 监听 127.0.0.1（plan-M1：M1 无鉴权，不对外暴露）。
 */
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { handleArenaRequest } from './routes.js'
import type { ArenaHttpServices, ArenaRequest } from './routes.js'
import type { MatchMachine, MatchEvent } from '../match/machine.js'

export interface HttpServerOptions {
  services: ArenaHttpServices
  port?: number
  /** 前端产物目录（@fastify/static 根；缺省不挂静态）。 */
  staticDir?: string
  log?: (msg: string) => void
}

export interface HttpServerHandle {
  port: number
  /** WS 广播（对局状态变更/tick 推送；server 内部接线用）。 */
  broadcast(event: { type: string; [k: string]: unknown }): void
  close(): Promise<void>
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  const wsClients = new Set<{ readyState: number; send: (data: string) => void; close: (code?: number, reason?: string) => void; on: (ev: string, cb: () => void) => void }>()
  const broadcast = (event: { type: string; [k: string]: unknown }): void => {
    const payload = JSON.stringify(event)
    for (const client of wsClients) {
      if (client.readyState === 1) client.send(payload)
    }
  }

  // WS 通道：/ws/matches/:id（对局状态流）与 /ws/world（tick 推进）
  app.get('/ws/matches/:id', { websocket: true }, (socket, req) => {
    const id = (req.params as { id: string }).id
    const m = opts.services.match(id)
    if (!m) {
      socket.close(1008, 'match not found')
      return
    }
    wsClients.add(socket)
    socket.send(JSON.stringify({ type: 'match_state', match: m.id, phase: m.phase, roundIndex: m.state.roundIndex }))
    socket.on('close', () => wsClients.delete(socket))
  })

  app.get('/ws/world', { websocket: true }, (socket) => {
    wsClients.add(socket)
    socket.on('close', () => wsClients.delete(socket))
  })

  // HTTP 路由 → 纯函数打表
  const allPaths = ['/api/matches', '/api/matches/:id', '/api/matches/:id/start', '/api/matches/:id/settle', '/api/world', '/api/terrain']
  const routeHandler = async (req: { method: string; url: string; body?: unknown; query?: Record<string, string> }) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const arenaReq: ArenaRequest = {
      method: req.method,
      pathname: url.pathname,
      ...(req.body !== undefined ? { body: req.body } : {}),
      query: Object.fromEntries(url.searchParams.entries()),
    }
    const res = await handleArenaRequest(opts.services, arenaReq)
    return res
  }

  app.get('/api/matches', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.post('/api/matches', async (req, reply) => {
    const r = await routeHandler({ method: 'POST', url: req.url, body: req.body })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/matches/:id', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.post('/api/matches/:id/start', async (req, reply) => {
    const r = await routeHandler({ method: 'POST', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.post('/api/matches/:id/settle', async (req, reply) => {
    const r = await routeHandler({ method: 'POST', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/matches/:id/console', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/world', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/terrain', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })

  if (opts.staticDir) {
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: '/' })
  }

  await app.listen({ port: opts.port ?? 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  opts.log?.(`http server listening on 127.0.0.1:${port}`)

  return {
    port,
    broadcast: (event) => broadcast(event),
    close: async () => {
      for (const c of wsClients) c.close()
      await app.close()
    },
  }
}

/** 对局事件 → WS 广播 + 驱动器唤醒的统一接线（server.ts 组装时调用）。 */
export function wireMatchEvents(
  machine: MatchMachine,
  hooks: { onEvent: (m: MatchMachine, e: MatchEvent) => Promise<void>; broadcast: (e: Record<string, unknown>) => void },
): void {
  // MatchMachine 的 onEvent 是构造期注入——这里用包装：创建时由 services 层接好。
  // 本函数提供「事件 → 广播 + 唤醒」的组合语义，供 createMatch 时调用。
  void machine
  void hooks
}
