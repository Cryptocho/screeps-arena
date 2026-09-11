/**
 * 地图投影纯函数（S12 F 步）：世界房间网格 → 格子颜色/标签。
 *
 * 输入来自 host 的 `GET /dsh-screeps/world`（ScreepsWorldSnapshot.users[].rooms），
 * 只画归属色 + RCL 数字，不画地形/spawn 坐标（数据源缺，M2 地图增强）。
 * 纯函数：同一输入恒同一输出，直接单测打表。
 */

export interface WorldRoom {
  room: string
  level: number
  progress: number
  /** M6：房内 spawn 坐标（world 快照透传；外部旧版 server 缺 → 降级不画标记）。 */
  spawns?: Array<{ x: number; y: number }>
}

export interface GridCell {
  /** 世界坐标 x（room 名的横坐标，如 W45N74 → x=45 西向记负由调用方处理）。 */
  x: number
  y: number
  /** 归属色（CSS 色值；无归属为中性色）。 */
  color: string
  /** 格子标签：RCL 数字或空。 */
  label: string
  /** 房间名。 */
  room: string
  /** 归属用户名（无则 undefined）。 */
  owner?: string
  /** M6：房内 spawn 坐标（透传；缺省不画标记）。 */
  spawns?: Array<{ x: number; y: number }>
}

/** 房间名 "W45N74" → {x: 45, y: 74}（E/W 记正负由外部决定；这里返回原始坐标）。 */
export function parseRoomName(room: string): { x: number; y: number } {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(room)
  if (!m) return { x: 0, y: 0 }
  const x = Number(m[2])
  const y = Number(m[4])
  return { x, y }
}

/** 稳定归属色：用户名 → 色（可复现，供多用户区分）。 */
export function ownerColor(owner: string | undefined): string {
  if (!owner) return '#3a3f4a'
  let hash = 0
  for (let i = 0; i < owner.length; i++) {
    hash = (hash * 31 + owner.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 60% 45%)`
}

export interface WorldGridInput {
  /** 玩家列表：username + 其房间（world 快照 users[].rooms）。 */
  users: Array<{ username: string; rooms: WorldRoom[] }>
}

/**
 * 世界房间 → 格子数组（归属色 + RCL 标签）。同一玩家多房合并，无房玩家不产生格子。
 * M6：携带房内 spawns（原字段不变，旧调用零破坏）。
 */
export function projectRooms(input: WorldGridInput): GridCell[] {
  const cells: GridCell[] = []
  for (const user of input.users) {
    const color = ownerColor(user.username)
    for (const room of user.rooms) {
      const { x, y } = parseRoomName(room.room)
      cells.push({
        x,
        y,
        color,
        label: String(room.level),
        room: room.room,
        owner: user.username,
        ...(room.spawns !== undefined ? { spawns: room.spawns } : {}),
      })
    }
  }
  return cells
}

/** 世界范围：cells 的 x/y 包围盒（无格子返回空）。用于 canvas 视口缩放。 */
export function worldBounds(cells: GridCell[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (cells.length === 0) return undefined
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of cells) {
    if (c.x < minX) minX = c.x
    if (c.y < minY) minY = c.y
    if (c.x > maxX) maxX = c.x
    if (c.y > maxY) maxY = c.y
  }
  return { minX, minY, maxX, maxY }
}

/* ------------------------------ M6：坐标地图投影（复活/新增纯函数） ------------------------------ */

/**
 * 房间名 → 带符号世界坐标：E 正 W 负（东为 +x）；S 正 N 负（屏幕 y 向下，北在上）。
 * 例：W45N74 → {x: -45, y: -74}；E5S3 → {x: 5, y: 3}。
 */
export function roomWorldXY(room: string): { x: number; y: number } {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(room)
  if (!m) return { x: 0, y: 0 }
  const x = (m[1] === 'E' ? 1 : -1) * Number(m[2])
  const y = (m[3] === 'S' ? 1 : -1) * Number(m[4])
  return { x, y }
}

/**
 * 地形位域字符 → {wall, swamp}（reference/screeps/common/index.js encodeTerrain：
 * bit1=wall、bit2=swamp，**3=墙+沼泽同格合法**——渲染 wall 优先）。
 */
export function terrainCell(ch: string): { wall: boolean; swamp: boolean } {
  const code = Number(ch)
  return { wall: (code & 1) === 1, swamp: (code & 2) === 2 }
}

export const TERRAIN_PALETTE = {
  wall: '#1b1e24',
  swamp: '#24404a',
  plain: 'transparent',
} as const

/**
 * 地形串（2500 字符，索引 y*50+x）→ 2500 色数组（wall 优先）。
 * 坏串（缺串/长度≠2500）→ 空数组 = 调用方降级为纯归属色块（地图永不白屏）。
 */
export function terrainColors(terrain: string | undefined): string[] {
  if (!terrain || terrain.length !== 2500) return []
  const out: string[] = new Array(2500)
  for (let i = 0; i < 2500; i++) {
    const { wall, swamp } = terrainCell(terrain[i]!)
    out[i] = wall ? TERRAIN_PALETTE.wall : swamp ? TERRAIN_PALETTE.swamp : TERRAIN_PALETTE.plain
  }
  return out
}