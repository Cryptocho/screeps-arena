/**
 * 真实 ArenaBackend（M1/S3，plan-M1 §3）——实现 M0 的 SeatRegistry + ArenaBackend 接口，
 * 底座 = ScreepsService（S1）。M0 的 MemoryArena 退役为测试装置。
 *
 * 公平边界（AGENTS.md 红线）：
 *   - 映射只存在于 host 侧：bindUser(seatId) 是唯一写入口（room 分配在 opts.rooms，host 注入）；
 *   - report 的 fog-of-war 过滤：visibleRooms(user) = 己方 owned rooms ∪ 己方 creep/建筑
 *     所在房间（Screeps 官方视野规则）；对手动向只报有视野房间内的存在性，不透视
 *     （负向测试锚点，plan-M1 二审采纳）；
 *   - 事件流去重边界（event-stream.md）：mod 侧已做整组去重（roomPrevRaw），本层按 ring
 *     增量拉取（since=下标），不重复消费。
 */
import type { ArenaBackend, SeatRegistry } from '../../agent/tools.js'
import type { ScreepsService } from './service.js'
import { seatSlug } from '../../shared/seat-slug.js'
import { FAIRNESS_THRESHOLD, REROLL_BUDGET, fairnessDeviation, roomDistanceScore } from './fairness.js'

export interface RealArenaOptions {
  /** 每席位初始房间（bindUser 时建号；房间生成在 prepareRooms 批量做）。可由 assignRoom 追加。 */
  rooms: Record<string, string>
  /** 初始代码（createUser 时随建号写入）。 */
  initialCode?: Record<string, string>
  /** CPU 配额（默认 100）。 */
  cpu?: number
  /** 日志回调（公平性重掷告警等）。 */
  log?: (msg: string) => void
}

/** 视野判定（负向测试的断言锚点）：owned rooms ∪ creep/建筑所在房间。 */
export function visibleRooms(
  ownedRooms: string[],
  objects: Array<{ room: string; user?: string | null; type: string }>,
  username: string,
): Set<string> {
  const visible = new Set<string>(ownedRooms)
  for (const o of objects) {
    if (o.user && o.user === username) visible.add(o.room)
  }
  return visible
}

export class RealArena implements SeatRegistry, ArenaBackend {
  private readonly users = new Map<string, string>()
  private readonly consoleCursors = new Map<string, number>()
  /** 事件流增量游标（ring 下标；report 只回增量，对齐 report 工具「deltas only」语义）。 */
  private readonly eventCursors = new Map<string, number>()
  private readonly opts: RealArenaOptions
  private roomsPrepared = false
  private preparePromise: Promise<void> | undefined

  constructor(
    private readonly svc: ScreepsService,
    opts: RealArenaOptions,
  ) {
    this.opts = opts
  }

  /** host 侧房间分配（对局创建时调用；公平性校验在 prepareRooms）。同席位重复分配拒绝。 */
  assignRoom(seatId: string, room: string): void {
    if (seatId in this.opts.rooms) throw new Error(`seat ${seatId}: room already assigned`)
    this.opts.rooms[seatId] = room
  }

  /** 房间坐标 → Σ(source→controller) 距离（缺 controller/source 计 0——生成失败的房必然偏大偏离）。 */
  private async roomDistances(): Promise<number[]> {
    const distances: number[] = []
    for (const room of Object.values(this.opts.rooms)) {
      const objects = await this.svc.getRoomObjects(room)
      const sources = objects.filter((o) => o.type === 'source').map((o) => ({ x: o.x, y: o.y }))
      const controller = objects.find((o) => o.type === 'controller')
      distances.push(
        !controller || sources.length === 0 ? 0 : roomDistanceScore(sources, { x: controller.x, y: controller.y }),
      )
    }
    return distances
  }

