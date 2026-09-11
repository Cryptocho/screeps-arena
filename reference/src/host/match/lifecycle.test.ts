import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScreepsWorldSnapshot } from '../service.ts'
import { buildMatchResult, toResultHash, type MatchResult } from '../history/model.ts'
import { configFromPreset, type MatchState, type SettlementJournal } from './model.ts'
import type { ArenaBackend, SettlementDrivers } from './lifecycle.ts'
import { MatchLifecycle } from './lifecycle.ts'
import { MatchStore } from './store.ts'

function snapshot(gameTime: number, users: Array<Partial<ScreepsWorldSnapshot['users'][number]> & { username: string }>): ScreepsWorldSnapshot {
  return {
    ok: true,
    gameTime,
    users: users.map(u => ({
      id: `uid-${u.username}`,
      username: u.username,
      badge: undefined,
      isBot: false,
      cpu: 100,
      gcl: 0,
      ownedRooms: u.ownedRooms ?? 0,
      rclTotal: u.rclTotal ?? 0,
      spawns: u.spawns ?? 0,
      creeps: u.creeps ?? 0,
      spawnEnergy: u.spawnEnergy ?? 0,
      rooms: u.rooms ?? [],
    })),
  }
}

function fakeBackend(initial: ScreepsWorldSnapshot, opts: { eventDelayMs?: number } = {}) {
  const calls: Array<[cmd: string, value?: unknown, code?: Record<string, string>]> = []
  let world = initial
  let tickDuration = 1000
  const backend: ArenaBackend & {
    setWorld(next: ScreepsWorldSnapshot): void
    calls: typeof calls
    currentTickDuration(): number
    pushEvents(events: unknown[]): void
    setRingBound(bound: boolean): void
  } = {
    calls,
    async ensureRunning() {},
    async system(cmd, value) {
      calls.push([cmd, value])
      if (cmd === 'setTickDuration') tickDuration = Number(value)
      if (cmd === 'generateRoom') return { generated: String(value) }
      return {}
    },
    async createUser(input) {
      calls.push(['createUser', input.username, input.code])
      return { username: input.username, id: `uid-${input.username}` }
    },
    async restart() {},
    async getWorld() {
      return world
    },
    async eventLog(_since) {
      // 归因测试用注入：事件源由 pushEvents 维护，cursor=当前消费终点；slice 模拟 mod 的 since 语义
      const from = typeof _since === 'number' && _since >= 0 ? _since : 0
      // P0 并发测试：可注入延迟，让两个 observe 同时进入 consumeEvents（否则同步 slice 无交错窗）
      if (opts.eventDelayMs) await new Promise(r => setTimeout(r, opts.eventDelayMs))
      return { events: eventSource.slice(from), cursor: eventSource.length, bound: ringBound }
    },
    setWorld(next) {
      world = next
    },
    currentTickDuration: () => tickDuration,
    pushEvents(events) {
      eventSource = [...eventSource, ...events]
    },
    setRingBound(bound) {
      ringBound = bound
    },
  }
  let eventSource: unknown[] = []
  let ringBound = true
  return backend
}

const dirs: string[] = []
function makeLifecycle(initial: ScreepsWorldSnapshot, backendOpts?: { eventDelayMs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-lifecycle-'))
  dirs.push(dir)
  const store = new MatchStore(join(dir, 'matches'))
  const backend = fakeBackend(initial, backendOpts)
  const lifecycle = new MatchLifecycle(store, backend, () => {}, {}, 0)
  return { store, backend, lifecycle }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function twoPlayerMatch(lifecycle: MatchLifecycle) {
  const match = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 'sess-a', username: 'bot_a' })
  await lifecycle.join(match.id, { sessionId: 'sess-b', username: 'bot_b' })
  return match.id
}

