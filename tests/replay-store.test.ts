/**
 * M6/S3 ReplayStore 与回放路由打表（plan-M6 D4/D7）：mtime 失效、range 裁剪、
 * frames=none 不回帧、404（缺文件/空文件/坏 meta）、partial（无 end 行）、
 * eventsIncomplete / incompleteAfterRestart 派生、残行跳过、LRU 收敛。
 */
import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplayStore } from '../src/server/replay/store.js'
import { handleArenaRequest } from '../src/server/http/routes.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'

const meta = (id: string) => ({
  kind: 'meta',
  v: 1,
  matchId: id,
  form: 'arena',
  config: { maxTicks: 2000 },
  players: [
    { seatId: 's1', username: 's1', screepsUsername: null },
    { seatId: 's2', username: 's2', screepsUsername: null },
  ],
  rooms: ['W15N15', 'W14N15'],
  createdAt: 1,
})
const frame = (gt: number, kills: unknown[] = []) => ({ kind: 'frame', gameTime: gt, round: 0, scores: { s1: { spawns: 1 } }, kills })
const idmap = { kind: 'idmap', map: { s1: 'u1', s2: 'u2' }, at: 2 }
const end = {
  kind: 'end',
  settledAt: 99,
  settleReason: 'lastStanding',
  winner: { kind: 'seat', seatId: 's1' },
  scores: { s1: 100, s2: 0 },
  ledger: { s1: { kills: 2, losses: 0, decayLosses: 0 }, s2: { kills: 0, losses: 2, decayLosses: 1 } },
}

