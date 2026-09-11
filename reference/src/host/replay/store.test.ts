import { mkdtempSync, rmSync } from 'node:fs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashV1 } from '../canonical.ts'
import { toReplayMetaHash, type ReplayMeta, type ReplayRecord } from './model.ts'
import { ReplayStore } from './store.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-screeps-replay-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const GEN = 'g-test-1'
const REPLAY_ID = 'replay-1'

function frameRecord(seq: number, gameTime: number): ReplayRecord {
  return {
    schemaVersion: 1,
    sourceGeneration: GEN,
    replayId: REPLAY_ID,
    seq,
    kind: 'frame',
    gameTime,
    frame: { sourceGeneration: GEN, replayId: REPLAY_ID, seq, gameTime, rooms: [], events: [] },
  }
}

function gapRecord(seq: number, fromTick: number, toTick: number): ReplayRecord {
  return { schemaVersion: 1, sourceGeneration: GEN, replayId: REPLAY_ID, seq, kind: 'gap', fromTick, toTick, reason: 'busy' }
}

function metaFor(matchId: string, lastSeq: number, status: 'complete' | 'partial' = 'complete'): ReplayMeta {
  return {
    schemaVersion: 1,
    replayId: REPLAY_ID,
    sourceGeneration: GEN,
    matchId,
    participantSnapshot: [{ participantId: 'pa', displayName: 'Agent A' }],
    status,
    recordCount: lastSeq + 1,
    firstSeq: 0,
    lastSeq,
    gapReasons: status === 'partial' ? ['busy'] : [],
  }
}

function cp(matchId: string): string {
  return path.join(dir, 'replays', matchId, 'checkpoint.json')
}

function frames(matchId: string): string {
  return path.join(dir, 'replays', matchId, 'frames.jsonl')
}