describe('MatchLifecycle', () => {
  it('boot() marks leftover active matches interrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-lifecycle-'))
    dirs.push(dir)
    const store = new MatchStore(join(dir, 'matches'))
    const leftover = await store.create(configFromPreset('world-rounds'), { sessionId: 's', username: 'x' })
    const backend = fakeBackend(snapshot(1, []))
    const flagged = await new MatchLifecycle(store, backend).boot()
    expect(flagged.map(m => m.id)).toContain(leftover.id)
  })

  it('start(): full deploy order, assignments, tickDuration from config, startTick recorded', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(500, []))
    const id = await twoPlayerMatch(lifecycle)

    const running = await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })

    expect(running.phase).toBe('running')
    expect(running.startTick).toBe(500)
    expect(running.assignments).toEqual({ 'sess-a': 'W42N42', 'sess-b': 'W43N43' })
    const cmds = backend.calls.map(c => c[0])
    expect(cmds).toEqual([
      // M5 加固：start 先 pause 掐掉上一进程遗留活世界的在途 tick，再清场（防 controller.user 复活竞态）
      'pause', 'resetArena', 'generateRoom', 'generateRoom', 'createUser', 'createUser',
      'setAccessibleRooms', 'setTickDuration', 'resume',
    ])
    expect(backend.calls.find(c => c[0] === 'resume')?.[1]).toEqual(['W42N42', 'W43N43'])
    // ensureRunning/restart 在 backend 接口里不是 system 调用；顺序由实现保证
    expect(backend.currentTickDuration()).toBe(400) // world-rounds 预设
    const userIds = (await store.get(id))!.players.map(p => p.userId)
    expect(userIds).toEqual(['uid-bot_a', 'uid-bot_b'])
  })

  it('start() auto-picks rooms and rejects single-player starts', async () => {
    const { lifecycle, store } = makeLifecycle(snapshot(1, []))
    const solo = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'a' })
    await expect(lifecycle.start(solo.id)).rejects.toMatchObject({ code: 'full' })
    await store.transition(solo.id, 'interrupted') // 腾出唯一活跃席位

    const id = await twoPlayerMatch(lifecycle)
    const running = await lifecycle.start(id)
    expect(Object.values(running.assignments!)).toHaveLength(2)
    expect(Object.values(running.assignments!).every(r => /^W\d{2}N\d{2}$/.test(r))).toBe(true)
  })

  it('start(): {room, exits} rooms pass exits to generateRoom (M2 battle-IT shape)', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(500, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, {
      rooms: [
        { room: 'W15N15', exits: { top: [22, 23, 24] } },
        { room: 'W15N16', exits: { bottom: [22, 23, 24] } },
      ],
    })
    const genCalls = backend.calls.filter(c => c[0] === 'generateRoom')
    expect(genCalls).toEqual([
      ['generateRoom', { room: 'W15N15', exits: { top: [22, 23, 24] } }],
      ['generateRoom', { room: 'W15N16', exits: { bottom: [22, 23, 24] } }],
    ])
    expect((await lifecycle.observe(id)).match.assignments).toEqual({ 'sess-a': 'W15N15', 'sess-b': 'W15N16' })
  })

  it('create(): tickDuration override flows into config and start setTickDuration', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'a', tickDuration: 100 })
    expect(match.config.tickDuration).toBe(100)
    await lifecycle.join(match.id, { sessionId: 's2', username: 'b' })
    await lifecycle.start(match.id)
    expect(backend.currentTickDuration()).toBe(100)
  })

  it('start(): bot seats use injected botCode instead of EMPTY_CODE', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'a' })
    await store.addPlayer(match.id, {
      sessionId: '__bot__harvester',
      username: '__bot_harvester',
      botCode: { main: 'module.exports.loop = function(){ /* bot */ }' },
    })
    await lifecycle.start(match.id)
    const createCalls = backend.calls.filter(c => c[0] === 'createUser') as unknown as Array<[string, string, Record<string, string>]>
    expect(createCalls).toHaveLength(2)
    const botCall = createCalls.find(c => c[1] === '__bot_harvester')!
    expect(botCall[2].main).toContain('/* bot */') // bot 座位走注入代码而非 EMPTY_CODE
    const playerCall = createCalls.find(c => c[1] === 'a')!
    expect(playerCall[2].main).toContain('loop') // 普通玩家空壳起步
  })

  // ---- A0 全就绪门槛（六审 B1 复诊：仅 spawn-Agent 局生效；普通局/bot 局零回归）----

  it('A0: spawn-agent match (spawnedBy=agents) with an un-submitted player is blocked at start', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'a' })
    await store.addPlayer(match.id, { sessionId: 's2', username: 'b' })
    // 打标 spawnedBy + 玩家 a 已 submitted、玩家 b 未提交
    await store.update(match.id, s => {
      s.spawnedBy = 'agents'
      const a = s.players.find(p => p.sessionId === 's1')!
      a.submitted = true
      a.code = { main: 'module.exports.loop = function () {}' }
    })
    await expect(lifecycle.start(match.id)).rejects.toMatchObject({ code: 'badPhase' })
    // 未烧到部署：resetArena 未被调用
    expect(backend.calls.some(c => c[0] === 'resetArena')).toBe(false)
  })

  it('A0: spawn-agent match with all players submitted starts and injects staged code', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'a' })
    await store.addPlayer(match.id, { sessionId: 's2', username: 'b' })
    await store.update(match.id, s => {
      s.spawnedBy = 'agents'
      for (const p of s.players) {
        p.submitted = true
        p.code = { main: 'module.exports.loop = function () { /* staged */ }' }
      }
    })
    const started = await lifecycle.start(match.id)
    expect(started.phase).toBe('running')
    const createCalls = backend.calls.filter(c => c[0] === 'createUser') as unknown as Array<[string, string, Record<string, string>]>
    expect(createCalls).toHaveLength(2)
    for (const call of createCalls) {
      expect(call[2].main).toContain('/* staged */') // 暂存式 submit 的 code 建号注入（botCode ?? code ?? EMPTY）
    }
  })

  it('A0: ordinary create/join match with no submitted field is NOT blocked (旧流程零回归)', async () => {
    const { lifecycle } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'a' })
    await lifecycle.join(match.id, { sessionId: 's2', username: 'b' })
    const started = await lifecycle.start(match.id)
    expect(started.phase).toBe('running')
  })

  it('A0: bot-seat match (botCode, no submitted) is NOT blocked', async () => {
    const { lifecycle, store } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 's1', username: 'a' })
    await store.addPlayer(match.id, { sessionId: '__bot__raider', username: '__bot_raider', botCode: { main: 'loop' } })
    const started = await lifecycle.start(match.id)
    expect(started.phase).toBe('running')
  })

  it('A0: duplicate usernames are rejected before deploys (起名查重，防建号中途炸)', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'same' })
    await store.addPlayer(match.id, { sessionId: 's2', username: 'same' })
    await store.update(match.id, s => {
      s.spawnedBy = 'agents'
      for (const p of s.players) {
        p.submitted = true
        p.code = { main: 'module.exports.loop = function () {}' }
      }
    })
    await expect(lifecycle.start(match.id)).rejects.toMatchObject({ code: 'full' })
    expect(backend.calls.some(c => c[0] === 'resetArena')).toBe(false)
  })

  it('pause/resume roundtrip with backend sync', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(1, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id)
    const paused = await lifecycle.pause(id)
    expect(paused.phase).toBe('paused')
    expect(backend.calls.some(c => c[0] === 'pause')).toBe(true)
    const running = await lifecycle.resume(id)
    expect(running.phase).toBe('running')
  })

  it('observe(): scoreboard projection from world snapshot', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(500, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })
    backend.setWorld(
      snapshot(1500, [
        { username: 'bot_a', ownedRooms: 2, rclTotal: 5, spawns: 2 },
        { username: 'bot_b', ownedRooms: 0, rclTotal: 0, spawns: 0 },
      ]),
    )

    const obs = await lifecycle.observe(id)
    expect(obs.gameTime).toBe(1500)
    expect(obs.ticksElapsed).toBe(1000)
    expect(obs.scoreboard['sess-a']!.score).toBe(2 * 100 + 5 * 50)
    expect(obs.scoreboard['sess-b']!.eliminated).toBe(true)
    expect(obs.autoSettle).toEqual({ due: true, reason: 'lastStanding' })
  })

  // ---- M3 B 节：arena form 分支 + eliminated 双分支 ----

  it('arena start: calls arenaGen (mirror) instead of generateRoom, assigns base/mirror rooms', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'a' })
    await lifecycle.join(match.id, { sessionId: 's2', username: 'b' })
    const started = await lifecycle.start(match.id)
    expect(started.phase).toBe('running')
    const arenaCalls = backend.calls.filter(c => c[0] === 'arenaGen')
    expect(arenaCalls).toHaveLength(1)
    expect(arenaCalls[0]![1]).toEqual({ room: 'W15N15', sources: 2 })
    // world 路径的 generateRoom 不被调用（arena 由 mod 一次生成两房）
    expect(backend.calls.some(c => c[0] === 'generateRoom')).toBe(false)
    expect(started.assignments).toEqual({ s1: 'W15N15', s2: 'W14N15' })
  })

  it('arena start rejects explicit rooms (mirror is automatic)', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(1, []))
    const match = await lifecycle.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'a' })
    await lifecycle.join(match.id, { sessionId: 's2', username: 'b' })
    await expect(
      lifecycle.start(match.id, { rooms: ['W42N42', 'W43N43'] }),
    ).rejects.toMatchObject({ code: 'badPhase' })
    // 未烧到部署
    expect(backend.calls.some(c => c[0] === 'resetArena')).toBe(false)
  })

  it('eliminated: arena uses spawns==0; world uses spawns==0 && creeps==0 (缺 creeps 降级)', async () => {
    // arena 局：spawn=0 但还有 creep → 已 eliminated（拆光 spawn 即无法再生产）
    const arenaCtx = makeLifecycle(snapshot(500, []))
    const arena = await arenaCtx.lifecycle.createMatch({ preset: 'arena-blitz', sessionId: 's1', username: 'a' })
    await arenaCtx.lifecycle.join(arena.id, { sessionId: 's2', username: 'b' })
    await arenaCtx.lifecycle.start(arena.id)
    arenaCtx.backend.setWorld(
      snapshot(1500, [
        { username: 'a', ownedRooms: 1, rclTotal: 1, spawns: 0, creeps: 1 },
        { username: 'b', ownedRooms: 1, rclTotal: 1, spawns: 1, creeps: 1 },
      ]),
    )
    const arenaObs = await arenaCtx.lifecycle.observe(arena.id)
    expect(arenaObs.scoreboard['s1']!.eliminated).toBe(true)
    expect(arenaObs.scoreboard['s2']!.eliminated).toBe(false)

    // world 局：spawn=0 但 creep=1 → 仍未出局（还有战力）；creep 清零 → 出局
    const worldCtx = makeLifecycle(snapshot(2000, []))
    const world = await worldCtx.lifecycle.createMatch({ preset: 'world-rounds', sessionId: 'w1', username: 'wa' })
    await worldCtx.lifecycle.join(world.id, { sessionId: 'w2', username: 'wb' })
    await worldCtx.lifecycle.start(world.id, { rooms: ['W42N42', 'W43N43'] })
    worldCtx.backend.setWorld(
      snapshot(2500, [
        { username: 'wa', ownedRooms: 0, rclTotal: 0, spawns: 0, creeps: 1 },
        { username: 'wb', ownedRooms: 0, rclTotal: 0, spawns: 0, creeps: 0 },
      ]),
    )
    const worldObs = await worldCtx.lifecycle.observe(world.id)
    expect(worldObs.scoreboard['w1']!.eliminated).toBe(false)
    expect(worldObs.scoreboard['w2']!.eliminated).toBe(true)
    // 外部旧版缺 creeps：降级为 spawns==0（出局判定仍成立）
    worldCtx.backend.setWorld(
      snapshot(2600, [
        { username: 'wa', ownedRooms: 0, rclTotal: 0, spawns: 1 },
        { username: 'wb', ownedRooms: 0, rclTotal: 0, spawns: 0 },
      ]),
    )
    const legacyObs = await worldCtx.lifecycle.observe(world.id)
    expect(legacyObs.scoreboard['w1']!.eliminated).toBe(false) // spawns=1 未出局
    expect(legacyObs.scoreboard['w2']!.eliminated).toBe(true) // spawns=0 → 出局（creeps 缺失降级）
  })

  it('settle(lastStanding): sole survivor wins, world paused, scores persisted once', async () => {
    const { backend, lifecycle, store } = makeLifecycle(
      snapshot(2100, [
        { username: 'bot_a', ownedRooms: 1, rclTotal: 2, spawns: 1 },
        { username: 'bot_b', ownedRooms: 0, rclTotal: 0, spawns: 0 },
      ]),
    )
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })

    const settled = await lifecycle.settle(id, 'lastStanding')

    expect(settled.winner).toEqual({ kind: 'session', id: 'sess-a' })
    expect(settled.endTick).toBe(2100)
    expect(settled.scores?.['sess-a']).toBe(1 * 100 + 2 * 50)
    expect(settled.scores?.['sess-b']).toBe(0)
    expect(backend.calls.some(c => c[0] === 'pause')).toBe(true)
    expect((await store.get(id))!.phase).toBe('settled')
  })

  it('settle(): equal scores → draw (no fake tiebreaks)', async () => {
    const { lifecycle } = makeLifecycle(
      snapshot(300, [
        { username: 'bot_a', ownedRooms: 1, rclTotal: 1, spawns: 1 },
        { username: 'bot_b', ownedRooms: 1, rclTotal: 1, spawns: 1 },
      ]),
    )
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })
    const settled = await lifecycle.settle(id, 'manual')
    expect(settled.winner).toEqual({ kind: 'draw' })
  })

  it('settle() rejects terminal matches (idempotence guard at phase level)', async () => {
    const { lifecycle } = makeLifecycle(snapshot(1, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id)
    await lifecycle.settle(id, 'manual')
    await expect(lifecycle.settle(id, 'manual')).rejects.toMatchObject({ code: 'badPhase' })
  })

  it('observe(): kills/losses accumulate from event stream and repeat observe does not double-count', async () => {
    const { backend, lifecycle } = makeLifecycle(snapshot(500, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })

    // 第一段：A 杀 B 一个 creep（uid-bot_a=击方；uid-bot_b=owner）
    backend.pushEvents([
      {
        tick: 600,
        eventsByRoom: {
          W42N42: [
            { event: 1, objectId: 'atk1', attackerUser: 'uid-bot_a', targetUser: 'uid-bot_b', data: { targetId: 'victim1', damage: 30, attackType: 1 } },
            { event: 2, objectId: 'victim1', attackerUser: 'uid-bot_b', data: { type: 'creep' } },
          ],
        },
      },
    ])
    let obs = await lifecycle.observe(id)
    expect(obs.scoreboard['sess-a']!.counters.kills).toBe(1)
    expect(obs.scoreboard['sess-b']!.counters.losses).toBe(1)

    // 第二次 observe（无新事件）→ 不重计
    obs = await lifecycle.observe(id)
    expect(obs.scoreboard['sess-a']!.counters.kills).toBe(1)
    expect(obs.scoreboard['sess-b']!.counters.losses).toBe(1)

    // 第二段：老死 DESTROYED（无 ATTACK 匹配）→ 不计 loss
    backend.pushEvents([
      { tick: 700, eventsByRoom: { W42N42: [{ event: 2, objectId: 'old1', attackerUser: 'uid-bot_a', data: { type: 'creep' } }] } },
    ])
    obs = await lifecycle.observe(id)
    expect(obs.scoreboard['sess-a']!.counters.kills).toBe(1)
    expect(obs.scoreboard['sess-a']!.counters.losses).toBe(0) // 非战斗死亡不计
  })

  it('concurrent observe/settle do NOT double-count events (P0 审查次要2: per-match single-flight lock)', async () => {
    // 事件拉取带延迟 → 两个并发 observe 真正同时进入 consumeEvents（否则无交错窗）
    const { backend, lifecycle } = makeLifecycle(snapshot(500, []), { eventDelayMs: 10 })
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })
    backend.pushEvents([
      {
        tick: 600,
        eventsByRoom: {
          W42N42: [
            { event: 1, objectId: 'atk1', attackerUser: 'uid-bot_a', targetUser: 'uid-bot_b', data: { targetId: 'victim1', damage: 30, attackType: 1 } },
            { event: 2, objectId: 'victim1', attackerUser: 'uid-bot_b', data: { type: 'creep' } },
          ],
        },
      },
    ])
    // 模拟 client 3s 轮询与 Agent 工具 observe 并发（同一批事件）
    const [obsA, obsB] = await Promise.all([lifecycle.observe(id), lifecycle.observe(id)])
    expect(obsA.scoreboard['sess-a']!.counters.kills).toBe(1)
    expect(obsB.scoreboard['sess-a']!.counters.kills).toBe(1) // 锁串行化 → 第二次读已推进 cursor，不双计
    expect(obsA.scoreboard['sess-b']!.counters.losses).toBe(1)
    expect(obsB.scoreboard['sess-b']!.counters.losses).toBe(1)

    // 事件消费后 concurrent settle 也串行（含全程 kills；空世界 territory/rcl=0 → score 纯 kills）
    const settled = await lifecycle.settle(id, 'manual')
    expect(settled.scores?.['sess-a']).toBe(1) // 1 kill，无双计
    expect(settled.scores?.['sess-b']).toBe(-1) // 1 loss
  })

  it('settle() includes full event-accumulated kills in persisted scores and scoreWarning on ring overflow', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(500, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id, { rooms: ['W42N42', 'W43N43'] })
    backend.pushEvents([
      {
        tick: 600,
        eventsByRoom: {
          W42N42: [
            { event: 1, objectId: 'atk1', attackerUser: 'uid-bot_a', targetUser: 'uid-bot_b', data: { targetId: 'victim1', damage: 30, attackType: 1 } },
            { event: 2, objectId: 'victim1', attackerUser: 'uid-bot_b', data: { type: 'creep' } },
          ],
        },
      },
    ])
    backend.setWorld(snapshot(900, [
      { username: 'bot_a', ownedRooms: 1, rclTotal: 1, spawns: 1 },
      { username: 'bot_b', ownedRooms: 1, rclTotal: 1, spawns: 1 },
    ]))

    const settled = await lifecycle.settle(id, 'manual')
    expect(settled.scores?.['sess-a']).toBe(1 * 100 + 1 * 50 + 1 * 1) // 含 1 kill
    expect(settled.scores?.['sess-b']).toBe(1 * 100 + 1 * 50 - 1 * 1) // 含 1 loss
    expect(settled.scoreWarning).toBeUndefined() // ring 完整

    // 新对局：ring 溢出 → settle 落 scoreWarning
    const { lifecycle: lc2, backend: bk2 } = makeLifecycle(snapshot(1, []))
    const id2 = await twoPlayerMatch(lc2)
    await lc2.start(id2)
    bk2.setRingBound(false)
    bk2.pushEvents([
      { tick: 100, eventsByRoom: { W42N42: [{ event: 2, objectId: 'x', attackerUser: 'uid-bot_a', data: { type: 'creep' } }] } },
    ])
    const settled2 = await lc2.settle(id2, 'manual')
    expect(settled2.scoreWarning).toContain('ring 溢出')
  })

  it('delete-match clears in-memory event state (leak guard)', async () => {
    const { backend, lifecycle, store } = makeLifecycle(snapshot(1, []))
    const id = await twoPlayerMatch(lifecycle)
    await lifecycle.start(id)
    backend.pushEvents([
      { tick: 100, eventsByRoom: { W42N42: [{ event: 2, objectId: 'x', attackerUser: 'uid-bot_a', data: { type: 'creep' } }] } },
    ])
    await lifecycle.observe(id)
    await store.remove(id)
    // 再次 observe 会 404（store 无此对局）——直接触发 consumeEvents 的清理路径
    await expect(lifecycle.observe(id)).rejects.toMatchObject({ code: 'notFound' })
  })
})

