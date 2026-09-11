/**
 * S4 路由纯函数打表单测（plan-M1 §4）——不碰 fastify，直接打 handleArenaRequest。
 */
import { describe, expect, it } from 'vitest'
import { handleArenaRequest, matchView } from '../src/server/http/routes.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'
import { MatchMachine } from '../src/server/match/machine.js'

function fakeServices(): ArenaHttpServices & { machines: Map<string, MatchMachine> } {
  const machines = new Map<string, MatchMachine>()
  return {
    machines,
    matches: () => [...machines.values()],
    match: (id) => machines.get(id),
    createMatch: (input) => {
      const m = new MatchMachine({ players: input.players, ...(input.config ? { config: input.config } : {}) })
      machines.set(m.id, m)
      return m
    },
    getWorld: async () => ({ ok: true, gameTime: 100, users: [] }),
    getTerrain: async (rooms) => ({ terrain: Object.fromEntries(rooms.map((r) => [r, '0'.repeat(2500)])) }),
  }
}

describe('HTTP 路由打表（S4）', () => {
  it('POST /api/matches：创建 201；非法 players 400；公平边界——无身份通道', async () => {
    const svc = fakeServices()
    const bad = await handleArenaRequest(svc, { method: 'POST', pathname: '/api/matches', body: {} })
    expect(bad.status).toBe(400)
    const badSeat = await handleArenaRequest(svc, {
      method: 'POST', pathname: '/api/matches',
      body: { players: [{ seatId: 'a/b', username: 'x' }] },
    })
    expect(badSeat.status).toBe(400)
    const ok = await handleArenaRequest(svc, {
      method: 'POST', pathname: '/api/matches',
      body: { players: [{ seatId: 'seat-a', username: 'userA' }, { seatId: 'seat-b', username: 'userB' }] },
    })
    expect(ok.status).toBe(201)
    const view = ok.json as { id: string; phase: string }
    expect(view.phase).toBe('creating')
  })

  it('GET /api/matches/:id：404 未知；公开投影不暴露 code 内容', async () => {
    const svc = fakeServices()
    const m = svc.createMatch({ players: [{ seatId: 'seat-a', username: 'userA' }, { seatId: 'seat-b', username: 'userB' }] })
    m.submitCode('seat-a', { main: 'SECRET-CODE' })
    const res = await handleArenaRequest(svc, { method: 'GET', pathname: `/api/matches/${m.id}` })
    expect(res.status).toBe(200)
    const json = JSON.stringify(res.json)
    expect(json).not.toContain('SECRET-CODE')
    expect(json).toContain('"hasCode":true')
    const missing = await handleArenaRequest(svc, { method: 'GET', pathname: '/api/matches/nope' })
    expect(missing.status).toBe(404)
  })

  it('start/settle：业务错误 409（全员未提交不能 start；settled 后再 settle 409）', async () => {
    const svc = fakeServices()
    const m = svc.createMatch({ players: [{ seatId: 'a', username: 'ua' }, { seatId: 'b', username: 'ub' }] })
    const start = await handleArenaRequest(svc, { method: 'POST', pathname: `/api/matches/${m.id}/start` })
    expect(start.status).toBe(409)
    m.submitCode('a', { main: 'module.exports.loop=function(){}' })
    m.submitCode('b', { main: 'module.exports.loop=function(){}' })
    const start2 = await handleArenaRequest(svc, { method: 'POST', pathname: `/api/matches/${m.id}/start` })
    expect(start2.status).toBe(200)
    const settle = await handleArenaRequest(svc, { method: 'POST', pathname: `/api/matches/${m.id}/settle` })
    expect(settle.status).toBe(200)
    const again = await handleArenaRequest(svc, { method: 'POST', pathname: `/api/matches/${m.id}/settle` })
    expect(again.status).toBe(409)
  })

  it('GET /api/world + /api/terrain：透传；terrain 边界 400', async () => {
    const svc = fakeServices()
    const world = await handleArenaRequest(svc, { method: 'GET', pathname: '/api/world' })
    expect((world.json as { ok: boolean }).ok).toBe(true)
    const terrain = await handleArenaRequest(svc, { method: 'GET', pathname: '/api/terrain', query: { rooms: 'E5N5,E6N5' } })
    expect((terrain.json as { terrain: Record<string, string> }).terrain.E5N5).toHaveLength(2500)
    const tooMany = await handleArenaRequest(svc, { method: 'GET', pathname: '/api/terrain', query: { rooms: new Array(65).fill('E1N1').join(',') } })
    expect(tooMany.status).toBe(400)
  })

  it('未知路由 404；方法不匹配 405', async () => {
    const svc = fakeServices()
    const nf = await handleArenaRequest(svc, { method: 'GET', pathname: '/api/nope' })
    expect(nf.status).toBe(404)
    const mna = await handleArenaRequest(svc, { method: 'DELETE', pathname: '/api/matches' })
    expect(mna.status).toBe(405)
  })
})