function writeReplay(dir: string, id: string, rows: unknown[]): string {
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

const KILL = { tick: 55, killer: 's1', owner: 's2', type: 'creep', room: 'W15N15', x: 3, y: 4 }

describe('M6/S3 ReplayStore', () => {
  it('完整局：meta/summary/frames；totals 取 end.ledger；players 经 idmap 挂 screepsUserId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      writeReplay(dir, 'm1', [meta('m1'), idmap, frame(10), frame(20, [KILL]), end])
      const view = new ReplayStore(dir).get('m1')!
      expect(view.meta.matchId).toBe('m1')
      expect(view.summary.partial).toBe(false)
      expect(view.summary.players).toEqual([
        { seatId: 's1', username: 's1', screepsUsername: null, screepsUserId: 'u1' },
        { seatId: 's2', username: 's2', screepsUsername: null, screepsUserId: 'u2' },
      ])
      expect(view.summary.killTimeline).toEqual([KILL])
      expect(view.summary.scoreCurve.map((c) => c.gameTime)).toEqual([10, 20])
      expect(view.summary.totals).toEqual(end.ledger)
      expect(view.frames!.map((f) => f.gameTime)).toEqual([10, 20])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('frames=none 不回帧；from/to 服务端裁剪', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      writeReplay(dir, 'm1', [meta('m1'), frame(10), frame(20), frame(30)])
      const store = new ReplayStore(dir)
      expect(store.get('m1', { frames: false })!.frames).toBeUndefined()
      expect(store.get('m1', { from: 15, to: 25 })!.frames!.map((f) => f.gameTime)).toEqual([20])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('mtime/size 失效：追加帧后同一 store 立刻读到新帧（running 局轮询语义）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      const file = writeReplay(dir, 'm1', [meta('m1'), frame(10)])
      const store = new ReplayStore(dir)
      expect(store.get('m1')!.summary.frames).toBe(1)
      appendFileSync(file, JSON.stringify(frame(20)) + '\n')
      expect(store.get('m1')!.summary.frames).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('404：缺文件 / 空文件 / 坏 meta（无合法 meta 行）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      const store = new ReplayStore(dir)
      expect(store.get('nope')).toBeUndefined()
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'empty.jsonl'), '')
      expect(store.get('empty')).toBeUndefined()
      writeFileSync(join(dir, 'bad.jsonl'), '{"kind":"frame","gameTime":1}\n')
      expect(store.get('bad')).toBeUndefined()
      // has = 文件存在且非空（入口可用性判定，O(1)）；内容不可读由 get() 的 404 兜底
      expect(store.has('bad')).toBe(true)
      expect(store.has('empty')).toBe(false) // 空文件（崩在首行前）→ 入口禁用，与 404 一致
      expect(store.has('nope')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('partial（无 end 行）+ 残行跳过 + idmap 缺失不留白', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      const file = writeReplay(dir, 'm1', [meta('m1'), frame(10)])
      appendFileSync(file, '{"kind":"frame","gam\n') // 崩溃残行
      appendFileSync(file, JSON.stringify(frame(20)) + '\n')
      const view = new ReplayStore(dir).get('m1')!
      expect(view.summary.partial).toBe(true)
      expect(view.summary.frames).toBe(2)
      expect(view.summary.settle).toBeNull()
      expect(view.summary.players[0]!.screepsUserId).toBeNull() // 无 idmap → 原始缺口，不伪造
      // 无 end → totals 由 killTimeline 派生
      expect(view.summary.totals.s1).toEqual({ kills: 0, losses: 0, decayLosses: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('派生角标：recovered → incompleteAfterRestart；eventRingSaturated → eventsIncomplete（含水位）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      writeReplay(dir, 'm1', [
        meta('m1'),
        { kind: 'mark', at: 5, type: 'recovered' },
        { kind: 'mark', at: 9, type: 'eventRingSaturated', ringCapacity: 4096, lastEventTick: 777 },
        frame(10),
      ])
      const s = new ReplayStore(dir).get('m1')!.summary
      expect(s.partial).toBe(true)
      expect(s.incompleteAfterRestart).toBe(true)
      expect(s.eventsIncomplete).toEqual({ ringCapacity: 4096, lastEventTick: 777, at: 9 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('LRU 收敛：跨 5 局反复查询结果仍正确（淘汰不破坏解析）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      for (let i = 0; i < 5; i++) writeReplay(dir, `m${i}`, [meta(`m${i}`), frame(10 + i)])
      const store = new ReplayStore(dir)
      expect(store.get('m0')!.summary.frames).toBe(1)
      expect(store.get('m4')!.summary.frames).toBe(1)
      expect(store.get('m2')!.summary.scoreCurve[0]!.gameTime).toBe(12)
      expect(store.get('m0')!.summary.frames).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** frames 字段的运行时收窄（响应体是 unknown；in + Array.isArray 才是真检查）。 */
function framesOf(json: unknown): unknown[] | undefined {
  if (json && typeof json === 'object' && 'frames' in json) {
    const f = json.frames
    return Array.isArray(f) ? f : undefined
  }
  return undefined
}

describe('M6/S3 回放路由（纯打表）', () => {
  function services(dir: string): ArenaHttpServices {
    const store = new ReplayStore(dir)
    return {
      matches: () => [],
      match: () => undefined,
      createMatch: () => {
        throw new Error('unused')
      },
      getWorld: async () => ({ ok: true, gameTime: 0, users: [] }),
      getTerrain: async () => ({ terrain: {} }),
      consoleSince: async () => ({ lines: [], cursor: 0, bound: true }),
      history: () => [{ id: 'm1', config: {}, winner: null, settleReason: null, scores: null, roundIndex: 0, createdAt: 1, settledAt: 2, teardown: 'done' }],
      replay: (id, opts) => store.get(id, opts),
      replayExists: (id) => store.has(id),
    }
  }

  it('GET /api/replays/:id → 200 {meta,summary,frames}；?frames=none 回 {meta,summary}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      writeReplay(dir, 'm1', [meta('m1'), frame(10), end])
      const s = services(dir)
      const okRes = await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/m1' })
      expect(okRes.status).toBe(200)
      expect(framesOf(okRes.json)).toHaveLength(1)
      const none = await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/m1', query: { frames: 'none' } })
      expect(none.status).toBe(200)
      expect(framesOf(none.json)).toBeUndefined()
      // 未知局 / 路径穿越 → 404
      expect((await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/ghost' })).status).toBe(404)
      expect((await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/..%2Fx' })).status).toBe(404)
      // 方法约束
      expect((await handleArenaRequest(s, { method: 'POST', pathname: '/api/replays/m1' })).status).toBe(405)
      // 区间参数须为数字（NaN 会静默裁成空集 → 显式 400）
      expect((await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/m1', query: { from: 'abc' } })).status).toBe(400)
      expect((await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/m1', query: { to: 'nan' } })).status).toBe(400)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无 replay 服务的实例：路由 404（dev/mock lane 语义）', async () => {
    const s: ArenaHttpServices = {
      matches: () => [],
      match: () => undefined,
      createMatch: () => {
        throw new Error('unused')
      },
      getWorld: async () => ({}),
      getTerrain: async () => ({ terrain: {} }),
      consoleSince: async () => ({ lines: [], cursor: 0, bound: true }),
    }
    expect((await handleArenaRequest(s, { method: 'GET', pathname: '/api/replays/m1' })).status).toBe(404)
  })

  it('GET /api/history 逐行标注 replay 可读性（入口可用性，D6）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-store-'))
    try {
      writeReplay(dir, 'm1', [meta('m1'), frame(10)])
      const res = await handleArenaRequest(services(dir), { method: 'GET', pathname: '/api/history' })
      expect(res.json).toMatchObject({ history: [{ id: 'm1', replay: true }] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
