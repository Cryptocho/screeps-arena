/**
 * 事件 → kills/losses 归因（M2 B 步）。
 *
 * 纯函数、无 I/O，输入 arena-mod 加工后的事件条目，输出每条 DESTROYED 的归因结论；
 * 跨 tick 累积计数由调用方（MatchLifecycle）维护。
 *
 * 事件常量（引擎 common/lib/constants.js L785-803）：
 *   EVENT_ATTACK = 1（objectId=攻击方，data.targetId=目标；每 hit 一条）
 *   EVENT_OBJECT_DESTROYED = 2（objectId=被毁对象；无攻击方字段）
 *   EVENT_ATTACK_TYPE_HIT_BACK = 5（反伤 ATTACK：objectId=挨打方，data.targetId=出手方，方向与普通 ATTACK 相反）
 *
 * mod 加工字段（screeps-mod/arena-mod.cjs resolveEventUsers）：
 *   attackerUser = objectId 归属 user（ATTACK=攻击方 / DESTROYED=被毁对象 owner）
 *   targetUser   = data.targetId 归属 user
 *   两者在 DESTROYED 语义下都经 tombstone/ruin 兜底（被杀对象已从 rooms.objects 移除）。
 *
 * 归因口径（plan-M2 B 步，九审 PASS）：
 *   - kills：同 tick 内 DESTROYED.objectId ↔ ATTACK.data.targetId 匹配 → 归「攻击发出方」
 *     （普通 ATTACK=attackerUser；HIT_BACK 反伤=targetUser）；同目标多命中去重计 1
 *     （取伤害最大者，平手取最后出现的）；
 *   - losses：匹配到 ATTACK 的 DESTROYED 归属（objectId owner）计 1 loss；
 *     无 ATTACK 匹配的老死/自杀/回收/降解不计 loss（记 decayLosses）；
 *   - 匹配不到攻击方的 DESTROYED 也计入 decayLosses（核对用）。
 */

export const EVENT_ATTACK = 1
export const EVENT_OBJECT_DESTROYED = 2
export const EVENT_ATTACK_TYPE_HIT_BACK = 5

/** 对象位置/类型解析结果（M6/S1 mod enrich）：via = 解析来源（live/tombstone/ruin）。 */
export interface ObjectInfo {
  x: number
  y: number
  type: string
  via: 'live' | 'tombstone' | 'ruin'
}

/** arena-mod 加工后的事件条目（eventLog 返回的 eventsByRoom 的任一事件的形状）。 */
export interface ArenaEvent {
  event?: unknown
  objectId?: unknown
  attackerUser?: unknown
  targetUser?: unknown
  /** objectId 的解析结果（M6 enrich；解析不到为 null）。 */
  objectInfo?: ObjectInfo | null
  /** data.targetId 的解析结果（M6 enrich；解析不到为 null）。 */
  targetInfo?: ObjectInfo | null
  data?: { targetId?: unknown; damage?: unknown; attackType?: unknown }
}

/** eventLog 单 tick 条目。 */
export interface EventTick {
  tick: number
  eventsByRoom: Record<string, ArenaEvent[]>
}

/** 一条 DESTROYED 的归因结论。 */
export interface DestroyedAttribution {
  /** 被毁对象 Screeps user id（loss 归属），null=归属未知。 */
  ownerUserId: string | null
  /** 攻击发出方 Screeps user id（kill 归属），null=无匹配（非战斗死亡）。 */
  killerUserId: string | null
  /** 是否为战斗死亡（有同 tick ATTACK 匹配）。 */
  combat: boolean
}

function userIdOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * 取攻击发出方。engine _damage.js L87-93 两种 ATTACK 的 objectId 都是「打出这次伤害的实体」：
 *   普通：objectId=打人者（object），targetId=挨打者（target）
 *   HIT_BACK 反击：objectId=反击者（target），targetId=挨反击者（object）
 * 所以统一取 objectId 归属（attackerUser）即可，不需要按 attackType 区分方向。
 */
function attackerSide(ev: ArenaEvent): string | null {
  return userIdOf(ev.attackerUser)
}

/** 带对象 id 的归因条目（M6/S1：recorder 需要 (tick, objectId) 关联事件位置/类型）。 */
export interface DetailedAttribution {
  /** 被毁对象 id（eventLog DESTROYED 的 objectId；无 id 时为 null）。 */
  objectId: string | null
  attribution: DestroyedAttribution
}

/**
 * 归因一个 tick 的全部事件（拍平 eventsByRoom；攻击与其致死目标必在同房间同 tick，
 * 目标 id 全局唯一，跨房匹配不会误配）。
 * 返回该 tick 内每条 DESTROYED 的归因；无 DESTROYED 返回空数组。
 */
export function attributeTick(events: ArenaEvent[]): DestroyedAttribution[] {
  return attributeTickDetailed(events).map((d) => d.attribution)
}

/** 同 attributeTick，但保留每条结论对应的被毁对象 id（顺序与 DESTROYED 事件序一致）。 */
export function attributeTickDetailed(events: ArenaEvent[]): DetailedAttribution[] {
  const attacksByTarget = new Map<string, ArenaEvent[]>()
  for (const ev of events) {
    if (ev.event !== EVENT_ATTACK) continue
    const targetId = ev.data?.targetId
    if (typeof targetId !== 'string') continue
    const list = attacksByTarget.get(targetId) ?? []
    list.push(ev)
    attacksByTarget.set(targetId, list)
  }

  const out: DetailedAttribution[] = []
  for (const ev of events) {
    if (ev.event !== EVENT_OBJECT_DESTROYED) continue
    const destroyedId = typeof ev.objectId === 'string' ? ev.objectId : null
    const owner = userIdOf(ev.attackerUser)
    if (destroyedId === null) {
      // 无 id 的 DESTROYED 无法归因（核对用）
      out.push({ objectId: null, attribution: { ownerUserId: owner, killerUserId: null, combat: false } })
      continue
    }
    const matched = attacksByTarget.get(destroyedId)
    if (!matched || matched.length === 0) {
      out.push({ objectId: destroyedId, attribution: { ownerUserId: owner, killerUserId: null, combat: false } })
      continue
    }
    // 多命中去重：取伤害最大者，平手取最后出现的（从后往前扫，严格大于才替换）
    let best: ArenaEvent | undefined
    let bestDamage = -Infinity
    for (let i = matched.length - 1; i >= 0; i--) {
      const candidate = matched[i]!
      const damage = typeof candidate.data?.damage === 'number' ? candidate.data.damage : 0
      if (damage > bestDamage) {
        bestDamage = damage
        best = candidate
      }
    }
    out.push({
      objectId: destroyedId,
      attribution: { ownerUserId: owner, killerUserId: best ? attackerSide(best) : null, combat: true },
    })
  }
  return out
}