async function appendRawLines(matchId: string, lines: string[]): Promise<void> {
  const fh = await open(frames(matchId), 'a')
  try {
    await fh.writeFile(lines.join('\n') + '\n', 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
}

describe('ReplayStore — visible watermark & read', () => {
  it('appends batches, advancing the visible watermark; reader sees only <= watermark', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    expect(await store.exists('m1')).toBe(true)
    const w1 = await store.append('m1', { records: [frameRecord(0, 10), gapRecord(1, 11, 11)], sourceGeneration: GEN, replayId: REPLAY_ID })
    expect(w1).toBe(1)
    const w2 = await store.append('m1', { records: [frameRecord(2, 12)], sourceGeneration: GEN, replayId: REPLAY_ID })
    expect(w2).toBe(2)
    const page = await store.read('m1', { cursor: 1, limit: 5 })
    expect(page.unavailable).toBe(false)
    expect(page.records.map(r => r.seq)).toEqual([1, 2])
    expect(page.nextCursor).toBe(3)
    expect(page.availableCount).toBe(3)
    expect(page.status).toBe('live')
    expect(page.complete).toBe(false)
    expect(page.meta).toBeUndefined()
  })

  it('returns unavailable for matches without a replay', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    const page = await store.read('none', {})
    expect(page.unavailable).toBe(true)
    expect(await store.exists('none')).toBe(false)
  })

  it('enforces seq continuity from the watermark and rejects generation mismatch', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m1', { records: [frameRecord(0, 1)], sourceGeneration: GEN, replayId: REPLAY_ID })
    await expect(store.append('m1', { records: [frameRecord(2, 2)], sourceGeneration: GEN, replayId: REPLAY_ID })).rejects.toMatchObject({ code: 'badSeq' })
    await expect(store.append('m1', { records: [frameRecord(1, 2)], sourceGeneration: 'g-other', replayId: REPLAY_ID })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('finalize writes meta and flips status/complete; conflicting finalize is corrupt', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m1', { records: [frameRecord(0, 1), gapRecord(1, 2, 3)], sourceGeneration: GEN, replayId: REPLAY_ID })
    await store.finalize('m1', metaFor('m1', 1, 'partial'))
    let page = await store.read('m1', {})
    expect(page.status).toBe('partial')
    expect(page.complete).toBe(false)
    expect(page.gapReasons).toEqual(['busy'])
    await store.finalize('m1', metaFor('m1', 1, 'partial')) // 幂等
    await expect(store.finalize('m1', metaFor('m1', 1, 'complete'))).rejects.toMatchObject({ code: 'corrupt' })

    await store.create('m2', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m2', { records: [frameRecord(0, 1)], sourceGeneration: GEN, replayId: REPLAY_ID })
    await store.finalize('m2', metaFor('m2', 0, 'complete'))
    page = await store.read('m2', {})
    expect(page.status).toBe('complete')
    expect(page.complete).toBe(true)
  })

  it('supports afterTick seek', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m1', { records: [frameRecord(0, 10), frameRecord(1, 20), gapRecord(2, 21, 25), frameRecord(3, 26)], sourceGeneration: GEN, replayId: REPLAY_ID })
    const page = await store.read('m1', { afterTick: 20 })
    expect(page.records.map(r => r.seq)).toEqual([2, 3])
    expect(page.nextCursor).toBe(4)
  })

  it('toReplayMetaHash matches hashV1 over the fixed field set', () => {
    const manual = hashV1({
      replayId: REPLAY_ID,
      sourceGeneration: GEN,
      schemaVersion: 1,
      matchId: 'm1',
      participantSnapshot: [{ participantId: 'pa', displayName: 'Agent A' }],
      status: 'complete',
      recordCount: 5,
      firstSeq: 0,
      lastSeq: 4,
      gapReasons: [],
    })
    expect(toReplayMetaHash(metaFor('m1', 4, 'complete'))).toBe(manual)
  })
})

describe('ReplayStore — batch recovery & torn tail', () => {
  it('recovers committed batches when the checkpoint lags (crash window: manifest written, cp not advanced)', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m1', { records: [frameRecord(0, 1), frameRecord(1, 2)], sourceGeneration: GEN, replayId: REPLAY_ID })
    // 模拟崩溃窗口：manifest 已写，checkpoint 缺失/落后
    rmSync(cp('m1'), { force: true })
    const report = await store.recover('m1')
    expect(report.watermark).toBe(1)
    const page = await store.read('m1', {})
    expect(page.availableCount).toBe(2)
    expect(page.records).toHaveLength(2)
  })

  it('truncates orphan lines (no manifest marker) and torn tail lines', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m1', { records: [frameRecord(0, 1)], sourceGeneration: GEN, replayId: REPLAY_ID })
    // 手工追加无 manifest 残留行 + torn 尾行（模拟 crash 在 frames 后、manifest 前）
    await appendRawLines('m1', [JSON.stringify(frameRecord(1, 2)), JSON.stringify(frameRecord(2, 3)).slice(0, 24)])
    const report = await store.recover('m1')
    expect(report.watermark).toBe(0)
    expect(report.truncated).toBeGreaterThan(0)
    const raw = await readFile(frames('m1'), 'utf8')
    expect(raw.split('\n').filter(l => l.trim() !== '')).toHaveLength(1)
    expect((await store.read('m1', {})).availableCount).toBe(1)
  })

  it('idempotent append replay: committed batch (manifest present, cp stale) advances checkpoint without duplicating lines', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    const records = [frameRecord(0, 1)]
    await store.append('m1', { records, sourceGeneration: GEN, replayId: REPLAY_ID })
    await writeFile(cp('m1'), JSON.stringify({ lastPersistedSeq: -1 }), 'utf8') // 模拟 cp 落后
    const w = await store.append('m1', { records, sourceGeneration: GEN, replayId: REPLAY_ID })
    expect(w).toBe(0)
    const raw = await readFile(frames('m1'), 'utf8')
    expect(raw.split('\n').filter(l => l.trim() !== '')).toHaveLength(1)
    expect((await store.read('m1', {})).availableCount).toBe(1)
  })

  it('handles multiple batches with interleaved recovery after every append', async () => {
    const store = new ReplayStore(path.join(dir, 'replays'))
    await store.create('m1', { replayId: REPLAY_ID, sourceGeneration: GEN })
    await store.append('m1', { records: [frameRecord(0, 1)], sourceGeneration: GEN, replayId: REPLAY_ID })
    await store.append('m1', { records: [frameRecord(1, 2), gapRecord(2, 3, 3)], sourceGeneration: GEN, replayId: REPLAY_ID })
    const report = await store.recover('m1')
    expect(report.watermark).toBe(2)
    expect(report.truncated).toBe(0)
    const page = await store.read('m1', {})
    expect(page.availableCount).toBe(3)
    expect(page.records.map(r => r.seq)).toEqual([0, 1, 2])
  })
})
