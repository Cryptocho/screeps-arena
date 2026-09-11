/**
 * S5 前端投影纯函数单测（plan-M1 §4）——terrain 解码/归属色/terrainColor。
 */
import { describe, expect, it } from 'vitest'
import { terrainBitAt } from '../src/shared/types.js'
import { ownerColor, terrainColor } from '../src/client/terrain-canvas.js'

describe('前端投影纯函数（S5）', () => {
  it('terrainBitAt：bit1=wall bit2=swamp（索引 y*50+x）', () => {
    const t = '0'.repeat(2500)
    expect(terrainBitAt(t, 0, 0)).toEqual({ wall: false, swamp: false })
    // 手工构造：x=3,y=2 → 索引 103；'3' = wall+swamp
    const arr = '0'.repeat(2500).split('')
    arr[103] = '3'
    expect(terrainBitAt(arr.join(''), 3, 2)).toEqual({ wall: true, swamp: true })
    arr[103] = '1'
    expect(terrainBitAt(arr.join(''), 3, 2)).toEqual({ wall: true, swamp: false })
    arr[103] = '2'
    expect(terrainBitAt(arr.join(''), 3, 2)).toEqual({ wall: false, swamp: true })
  })

  it('terrainColor：墙恒深色；非墙按归属色/默认草色', () => {
    expect(terrainColor(true, '#ff0000')).toBe('#2a2a35')
    expect(terrainColor(false, null)).toBe('#3d5a3d')
    expect(terrainColor(false, '#123456')).toBe('#123456')
  })

  it('ownerColor：稳定 hash → 同名同色、异名大概率异色', () => {
    expect(ownerColor('alice')).toBe(ownerColor('alice'))
    expect(ownerColor('alice')).not.toBe(ownerColor('bob'))
    expect(ownerColor('x')).toMatch(/^hsl\(\d+ 55% 45%\)$/)
  })
})