describe('MatchLifecycle — M4-B journal settle', () => {
  const dirs2: string[] = []
  function makeWithDrivers(initial: ScreepsWorldSnapshot, drivers: SettlementDrivers = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-screeps-lifecycle-m4-'))
    dirs2.push(dir)
    const store = new MatchStore(join(dir, 'matches'))
    const backend = fakeBackend(initial)
    const lifecycle = new MatchLifecycle(store, backend, undefined, drivers, 0)
    return { store, backend, lifecycle }
  }
  afterEach(() => {
    for (const dir of dirs2.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function runningArena(lifecycle: MatchLifecycle, store: MatchStore, tournament = false) {
    // 用 world-rounds（territory 权重非零，world 快照可驱动 winner）；tournament 局手动置 running
    const match = await lifecycle.createMatch({ preset: 'world-rounds', sessionId: 'sess-a', username: 'bot_a' })
    await lifecycle.join(match.id, { sessionId: 'sess-b', username: 'bot_b' })
    if (tournament) {
      await store.update(match.id, s => {
        s.tournamentId = 't1'
        s.tournamentSlotId = 'r1s0'
        s.attempt = 0
        s.phase = 'running'
        s.players.forEach((p, i) => {
          p.participantId = `p${i}`
          p.userId = `uid-${p.username}`
        })
      })
    } else {
      await lifecycle.start(match.id)
    }
    return match.id
  }

  const winnerWorld = snapshot(100, [
    { username: 'bot_a', ownedRooms: 2, rclTotal: 1, spawns: 1 },
    { username: 'bot_b', ownedRooms: 0, rclTotal: 1, spawns: 1 },
  ])

  it('ordinary settle leaves a journal and commits the candidate into state (replay/tournament na, cleanup pending)', async () => {
    const { backend, lifecycle, store } = makeWithDrivers(winnerWorld)
    const id = await runningArena(lifecycle, store)
    const settled = await lifecycle.settle(id, 'manual')
    expect(settled.phase).toBe('settled')
    expect(settled.winner).toEqual({ kind: 'session', id: 'sess-a' })
    expect(settled.scores?.['sess-a']).toBe(2 * 100 + 1 * 50)
    expect(settled.settlement?.replay.status).toBe('not-applicable')
    expect(settled.settlement?.history.status).toBe('not-applicable')
    expect(settled.settlement?.tournament.status).toBe('not-applicable')
    expect(settled.settlement?.cleanup.status).toBe('pending')
    expect(settled.settlement?.candidateHash).toMatch(/^[0-9a-f]{64}$/)
    expect(backend.calls.map(c => c[0])).toContain('pause')
  })

  it('second settle on a settled match still rejects (M3 409)', async () => {
    const { lifecycle, store } = makeWithDrivers(winnerWorld)
    const id = await runningArena(lifecycle, store)
    await lifecycle.settle(id, 'manual')
    await expect(lifecycle.settle(id, 'manual')).rejects.toMatchObject({ code: 'badPhase' })
    expect((await store.get(id))!.phase).toBe('settled')
  })

  it('pause failure only records journal.error and keeps settling; ordinary settle still commits', async () => {
    const { lifecycle, store, backend } = makeWithDrivers(winnerWorld)
    const id = await runningArena(lifecycle, store)
    // pause 抛 → 记 journal.error；普通局其余 marker 全 na → commit 成功
    const originalSystem = backend.system.bind(backend)
    backend.system = async (cmd, value) => {
      if (cmd === 'pause') throw new Error('backend down')
      return originalSystem(cmd, value)
    }
    const settled = await lifecycle.settle(id, 'manual')
    expect(settled.phase).toBe('settled')
    expect(settled.settlement?.error).toContain('pause failed')
  })

  it('observe on a settling match returns 409 (settlement in progress) without touching the world', async () => {
    const { lifecycle, store } = makeWithDrivers(winnerWorld)
    const id = await runningArena(lifecycle, store)
    // 直接 begin（不经 settle）把局推进到 settling
    const state = await store.get(id)!
    await store.beginSettlement(id, {
      reason: 'manual', winner: { kind: 'draw' }, scores: { 'sess-a': 0, 'sess-b': 0 },
      kills: {}, losses: {}, endTick: 1, participantMapping: [],
    }, { replay: 'na', history: 'na', tournament: 'na' }, state!.revision)
    await expect(lifecycle.observe(id)).rejects.toMatchObject({ code: 'badPhase' })
  })

  it('tournament settle requires all three drivers (rejects when missing)', async () => {
    const { lifecycle, store } = makeWithDrivers(winnerWorld, { history: async () => ({ resultId: 'x', resultHash: 'h' }) })
    const id = await runningArena(lifecycle, store, true)
    // 缺 replay/tournament driver → 拒绝（不会半 commit）
    await expect(lifecycle.settle(id, 'manual')).rejects.toMatchObject({ code: 'badPhase' })
    const state = await store.get(id)
    expect(state!.phase).toBe('running') // 未进入 settling
  })

  it('tournament settle runs the唯一顺序 replay→history→tournament→commit and forwards a participant-scoped result', async () => {
    const order: string[] = []
    let receivedResult: MatchResult | undefined
    const drivers = {
      replay: async (match: MatchState) => {
        order.push('replay')
        return { receipt: { resultId: match.id, payloadHash: 'rep-meta-hash', replayId: 'rep-1' }, completeness: 'complete' as const, gapReasons: [] }
      },
      history: async (_m: MatchState, journal: SettlementJournal) => {
        order.push('history')
        const result = buildMatchResult(_m, journal)
        return { resultId: _m.id, resultHash: toResultHash(result) }
      },
      tournament: {
        applyResult: async (matchId: string, result: MatchResult) => {
          order.push('tournament')
          receivedResult = result
          return { resultId: matchId, resultHash: toResultHash(result), outcome: 'won' as const, slotRevision: 1 }
        },
      },
    }
    const { lifecycle, store } = makeWithDrivers(winnerWorld, drivers)
    const id = await runningArena(lifecycle, store, true)
    const settled = await lifecycle.settle(id, 'manual')
    expect(order).toEqual(['replay', 'history', 'tournament'])
    expect(settled.phase).toBe('settled')
    expect(settled.settlement?.replay.status).toBe('committed')
    expect(settled.settlement?.tournament.status).toBe('committed')
    // gateway 收到同一 canonical MatchResult：winner 是 participant 而非 session
    expect(receivedResult?.winner).toEqual({ kind: 'participant', participantId: 'p0' })
    expect(receivedResult?.scores).toHaveProperty('p0')
    expect(settled.settlement?.tournament.receipt?.payloadHash).toBe(toResultHash(receivedResult!))
  })

  it('reconcileSettlement completes a stalled settlement idempotently (never recomputes candidate)', async () => {
    let gateCalls = 0
    const drivers = {
      replay: async (match: MatchState) => ({
        receipt: { resultId: match.id, payloadHash: 'rep-meta-hash', replayId: 'rep-1' },
        completeness: 'complete' as const,
        gapReasons: [] as string[],
      }),
      history: async (m: MatchState, j: SettlementJournal) => {
        const result = buildMatchResult(m, j)
        return { resultId: m.id, resultHash: toResultHash(result) }
      },
      tournament: {
        applyResult: async (matchId: string, result: MatchResult) => {
          gateCalls += 1
          if (gateCalls === 1) throw new Error('gateway transient failure') // 首次失败 → settle 抛、保持 settling
          return { resultId: matchId, resultHash: toResultHash(result), outcome: 'won' as const, slotRevision: 1 }
        },
      },
    }
    const { lifecycle, store } = makeWithDrivers(winnerWorld, drivers)
    const id = await runningArena(lifecycle, store, true)
    await expect(lifecycle.settle(id, 'manual')).rejects.toThrow('gateway transient failure')
    const stalled = await store.get(id)
    expect(stalled!.phase).toBe('settling')
    expect(stalled!.settlement?.error).toContain('gateway transient failure')
    // 重放：reconcile 只补 pending marker 再 commit（history/replay 已 committed 幂等跳过）
    const settled = await lifecycle.reconcileSettlement(id)
    expect(settled.phase).toBe('settled')
    expect(gateCalls).toBe(2)
    expect(settled.settlement?.tournament.status).toBe('committed')
    // 再次 reconcile 幂等
    await expect(lifecycle.reconcileSettlement(id)).resolves.toMatchObject({ phase: 'settled' })
  })
})
