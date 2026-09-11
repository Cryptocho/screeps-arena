// @dsh-bot 测试驱动 raider（IT1/IT2 专用）：跨房拆对方 spawn / 杀对方 creep。
//
// 铁律（plan-M3 D 节钉死）：
// - 寻敌：Game.map.describeExits(here) 拿出口方向 → 沿出口跨房找敌房；或 Memory.arena.targetRoom
//   显式兜底（注入机制 = writeMemory，createUser 后、start 前写入）。敌房内必须用玩家 API
//   FIND_HOSTILE_CREEPS / FIND_HOSTILE_STRUCTURES（Game.roomObjects 是服务器内部隔离环境）。
// - 攻击：拆 spawn（[ATTACK,ATTACK,MOVE] 成本 210 ≤ SPAWN_ENERGY_START=300 已实战；
//   60 damage/tick × 84 tick ≥ 5000 hits）。
// - arena 常态：RCL1 无 tower，纯近战。

const BODY = [ATTACK, ATTACK, MOVE]
const BODY_COST = 210

function pickTargetRoom() {
  if (Memory.arena && typeof Memory.arena.targetRoom === 'string') return Memory.arena.targetRoom
  const spawn = Object.values(Game.spawns)[0]
  if (!spawn) return null
  const here = spawn.room.name
  const exits = Game.map.describeExits(here)
  for (const dir of Object.keys(exits)) {
    const room = exits[dir]
    if (typeof room === 'string' && room !== here) return room
  }
  return null
}

function exitPosFor(creep, target) {
  // 找目标方向的真实出口格（Screeps 1 格中位不一定在出口列表；m2-battle 教训：
  // 硬编码精确格才跨房）。沿目标方向边界扫描首个非墙格；interRoom 在边界格自动转移。
  const dir = creep.room.findExitTo(target)
  if (dir === ERR_NO_PATH || dir === ERR_INVALID_ARGS || dir === undefined || dir === null) return null
  const terrain = Game.map.getRoomTerrain(creep.room.name)
  const wall = (x, y) => (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0
  for (let i = 1; i < 49; i++) {
    if (dir === FIND_EXIT_TOP && !wall(i, 0)) return new RoomPosition(i, 0, creep.room.name)
    if (dir === FIND_EXIT_BOTTOM && !wall(i, 49)) return new RoomPosition(i, 49, creep.room.name)
    if (dir === FIND_EXIT_LEFT && !wall(0, i)) return new RoomPosition(0, i, creep.room.name)
    if (dir === FIND_EXIT_RIGHT && !wall(49, i)) return new RoomPosition(49, i, creep.room.name)
  }
  return null
}

module.exports.loop = function () {
  const spawn = Object.values(Game.spawns)[0]
  if (spawn && !spawn.spawning && Object.keys(Game.creeps).length < 2 && spawn.store.energy >= BODY_COST) {
    spawn.spawnCreep(BODY, 'r' + Game.time)
  }

  const target = pickTargetRoom()
  for (const creep of Object.values(Game.creeps)) {
    if (target && creep.room.name !== target) {
      // 跨房：走到目标房出口（interRoom 在边界格自动转移）
      const exitPos = exitPosFor(creep, target)
      if (exitPos) creep.moveTo(exitPos)
      continue
    }
    // 已在目标房（或无可达目标）：攻击敌对目标——优先拆结构（spawn 是歼灭目标），再打 creep
    // 注意：controller 也是 structure 且 findClosestByPath 会选中它，但 attack(controller) 恒为
    // ERR_INVALID_TARGET——controller 恰好路径更近时 raider 会永久卡在旁边空挥（2026-09-09 run4
    // 实锤：两 creep 卡 (37,22) 紧贴敌方 controller(37,23)，180s 零进展）。必须显式剔除 controller。
    const structs = (creep.room.find(FIND_HOSTILE_STRUCTURES) || []).filter(
      o => o.structureType !== STRUCTURE_CONTROLLER,
    )
    const enemy =
      creep.pos.findClosestByPath(structs) ||
      creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS)
    if (enemy) {
      if (creep.pos.isNearTo(enemy)) {
        creep.attack(enemy)
      } else {
        creep.moveTo(enemy)
      }
    }
  }
}