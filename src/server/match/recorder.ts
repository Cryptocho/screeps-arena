/**
 * 回放记录器（M6/S2，plan-M6 D1/D2）——append-only JSONL，崩溃最多丢最后一行。
 *
 * 记录面：meta / idmap / mark / frame / end（v:1 版本化，读端未知 kind 跳过）。
 * 记录器本身**不节流、不取数**：采样节拍与取数在 main.ts 注入函数内（D1 v3），
 * 记录器只做「过滤 → 归一 → 落行」：
 *   - 混跑过滤：eventLog ring 全服共享，只收「事件所在键 ∈ 本局房间集合」的战斗事件
 *     （v3：键即房名，无需映射）；
 *   - kill 归因：复用 KillLedger 明细（单飞消费点，R5），(tick,objectId) 去重（防御）；
 *   - type 归一：objectInfo 缺失 → 'unknown'（写端恒有值，前端按 'unknown' 画通用图标）。
 *
 * 位置采样的软上限（D2）：文件超 softLimitBytes 后位置降频 ×4，再超继续 ×4；kills/scores
 * 永不降；首次降级写一条 'samplingThrottled' mark（D2 措辞：记一次）。
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import * as path from 'node:path'
import type { ArenaEvent, EventTick } from './attribution.js'
import type { KillDetail } from './arena-observe.js'
import type { MatchConfig, MatchForm, SettleReason, WinnerRef } from './model.js'
import type { SeatScoreInput } from './score.js'
import type { ReplayKillView, ReplayObjectView } from '../../shared/types.js'

/** 帧内对象/击杀行（DTO 与前端同源；见 shared/types.ts）。 */
export type ReplayObject = ReplayObjectView
export type ReplayKill = ReplayKillView

export type ReplayMarkType =
  | 'started'
  | 'roundBreak'
  | 'resume'
  | 'settled'
  | 'recovered'
  | 'samplingThrottled'
  | 'eventRingSaturated'

export interface ReplayMark {
  at: number
  type: ReplayMarkType
  round?: number
  reason?: SettleReason
  winner?: WinnerRef
  scores?: Record<string, number>
  ringCapacity?: number
  lastEventTick?: number
  factor?: number
}

export interface MatchRecorderOptions {
  /** replays 目录（dataDir/replays）。 */
  dir: string
  matchId: string
  form: MatchForm
  config: MatchConfig
  players: Array<{ seatId: string; username: string }>
  /** 本局房间集合（arena = 镜像双房；world = 房间池分配）。 */
  rooms: string[]
  createdAt: number
  /** journal 恢复局：文件已存在则续写；不存在则补 meta + 'recovered' mark（D3）。 */
  recovered?: boolean
  /** 位置采样软上限（字节，默认 32MB）。 */
  softLimitBytes?: number
}

/** 单拍写入输入（main.ts 在采样点/事件点调用）。 */
export interface RecordTickInput {
  gameTime: number
  round: number
  /** eventLog 增量（含键=房名 + enrich 字段）。 */
  enrichedEvents: EventTick[]
  /** KillLedger 同拍明细（唯一消费点的返回值）。 */
  details: KillDetail[]
  /** 计分快照（seatId → 计数）。 */
  scores: Record<string, SeatScoreInput>
  /** seatId → Screeps userId（本拍解析结果；kill 显示名反查 + idmap 惰性补写）。 */
  userIds: Record<string, string | null>
  /** 位置采样（仅采样拍传；缺席 = kills-only 帧）。 */
  positions?: Record<string, ReplayObject[]>
}

export class MatchRecorder {
  readonly file: string
  /** idmap 是否已落（惰性补写只写一次；end 时兜底补部分映射）。 */
  private idmapWritten = false
  private readonly players: Array<{ seatId: string; username: string }>
  private readonly rooms: Set<string>
  private readonly softLimitBytes: number
  /** 当前降级门槛（首次 = softLimitBytes；每次降级 ×4——阶梯式，不逐帧重复降）。 */
  private limitGate: number
  /** 位置降频因子（1 = 不降；超软上限后 4、16、…）。 */
  private degradeFactor = 1
  private sampleCount = 0
  private readonly seenKills = new Set<string>()

  constructor(private readonly opts: MatchRecorderOptions) {
    this.players = opts.players
    this.rooms = new Set(opts.rooms)
    this.softLimitBytes = opts.softLimitBytes ?? 32 * 1024 * 1024
    this.limitGate = this.softLimitBytes
    mkdirSync(opts.dir, { recursive: true })
    this.file = path.join(opts.dir, `${opts.matchId}.jsonl`)
    const resume = opts.recovered === true && existsSync(this.file)
    if (!resume) {
      this.append({
        kind: 'meta',
        v: 1,
        matchId: opts.matchId,
        form: opts.form,
        config: opts.config,
        players: opts.players.map((p) => ({ seatId: p.seatId, username: p.username, screepsUsername: null })),
        rooms: opts.rooms,
        createdAt: opts.createdAt,
      })
    }
    if (opts.recovered) this.append({ kind: 'mark', at: Date.now(), type: 'recovered' })
  }

