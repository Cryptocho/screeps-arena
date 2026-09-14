/**
 * M5/S3 单测（plan-M5 D5/D8）：归因器打表（B1 语义）、KillLedger 累积、arena 结算决策
 * （lastStanding/双淘汰/ticksExhausted）；HTTP 层 botCode 剥除负向 + preset 校验（S4）。
 */
import { describe, expect, it } from 'vitest'
import { attributeTick, EVENT_ATTACK, EVENT_OBJECT_DESTROYED } from '../src/server/match/attribution.js'
import type { ArenaEvent, EventTick } from '../src/server/match/attribution.js'
import { KillLedger, arenaSettleDecision, ticksExhaustedDecision } from '../src/server/match/arena-observe.js'
import { handleArenaRequest } from '../src/server/http/routes.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'

const attack = (attackerUser: string | null, targetId: string, damage = 30): ArenaEvent => ({
  event: EVENT_ATTACK,
  objectId: 'obj-' + attackerUser,
  attackerUser,
  data: { targetId, damage },
})
const destroyed = (ownerUser: string | null, objectId: string): ArenaEvent => ({
  event: EVENT_OBJECT_DESTROYED,
  objectId,
  attackerUser: ownerUser, // mod 语义：DESTROYED 的 attackerUser=被毁对象 owner
})

describe('M5/B1 归因器打表', () => {
  it('combat kill：同 tick ATTACK↔DESTROYED 匹配 → kills 归攻击方，losses 归 owner', () => {
    const out = attributeTick([attack('uA', 't1', 30), destroyed('uB', 't1')])
    expect(out).toEqual([{ ownerUserId: 'uB', killerUserId: 'uA', combat: true }])
  })

  it('无 ATTACK 匹配（老死/自杀）→ combat:false 不计 loss（B1 订正语义）', () => {
    const out = attributeTick([destroyed('uB', 't1')])
    expect(out).toEqual([{ ownerUserId: 'uB', killerUserId: null, combat: false }])
  })

  it('多命中去重：取伤害最大者，平手取最后出现的', () => {
    const out = attributeTick([attack('uA', 't1', 10), attack('uB', 't1', 50), attack('uA', 't1', 50), destroyed('uC', 't1')])
    expect(out[0]!.killerUserId).toBe('uA') // 平手取最后出现的
    const out2 = attributeTick([attack('uA', 't2', 10), attack('uB', 't2', 90), attack('uA', 't2', 90), destroyed('uC', 't2')])
    expect(out2[0]!.killerUserId).toBe('uA') // 90 平手取最后出现的
  })

  it('HIT_BACK 反伤：attackerUser=反击者（统一取 objectId 归属）', () => {
    const out = attributeTick([{ event: EVENT_ATTACK, objectId: 'defender', attackerUser: 'uB', data: { targetId: 't3', damage: 5 } }, destroyed('uA', 't3')])
    expect(out[0]).toEqual({ ownerUserId: 'uA', killerUserId: 'uB', combat: true })
  })

  it('eventsByRoom 拍平：攻击与被毁跨房间同 tick 仍可匹配（目标 id 全局唯一）', () => {
    const tick: EventTick = {
      tick: 7,
      eventsByRoom: {
        W15N15: [attack('uA', 't9', 30)],
        W14N15: [destroyed('uB', 't9')],
      },
    }
    const out = attributeTick(Object.values(tick.eventsByRoom).flat())
    expect(out).toEqual([{ ownerUserId: 'uB', killerUserId: 'uA', combat: true }])
  })
})

