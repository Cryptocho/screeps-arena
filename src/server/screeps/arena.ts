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

export interface RealArenaOptions {
  /** 每席位初始房间（bindUser 时 generateRoom + createUser 一次完成）。 */
  rooms: Record<string, string>
  /** 初始代码（createUser 时随建号写入）。 */
  initialCode?: Record<string, string>
  /** CPU 配额（默认 100）。 */
  cpu?: number
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
  private readonly opts: RealArenaOptions

  constructor(
    private readonly svc: ScreepsService,
    opts: RealArenaOptions,
  ) {
    this.opts = opts
  }

  /** host 侧落映射 + 私服建号（generateRoom → createUser 一次完成）。幂等：重复 bind 拒绝。 */
  async bindUser(seatId: string): Promise<{ id: string; username: string }> {
    const existing = this.users.get(seatId)
    if (existing) throw new Error(`seat ${seatId}: already bound to ${existing}`)
    const room = this.opts.rooms[seatId]
    if (!room) throw new Error(`seat ${seatId}: no room assigned (host-side mapping only)`)
    const username = `agent_${seatId.replace(/[^A-Za-z0-9_-]/g, '_')}`
    await this.svc.system('generateRoom', { room, sources: 2 })
    const user = await this.svc.createUser({
      username,
      room,
      ...(this.opts.initialCode ? { code: this.opts.initialCode } : {}),
      cpu: this.opts.cpu ?? 100,
    })
    this.users.set(seatId, username)
    return user
  }

  unbindUser(seatId: string): void {
    this.users.delete(seatId)
    this.consoleCursors.delete(seatId)
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

  /** 战报投影：world 快照（公开）∪ 己方完整视图 ∪ 有视野房间对手动向（fog 过滤，不透视）。 */
  async report(username: string): Promise<string> {
    const world = await this.svc.getWorld()
    const me = world.users.find((u) => u.username === username)
    const ownedRooms = (me?.rooms ?? []).map((r) => r.room)
    // 视野判定：owned rooms ∪ 己方对象所在房间（逐房 roomObjects；房间数 ≤ owned+creep 房，量小）
    const visible = new Set<string>(ownedRooms)
    for (const room of ownedRooms) {
      const objects = await this.svc.getRoomObjects(room)
      for (const o of objects) {
        if (o.user && o.user === username) visible.add(room)
      }
    }
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
