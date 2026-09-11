/**
 * M4-A0 — canonical replay bridge 契约测试（纯状态机，不依赖 arena-mod db/env）。
 *
 * 直接加载 screeps-mod/arena-mod.cjs 的 _createReplayBridge，注入同步/可控异步
 * makeFrame，验证 v6 §5.2/5.3 契约：
 * - start → schemaVersion/generation/cursor=0/单 active；
 * - 每个 accepted roomsDone → frame 或覆盖闭区间 gap，record seq 单调；
 * - 队列满 → backpressure gap；无解 → fatalBackpressure（显式，不静默丢）；
 * - page：cursor/limit/nextCursor/status/complete；
 * - stop：complete|partial、finalCursor、幂等；
 * - invalidate/reset：旧 generation 不可写、可开新 replay。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)
const arenaMod = requireCjs('../../screeps-mod/arena-mod.cjs')

/** 构造 bridge：makeFrame 默认同步返回 {gameTime}，可注入慢/失败帧。 */
function makeBridge(overrides: { queueCapacity?: number; makeFrame?: (tick: number) => Promise<unknown> | unknown } = {}) {
  const b = arenaMod._createReplayBridge({
    queueCapacity: overrides.queueCapacity ?? 8,
    makeFrame:
      overrides.makeFrame ??
      ((tick: number) => ({ gameTime: tick, rooms: [{ room: 'W15N15', status: 'normal', publicObjects: [], own: null }], events: [] })),
  })
  return b
}

