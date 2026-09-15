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

/* ---------------- M6 回放/战报 DTO（前后端同源；recorder/ReplayStore 与前端共用） ---------------- */

/** 回放帧里的一个对象（roomObjects 投影；user 是 Screeps userId，name 是引擎对象名）。 */
export interface ReplayObjectView {
  type: string
  x: number
  y: number
  user: string | null
  name: string | null
  hits: number | null
}

/** frame.kills 条目（killer/owner 已反查 seatId，反查不到时落原始 userId；room = 事件所在键）。 */
export interface ReplayKillView {
  tick: number
  killer: string | null
  owner: string | null
  /** objectInfo.type；缺失归一 'unknown'。 */
  type: string
  room: string
  x?: number
  y?: number
}

export interface ReplayScoreView {
  spawns?: number
  creeps?: number
  rooms?: number
  rclTotal?: number
}

export interface ReplayFrameView {
  gameTime: number
  round: number
  scores: Record<string, ReplayScoreView>
  kills: ReplayKillView[]
  positions?: Record<string, ReplayObjectView[]>
}

export interface ReplayMetaView {
  matchId: string
  form: string
  config: unknown
  players: Array<{ seatId: string; username: string; screepsUsername: string | null }>
  rooms: string[]
  createdAt: number
}

export interface ReplaySettleView {
  settledAt: number
  settleReason: string
  winner: unknown
  scores: Record<string, number>
  ledger: Record<string, { kills: number; losses: number; decayLosses: number }>
}

export interface ReplaySummaryView {
  players: Array<{ seatId: string; username: string; screepsUsername: string | null; screepsUserId: string | null }>
  rooms: string[]
  form: string
  config: unknown
  settle: ReplaySettleView | null
  killTimeline: ReplayKillView[]
  scoreCurve: Array<{ gameTime: number; round: number; scores: Record<string, ReplayScoreView> }>
  totals: Record<string, { kills: number; losses: number; decayLosses: number }>
  /** 无 end 行（running 期正常态）。 */
  partial: boolean
  /** 重启恢复（数据不完整角标）。 */
  incompleteAfterRestart?: boolean
  /** ring 饱和 → 事件停投（角标 + 缺口定位）。 */
  eventsIncomplete?: { ringCapacity?: number; lastEventTick?: number; at: number }
  frames: number
}

export interface ReplayView {
  meta: ReplayMetaView
  summary: ReplaySummaryView
  frames?: ReplayFrameView[]
}
