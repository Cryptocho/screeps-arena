/**
 * M6/S2 回放记录器单测（plan-M6 D7）：行序/版本化、idmap 惰性补写、恢复续写、
 * 软上限降频（kills/scores 不降）、键=房名混跑过滤、objectInfo=null → 'unknown'、
 * (tick,objectId) 去重（防御路径）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatchRecorder } from '../src/server/match/recorder.js'
import type { ReplayObject } from '../src/server/match/recorder.js'
import { configFromPreset } from '../src/server/match/model.js'
import type { EventTick } from '../src/server/match/attribution.js'
import type { KillDetail } from '../src/server/match/arena-observe.js'

const PLAYERS = [
  { seatId: 's1', username: 's1' },
  { seatId: 's2', username: 's2' },
]
const ROOMS = ['W15N15', 'W14N15']

function makeRecorder(dir: string, matchId = 'm1', extra: { recovered?: boolean; softLimitBytes?: number } = {}) {
  return new MatchRecorder({
    dir,
    matchId,
    form: 'arena',
    config: configFromPreset('arena-blitz'),
    players: PLAYERS,
    rooms: ROOMS,
    createdAt: 1000,
    ...extra,
  })
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const obj = (type: string, x: number, y: number, user: string | null): ReplayObject => ({ type, x, y, user, name: null, hits: null })

/** 命中房 + 他局房各一条 DESTROYED（混跑过滤用）。 */
function enriched(): { events: EventTick[]; details: KillDetail[] } {
  const events: EventTick[] = [
    {
      tick: 10,
      eventsByRoom: {
        W15N15: [{ event: 2, objectId: 'd1', attackerUser: 'u1', objectInfo: { x: 5, y: 6, type: 'spawn', via: 'ruin' } }],
        E5N5: [{ event: 2, objectId: 'foreign', attackerUser: 'u9', objectInfo: { x: 1, y: 1, type: 'creep', via: 'live' } }],
      },
    },
  ]
  const details: KillDetail[] = [
    { tick: 10, objectId: 'd1', attribution: { ownerUserId: 'u1', killerUserId: 'u2', combat: true } },
    { tick: 10, objectId: 'foreign', attribution: { ownerUserId: 'u9', killerUserId: 'u8', combat: true } },
  ]
  return { events, details }
}

