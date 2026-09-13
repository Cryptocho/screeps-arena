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

export interface HttpServerOptions {
  services: ArenaHttpServices
  port?: number
  /** 监听地址（默认 127.0.0.1——无鉴权不对外；compose 需端口映射时显式传 0.0.0.0）。 */
  host?: string
  /** 前端产物目录（@fastify/static 根；缺省不挂静态）。 */
  staticDir?: string
  /** console 订阅轮询间隔（ms，默认 1000）。 */
  consolePollMs?: number
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

  type WsSocket = {
    readyState: number
    send: (data: string) => void
    close: (code?: number, reason?: string) => void
    on: (ev: string, cb: (arg?: unknown) => void) => void
  }
  const wsClients = new Set<WsSocket>()

  // console 订阅（M2/S2）：per-user 单一定时器 → 多订阅者分发（RealArena 内部游标 per-user
  // 单值，双连接各自拉取会互吞增量）。WS 推送走内部游标；HTTP 降级口必须显式传 since。
  const consoleSubs = new Map<string, Set<WsSocket>>()
  const consoleTimers = new Map<string, ReturnType<typeof setInterval>>()
  const consolePollMs = opts.consolePollMs ?? 1000

  const unsubscribeConsole = (user: string, sock: WsSocket): void => {
    const set = consoleSubs.get(user)
    if (!set) return
    set.delete(sock)
    if (set.size === 0) {
      consoleSubs.delete(user)
      const timer = consoleTimers.get(user)
      if (timer) {
        clearInterval(timer)
        consoleTimers.delete(user)
      }
    }
  }

  const pollConsole = async (user: string): Promise<void> => {
    const set = consoleSubs.get(user)
    if (!set || set.size === 0) return
    let payload: string
    try {
      const page = await opts.services.consoleSince(user)
      payload = JSON.stringify({ type: 'console_lines', user, lines: page.lines, cursor: page.cursor, bound: page.bound })
      if (!page.bound) {
        // 未 bind 用户：推一次即静默（plan-M2 S2）
        for (const s of set) if (s.readyState === 1) s.send(payload)
        for (const s of [...set]) unsubscribeConsole(user, s)
        return
      }
    } catch {
      return // 瞬时错误静默，下轮重试
    }
    for (const s of set) if (s.readyState === 1) s.send(payload)
  }

  const subscribeConsole = (user: string, sock: WsSocket): void => {
    let set = consoleSubs.get(user)
    if (!set) {
      set = new Set()
      consoleSubs.set(user, set)
      const timer = setInterval(() => void pollConsole(user), consolePollMs)
      timer.unref?.()
      consoleTimers.set(user, timer)
    }
    set.add(sock)
  }
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
    let consoleUser: string | undefined
    socket.on('message', (raw) => {
      let msg: { type?: string; user?: string }
      try {
        msg = JSON.parse(String(raw)) as { type?: string; user?: string }
      } catch {
        return
      }
      if (msg?.type === 'subscribe_console' && typeof msg.user === 'string' && msg.user !== '') {
        if (consoleUser) unsubscribeConsole(consoleUser, socket)
        consoleUser = msg.user
        subscribeConsole(consoleUser, socket)
      } else if (msg?.type === 'unsubscribe_console') {
        if (consoleUser) unsubscribeConsole(consoleUser, socket)
        consoleUser = undefined
      }
    })
    socket.on('close', () => {
      if (consoleUser) unsubscribeConsole(consoleUser, socket)
      wsClients.delete(socket)
    })
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
  app.get('/api/history', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/teardown-failures', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/tournaments', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })
  app.post('/api/tournaments', async (req, reply) => {
    const r = await routeHandler({ method: 'POST', url: req.url, body: req.body })
    return reply.code(r.status).send(r.json)
  })
  app.get('/api/tournaments/:id', async (req, reply) => {
    const r = await routeHandler({ method: 'GET', url: req.url })
    return reply.code(r.status).send(r.json)
  })

  if (opts.staticDir) {
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: '/' })
  }

  const host = opts.host ?? '127.0.0.1'
  await app.listen({ port: opts.port ?? 0, host })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  opts.log?.(`http server listening on ${host}:${port}`)

  return {
    port,
    broadcast: (event) => broadcast(event),
    close: async () => {
      for (const c of wsClients) c.close()
      await app.close()
    },
  }
}
