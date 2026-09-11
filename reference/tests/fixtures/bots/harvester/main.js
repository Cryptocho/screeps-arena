/**
 * dsh starter bot "harvester" —— 可被击败的基线对手（M1 对局陪练）。
 *
 * 策略（简单但完整）：
 *   1. spawn: 维持最多 4 个 [WORK×2, CARRY, MOVE] 采集者；
 *   2. creep: 满 → 去升级 controller；空 → 最近 source 采集；
 *   3. 自带 Memory.stats 遥测（AGENTS.md 工具面惯例，供战报读取）。
 * 不做攻击/防御——它存在的意义是让 Agent 的第一场胜利有对手。
 *
 * @dsh-bot 采集升级型基线对手: 纯经济, 无战斗, 适合 M1 首胜
 */
'use strict'

const BODY = [WORK, WORK, CARRY, MOVE]
const MAX_CREEPS = 4

function roleOf(creep) {
  return creep.memory.role || 'harvest'
}

module.exports.loop = function () {
  // ---- spawn 管理 ----------------------------------------------------------
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning) {
    const creeps = Object.values(Game.creeps)
    if (creeps.length < MAX_CREEPS && spawn.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      const name = 'h' + Game.time
      spawn.spawnCreep(BODY, name, { memory: { role: 'harvest' } })
    }
  }

  // ---- creep 行为 ----------------------------------------------------------
  let harvested = 0
  let upgraded = 0
  for (const creep of Object.values(Game.creeps)) {
    if (roleOf(creep) !== 'harvest') continue
    if (creep.store.getFreeCapacity() === 0) {
      const controller = creep.room.controller
      if (!controller) continue
      const result = creep.upgradeController(controller)
      if (result === ERR_NOT_IN_RANGE) creep.moveTo(controller)
      else if (result === OK) upgraded++
    } else {
      const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE)
      if (!source) continue
      const result = creep.harvest(source)
      if (result === ERR_NOT_IN_RANGE) creep.moveTo(source)
      else if (result === OK) harvested += 2
    }
  }

  // ---- 自打遥测（战报原料）--------------------------------------------------
  Memory.stats = {
    tick: Game.time,
    creeps: Object.keys(Game.creeps).length,
    harvested,
    upgraded,
  }
}