  /** 惰性补写 idmap：首个「全员可解析」的拍写一次（D1 v3；建局瞬间无映射可查）。 */
  noteIdmap(userIds: Record<string, string | null>): void {
    if (this.idmapWritten) return
    const map: Record<string, string> = {}
    for (const p of this.players) {
      const id = userIds[p.seatId]
      if (!id) return // 任一席位未绑定 → 等下一拍
      map[p.seatId] = id
    }
    this.idmapWritten = true
    this.append({ kind: 'idmap', map, at: Date.now() })
  }

  /** 落一帧（kills/scores 永不降频；positions 按软上限降频）。 */
  recordTick(input: RecordTickInput): void {
    // idmap 先于本拍帧落（惰性：首个全员可解析的拍；之后不再写）
    this.noteIdmap(input.userIds)
    const frame: Record<string, unknown> = {
      kind: 'frame',
      gameTime: input.gameTime,
      round: input.round,
      scores: input.scores,
      kills: this.collectKills(input),
    }
    if (input.positions) {
      this.sampleCount += 1
      if (this.sampleCount % this.degradeFactor === 0) frame.positions = input.positions
    }
    this.append(frame)
    this.enforceSoftLimit()
  }

  /** mark 行（started/roundBreak/resume/settled/recovered/samplingThrottled/eventRingSaturated）。 */
  mark(m: ReplayMark): void {
    this.append({ kind: 'mark', ...m })
  }

  /** end 行（settle 后一次；Map 清理由调用方负责）。 */
  end(input: {
    settledAt: number
    settleReason: SettleReason
    winner: WinnerRef
    scores: Record<string, number>
    ledger: Record<string, { kills: number; losses: number; decayLosses: number }>
    userIds?: Record<string, string | null>
  }): void {
    // 兜底：全程未能全员解析（竞标赛/无 provider 观测局）→ 落部分映射，能显示多少算多少
    if (!this.idmapWritten && input.userIds) {
      const map: Record<string, string> = {}
      for (const p of this.players) {
        const id = input.userIds[p.seatId]
        if (id) map[p.seatId] = id
      }
      if (Object.keys(map).length > 0) {
        this.idmapWritten = true
        this.append({ kind: 'idmap', map, at: Date.now() })
      }
    }
    this.append({
      kind: 'end',
      settledAt: input.settledAt,
      settleReason: input.settleReason,
      winner: input.winner,
      scores: input.scores,
      ledger: input.ledger,
    })
  }

  /**
   * 战斗事件 → frame.kills（本局房间过滤 + (tick,objectId) 去重 + type 归一）。
   * room 只能来自「事件所在键」（明细不含 room，plan-M6 D1 v4 入参钉死）。
   */
  private collectKills(input: RecordTickInput): ReplayKill[] {
    const eventByKey = new Map<string, { room: string; ev: ArenaEvent }>()
    for (const tick of input.enrichedEvents) {
      for (const [room, list] of Object.entries(tick.eventsByRoom ?? {})) {
        if (!this.rooms.has(room)) continue // 混跑过滤：他局房间的战斗不进本局时间线
        for (const ev of list) {
          if (ev.event !== 2 || typeof ev.objectId !== 'string') continue
          eventByKey.set(`${tick.tick}:${ev.objectId}`, { room, ev })
        }
      }
    }
    const seatByUserId = new Map<string, string>()
    for (const p of this.players) {
      const id = input.userIds[p.seatId]
      if (id) seatByUserId.set(id, p.seatId)
    }
    const out: ReplayKill[] = []
    for (const d of input.details) {
      if (d.objectId === null) continue
      const key = `${d.tick}:${d.objectId}`
      if (this.seenKills.has(key)) continue // 防御（游标改单调序号/饱和重置时的兜底）
      const hit = eventByKey.get(key)
      if (!hit) continue // 他局事件（明细拍平了全服 ring）
      this.seenKills.add(key)
      const info = hit.ev.objectInfo
      const ownerId = d.attribution.ownerUserId
      const killerId = d.attribution.killerUserId
      const kill: ReplayKill = {
        tick: d.tick,
        killer: killerId ? seatByUserId.get(killerId) ?? killerId : null,
        owner: ownerId ? seatByUserId.get(ownerId) ?? ownerId : null,
        type: info?.type ?? 'unknown',
        room: hit.room,
      }
      if (info) {
        kill.x = info.x
        kill.y = info.y
      }
      out.push(kill)
    }
    return out
  }

  /** 软上限：首次越界把位置降频 ×4 并记 mark；越过新门槛再 ×4（不再重复 mark，D2）。 */
  private enforceSoftLimit(): void {
    if (statSync(this.file).size <= this.limitGate) return
    const first = this.degradeFactor === 1
    this.degradeFactor *= 4
    this.limitGate *= 4
    if (first) this.mark({ at: Date.now(), type: 'samplingThrottled', factor: this.degradeFactor })
  }

  private append(line: Record<string, unknown>): void {
    appendFileSync(this.file, `${JSON.stringify(line)}\n`)
  }
}