describe('M5/D5 KillLedger', () => {
  it('累积 kills/losses；decayLosses 独立（不进 score）', () => {
    const l = new KillLedger()
    l.consume([
      { tick: 1, eventsByRoom: { r: [attack('uA', 't1', 30), destroyed('uB', 't1'), destroyed('uB', 't2')] } },
      { tick: 5, eventsByRoom: { r: [attack('uB', 't3', 30), destroyed('uA', 't3')] } },
    ])
    expect(l.score('uA')).toBe(0) // 1 kill − 1 loss
    expect(l.score('uB')).toBe(0) // 1 kill − 1 loss（老死不计 combat loss）
    expect(l.cursor).toBe(5)
    expect(l.score('uA')).toBe(0)
    l.consume([{ tick: 2, eventsByRoom: {} }]) // 旧 tick 不回退游标
    expect(l.cursor).toBe(5)
  })

  it('空消费推进游标；scores 缺席用户 = 0', () => {
    const l = new KillLedger()
    l.consume([{ tick: 3, eventsByRoom: { a: [], b: [] } }])
    expect(l.cursor).toBe(3)
    expect(l.score('nobody')).toBe(0)
    expect(l.score(null)).toBe(0)
  })
})

const ALIVE = { spawns: 1, creeps: 5, rooms: 1, rclTotal: 1 }
const DEAD = { spawns: 0, creeps: 3, rooms: 0, rclTotal: 0 }

describe('M5/D5 arena 结算决策', () => {
  it('无淘汰 → undefined（对局继续）', () => {
    expect(arenaSettleDecision({ a: ALIVE, b: ALIVE }, { a: 0, b: 0 })).toBeUndefined()
  })

  it('恰一席歼灭 → lastStanding，winner=对手', () => {
    const d = arenaSettleDecision({ a: DEAD, b: ALIVE }, { a: 0, b: 2 })
    expect(d?.reason).toBe('lastStanding')
    expect(d?.outcome.winner).toEqual({ kind: 'seat', seatId: 'b' })
  })

  it('同 tick 双淘汰 → 击杀分高者胜；平 → draw', () => {
    const both = { a: DEAD, b: DEAD }
    expect(arenaSettleDecision(both, { a: 3, b: 1 })?.outcome.winner).toEqual({ kind: 'seat', seatId: 'a' })
    expect(arenaSettleDecision(both, { a: 2, b: 2 })?.outcome.winner).toEqual({ kind: 'draw' })
  })

  it('maxTicks 兜底：未到预算 undefined；到预算击杀分定胜负；平 → draw', () => {
    const snap = { a: ALIVE, b: ALIVE }
    expect(ticksExhaustedDecision(['a', 'b'], { a: 1, b: 2 }, 100, 100 + 1999, 2000, snap)).toBeUndefined()
    const d = ticksExhaustedDecision(['a', 'b'], { a: 1, b: 2 }, 100, 100 + 2000, 2000, snap)
    expect(d?.reason).toBe('ticksExhausted')
    expect(d?.outcome.winner).toEqual({ kind: 'seat', seatId: 'b' })
    expect(ticksExhaustedDecision(['a', 'b'], { a: 1, b: 1 }, 100, 2100, 2000, snap)?.outcome.winner).toEqual({ kind: 'draw' })
  })
})

describe('M5/S4 HTTP 边界（公平红线）', () => {
  const svc: ArenaHttpServices = {
    matches: () => [],
    match: () => undefined,
    createMatch: () => {
      throw new Error('should not be called')
    },
    getWorld: async () => ({}),
    getTerrain: async () => ({ terrain: {} }),
    consoleSince: async () => ({ lines: [], cursor: 0, bound: true }),
  }

  it('botCode 经 HTTP 拒绝（公平红线：LLM 永不经由 HTTP 注代码）', async () => {
    const res = await handleArenaRequest(svc, {
      method: 'POST',
      pathname: '/api/matches',
      body: { players: [{ seatId: 'a', username: 'a' }, { seatId: 'b', username: 'b' }], botCode: { main: 'x' } },
    })
    expect(res.status).toBe(400)
    expect((res.json as { error: string }).error).toContain('botCode')
  })

  it('未知 preset 400', async () => {
    const res = await handleArenaRequest(svc, {
      method: 'POST',
      pathname: '/api/matches',
      body: { players: [{ seatId: 'a', username: 'a' }, { seatId: 'b', username: 'b' }], preset: 'nope' },
    })
    expect(res.status).toBe(400)
    expect((res.json as { error: string }).error).toContain('unknown preset')
  })
})
