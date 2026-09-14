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
  /** 席位 → spawn 固定坐标（M5/D3：arena 对称建号 base(25,25)/mirror(24,25)）。缺席随机。 */
  spawnCoords?: Record<string, { x: number; y: number }>
  /** 日志回调（公平性重掷告警等）。 */
  log?: (msg: string) => void
}

/** arena-blitz 固定基准房（plan-M5 D3）：镜像 = 东邻 roomNameFromXY(x+1,y)。 */
export const ARENA_BASE_ROOM = 'W15N15'
export function arenaMirrorRoom(base = ARENA_BASE_ROOM): string {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(base)
  if (!m) throw new Error(`invalid arena base room: ${base}`)
  // 旧仓库 B3 推导：东邻 = x+1。W/E 方向 x 增减语义由引擎 roomNameFromXY 承担，
  // 这里直接用 svc.system('arenaGen') 的返回值（base/mirror），此函数仅作守卫/展示。
  return m[1] === 'W' ? `W${Number(m[2]) - 1}${m[3]}${m[4]}` : `E${Number(m[2]) + 1}${m[3]}${m[4]}`
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
  /** 已生成房间全集（M3/S2，plan-M3 D5）：防误重掷的唯一防线——mod generateRoom 是
   *  覆盖语义（先清库再生成，无 already-exists 拒绝），重掷只允许碰 ∉ 此集合的房间。 */
  private readonly generatedRooms = new Set<string>()
  private preparePromise: Promise<void> | undefined
  /** arena 镜像房集合（M5/D3）+ 单飞 Promise：bindUser 据此等待战场就绪而不走 prepareRooms。 */
  private readonly arenaRooms = new Set<string>()
  private arenaPreparePromise: Promise<{ base: string; mirror: string; spawnA: { x: number; y: number }; spawnB: { x: number; y: number } }> | undefined
  /** arena 镜像房 → 对称 spawn 坐标（prepareArena 按真实地形选定；bindUser 按房间自取，
   *  不经调用方 setSpawnCoords——微任务时序下「先 await 后 set」会漏首席坐标）。 */
  private readonly arenaSpawnCoords = new Map<string, { x: number; y: number }>()

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
  private async roomDistances(rooms: string[]): Promise<number[]> {
    const distances: number[] = []
    for (const room of rooms) {
      const objects = await this.svc.getRoomObjects(room)
      const sources = objects.filter((o) => o.type === 'source').map((o) => ({ x: o.x, y: o.y }))
      const controller = objects.find((o) => o.type === 'controller')
      distances.push(
        !controller || sources.length === 0 ? 0 : roomDistanceScore(sources, { x: controller.x, y: controller.y }),
      )
    }
    return distances
  }

  /** 待生成房间：已分配 ∉ generatedRooms。多局并存下各局只生成自己的新房间。 */
  private pendingRooms(): string[] {
    return Object.values(this.opts.rooms).filter((room) => !this.generatedRooms.has(room))
  }

  private async doPrepareRooms(pending: string[]): Promise<void> {
    let deviation = 0
    for (let attempt = 0; ; attempt++) {
      for (const room of pending) {
        await this.svc.system('generateRoom', { room, sources: 2 })
      }
      deviation = fairnessDeviation(await this.roomDistances(pending))
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
    // 集中一次重启代价最小。多局并存下此重启会短暂中断他局 run/console（plan-M3 D5：
    // prepare 互斥 + 中断窗口显式接受，观战/runner 由现有游标与重试吸收）。
    // 注意：公平性偏离按「本局待生成房间集合」计算（M2 全局语义随 roomsPrepared 一并退役）。
    await this.svc.restart({ resume: true })
    // 成果审查非阻塞 4：prepare 在飞期间房间可能已被 settle 拆解（映射已删）——
    // 只把「仍在分配中」的房标记为已生成，否则孤儿房被永久假标记
    const assigned = new Set(Object.values(this.opts.rooms))
    for (const room of pending) {
      if (assigned.has(room)) this.generatedRooms.add(room)
    }
  }

  /**
   * 批量房间生成 + 公平性校验重掷（M2/S6 基础上 M3/S5 多局化，plan-M3 D5）：
   * 只处理「已分配且 ∉ generatedRooms」的房间；重掷同样只碰这些房（对已生成房重掷被
   * host 侧拒绝——mod generateRoom 是覆盖语义，防误重掷唯一防线在此）。
   * 幂等 + 并发安全：preparePromise 互斥，后来者等待后重查 pending（新局中途分配也能补齐）。
   * 公平性偏离中位数阈值与预算不变（≤10 / ≤3），计算域 = 本局待生成房间。
   */
  async prepareRooms(): Promise<void> {
    while (this.pendingRooms().length > 0) {
      if (!this.preparePromise) {
        const pending = this.pendingRooms()
        this.preparePromise = this.doPrepareRooms(pending).finally(() => {
          this.preparePromise = undefined
        })
      }
      await this.preparePromise
    }
  }

  /** journal 落盘用：席位 → 房间分配快照。 */
  roomsSnapshot(): Record<string, string> {
    return { ...this.opts.rooms }
  }

  /**
   * arena 镜像战场准备（M5/D3，plan-M5）：预清（removeRoom 回插全墙桩——R6/N5：复用
   * 依赖 mod 的 removeWhere 清桩链）→ arenaGen 一次生成 base + 东邻镜像（对称地形/
   * 资源/中立 controller，禁 NPC）→**登记 generatedRooms（B3 一审阻塞）**——否则后续
   * 任何 world 局的 prepareRooms 会 stock-generate + 公平重掷覆盖镜像战场（mod
   * generateRoom 是覆盖语义）。arenaGen 不走公平重掷（镜像即公平，distance 校验无意义）；
   * 生成后 runner 地形缓存不刷新（S7a spike）→ restart（同 prepareRooms 语义）。
   * 单飞（arenaPreparePromise）：createMatch 后台预热与 bindUser 的 ensureRoomReady
   * 并发进入时共享同一次准备（waker 建号与 prepare 竞态防线）。
   */
  async prepareArena(): Promise<{
    base: string
    mirror: string
    spawnA: { x: number; y: number }
    spawnB: { x: number; y: number }
  }> {
    if (this.arenaPreparePromise) return this.arenaPreparePromise
    // arenaRooms 必须在任何 await 之前同步登记：并发 bindUser 的 ensureRoomReady 据
    // 此判定「等待本 Promise」而非误走 prepareRooms stock 路径（stub IT 竞态实证）
    this.arenaRooms.add(ARENA_BASE_ROOM)
    this.arenaRooms.add(arenaMirrorRoom(ARENA_BASE_ROOM))
    this.arenaPreparePromise = this.doPrepareArena(ARENA_BASE_ROOM, arenaMirrorRoom(ARENA_BASE_ROOM)).finally(() => {
      this.arenaPreparePromise = undefined
    })
    return this.arenaPreparePromise
  }

  private async doPrepareArena(
    base: string,
    mirror: string,
  ): Promise<{ base: string; mirror: string; spawnA: { x: number; y: number }; spawnB: { x: number; y: number } }> {
    // 先暂停世界（对齐旧仓库 M3 A 节「pause → arenaGen → 建号 → resume」防 flake 链）：
    // 引擎在跑的几个 tick 内就会给新 accessible 的中立房派 Invader 殖民（实体占位，
    // hasEntity=true 实证）→ 双席建号撞 already owned。整个准备+建号窗口世界保持暂停，
    // 由 wireMachine 的 started 事件面统一 resume。
    await this.svc.system('pause')
    this.arenaRooms.add(base) // 先登记：bindUser 的 ensureRoomReady 据此等待本 Promise 而不走 prepareRooms
    this.arenaRooms.add(mirror)
    // 预清：removeRoom 幂等（不存在 found:false 安全）；把上一局的全墙桩/残骸清干净，
    // arenaGen 的基准房生成链从干净状态开始（对照旧仓库「resetArena 每次 start 清场」语义）
    await this.svc.system('removeRoom', base).catch(() => {})
    await this.svc.system('removeRoom', mirror).catch(() => {})
    const res = (await this.svc.system('arenaGen', { room: base, sources: 2 })) as { base?: string; mirror?: string }
    // arenaRooms 登记终身保留：ensureRoomReady 依赖 generatedRooms（不再等待），
    // bindUser 的 force 赋权依赖 arenaRooms（战场独占语义，见下）——删除会漏 force
    this.generatedRooms.add(base) // B3：防任何后续 prepareRooms 覆盖镜像战场
    this.generatedRooms.add(mirror)
    // resume:false（M5 live 实测）：resumed 世界的中立镜像房会被引擎 Invader NPC 抢注
    // controller（dump 实证 controller.user='2'）→ 第二席建号撞 'room already owned'。
    // 保持 paused 直到双席建号完成，wireMachine 的 started 事件面显式 resume——
    // paused 期间 gameTime 不走表，maxTicks 基线（started 时快照）不受影响。
    await this.svc.restart({ resume: false })
    // 对称 spawn 坐标：基于真实地形选点（[N2]：固定坐标落墙会被 placeSpawn 静默随机
    // 重掷，破坏镜像对称——live IT 实证）。镜像 terrain = base 逐行反转 ⇒ base 侧
    // (x,y) 非墙 ⇔ mirror 侧 (49-x,y) 非墙，扫一个双房同时非墙的对称对即可。
    const terrain = (await this.svc.getTerrain([base])).terrain[base] ?? ''
    let spawnA = { x: 25, y: 25 }
    for (let y = 5; y < 45; y++) {
      let found = false
      for (let x = 5; x < 45; x++) {
        if (terrain[y * 50 + x] !== '1') {
          spawnA = { x, y }
          found = true
          break
        }
      }
      if (found) break
    }
    const spawnB = { x: 49 - spawnA.x, y: spawnA.y }
    this.arenaSpawnCoords.set(base, spawnA)
    this.arenaSpawnCoords.set(mirror, spawnB)
    return { base: res.base ?? base, mirror: res.mirror ?? mirror, spawnA, spawnB }
  }

  /** journal 恢复路径（M2/S5 → M3/S2 语义）：恢复局房间已存在且已发展——灌入 generatedRooms
   *  （防新局重掷覆盖），不再有 roomsPrepared 全局标志。 */
  markRoomsPrepared(): void {
    for (const room of Object.values(this.opts.rooms)) this.generatedRooms.add(room)
  }

  /**
   * M3/S2 拆解面（plan-M3 D1/D3）：按席位定点回收——删私服用户（removeUser，含 env memory
   * 键 + mod 进程内 console ring）+ 删房间（removeRoom，含全墙桩回插 + blob 重建 +
   * accessible/active rooms 逆向）+ host 侧映射清理。幂等：用户/房间不存在时 mod 返回
   * found:false 而非报错（补拆解重放安全）。失败上抛给调用方（main 层记录 + 可查面）。
   *
   * expected（成果审查阻塞 3）：teardown 必须传 settle 时快照的 {username, room}——
   * 异步拆解窗口内席位可能已被新对局复用（同名 seatId），此时按当前映射删会误删新对局的
   * 用户/房间。expected 与当前映射不一致 → 跳过删除（席位已易主，新对局接管）。
   */
  async releaseSeat(seatId: string, expected?: { username?: string; room?: string }): Promise<void> {
    // prepare 在飞时等它收口（否则 in-flight generateRoom 可能在删除后重建孤儿房）
    if (this.preparePromise) await this.preparePromise
    const username = expected?.username ?? this.users.get(seatId)
    const room = expected?.room ?? this.opts.rooms[seatId]
    if (username) {
      if (this.users.get(seatId) !== username) {
        this.opts.log?.(`releaseSeat ${seatId}: seat reused (bound to ${this.users.get(seatId) ?? 'nothing'}, expected ${username}) — skip removeUser`)
      } else {
        await this.svc.system('removeUser', username)
      }
    }
    if (room) {
      if (this.opts.rooms[seatId] !== room) {
        this.opts.log?.(`releaseSeat ${seatId}: room ${room} no longer assigned — skip removeRoom`)
      } else {
        await this.svc.system('removeRoom', room)
        this.generatedRooms.delete(room)
        delete this.opts.rooms[seatId]
      }
    }
    // 席位未被新对局复用才清映射（否则会抹掉新对局的绑定）
    if (!expected || expected.username === undefined || this.users.get(seatId) === expected.username) {
      this.unbindUser(seatId)
    }
  }

  /** host 侧落映射 + 私服建号（房间生成在 prepareRooms；此处 createUser + 映射落地）。
   *  幂等：重复 bind 拒绝。username = agent_ + seatSlug（M2/S7 碰撞加固）。
   *  code（M5/[N6]）：per-call 覆盖——内部 IT/调度链建号即注码（botCode）；缺席用
   *  opts.initialCode（构造级全局）。 */
  async bindUser(seatId: string, code?: Record<string, string>): Promise<{ id: string; username: string }> {
    const existing = this.users.get(seatId)
    if (existing) throw new Error(`seat ${seatId}: already bound to ${existing}`)
    const room = this.opts.rooms[seatId]
    if (!room) throw new Error(`seat ${seatId}: no room assigned (host-side mapping only)`)
    // 房间就绪三态（M5/D3）：已生成 → 直接建号；arena 镜像房 → 等 prepareArena 单飞；
    // 其余 → prepareRooms 公平生成链（惰性兜底）。
    if (!this.generatedRooms.has(room)) {
      if (this.arenaRooms.has(room)) await this.arenaPreparePromise
      else await this.prepareRooms()
    }
    const username = `agent_${seatSlug(seatId)}`
    // 跨重启/跨容器幂等（compose 全链实测发现）：世界卷持久化后同名用户仍在世界库，
    // createUser 会 already exists——先查世界，在则收编映射不建号。
    const world = await this.svc.getWorld()
    if (world.users.some((u) => u.username === username)) {
      this.users.set(seatId, username)
      return { id: username, username }
    }
    const effectiveCode = code ?? this.opts.initialCode
    // arena 镜像房坐标由 prepareArena 注入（arenaSpawnCoords）；world 局走 opts.spawnCoords
    const coord = this.arenaSpawnCoords.get(room) ?? this.opts.spawnCoords?.[seatId]
    const user = await this.svc.createUser({
      username,
      room,
      ...(coord ? { x: coord.x, y: coord.y } : {}),
      ...(effectiveCode ? { code: effectiveCode } : {}),
      // M5：arena 镜像房是 host 独占战场（controller 上 NPC cronjob 殖民残留一律回收）
      ...(this.arenaRooms.has(room) ? { force: true } : {}),
      cpu: this.opts.cpu ?? 100,
    })
    this.users.set(seatId, username)
    return user
  }

  /** M5/D3：arena 对称 spawn 坐标（createMatchInternal 在分配镜像房时设置）。 */
  setSpawnCoords(seatId: string, coord: { x: number; y: number }): void {
    if (!this.opts.spawnCoords) this.opts.spawnCoords = {}
    this.opts.spawnCoords[seatId] = coord
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
