/**
 * 前后端共享 DTO（plan-M1 风险表：契约漂移防线——投影/DTO 同源引用）。
 * matchView（routes.ts）与前端组件都从这里取形状。
 */
export interface MatchPlayerView {
  seatId: string
  username: string
  ready: boolean
  hasCode: boolean
  autoReady: { round: number; reason: string } | null
}

export interface MatchView {
  id: string
  phase: 'creating' | 'running' | 'roundBreak' | 'settled'
  roundIndex: number
  config: {
    seats: number
    roundMs: number
    roundBreakTimeoutMs: number
    maxRounds: number
    form: 'world' | 'arena'
    maxTicks: number
  }
  players: Array<{
    seatId: string
    username: string
    ready: boolean
    hasCode: boolean
    autoReady: { round: number; reason: string } | null
    /** 真实私服用户名（agent_<slug>；人类旁观 UI 对齐 /api/world 用，Agent 可见面不含）。 */
    screepsUsername: string | null
  }>
  errors: string[]
  settledAt: number | null
  settleReason: string | null
  winner: { kind: 'seat'; seatId: string } | { kind: 'draw' } | null
  scores: Record<string, number> | null
}

export interface WorldSnapshot {
  ok: boolean
  gameTime: number
  users: Array<{
    id: string
    username: string
    isBot: boolean
    cpu: number
    gcl: number
    ownedRooms: number
    rclTotal: number
    spawns: number
    creeps?: number
    rooms: Array<{ room: string; level: number; progress: number; spawns?: Array<{ x: number; y: number }> }>
  }>
}

/** 地形位域串解码（索引 y*50+x；bit1=wall bit2=swamp）。 */
export function terrainBitAt(terrain: string, x: number, y: number): { wall: boolean; swamp: boolean } {
  const c = terrain.charCodeAt(y * 50 + x) - 48
  return { wall: (c & 1) === 1, swamp: (c & 2) === 2 }
}