  private async doPrepareRooms(): Promise<void> {
    const seatIds = Object.keys(this.opts.rooms)
    let deviation = 0
    for (let attempt = 0; ; attempt++) {
      for (const seatId of seatIds) {
        await this.svc.system('generateRoom', { room: this.opts.rooms[seatId]!, sources: 2 })
      }
      deviation = fairnessDeviation(await this.roomDistances())
      if (deviation <= FAIRNESS_THRESHOLD) break
      if (attempt >= REROLL_BUDGET) {
        this.opts.log?.(
          `map fairness: deviation ${deviation} > ${FAIRNESS_THRESHOLD} after ${REROLL_BUDGET} rerolls — keeping last roll`,
        )
        break
      }
      this.opts.log?.(
        `map fairness: deviation ${deviation} > ${FAIRNESS_THRESHOLD} — rerolling (attempt ${attempt + 1}/${REROLL_BUDGET})`,
      )
    }
    // generateRoom 后 runner 地形缓存不刷新（进程级，S7a spike）——必须重启；建号期无 run，
    // 集中一次重启代价最小。同房名重复 generateRoom 的覆盖行为由 live IT 钉住（plan-M2 S6）。
    if (seatIds.length > 0) await this.svc.restart({ resume: true })
    this.roomsPrepared = true
  }

  /**
   * 批量房间生成 + 公平性校验重掷（M2/S6，map-fairness.md §决策）：
   * 全部席位房间 generateRoom → 距离偏离中位数超阈值 → 整体重掷（spike 原文为「重掷该房」，
   * 实现取整体重掷——2 房 1v1 场景等价且实现更简；预算 ≤3，用尽取最后一次 + 告警）→
   * 一次 restart。幂等 + 并发安全（同一次 ensure 共享）。
   * 坐标来自 roomObjects 的 source/controller（mod generateRoom 返回无坐标，plan-M2 复审订正）。
   */
  async prepareRooms(): Promise<void> {
    if (this.roomsPrepared) return
    if (!this.preparePromise) {
      this.preparePromise = this.doPrepareRooms().finally(() => {
        this.preparePromise = undefined
      })
    }
    await this.preparePromise
  }

  /** journal 落盘用：席位 → 房间分配快照。 */
  roomsSnapshot(): Record<string, string> {
    return { ...this.opts.rooms }
  }

  /** journal 恢复路径（M2/S5）：跳过公平性重掷——恢复对局的房间已存在且内容已发展，重掷即破坏。 */
  markRoomsPrepared(): void {
    this.roomsPrepared = true
  }

  /** host 侧落映射 + 私服建号（房间生成在 prepareRooms；此处 createUser + 映射落地）。
   *  幂等：重复 bind 拒绝。username = agent_ + seatSlug（M2/S7 碰撞加固）。 */
  async bindUser(seatId: string): Promise<{ id: string; username: string }> {
    const existing = this.users.get(seatId)
    if (existing) throw new Error(`seat ${seatId}: already bound to ${existing}`)
    const room = this.opts.rooms[seatId]
    if (!room) throw new Error(`seat ${seatId}: no room assigned (host-side mapping only)`)
    if (!this.roomsPrepared) await this.prepareRooms() // 惰性兑底：未显式 prepare 时建号前补齐
    const username = `agent_${seatSlug(seatId)}`
    const user = await this.svc.createUser({
      username,
      room,
      ...(this.opts.initialCode ? { code: this.opts.initialCode } : {}),
      cpu: this.opts.cpu ?? 100,
    })
    this.users.set(seatId, username)
    return user
  }

  /** journal 恢复路径（M2/S5）：灌回 seatId→username 映射（用户已存在于私服，不建号）。
   *  游标保持 0（新实例默认）——重启后 console 可能重放，plan-M2 S5 已注明。 */
  restoreUser(seatId: string, username: string): void {
    this.users.set(seatId, username)
  }

  unbindUser(seatId: string): void {
    this.users.delete(seatId)
    this.consoleCursors.delete(seatId)
    this.eventCursors.delete(seatId)
  }

  resolveUser(seatId: string): string | undefined {
    return this.users.get(seatId)
  }

  async submitCode(
    username: string,
    modules: Record<string, string>,
  ): Promise<{ ok: true; seq: number } | { ok: false; reason: string }> {
    try {
      const { timestamp } = await this.svc.submitCode(username, modules)
      return { ok: true, seq: timestamp }
    } catch (err) {
      return { ok: false, reason: String(err instanceof Error ? err.message : err) }
    }
  }

  /** 以用户身份执行 console（官方通道），输出经 ring buffer 游标增量取回。 */
  async runConsole(username: string, expression: string): Promise<string> {
    const before = await this.svc.consoleOutput(username)
    const post = await this.svc.runConsoleAs(username, expression)
    if (post !== 'ok') return post
    await new Promise((r) => setTimeout(r, 100))
    const after = await this.svc.consoleOutput(username, before.cursor)
    const msgs = after.lines.filter((l) => typeof l === 'string')
    return msgs.length > 0 ? msgs.join('\n') : 'ok'
  }