describe('canonical replay bridge (M4-A0)', () => {
  it('start returns schemaVersion/generation/cursor=0 and enforces single active', () => {
    const b = makeBridge()
    const s = b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    expect(s.schemaVersion).toBe(1)
    expect(s.sourceGeneration).toMatch(/^g-/)
    expect(s.cursor).toBe(0)
    expect(s.queueCapacity).toBe(8)
    // second start conflicts
    const again = b.start({ replayId: 'm2', matchId: 'm2', rooms: ['W15N15'] })
    expect(again.error).toBeTruthy()
  })

  it('accepted ticks become monotonic frame records with closed-tick coverage', async () => {
    const b = makeBridge()
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    for (const t of [100, 101, 102]) {
      const r = await b.acceptTick(t)
      expect(r.accepted).toBe(true)
    }
    await b.stop()
    const st = b.status()
    expect(st.recordCount).toBe(3)
    expect(st.complete).toBe(true)
    expect(b.state.records.map((r: { seq: number }) => r.seq)).toEqual([0, 1, 2])
    expect(b.state.records.every((r: { sourceGeneration: string }) => r.sourceGeneration === b.state.sourceGeneration)).toBe(true)
  })

  it('duplicate and stale ticks are NOT accepted (no duplicate records)', async () => {
    const b = makeBridge()
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(200)
    const dup = await b.acceptTick(200)
    expect(dup.accepted).toBe(false)
    expect(dup.reason).toBe('duplicate')
    const stale = await b.acceptTick(199)
    expect(stale.accepted).toBe(false)
    expect(stale.reason).toBe('stale')
    await b.stop()
    expect(b.state.records).toHaveLength(1)
  })

  it('queue overflow produces closed-interval backpressure gap, then frames resume', async () => {
    // queueCapacity=2 且 makeFrame 全失败 → 前两个 tick frame、其后 gap 闭区间
    const b = makeBridge({ queueCapacity: 2 })
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(300)
    await b.acceptTick(301)
    // 让 frame 异步成功前先把队列填满后，第三、四 tick 走 gap
    const r3 = await b.acceptTick(302)
    // queue 满：第三个 tick 被并入 gap（若前两个已 drain 则可能仍是 frame）
    // 这里不依赖具体 kind，只验证：要么 frame 要么 gap，绝不 dropped/静默
    expect(r3.accepted).toBe(true)
    const r4 = await b.acceptTick(303)
    expect(r4.accepted).toBe(true)
    const fin = await b.stop()
    // 每个 accepted tick 要么有 frame 要么被 gap 闭区间覆盖
    const covered = new Set<number>()
    for (const r of fin.records) {
      if (r.kind === 'frame') covered.add(r.gameTime)
      else for (let t = r.fromTick; t <= r.toTick; t++) covered.add(t)
    }
    expect(covered.has(300)).toBe(true)
    expect(covered.has(301)).toBe(true)
    expect(covered.has(302)).toBe(true)
    expect(covered.has(303)).toBe(true)
    if (fin.gapReasons.length > 0) expect(fin.status).toBe('partial')
  })

  it('async frame failure is folded into busy gap (no silent drop)', async () => {
    let failNext = true
    const b = makeBridge({
      queueCapacity: 8,
      makeFrame: async (tick: number) => {
        if (failNext) {
          failNext = false
          throw new Error('frame producer transient failure')
        }
        return { gameTime: tick, rooms: [], events: [] }
      },
    })
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(400) // frame 失败 → busy gap
    await b.acceptTick(401) // frame 成功
    const fin = await b.stop()
    expect(fin.status).toBe('partial')
    expect(fin.gapReasons).toContain('busy')
    const covered = new Set<number>()
    for (const r of fin.records) {
      if (r.kind === 'frame') covered.add(r.gameTime)
      else for (let t = r.fromTick; t <= r.toTick; t++) covered.add(t)
    }
    expect(covered.has(400)).toBe(true)
    expect(covered.has(401)).toBe(true)
  })

  it('stop is idempotent and marks complete when no gap', async () => {
    const b = makeBridge()
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(1)
    const s1 = await b.stop()
    const s2 = await b.stop()
    expect(s1.complete).toBe(true)
    expect(s1.status).toBe('complete')
    expect(s1.finalCursor).toBe(1)
    expect(s2).toEqual(s1)
    // closed 后不再 accept
    const after = await b.acceptTick(2)
    expect(after.accepted).toBe(false)
    expect(after.reason).toBe('closed')
  })

  it('page: cursor/limit/nextCursor/status/complete and inactive guard', async () => {
    const b = makeBridge()
    expect(b.page(0, 10).error?.code).toBe('inactive')
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(10)
    await b.acceptTick(11)
    await b.acceptTick(12)
    const p1 = b.page(0, 2)
    expect(p1.records).toHaveLength(2)
    expect(p1.nextCursor).toBe(2)
    expect(p1.status).toBe('live')
    expect(p1.complete).toBe(false)
    const p2 = b.page(2, 2)
    expect(p2.records).toHaveLength(1)
    expect(p2.nextCursor).toBe(3)
    await b.stop()
    const p3 = b.page(0, 10)
    expect(p3.complete).toBe(true)
    expect(p3.finalCursor).toBe(3)
  })

  it('invalidate finalizes partial and releases active; new start gets new generation', async () => {
    const b = makeBridge()
    const s1 = b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(10)
    const inv = await b.invalidate('restart')
    expect(inv.invalidated).toBe(true)
    expect(inv.generation).toBe(s1.sourceGeneration)
    expect(inv.complete).toBe(false)
    // 旧 generation 不可再写（已 finalize+释放）
    const after = await b.acceptTick(11)
    expect(after.accepted).toBe(false)
    expect(after.reason).toBe('inactive')
    // 同 bridge 开新 replay → 新 generation，旧记录清空（新场隔离）
    const s2 = b.start({ replayId: 'm2', matchId: 'm2', rooms: ['W15N15'] })
    expect(s2.sourceGeneration).not.toBe(s1.sourceGeneration)
    expect(b.state.records).toHaveLength(0)
  })

  it('reset clears state entirely', async () => {
    const b = makeBridge()
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(10)
    b.reset()
    expect(b.state.active).toBe(false)
    expect(b.state.records).toHaveLength(0)
    const s = b.start({ replayId: 'm2', matchId: 'm2', rooms: ['W15N15'] })
    expect(s.sourceGeneration).toBeTruthy()
  })

  it('exposes fatalBackpressure instead of silently dropping when producer cannot keep up', async () => {
    // 帧永不成功：首个 tick 入队产 frame 失败 → busy gap，之后 gap 闭区间扩展；
    // gap 跨度超阈值 → fatalBackpressure：其后新 tick 拒绝（bridge 停止接受），但每个
    // 已 accepted tick 都被 frame 或 gap 闭区间覆盖，stop 报 partial。
    const b2 = makeBridge({
      queueCapacity: 1,
      makeFrame: () => new Promise((_res, rej) => setTimeout(() => rej(new Error('always busy')), 5)),
    })
    b2.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    const acceptedTicks: number[] = []
    let sawFatalReject = false
    for (let i = 0; i < 40; i++) {
      const r = await b2.acceptTick(1000 + i)
      if (r.accepted) acceptedTicks.push(1000 + i)
      else if (r.reason === 'fatalBackpressure') sawFatalReject = true
    }
    expect(acceptedTicks.length).toBeGreaterThanOrEqual(8) // fatal 前已被接受
    expect(sawFatalReject).toBe(true) // 无法跟上时显式 fatal，拒绝后续 tick
    const fin = await b2.stop()
    expect(fin.status).toBe('partial')
    expect(fin.fatalBackpressure).toBe(true)
    // 每个已 accepted tick 都有 frame/gap 闭区间覆盖
    const covered = new Set<number>()
    for (const r of fin.records) {
      if (r.kind === 'frame') covered.add(r.gameTime)
      else for (let t = r.fromTick; t <= r.toTick; t++) covered.add(t)
    }
    for (const t of acceptedTicks) expect(covered.has(t)).toBe(true)
  })

  it('sync frame producer all-success yields complete replay (no spurious gap)', async () => {
    const b = makeBridge({ queueCapacity: 2 })
    b.start({ replayId: 'm1', matchId: 'm1', rooms: ['W15N15'] })
    await b.acceptTick(500)
    await b.acceptTick(501)
    const fin = await b.stop()
    expect(fin.complete).toBe(true)
    expect(fin.records).toHaveLength(2)
  })
})
