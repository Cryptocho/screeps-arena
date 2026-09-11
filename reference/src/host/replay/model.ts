/**
 * 公开回放存储模型（M4-B.3）—— ReplayRecord/ReplayMeta 类型、replayMetaHash、reader 页。
 *
 * record 形状与 arena-mod canonical bridge 逐字段一致（schemaVersion=1，plan §5.2/§5.3）：
 *   frame: { schemaVersion, sourceGeneration, replayId, seq, kind:'frame', gameTime, frame: PublicReplayFrame }
 *   gap:   { schemaVersion, sourceGeneration, replayId, seq, kind:'gap', fromTick, toTick, reason }
 *
 * meta.json 字段集固定为 replayMetaHash 所需集合（§5.3）：{schemaVersion, replayId,
 * sourceGeneration, matchId, participantSnapshot, status, recordCount, firstSeq, lastSeq,
 * gapReasons} —— replay marker 的 receipt payloadHash 即 replayMetaHash（§3.2 Marker 矩阵，
 * 不接受 Matrix 行内另一份字段集）。
 *
 * participantSnapshot 是结算/起播时固定的公开投影（participantId/displayName，无 session）。
 */
import { hashV1 } from '../canonical.ts'

export const REPLAY_SCHEMA_VERSION = 1

export interface PublicReplayFrameObject {
  kind: 'controller' | 'spawn' | 'creep' | 'tower' | 'constructionSite'
  x: number
  y: number
  username?: string
  level?: number
  hitsBucket?: number
}

export interface PublicReplayFrameRoom {
  room: string
  status: string
  novice?: boolean
  respawnArea?: boolean
  openTime?: number
  safeMode?: boolean
  own?: { username: string; level: number } | null
  publicObjects: PublicReplayFrameObject[]
}

export interface PublicReplayFrame {
  sourceGeneration: string
  replayId: string
  seq: number
  gameTime: number
  rooms: PublicReplayFrameRoom[]
  events: Array<{
    kind: 'attack' | 'destroyed' | 'heal' | 'upgrade' | 'other'
    room: string
    actorUsername?: string
    targetUsername?: string
  }>
  gap?: { fromTick: number; toTick: number; reason: 'busy' | 'backpressure' | 'ring-overflow' | 'restart' | 'reset' }
}

export type ReplayGapReason = 'busy' | 'backpressure' | 'ring-overflow' | 'restart' | 'reset'

export type ReplayRecord =
  | {
      schemaVersion: 1
      sourceGeneration: string
      replayId: string
      seq: number
      kind: 'frame'
      gameTime: number
      frame: PublicReplayFrame
    }
  | {
      schemaVersion: 1
      sourceGeneration: string
      replayId: string
      seq: number
      kind: 'gap'
      fromTick: number
      toTick: number
      reason: ReplayGapReason
    }

/** meta.json 内容（= replayMetaHash 的 canonical 源）。 */
export interface ReplayMeta {
  schemaVersion: 1
  replayId: string
  sourceGeneration: string
  matchId: string
  participantSnapshot: Array<{ participantId: string; displayName: string }>
  status: 'complete' | 'partial'
  recordCount: number
  firstSeq: number
  lastSeq: number
  gapReasons: ReplayGapReason[]
}

export interface ReplayBatchManifest {
  batchId: string
  schemaVersion: 1
  sourceGeneration: string
  replayId: string
  firstSeq: number
  lastSeq: number
  recordCount: number
  /** hashV1(该批 records 数组) —— recovery 校验帧行完整性的依据。 */
  payloadHash: string
}

/** checkpoint.json —— 唯一可见水位。 */
export interface ReplayCheckpoint {
  lastPersistedSeq: number
  replayId?: string
  sourceGeneration?: string
}

/**
 * replayMetaHash（plan §3.2 receipt hash 权威定义）：字段集固定为
 * {replayId, sourceGeneration, schemaVersion, matchId, participantSnapshot,
 *  status, recordCount, firstSeq, lastSeq, gapReasons}。
 */
export function toReplayMetaHash(meta: ReplayMeta): string {
  return hashV1({
    replayId: meta.replayId,
    sourceGeneration: meta.sourceGeneration,
    schemaVersion: meta.schemaVersion,
    matchId: meta.matchId,
    participantSnapshot: meta.participantSnapshot,
    status: meta.status,
    recordCount: meta.recordCount,
    firstSeq: meta.firstSeq,
    lastSeq: meta.lastSeq,
    gapReasons: meta.gapReasons,
  })
}
