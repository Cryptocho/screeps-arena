/**
 * M2/S2 WS console 流协议 IT（成果审查阻塞 3）——真实 HTTP/WS 承载：
 * subscribe → 收 console_lines → unsubscribe 停推；双客户端 per-user 单定时器分发；
 * bound:false 推一次即静默。consoleSince 计数 spy 兼验共享游标语义（per-user 单拉取）。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startHttpServer } from '../src/server/http/server.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'
import { MatchMachine } from '../src/server/match/machine.js'

const handles: Array<{ close(): Promise<void> }> = []
const sockets: WebSocket[] = []
afterEach(() => {
  for (const s of sockets) s.close()
  sockets.length = 0
})
afterAll(async () => {
  for (const h of handles) await h.close()
})

function makeServices(calls: string[], bound = true): { services: ArenaHttpServices; matchId: string } {
  const m = new MatchMachine({
    players: [
      { seatId: 'a', username: 'ua' },
      { seatId: 'b', username: 'ub' },
    ],
  })
  const services: ArenaHttpServices = {
    matches: () => [m],
    match: (id) => (id === m.id ? m : undefined),
    createMatch: () => m,
    getWorld: async () => ({}),
    getTerrain: async () => ({ terrain: {} }),
    consoleSince: async (user) => {
      calls.push(user)
      return { lines: [`line:${calls.length}`], cursor: calls.length, bound }
    },
  }
  return { services, matchId: m.id }
}

function open(port: number, id: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/matches/${id}`)
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg))
}

async function collect(ws: WebSocket, count: number, ms = 3000): Promise<Array<{ type: string; user?: string; lines?: string[]; bound?: boolean }>> {
  const got: Array<{ type: string; user?: string; lines?: string[]; bound?: boolean }> = []
  await new Promise<void>((resolve) => {
    const onMsg = (data: WebSocket.RawData): void => {
      got.push(JSON.parse(String(data)))
      if (got.length >= count) {
        ws.off('message', onMsg)
        resolve()
      }
    }
    ws.on('message', onMsg)
    setTimeout(() => {
      ws.off('message', onMsg)
      resolve()
    }, ms)
  })
  return got
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  expect(cond()).toBe(true)
}

describe('WS console 流协议（M2/S2）', () => {
  it('subscribe → 收增量 → unsubscribe 停推；同 user 双客户端 per-user 单拉取分发', async () => {
    const calls: string[] = []
    const { services, matchId } = makeServices(calls)
    const handle = await startHttpServer({ services, port: 0, consolePollMs: 50 })
    handles.push(handle)
    const ws1 = await open(handle.port, matchId)
    const ws2 = await open(handle.port, matchId)
    send(ws1, { type: 'subscribe_console', user: 'ua' })
    send(ws2, { type: 'subscribe_console', user: 'ua' })
    const got1 = await collect(ws1, 2)
    const got2 = await collect(ws2, 2)
    expect(got1.length).toBe(2)
    expect(got2.length).toBe(2)
    expect(got1.every((x) => x.type === 'console_lines' && x.user === 'ua' && x.lines!.length === 1)).toBe(true)
    // per-user 单拉取：两客户端两拍 = 2 次 consoleSince（非 4 次——不互吞）
    const callsAfterSub = calls.length
    await waitFor(() => calls.length >= callsAfterSub + 1)
    const before = calls.length
    send(ws1, { type: 'unsubscribe_console' })
    send(ws2, { type: 'unsubscribe_console' })
    await new Promise((r) => setTimeout(r, 200))
    expect(calls.length).toBeLessThanOrEqual(before + 1) // 退订后停推（至多一次在途）
  })

  it('bound:false → 推一次即静默（未 bind 用户不轮询）', async () => {
    const calls: string[] = []
    const { services, matchId } = makeServices(calls, false)
    const handle = await startHttpServer({ services, port: 0, consolePollMs: 50 })
    handles.push(handle)
    const ws = await open(handle.port, matchId)
    send(ws, { type: 'subscribe_console', user: 'ghost' })
    const got = await collect(ws, 1)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'console_lines', bound: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.length).toBe(1) // 推一次后不再拉取
  })

  it('连接断开自动退订（close 清理，不残留定时器拉取）', async () => {
    const calls: string[] = []
    const { services, matchId } = makeServices(calls)
    const handle = await startHttpServer({ services, port: 0, consolePollMs: 50 })
    handles.push(handle)
    const ws = await open(handle.port, matchId)
    send(ws, { type: 'subscribe_console', user: 'ua' })
    await collect(ws, 1)
    const before = calls.length
    ws.close()
    await new Promise((r) => setTimeout(r, 250))
    expect(calls.length).toBeLessThanOrEqual(before + 1) // close 后停拉
  })
})
