/**
 * 地图投影纯函数单测（S12 F 步 + M6 坐标地图）：归属色 + RCL 标签 + 世界范围 +
 * 带符号世界坐标 + 地形位域解码（含 3=墙+沼泽同格）。
 * node lane 直接打表（纯函数，无 DOM）。
 */
import { describe, expect, it } from 'vitest'
import { projectRooms, parseRoomName, worldBounds, ownerColor, roomWorldXY, terrainCell, terrainColors, TERRAIN_PALETTE } from './projection.ts'

describe('projectRooms（归属色网格投影）', () => {
  it('maps rooms to colored cells with RCL label', () => {
    const cells = projectRooms({
      users: [
        { username: 'bot_a', rooms: [{ room: 'W45N74', level: 3, progress: 100 }] },
        { username: 'bot_b', rooms: [{ room: 'W68N70', level: 1, progress: 0 }] },
      ],
    })
    expect(cells).toHaveLength(2)
    const [cellA, cellB] = cells
    expect(cellA).toMatchObject({ x: 45, y: 74, room: 'W45N74', label: '3', owner: 'bot_a' })
    expect(cellB).toMatchObject({ x: 68, y: 70, room: 'W68N70', label: '1', owner: 'bot_b' })
    // 不同玩家不同色
    expect(cellA.color).not.toBe(cellB.color)
  })

  it('omits users with no rooms and handles empty input', () => {
    expect(projectRooms({ users: [{ username: 'x', rooms: [] }] })).toEqual([])
    expect(projectRooms({ users: [] })).toEqual([])
  })

  it('parses room names across all quadrants', () => {
    expect(parseRoomName('E5S3')).toEqual({ x: 5, y: 3 })
    expect(parseRoomName('W10N20')).toEqual({ x: 10, y: 20 })
  })

  it('computes world bounds from cells', () => {
    const cells = projectRooms({
      users: [
        { username: 'a', rooms: [{ room: 'W45N74', level: 1, progress: 0 }] },
        { username: 'b', rooms: [{ room: 'W68N70', level: 1, progress: 0 }] },
      ],
    })
    const bounds = worldBounds(cells)
    expect(bounds).toEqual({ minX: 45, minY: 70, maxX: 68, maxY: 74 })
    expect(worldBounds([])).toBeUndefined()
  })

  it('stable owner color (same user, same color)', () => {
    expect(ownerColor('bot_a')).toBe(ownerColor('bot_a'))
    expect(ownerColor('bot_a')).not.toBe(ownerColor('bot_b'))
  })

  it('carries per-room spawns from the world snapshot (M6)', () => {
    const cells = projectRooms({
      users: [{ username: 'bot_a', rooms: [{ room: 'W15N15', level: 1, progress: 0, spawns: [{ x: 25, y: 25 }] }] }],
    })
    expect(cells[0]!.spawns).toEqual([{ x: 25, y: 25 }])
    // 无 spawns 字段（外部旧 server）→ 缺省（降级不画标记）
    const bare = projectRooms({ users: [{ username: 'bot_a', rooms: [{ room: 'W15N15', level: 1, progress: 0 }] }] })
    expect(bare[0]!.spawns).toBeUndefined()
  })
})

describe('roomWorldXY（带符号世界坐标，M6）', () => {
  it('E positive / W negative; S positive / N negative (north on top)', () => {
    expect(roomWorldXY('W45N74')).toEqual({ x: -45, y: -74 })
    expect(roomWorldXY('E5S3')).toEqual({ x: 5, y: 3 })
    expect(roomWorldXY('E10N20')).toEqual({ x: 10, y: -20 })
    expect(roomWorldXY('W1S1')).toEqual({ x: -1, y: 1 })
    expect(roomWorldXY('bogus')).toEqual({ x: 0, y: 0 })
  })
})

describe('terrainCell / terrainColors（位域解码，M6）', () => {
  it('decodes bit fields: bit1=wall, bit2=swamp, 3=both (wall wins)', () => {
    expect(terrainCell('0')).toEqual({ wall: false, swamp: false })
    expect(terrainCell('1')).toEqual({ wall: true, swamp: false })
    expect(terrainCell('2')).toEqual({ wall: false, swamp: true })
    expect(terrainCell('3')).toEqual({ wall: true, swamp: true })
  })

  it('terrainColors: 2500 cells with wall priority; bad strings degrade to empty', () => {
    const wall = '1'.repeat(2500)
    expect(terrainColors(wall)).toEqual(new Array(2500).fill(TERRAIN_PALETTE.wall))
    const mixed = ('0'.repeat(2499) + '3').split('')
    const colors = terrainColors(mixed.join(''))
    expect(colors[2499]).toBe(TERRAIN_PALETTE.wall) // 3 → wall 优先
    expect(colors[0]).toBe(TERRAIN_PALETTE.plain)
    // 全沼泽
    expect(new Set(terrainColors('2'.repeat(2500)))).toEqual(new Set([TERRAIN_PALETTE.swamp]))
    // 坏串降级
    expect(terrainColors(undefined)).toEqual([])
    expect(terrainColors('1'.repeat(2499))).toEqual([])
    expect(terrainColors('')).toEqual([])
  })
})