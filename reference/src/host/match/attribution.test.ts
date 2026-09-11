/**
 * kills/losses 归因纯函数打表（M2 B 步）。
 */
import { describe, expect, it } from 'vitest'
import { attributeTick, EVENT_ATTACK, EVENT_ATTACK_TYPE_HIT_BACK, EVENT_OBJECT_DESTROYED, type ArenaEvent } from './attribution.ts'

function attack(objectId: string, targetId: string, damage: number, attackType = 0, attackerUser?: string, targetUser?: string): ArenaEvent {
  return { event: EVENT_ATTACK, objectId, attackerUser, data: { targetId, damage, attackType }, targetUser }
}
function destroyed(objectId: string, ownerUserId?: string): ArenaEvent {
  return { event: EVENT_OBJECT_DESTROYED, objectId, attackerUser: ownerUserId, data: {} }
}

describe('attributeTick kills/losses attribution', () => {
  it('attributes a clean kill: attacker gets kills, owner gets losses', () => {
    const result = attributeTick([attack('atk', 'victim', 60, 2, 'userA', 'userB'), destroyed('victim', 'userB')])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ ownerUserId: 'userB', killerUserId: 'userA', combat: true })
  })

  it('multi-hit in one tick dedups to a single kill (highest damage wins)', () => {
    const result = attributeTick([
      attack('atk1', 'victim', 30, 1, 'userA', 'userB'),
      attack('atk2', 'victim', 150, 2, 'userC', 'userB'),
      destroyed('victim', 'userB'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.killerUserId).toBe('userC') // 伤害最大者（tower 150）
    expect(result[0]!.combat).toBe(true)
  })

  it('tie damage picks the last occurrence', () => {
    const result = attributeTick([
      attack('atk1', 'victim', 60, 1, 'userA', 'userB'),
      attack('atk2', 'victim', 60, 1, 'userC', 'userB'),
      destroyed('victim', 'userB'),
    ])
    expect(result[0]!.killerUserId).toBe('userC') // 平手取最后
  })

  it('hit-back ATTACK direction is reversed (objectId=hit target, targetId=attacker)', () => {
    // A creep attcks B creep; B has ATTACK part → hitback event with objectId=B, targetId=A
    const result = attributeTick([
      attack('aCreep', 'bCreep', 30, 1, 'userA', 'userB'),
      attack('bCreep', 'aCreep', 30, EVENT_ATTACK_TYPE_HIT_BACK, 'userB', 'userA'),
      destroyed('aCreep', 'userA'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.killerUserId).toBe('userB') // hitback attackerSide = targetUser
    expect(result[0]!.ownerUserId).toBe('userA')
    expect(result[0]!.combat).toBe(true)
  })

  it('non-combat deaths (aging/suicide) do not count as combat (no kill, decay)', () => {
    const result = attributeTick([destroyed('creepX', 'userA')])
    expect(result[0]).toMatchObject({ ownerUserId: 'userA', killerUserId: null, combat: false })
  })

  it('destroyed with unknown owner still flags combat when matched', () => {
    const result = attributeTick([attack('atk', 'v', 30, 1, 'userA'), destroyed('v')])
    expect(result[0]).toMatchObject({ ownerUserId: null, killerUserId: 'userA', combat: true })
  })

  it('no destroyed events produce no attributions', () => {
    expect(attributeTick([attack('a', 'b', 30, 1, 'u1', 'u2')])).toEqual([])
  })
})