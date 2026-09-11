import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashV1 } from '../canonical.ts'
import type { MatchState } from '../match/model.ts'
import type { ReplayRecord } from './model.ts'
import { toReplayMetaHash } from './model.ts'
import { ReplayStore } from './store.ts'
import { ReplayRecorder, type ReplayBridgeLike } from './recorder.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-recrec-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const GEN = 'g-rec-1'

function makeFrame(seq: number, gameTime: number): ReplayRecord {
  return {
    schemaVersion: 1,
    sourceGeneration: GEN,
    replayId: 'r-m1',
    seq,
    kind: 'frame',
    gameTime,
    frame: { sourceGeneration: GEN, replayId: 'r-m1', seq, gameTime, rooms: [], events: [] },
  }
}

interface FakeBridgeState {
  records: ReplayRecord[]
  started: number
  stopped: number
  pages: number
  closed: boolean
}

function fakeBridge(): { bridge: ReplayBridgeLike; state: FakeBridgeState } {
  const state: FakeBridgeState = { records: [], started: 0, stopped: 0, pages: 0, closed: false }
  const bridge: ReplayBridgeLike = {
    async replayStart() {
      state.started++
      return { schemaVersion: 1, sourceGeneration: GEN, cursor: 0, acceptedGameTime: null, queueCapacity: 256 }
    },
    async replayPage(input) {
      state.pages++
      const from = input.cursor ?? 0
      const slice = state.closed ? state.records : state.records // 模拟 live：只给到当前已产
      const records = slice.slice(from, from + (input.limit ?? 200))
      const nextCursor = records.length > 0 ? records[records.length - 1]!.seq + 1 : from
      return {
        replayId: 'r-m1',
        sourceGeneration: GEN,
        cursor: from,
        nextCursor,
        records,
        status: state.closed ? 'complete' : 'live',
        complete: state.closed,
        gapReasons: [],
        fatalBackpressure: false,
      }
    },
    async replayStop() {
      state.stopped++
      state.closed = true
      return {
        replayId: 'r-m1',
        sourceGeneration: GEN,
        finalCursor: state.records.length,
        finalGameTime: 42,
        status: 'complete',
        complete: true,
        gapReasons: [],
        fatalBackpressure: false,
        records: [],
      }
    },
  }
  return { bridge, state }
}

function matchState(over: Partial<MatchState> = {}): MatchState {
  return {
    id: 'm1',
    createdAt: 1,
    updatedAt: 1,
    phase: 'running',
    config: {
      form: 'arena',
      preset: 'arena-blitz',
      tickDuration: 150,
      maxTicks: 2000,
      seats: 2,
      frozenCode: false,
      scoring: { territory: 0, rcl: 0, kills: 1, losses: 1, energy: 0 },
    },
    players: [
      { sessionId: 's1', username: 'u1', participantId: 'p0', joinedAt: 1 },
      { sessionId: 's2', username: 'u2', participantId: 'p1', joinedAt: 1 },
    ],
    tournamentId: 't1',
    tournamentSlotId: 'r1s0',
    attempt: 0,
    assignments: { s1: 'W15N15', s2: 'W14N15' },
    ...over,
  } as MatchState
}

describe('ReplayRecorder', () => {
  it('begin starts the bridge and creates the store; drain persists pages to the visible watermark', async () => {
    const { bridge, state } = fakeBridge()
    const store = new ReplayStore(path.join(dir, 'replays'))
    const recorder = new ReplayRecorder({ bridge, store })
    const begun = await recorder.begin(matchState())
    expect(begun.sourceGeneration).toBe(GEN)
    expect(state.started).toBe(1)
    // bridge 已有 2 条（模拟 roomsDone 已产）
    state.records = [makeFrame(0, 1), makeFrame(1, 2)]
    const drained = await recorder.drain('m1', { ...begun, cursor: 0 })
    expect(drained.nextCursor).toBe(2)
    expect(await store.watermark('m1')).toBe(1)
    const page = await store.read('m1', {})
    expect(page.records).toHaveLength(2)
    expect(page.availableCount).toBe(2)
  })

  it('finish stops the bridge, appends residual records and finalizes meta (replayMetaHash receipt)', async () => {
    const { bridge, state } = fakeBridge()
    const store = new ReplayStore(path.join(dir, 'replays'))
    const recorder = new ReplayRecorder({ bridge, store })
    const begun = await recorder.begin(matchState())
    state.records = [makeFrame(0, 1), makeFrame(1, 2), makeFrame(2, 3)]
    await recorder.drain('m1', { ...begun, cursor: 0 })
    const outcome = await recorder.finish(matchState())
    expect(outcome.completeness).toBe('complete')
    expect(outcome.gapReasons).toEqual([])
    expect(outcome.receipt.resultId).toBe('m1')
    expect(outcome.receipt.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    // meta 已 finalize → status complete
    const meta = await store.getMeta('m1')
    expect(meta?.status).toBe('complete')
    expect(meta?.recordCount).toBe(3)
    expect(meta?.participantSnapshot).toEqual([
      { participantId: 'p0', displayName: 'p0' },
      { participantId: 'p1', displayName: 'p1' },
    ])
    // replayMetaHash 与直接 hashV1 权威字段集一致
    expect(outcome.receipt.payloadHash).toBe(toReplayMetaHash(meta!))
  })

  it('finish without a prior begin auto-begins (no throw) and reports whatever frames arrived', async () => {
    const { bridge, state } = fakeBridge()
    const store = new ReplayStore(path.join(dir, 'replays'))
    const recorder = new ReplayRecorder({ bridge, store })
    state.records = []
    const outcome = await recorder.finish(matchState())
    expect(outcome.completeness).toBe('complete')
    expect(state.started).toBe(1)
    expect(state.stopped).toBe(1)
    expect(await store.watermark('m1')).toBe(-1) // 无帧（recordCount 0）
  })

  it('gap/partial: bridge reports partial → meta partial + gapReasons + completeness partial', async () => {
    const { bridge, state } = fakeBridge()
    const store = new ReplayStore(path.join(dir, 'replays'))
    const recorder = new ReplayRecorder({ bridge, store })
    await recorder.begin(matchState())
    state.records = [makeFrame(0, 1), makeFrame(1, 2)]
    await recorder.drain('m1', { replayId: 'r-m1', sourceGeneration: GEN, cursor: 0 })
    // 篡改 bridge stop 为 partial
    const origStop = bridge.replayStop.bind(bridge)
    ;(bridge as unknown as { replayStop: unknown }).replayStop = async () => {
      const base = await origStop({ replayId: 'r-m1', sourceGeneration: GEN })
      return { ...base, status: 'partial' as const, complete: false, gapReasons: ['busy'] }
    }
    const outcome = await recorder.finish(matchState())
    expect(outcome.completeness).toBe('partial')
    expect(outcome.gapReasons).toEqual(['busy'])
    const meta = await store.getMeta('m1')
    expect(meta?.status).toBe('partial')
    expect(meta?.gapReasons).toEqual(['busy'])
  })
})
