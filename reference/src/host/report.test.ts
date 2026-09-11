/**
 * report 纯函数打表（M2 D 步）：观察分层过滤（fog of war）+ 事件聚合 + console 报错提取。
 */
import { describe, expect, it } from 'vitest'
import { extractConsoleErrors, filterPlayerEvents, flattenEvents, summarizeEvents } from './report.ts'
import type { EventTick } from './match/attribution.ts'

function tick(room: string, events: unknown[]): EventTick {
  return { tick: 1, eventsByRoom: { [room]: events as Array<{ event: unknown; objectId?: unknown; attackerUser?: unknown; targetUser?: unknown }> } }
}

describe('report event layering (fog of war)', () => {
  const myUserId = 'uid-me'
  const myRooms = new Set(['W15N15'])

  it('keeps events I attack, I am attacked by, or that occur in my room', () => {
    const events = flattenEvents([
      tick('W14N15', [{ event: 1, objectId: 'me', attackerUser: myUserId, data: {} }]),
      tick('W14N15', [{ event: 1, objectId: 'foe', attackerUser: 'uid-foe', targetUser: myUserId, data: {} }]),
      tick('W15N15', [{ event: 2, objectId: 'x', attackerUser: 'uid-foe', data: {} }]), // 我方房间（有视野）
      tick('W99N99', [{ event: 2, objectId: 'y', attackerUser: 'uid-foe', data: {} }]), // 无关房间，无关联 → 滤掉
    ])
    const visible = filterPlayerEvents(events, myUserId, myRooms)
    expect(visible).toHaveLength(3)
    expect(summarizeEvents(visible)).toEqual({ involved: 3, attack: 2, destroyed: 1, other: 0 })
  })

  it('drops events with no relation to me (anti-cheat: no vision, no leak)', () => {
    const events = flattenEvents([
      tick('W99N99', [{ event: 1, objectId: 'a', attackerUser: 'uid-x', targetUser: 'uid-y', data: {} }]),
      tick('W88N88', [{ event: 2, objectId: 'b', attackerUser: 'uid-x', data: {} }]),
    ])
    const visible = filterPlayerEvents(events, myUserId, myRooms)
    expect(visible).toHaveLength(0)
    expect(summarizeEvents(visible)).toEqual({ involved: 0, attack: 0, destroyed: 0, other: 0 })
  })

  it('treats unknown-owner events in my room as visible (my room projection)', () => {
    const events = flattenEvents([tick('W15N15', [{ event: 3, objectId: 'c', data: {} }])])
    expect(filterPlayerEvents(events, myUserId, myRooms)).toHaveLength(1)
    expect(summarizeEvents(events)).toEqual({ involved: 1, attack: 0, destroyed: 0, other: 1 })
  })
})

describe('extractConsoleErrors', () => {
  it('extracts driver top-level {userId, error} frames', () => {
    const out = extractConsoleErrors([{ userId: 'u1', error: 'ReferenceError: x is not defined' }])
    expect(out).toEqual(['ReferenceError: x is not defined'])
  })

  it('falls back to messages-array {type:error} entries and error-like strings', () => {
    const out = extractConsoleErrors([
      { messages: [{ type: 'error', error: 'CPU bucked empty' }] },
      { messages: ['some error happened'] },
      { messages: [{ log: ['fine'] }] },
    ])
    expect(out).toEqual(['CPU bucked empty', 'some error happened'])
  })

  it('returns empty for clean frames', () => {
    expect(extractConsoleErrors([])).toEqual([])
    expect(extractConsoleErrors([{ messages: [{ log: ['noop'] }] }])).toEqual([])
  })
})