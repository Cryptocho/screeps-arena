/**
 * S4 Fastify 集成 IT——真实 listen（127.0.0.1 随机端口）+ fetch 断言 + WS 连接。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startHttpServer } from '../src/server/http/server.js'
import type { HttpServerHandle } from '../src/server/http/server.js'
import { MatchMachine } from '../src/server/match/machine.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'

let handle: HttpServerHandle
const machines = new Map<string, MatchMachine>()
const services: ArenaHttpServices = {
  matches: () => [...machines.values()],
  match: (id) => machines.get(id),
  createMatch: (input) => {
    const m = new MatchMachine({ players: input.players, ...(input.config ? { config: input.config } : {}) })
    machines.set(m.id, m)
    return m
  },
  getWorld: async () => ({ ok: true, gameTime: 42, users: [] }),
  getTerrain: async (rooms) => ({ terrain: Object.fromEntries(rooms.map((r) => [r, '1'.repeat(2500)])) }),
}

beforeAll(async () => {
  handle = await startHttpServer({ services })
})

afterAll(async () => {
  await handle.close()
})

describe('Fastify 壳（S4 集成）', () => {
  it('HTTP 全链：创建→start→查询→404/405', async () => {
    const base = `http://127.0.0.1:${handle.port}`
    const created = await fetch(`${base}/api/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }] }),
    })
    expect(created.status).toBe(201)
    const match = (await created.json()) as { id: string; phase: string }
    expect(match.phase).toBe('creating')

    const list = await fetch(`${base}/api/matches`)
    expect(((await list.json()) as { matches: unknown[] }).matches).toHaveLength(1)

    const get = await fetch(`${base}/api/matches/${match.id}`)
    expect(get.status).toBe(200)

    const nf = await fetch(`${base}/api/matches/none`)
    expect(nf.status).toBe(404)

    const world = await fetch(`${base}/api/world`)
    expect(((await world.json()) as { gameTime: number }).gameTime).toBe(42)

    const terrain = await fetch(`${base}/api/terrain?rooms=E5N5`)
    expect(((await terrain.json()) as { terrain: Record<string, string> }).terrain.E5N5).toHaveLength(2500)
  })

  it('WS：/ws/matches/:id 连接即推 match_state；未知 id 拒绝', async () => {
    const m = machines.values().next().value as MatchMachine
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/matches/${m.id}`)
    const first = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data: unknown) => resolve(String(data)))
      ws.on('error', reject)
      setTimeout(() => reject(new Error('ws timeout')), 3000)
    })
    expect(JSON.parse(first)).toMatchObject({ type: 'match_state', match: m.id })
    ws.close()

    const bad = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/matches/none`)
    const closed = await new Promise<number>((resolve) => {
      bad.on('close', (code: number) => resolve(code))
      setTimeout(() => resolve(-1), 3000)
    })
    expect(closed).toBe(1008)
  })

  it('broadcast：WS 客户端收到对局状态变更推送', async () => {
    const m = machines.values().next().value as MatchMachine
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/matches/${m.id}`)
    await new Promise<string>((resolve) => ws.on('message', (d: unknown) => resolve(String(d))))
    handle.broadcast({ type: 'match_state', match: m.id, phase: 'running', roundIndex: 0 })
    const pushed = await new Promise<string>((resolve, reject) => {
      ws.on('message', (d: unknown) => resolve(String(d)))
      setTimeout(() => reject(new Error('no push')), 3000)
    })
    expect(JSON.parse(pushed)).toMatchObject({ type: 'match_state', phase: 'running' })
    ws.close()
  })
})
