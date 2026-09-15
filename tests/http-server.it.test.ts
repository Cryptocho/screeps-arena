/**
 * S4 Fastify 集成 IT——真实 listen（127.0.0.1 随机端口）+ fetch 断言 + WS 连接。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startHttpServer } from '../src/server/http/server.js'
import type { HttpServerHandle } from '../src/server/http/server.js'
import { MatchMachine } from '../src/server/match/machine.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'
import { ReplayStore } from '../src/server/replay/store.js'

let handle: HttpServerHandle
const machines = new Map<string, MatchMachine>()
// M6/S3：回放查询面（真实 Fastify 路由覆盖——纯函数打表之外的壳注册必须也钉住）
const replayDir = mkdtempSync(join(tmpdir(), 'replay-shell-'))
writeFileSync(
  join(replayDir, 'm1.jsonl'),
  [
    JSON.stringify({
      kind: 'meta',
      v: 1,
      matchId: 'm1',
      form: 'arena',
      config: {},
      players: [{ seatId: 'a', username: 'ua', screepsUsername: null }],
      rooms: ['W15N15'],
      createdAt: 1,
    }),
    JSON.stringify({ kind: 'frame', gameTime: 10, round: 0, scores: {}, kills: [] }),
  ].join('\n') + '\n',
)
const replayStore = new ReplayStore(replayDir)

const services: ArenaHttpServices = {
  matches: () => [...machines.values()],
  match: (id) => machines.get(id),
  createMatch: (input) => {
    const m = new MatchMachine({ players: input.players, ...(input.config ? { config: input.config } : {}) })
    machines.set(m.id, m)
    return m
  },
  getWorld: async () => ({ ok: true, gameTime: 42, users: [] }),
  consoleSince: async () => ({ lines: [], cursor: 0, bound: true }),
  getTerrain: async (rooms) => ({ terrain: Object.fromEntries(rooms.map((r) => [r, '1'.repeat(2500)])) }),
  history: () => [{ id: 'm1', config: {}, winner: null, settleReason: null, scores: null, roundIndex: 0, createdAt: 1, settledAt: 2, teardown: 'done' }],
  replay: (id, opts) => replayStore.get(id, opts),
  replayExists: (id) => replayStore.has(id),
}

beforeAll(async () => {
  handle = await startHttpServer({ services })
})

afterAll(async () => {
  await handle.close()
  rmSync(replayDir, { recursive: true, force: true })
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

  it('M6：GET /api/replays/:id 真实路由（壳注册）+ frames=none + 404', async () => {
    const base = `http://127.0.0.1:${handle.port}`
    const full = await fetch(`${base}/api/replays/m1`)
    expect(full.status).toBe(200)
    const body = (await full.json()) as { frames?: unknown[]; summary: { partial: boolean } }
    expect(body.frames).toHaveLength(1)
    expect(body.summary.partial).toBe(true)
    const none = await fetch(`${base}/api/replays/m1?frames=none`)
    expect(none.status).toBe(200)
    expect('frames' in ((await none.json()) as object)).toBe(false)
    expect((await fetch(`${base}/api/replays/ghost`)).status).toBe(404)
    const hist = await fetch(`${base}/api/history`)
    expect(((await hist.json()) as { history: Array<{ replay: boolean }> }).history[0]!.replay).toBe(true)
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
