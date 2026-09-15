/**
 * 回放查询面（M6/S3，plan-M6 D4）——文件 IO + 解析 + 缓存，独立于 routes（routes 保持纯打表）。
 *
 * 语义：
 *   - append-only JSONL 读端：残行/未知 kind 跳过（前向兼容 v:1；history.ts 读端同款自愈）；
 *   - 缓存 entry = {size, mtimeMs, data}：请求时 stat，size/mtime 任一变化即重读——
 *     running 局每秒追 naturally 失效，settled 局自然稳定，无需失效策略分支；LRU 上限 4；
 *   - 404 语义：无文件 / 空文件 / meta 行损坏 → undefined（前端据此禁用「战报」入口）；
 *     文件存在但无 end 行**不是** 404 → partial:true（running 局正常态）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import type { ReplayFrameView, ReplayKillView, ReplayMetaView, ReplayObjectView, ReplayScoreView, ReplaySummaryView, ReplayView } from '../../shared/types.js'

/** 查询面 DTO 与前端同源（shared/types.ts）；服务端仅多内部解析行类型。 */
export type ReplayMeta = ReplayMetaView
export type ReplayFrame = ReplayFrameView
export type ReplaySummary = ReplaySummaryView
export type { ReplayView }
export type ReplayObject = ReplayObjectView
export type ReplayKill = ReplayKillView
export type ReplayScore = ReplayScoreView

interface ReplayEnd {
  settledAt: number
  settleReason: string
  winner: unknown
  scores: Record<string, number>
  ledger: Record<string, { kills: number; losses: number; decayLosses: number }>
}

interface ReplayMark {
  at: number
  type: string
  round?: number
  ringCapacity?: number
  lastEventTick?: number
  factor?: number
}

interface ParsedReplay {
  meta: ReplayMeta
  frames: ReplayFrame[]
  end: ReplayEnd | null
  idmap: Record<string, string>
  marks: ReplayMark[]
}

const LRU_MAX = 4

export class ReplayStore {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; data: ParsedReplay }>()

  constructor(private readonly dir: string) {}

  /** 查询单局；undefined = 404（无文件/空文件/坏 meta）。 */
  get(matchId: string, opts: { from?: number; to?: number; frames?: boolean } = {}): ReplayView | undefined {
    const data = this.load(matchId)
    if (!data) return undefined
    const view: ReplayView = { meta: data.meta, summary: this.summarize(data) }
    if (opts.frames !== false) {
      let frames = data.frames
      if (opts.from !== undefined) frames = frames.filter((f) => f.gameTime >= opts.from!)
      if (opts.to !== undefined) frames = frames.filter((f) => f.gameTime <= opts.to!)
      view.frames = frames
    }
    return view
  }

  /** 有回放文件（前端「战报」入口可用性）。O(1) 存在性判定——不解析（history 逐行调用，
   *  整读整解析会在每 5s 轮询里放大到 N×文件体积）；空文件（崩在首行前）判不可用，
   *  与 get() 的 404 一致；坏 meta 极罕见（append-only 不改首行）由 report 页兜底提示。 */
  has(matchId: string): boolean {
    if (!/^[A-Za-z0-9_-]+$/.test(matchId)) return false
    const file = path.join(this.dir, `${matchId}.jsonl`)
    return existsSync(file) && statSync(file).size > 0
  }

  /** stat + 缓存（size/mtime 变化重读；LRU 上限 4）。 */
  private load(matchId: string): ParsedReplay | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(matchId)) return undefined
    const file = path.join(this.dir, `${matchId}.jsonl`)
    if (!existsSync(file)) return undefined
    const st = statSync(file)
    const hit = this.cache.get(matchId)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      this.cache.delete(matchId)
      this.cache.set(matchId, hit) // LRU touch
      return hit.data
    }
    const data = parseReplay(readFileSync(file, 'utf8'))
    if (!data) return undefined
    this.cache.delete(matchId)
    this.cache.set(matchId, { size: st.size, mtimeMs: st.mtimeMs, data })
    if (this.cache.size > LRU_MAX) this.cache.delete(this.cache.keys().next().value!)
    return data
  }

  private summarize(data: ParsedReplay): ReplaySummary {
    const killTimeline = data.frames.flatMap((f) => f.kills)
    const totals: ReplaySummary['totals'] = {}
    for (const p of data.meta.players) totals[p.seatId] = { kills: 0, losses: 0, decayLosses: 0 }
    if (data.end) {
      for (const [seatId, counts] of Object.entries(data.end.ledger)) totals[seatId] = { ...counts }
    } else {
      for (const k of killTimeline) {
        if (k.owner && totals[k.owner]) totals[k.owner]!.losses += k.killer ? 1 : 0
        if (k.owner && !k.killer && totals[k.owner]) totals[k.owner]!.decayLosses += 1
        if (k.killer && totals[k.killer]) totals[k.killer]!.kills += 1
      }
    }
    const recovered = data.marks.some((m) => m.type === 'recovered')
    const saturated = data.marks.find((m) => m.type === 'eventRingSaturated')
    const summary: ReplaySummary = {
      players: data.meta.players.map((p) => ({
        seatId: p.seatId,
        username: p.username,
        screepsUsername: p.screepsUsername,
        screepsUserId: data.idmap[p.seatId] ?? null,
      })),
      rooms: data.meta.rooms,
      form: data.meta.form,
      config: data.meta.config,
      settle: data.end ? { ...data.end } : null,
      killTimeline,
      scoreCurve: data.frames.map((f) => ({ gameTime: f.gameTime, round: f.round, scores: f.scores })),
      totals,
      partial: data.end === null,
      frames: data.frames.length,
    }
    if (recovered) summary.incompleteAfterRestart = true
    if (saturated) {
      summary.eventsIncomplete = {
        ...(saturated.ringCapacity !== undefined ? { ringCapacity: saturated.ringCapacity } : {}),
        ...(saturated.lastEventTick !== undefined ? { lastEventTick: saturated.lastEventTick } : {}),
        at: saturated.at,
      }
    }
    return summary
  }
}

/** JSONL → 结构化（残行/未知 kind 跳过；无合法 meta → undefined = 404）。 */
function parseReplay(raw: string): ParsedReplay | undefined {
  let meta: ReplayMeta | undefined
  const frames: ReplayFrame[] = []
  const marks: ReplayMark[] = []
  const idmap: Record<string, string> = {}
  let end: ReplayEnd | null = null
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // 崩溃残行（读端自愈；history.ts 同款）
    }
    switch (row.kind) {
      case 'meta':
        if (meta === undefined && typeof row.matchId === 'string' && Array.isArray(row.rooms)) {
          meta = row as unknown as ReplayMeta
        }
        break
      case 'idmap':
        Object.assign(idmap, (row.map as Record<string, string> | undefined) ?? {})
        break
      case 'frame':
        frames.push(row as unknown as ReplayFrame)
        break
      case 'mark':
        marks.push(row as unknown as ReplayMark)
        break
      case 'end':
        end = row as unknown as ReplayEnd
        break
      default:
        break // v:1 前向兼容：未知 kind 跳过
    }
  }
  if (!meta) return undefined
  return { meta, frames, end, idmap, marks }
}