describe('M6/S2 MatchRecorder', () => {
  it('行序与版本：meta(v:1) 首行 → frame → mark → end；idmap 惰性补写恰一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-rec-'))
    try {
      const rec = makeRecorder(dir)
      const { events, details } = enriched()
      // 首拍 s2 未绑定 → 不写 idmap
      rec.recordTick({ gameTime: 10, round: 0, enrichedEvents: events, details, scores: {}, userIds: { s1: 'u1', s2: null }, positions: {} })
      // 次拍全员解析 → 写一次 idmap；第三拍不再重写
      rec.recordTick({ gameTime: 20, round: 0, enrichedEvents: [], details: [], scores: {}, userIds: { s1: 'u1', s2: 'u2' } })
      rec.recordTick({ gameTime: 30, round: 0, enrichedEvents: [], details: [], scores: {}, userIds: { s1: 'u1', s2: 'u2' } })
      rec.mark({ at: 5, type: 'settled' })
      rec.end({ settledAt: 99, settleReason: 'lastStanding', winner: { kind: 'seat', seatId: 's1' }, scores: { s1: 1, s2: 0 }, ledger: {} })
      const ls = lines(rec.file)
      expect(ls.map((l) => l.kind)).toEqual(['meta', 'frame', 'idmap', 'frame', 'frame', 'mark', 'end'])
      expect(ls[0]).toMatchObject({ kind: 'meta', v: 1, matchId: 'm1', form: 'arena', rooms: ROOMS })
      expect(ls[2]).toMatchObject({ kind: 'idmap', map: { s1: 'u1', s2: 'u2' } })
      expect(ls[6]).toMatchObject({ kind: 'end', settleReason: 'lastStanding' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('混跑过滤 + 去重 + type 归一：他局房事件不进本局时间线；objectInfo 缺 → unknown；同键不双计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-rec-'))
    try {
      const rec = makeRecorder(dir)
      const { events, details } = enriched()
      // 首拍：本局 d1 命中（ruin→spawn），他局 foreign 被滤；缺 info 的解析不到 → 需要新事件
      rec.recordTick({
        gameTime: 10,
        round: 0,
        enrichedEvents: [
          ...events,
          { tick: 11, eventsByRoom: { W14N15: [{ event: 2, objectId: 'd2', attackerUser: 'u3', objectInfo: null }] } },
        ],
        details: [...details, { tick: 11, objectId: 'd2', attribution: { ownerUserId: 'u3', killerUserId: null, combat: false } }],
        scores: {},
        userIds: { s1: 'u1', s2: 'u2' },
      })
      const frames = lines(rec.file).filter((l) => l.kind === 'frame')
      expect(frames[0]!.kills).toEqual([
        { tick: 10, killer: 's2', owner: 's1', type: 'spawn', room: 'W15N15', x: 5, y: 6 },
        { tick: 11, killer: null, owner: 'u3', type: 'unknown', room: 'W14N15' },
      ])
      // 同 (tick,objectId) 复投 → 去重（防御路径）
      rec.recordTick({ gameTime: 12, round: 0, enrichedEvents: events, details, scores: {}, userIds: { s1: 'u1', s2: 'u2' } })
      expect(lines(rec.file).filter((l) => l.kind === 'frame')[1]!.kills).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('软上限：越界后位置降频 ×4 并记 samplingThrottled 一次；kills 帧不受影响', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-rec-'))
    try {
      // 门槛取 200B（meta 行本身已越界）→ 首拍降级 ×4，门槛随之 ×4（≈800B）不再逐帧降
      const rec = makeRecorder(dir, 'm1', { softLimitBytes: 200 })
      const positions = { W15N15: [obj('creep', 1, 1, 'u1')] }
      const tick = (gt: number) =>
        rec.recordTick({ gameTime: gt, round: 0, enrichedEvents: [], details: [], scores: {}, userIds: { s1: 'u1', s2: 'u2' }, positions })
      tick(10) // 触发降级（factor 4，count 1 → 本次仍写）
      tick(20) // count 2 % 4 ≠ 0 → 降
      tick(30) // count 3 → 降
      tick(40) // count 4 % 4 === 0 → 写
      const ls = lines(rec.file)
      const frames = ls.filter((l) => l.kind === 'frame')
      expect(frames.map((f) => f.gameTime)).toEqual([10, 20, 30, 40])
      expect(frames.map((f) => 'positions' in f)).toEqual([true, false, false, true])
      expect(ls.filter((l) => l.type === 'samplingThrottled')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('恢复续写：文件已在位则只补 recovered mark（不覆盖既有行、不重写 meta）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-rec-'))
    try {
      const rec = makeRecorder(dir)
      rec.recordTick({ gameTime: 10, round: 0, enrichedEvents: [], details: [], scores: {}, userIds: { s1: 'u1', s2: 'u2' } })
      const before = lines(rec.file).length
      // 模拟重启恢复
      const resumed = makeRecorder(dir, 'm1', { recovered: true })
      const ls = lines(resumed.file)
      expect(ls).toHaveLength(before + 1)
      expect(ls[ls.length - 1]).toMatchObject({ kind: 'mark', type: 'recovered' })
      expect(ls.filter((l) => l.kind === 'meta')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('恢复但文件缺失：补 meta + recovered mark（D3 兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-rec-'))
    try {
      const rec = makeRecorder(dir, 'm9', { recovered: true })
      const ls = lines(rec.file)
      expect(ls.map((l) => l.kind)).toEqual(['meta', 'mark'])
      expect(ls[1]).toMatchObject({ type: 'recovered' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('残行容忍：崩溃留下的半行不影响已有行读取（append-only 固有语义）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-rec-'))
    try {
      const rec = makeRecorder(dir)
      writeFileSync(rec.file, readFileSync(rec.file, 'utf8') + '{"kind":"frame","gam')
      const raw = readFileSync(rec.file, 'utf8').trim().split('\n')
      expect(raw[raw.length - 1]).toBe('{"kind":"frame","gam')
      expect(JSON.parse(raw[0]!).kind).toBe('meta') // 残行之前的行完好（读端跳残行由 ReplayStore 负责）
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
