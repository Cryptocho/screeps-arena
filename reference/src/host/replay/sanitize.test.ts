import { describe, expect, it } from 'vitest'
import type { ReplayRecord } from './model.ts'
import { buildReplayNameMapping, sanitizeRecord, sanitizeRecords } from './sanitize.ts'

const GEN = 'g-san'

function frame(over: Partial<ReplayRecord & { kind: 'frame' }> = {}): ReplayRecord {
  return {
    schemaVersion: 1,
    sourceGeneration: GEN,
    replayId: 'r-m1',
    seq: 0,
    kind: 'frame',
    gameTime: 1,
    frame: {
      sourceGeneration: GEN,
      replayId: 'r-m1',
      seq: 0,
      gameTime: 1,
      rooms: [
        {
          room: 'W15N15',
          status: 'normal',
          own: { username: 'u_p0', level: 1 },
          publicObjects: [
            { kind: 'creep', x: 5, y: 5, username: 'u_p0' },
            { kind: 'tower', x: 6, y: 6 },
          ],
        },
      ],
      events: [
        { kind: 'attack', room: 'W15N15', actorUsername: 'u_p0', targetUsername: 'u_p1' },
        { kind: 'heal', room: 'W15N15', actorUsername: 'u_other' },
      ],
    },
    ...over,
  }
}

describe('replay sanitizer (username → participant display)', () => {
  it('maps usernames that have a participant mapping and leaves unmapped ones untouched', () => {
    const mapping = buildReplayNameMapping([
      { username: 'u_p0', participantId: 'p0', displayName: 'Agent 1' },
      { username: 'u_p1', participantId: 'p1', displayName: 'Agent 2' },
    ])
    const out = sanitizeRecord(mapping, frame())
    expect(out.kind).toBe('frame')
    if (out.kind !== 'frame') return
    // own/publicObjects/events 的 username → displayName
    expect(out.frame.rooms[0]!.own).toEqual({ username: 'Agent 1', level: 1 })
    expect(out.frame.rooms[0]!.publicObjects[0]!.username).toBe('Agent 1')
    expect(out.frame.rooms[0]!.publicObjects[1]!.username).toBeUndefined() // 无 username 字段不动
    expect(out.frame.events[0]).toMatchObject({ actorUsername: 'Agent 1', targetUsername: 'Agent 2' })
    // 未映射 username 原样保留（普通局公开昵称）
    expect(out.frame.events[1]).toMatchObject({ actorUsername: 'u_other' })
    // 结构字段不动
    expect(out.frame.rooms[0]!.room).toBe('W15N15')
    expect(out.seq).toBe(0)
  })

  it('does not mutate the input record and maps ordinary players (no mapping) to username passthrough', () => {
    const input = frame()
    const mapping = buildReplayNameMapping([]) // 普通局无 participant
    const out = sanitizeRecords(mapping, [input])
    expect(out[0]).not.toBe(input) // 新对象
    if (out[0]!.kind === 'frame') {
      expect(out[0]!.frame.rooms[0]!.own).toEqual({ username: 'u_p0', level: 1 })
    }
    // 输入未被改
    if (input.kind === 'frame') {
      expect(input.frame.rooms[0]!.own).toEqual({ username: 'u_p0', level: 1 })
    }
  })

  it('passes gap records through unchanged', () => {
    const gap: ReplayRecord = {
      schemaVersion: 1,
      sourceGeneration: GEN,
      replayId: 'r-m1',
      seq: 1,
      kind: 'gap',
      fromTick: 5,
      toTick: 8,
      reason: 'busy',
    }
    const mapping = buildReplayNameMapping([{ username: 'u_p0', participantId: 'p0' }])
    expect(sanitizeRecord(mapping, gap)).toEqual(gap)
  })
})
