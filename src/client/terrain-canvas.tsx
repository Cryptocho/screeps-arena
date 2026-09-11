/**
 * 地图 canvas（M1/S5）——terrain 位域渲染 + 归属色投影。
 * 投影纯函数（terrainColor）单测钉住；canvas 绘制在组件内。
 */
import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { terrainBitAt } from '../shared/types.js'
import type { WorldSnapshot } from '../shared/types.js'

/** 归属色投影（纯函数，单测锚点）：己方房间底色按用户 hash 取色。 */
export function terrainColor(
  wall: boolean,
  ownerColor: string | null,
): string {
  if (wall) return '#2a2a35'
  return ownerColor ?? '#3d5a3d'
}

/** 简单稳定 hash → HSL 色（同房同色）。 */
export function ownerColor(username: string): string {
  let h = 0
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) | 0
  return `hsl(${((h % 360) + 360) % 360} 55% 45%)`
}

export interface TerrainCanvasProps {
  terrain: Record<string, string>
  rooms: string[]
  world: WorldSnapshot | null
  /** 每房像素尺寸（默认 150 = 3px/格）。 */
  cellPx?: number
}

export function TerrainCanvas({ terrain, rooms, world, cellPx = 3 }: TerrainCanvasProps) {
  const ref = { current: null as HTMLCanvasElement | null }
  const canvasRef = (node: HTMLCanvasElement | null) => {
    ref.current = node
  }
  // 绘制在 layout 后（useEffect）
  useDraw(ref, terrain, rooms, world, cellPx)
  const cols = Math.min(rooms.length, 4)
  const w = cols * 50 * cellPx
  const h = Math.ceil(rooms.length / cols) * 50 * cellPx
  return <canvas ref={canvasRef} width={w} height={h} data-testid="terrain-canvas" />
}

function useDraw(
  ref: { current: HTMLCanvasElement | null },
  terrain: Record<string, string>,
  rooms: string[],
  world: WorldSnapshot | null,
  cellPx: number,
): void {
  Promise.resolve().then(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#11131a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    rooms.forEach((room, idx) => {
      const t = terrain[room]
      if (!t) return
      const ox = (idx % 4) * 50 * cellPx
      const oy = Math.floor(idx / 4) * 50 * cellPx
      // 房间归属（controller 在该房的用户）
      const owner = world?.users.find((u) => u.rooms.some((r) => r.room === room))
      const color = owner ? ownerColor(owner.username) : null
      for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
          const bit = terrainBitAt(t, x, y)
          ctx.fillStyle = terrainColor(bit.wall, color)
          ctx.fillRect(ox + x * cellPx, oy + y * cellPx, cellPx, cellPx)
        }
      }
      // spawn 标记
      const roomEntry = owner?.rooms.find((r) => r.room === room)
      for (const s of roomEntry?.spawns ?? []) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(ox + s.x * cellPx - 1, oy + s.y * cellPx - 1, cellPx + 2, cellPx + 2)
      }
    })
  })
}