  /**
   * 候选房间（视野判定的扫描域）：world 快照里出现过的所有房间（己方 owned ∪ 对手 owned）。
   * 真实世界里对手 creep 进入我方房 → 该房已在候选内（我方 owned），由 roomObjects 的 user
   * 判定纳入视野；我方 creep 进入对手房 → 该房也在候选内（对手 owned），同样可判定。
   */
  private candidateRooms(world: Awaited<ReturnType<ScreepsService['getWorld']>>): string[] {
    const rooms = new Set<string>()
    for (const u of world.users) for (const r of u.rooms ?? []) rooms.add(r.room)
    return [...rooms]
  }

  /** 战报投影：world 快照（公开）∪ 己方完整视图 ∪ 有视野房间对手动向（fog 过滤，不透视）。 */
  async report(username: string): Promise<string> {
    const world = await this.svc.getWorld()
    const me = world.users.find((u) => u.username === username)
    const ownedRooms = (me?.rooms ?? []).map((r) => r.room)
    // 视野判定：扫描候选房间的 roomObjects，交给 visibleRooms（owned ∪ 己方对象所在房间）
    const candidates = this.candidateRooms(world)
    const objects: Array<{ room: string; user?: string | null; type: string }> = []
    for (const room of candidates) {
      const roomObjects = await this.svc.getRoomObjects(room)
      for (const o of roomObjects) objects.push({ room, user: o.user ?? null, type: o.type })
    }
    const visible = visibleRooms(ownedRooms, objects, username)

    const lines: string[] = []
    lines.push(`gameTime=${world.gameTime}`)
    lines.push(
      `you: rooms=${me?.ownedRooms ?? 0} rclTotal=${me?.rclTotal ?? 0} spawns=${me?.spawns ?? 0} creeps=${me?.creeps ?? 0}`,
    )
    for (const u of world.users) {
      if (u.username === username) continue
      // 对手动向：只报有视野房间内的存在性（不透视资源/代码/memory）
      const opponentRooms = (u.rooms ?? []).map((r) => r.room).filter((r) => visible.has(r))
      if (opponentRooms.length > 0) {
        lines.push(`opponent ${u.username} visible in: ${opponentRooms.join(',')}`)
      }
    }
    // 对手单位进入我方视野房（world 快照 owned rooms 未必反映）——用已采集 objects 判定存在性
    const enemyPresence = new Set<string>()
    for (const o of objects) {
      if (o.user && o.user !== username && visible.has(o.room)) enemyPresence.add(o.user)
    }
    for (const enemy of [...enemyPresence].sort()) {
      if (!world.users.some((u) => u.username === enemy)) continue
      lines.push(`opponent ${enemy} units visible in your rooms`)
    }
    // 事件流（fog 过滤）：只保留有视野房间的事件；无视野房间的事件一律剥离（负向测试锚点）
    const since = this.eventCursors.get(username) ?? 0
    const raw = (await this.svc.system('eventLog', since)) as {
      events?: Array<{ tick: number; eventsByRoom: Record<string, unknown[]> }>
      cursor?: number
      bound?: boolean
    }
    if (typeof raw?.cursor === 'number') this.eventCursors.set(username, raw.cursor)
    const ring = Array.isArray(raw?.events) ? raw.events : []
    const visibleEvents: string[] = []
    for (const entry of ring) {
      const visibleRoomsInEntry = Object.keys(entry.eventsByRoom ?? {}).filter((r) => visible.has(r))
      for (const room of visibleRoomsInEntry) {
        const n = entry.eventsByRoom[room]!.length
        visibleEvents.push(`event tick ${entry.tick} room ${room}: ${n} event(s)`)
      }
    }
    if (visibleEvents.length > 0) lines.push(...visibleEvents)
    lines.push(`visibleRooms: ${[...visible].sort().join(',') || '(none)'}`)
    return lines.join('\n')
  }

  /** console ring 增量（游标推进；供 HTTP 桥 S4 的逐用户 console 流）。 */
  async consoleSince(username: string, since?: number): Promise<{ lines: unknown[]; cursor: number; bound: boolean }> {
    const cursor = since ?? this.consoleCursors.get(username) ?? 0
    const page = await this.svc.consoleOutput(username, cursor)
    this.consoleCursors.set(username, page.cursor)
    return page
  }
}
