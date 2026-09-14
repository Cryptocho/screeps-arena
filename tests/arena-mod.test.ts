/**
 * S2 arena-mod 打表单测（plan-M1 §3）——注入假 @screeps/* 依赖，断言：
 * ① 保留项（m0-flake §二防 flake 修复链）行为存在：generateRoom 后 8 邻墙桩、
 *    同房恰好一行地形、resume 刷 world meta、ok:false 熔断、addAccessibleRoom 落地；
 * ② generateRoom 链顺序：addWalledNeighbors 早于 updateTerrainData（B4 结论）；
 * ③ roomsDone 订阅在 storage 连接后生效（ensureEventCollector 惰性挂载）；
 * ④ 裁剪面：replay 系列/arenaGen/arenaProbe 已删（unknown command 拒绝）。
 * 装置复用 reference/src/runtime/arena-mod.test.ts 的 fake 形状（重写为本地版）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)

function nowPromise(value: unknown) {
  return Promise.resolve(value)
}

function matchDoc(doc: any, q: any): boolean {
  if (q == null || typeof q !== 'object') return true
  if (Array.isArray(q.$and)) return q.$and.every((cond: any) => matchDoc(doc, cond))
  return Object.entries(q).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(doc[k])
    if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne
    return doc[k] === v
  })
}

function makeDb() {
  const collections = {
    users: [] as any[], 'users.code': [] as any[], 'rooms.objects': [] as any[],
    'rooms.terrain': [] as any[], rooms: [] as any[],
  }
  let nextId = 1
  const id = () => String(nextId++)
  const db: Record<string, any> = { _collections: collections }
  const objectsColl: any[] = collections['rooms.objects']!
  const usersColl: any[] = collections.users!
  db.users = {
    findOne: (q: any) => nowPromise(usersColl.find((u) => q.username === undefined || u.username === q.username) ?? null),
    find: () => nowPromise(usersColl.slice()),
    insert: (doc: any) => { const rec = { _id: id(), ...doc }; usersColl.push(rec); return nowPromise(rec) },
    removeWhere: (q: any) => {
      const kept = usersColl.filter((u) => !matchDoc(u, q))
      usersColl.length = 0
      usersColl.push(...kept)
      return nowPromise(usersColl.length)
    },
  }
  db['users.code'] = {
    insert: (doc: any) => { collections['users.code'].push({ _id: id(), ...doc }); return nowPromise(doc) },
    find: (q: any) => nowPromise(collections['users.code'].filter((c) => matchDoc(c, q))),
    removeWhere: (q: any) => {
      const coll = collections['users.code']!
      const kept = coll.filter((c) => !matchDoc(c, q))
      coll.length = 0
      coll.push(...kept)
      return nowPromise(coll.length)
    },
  }
  db['rooms.objects'] = {
    findOne: (q: any) => nowPromise(objectsColl.find((o) => matchDoc(o, q)) ?? null),
    find: (q: any) => nowPromise(objectsColl.filter((o) => matchDoc(o, q))),
    insert: (doc: any) => { const rec = { _id: id(), ...doc }; objectsColl.push(rec); return nowPromise(rec) },
    update: (q: any, { $set }: any) => {
      let n = 0
      for (const o of objectsColl) if (matchDoc(o, q)) { Object.assign(o, $set); n++ }
      return nowPromise(n)
    },
    removeWhere: (q: any) => {
      const before = objectsColl.length
      const kept = objectsColl.filter((o) => !matchDoc(o, q))
      objectsColl.length = 0
      objectsColl.push(...kept)
      return nowPromise(before - objectsColl.length)
    },
  }
  const terrainColl: any[] = collections['rooms.terrain']!
  db['rooms.terrain'] = {
    findOne: (q: any) => nowPromise(collections['rooms.terrain'].find((t) => t.room === q.room) ?? null),
    find: (q: any) => nowPromise(terrainColl.filter((t) => q.room === undefined || q.room.$in === undefined || q.room.$in.includes(t.room))),
    insert: (doc: any) => { terrainColl.push({ _id: id(), ...doc }); return nowPromise(doc) },
    removeWhere: (q: any) => {
      const before = terrainColl.length
      const kept = terrainColl.filter((t) => t.room !== q.room)
      terrainColl.length = 0
      terrainColl.push(...kept)
      return nowPromise(before - terrainColl.length)
    },
  }
  const roomsColl: any[] = collections.rooms!
  db.rooms = {
    findOne: (q: any) => nowPromise(roomsColl.find((r) => matchDoc(r, q)) ?? null),
    find: () => nowPromise(roomsColl.slice()),
    insert: (doc: any) => { roomsColl.push({ _id: doc._id ?? id(), ...doc }); return nowPromise(doc) },
    update: (q: any, { $set }: any) => {
      for (const r of roomsColl) if (r._id === q._id) Object.assign(r, $set)
      return nowPromise(1)
    },
    removeWhere: (q: any) => {
      const kept = roomsColl.filter((r) => !matchDoc(r, q))
      roomsColl.length = 0
      roomsColl.push(...kept)
      return nowPromise(roomsColl.length)
    },
  }
  const collectionsAny = collections as Record<string, any[]>
  for (const key of Object.keys(collectionsAny)) {
    const coll = db[key]
    if (coll && typeof coll.clear !== 'function') {
      Object.defineProperty(coll, 'clear', { configurable: true, value: () => { collectionsAny[key]!.length = 0; return nowPromise('OK') } })
    }
  }
  return db
}

function makeDeps() {
  const db = makeDb()
  const envStore = new Map<string, string>()
  const driverCalls: string[] = []
  const cliMapCalls: string[] = []
  const pubsubListeners: Array<{ channel: string; listener: (payload: string) => void }> = []
  const env = {
    keys: {
      MEMORY: 'memory:', MAIN_LOOP_PAUSED: 'mainLoopPaused', MAIN_LOOP_MIN_DURATION: 'tickRate',
      TERRAIN_DATA: 'terrainData', ROOM_STATUS_DATA: 'roomStatusData', ACCESSIBLE_ROOMS: 'accessibleRooms',
      ACTIVE_ROOMS: 'activeRooms', ROOM_EVENT_LOG: 'roomEventLog:',
    },
    set: (k: string, v: unknown) => (envStore.set(k, String(v)), nowPromise('OK')),
    get: (k: string) => nowPromise(envStore.get(k)),
    del: (k: string) => (envStore.delete(k), nowPromise('OK')),
    hset: (k: string, field: string, v: unknown) => {
      const hash = JSON.parse(envStore.get(k) || '{}')
      hash[field] = String(v)
      envStore.set(k, JSON.stringify(hash))
      return nowPromise(String(v))
    },
    hmget: (k: string, ids: string[]) => {
      let hash: Record<string, string> = {}
      try { hash = JSON.parse(envStore.get(k) || '{}') } catch { hash = {} }
      return nowPromise(ids.map((id) => hash[id] ?? null))
    },
    smembers: (k: string) => {
      const v = envStore.get(k)
      return nowPromise(typeof v === 'string' && v.length > 0 ? v.split('\n') : [])
    },
    sadd: (k: string, member: string) => {
      const v = envStore.get(k)
      const list = typeof v === 'string' && v.length > 0 ? v.split('\n') : []
      if (!list.includes(member)) list.push(member)
      envStore.set(k, list.join('\n'))
      return nowPromise('OK')
    },
  }
  const common = {
    storage: {
      db, env,
      pubsub: {
        publish: (_k: string, _v: unknown) => nowPromise('OK'),
        subscribe: (channel: string, listener: (payload: string) => void) => {
          pubsubListeners.push({ channel, listener })
          return () => {}
        },
      },
    },
    configManager: { config: { common: { constants: {
      GCL_MULTIPLY: 1000000, GCL_POW: 2.4, SPAWN_ENERGY_START: 300, SPAWN_ENERGY_CAPACITY: 300,
      SPAWN_HITS: 2500, TERRAIN_MASK_WALL: 1,
    } } } },
    checkTerrain: () => false,
    getGametime: () => nowPromise(1000),
    roomNameToXY: (roomName: string) => {
      const m = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName)!
      const xx = m[1] === 'W' ? 127 - Number(m[2]) : 128 + Number(m[2])
      const yy = m[3] === 'N' ? 127 - Number(m[4]) : 128 + Number(m[4])
      return [xx, yy]
    },
    getRoomNameFromXY: (xx: number, yy: number) =>
      (xx <= 127 ? 'W' + (127 - xx) : 'E' + (xx - 128)) + (yy <= 127 ? 'N' + (127 - yy) : 'S' + (yy - 128)),
  }
  const routes: { post: Record<string, any>; get: Record<string, any> } = { post: {}, get: {} }
  const router = { post: (p: string, h: any) => { routes.post[p] = h }, get: (p: string, h: any) => { routes.get[p] = h } }
  return {
    db, envStore, driverCalls, cliMapCalls, pubsubListeners, routes,
    deps: {
      common,
      authlib: { genToken: (uid: string) => nowPromise('token-for-' + uid) },
      backendUtils: { activateRoom: () => nowPromise('OK') },
      cliMap: {
        generateRoom: (room: string, opts?: Record<string, any>) => {
          db._collections['rooms.terrain'].push({ _id: 'gen-' + room, room, terrain: '0'.repeat(2500) })
          cliMapCalls.push('generateRoom:' + room + ':' + JSON.stringify(opts ?? {}))
          return nowPromise('generated ' + room)
        },
        updateTerrainData: () => (cliMapCalls.push('updateTerrainData'), nowPromise('OK')),
      },
      express: { Router: () => router },
      driver: {
        updateAccessibleRoomsList: () => (driverCalls.push('updateAccessibleRoomsList'), nowPromise('OK')),
        updateRoomStatusData: () => (driverCalls.push('updateRoomStatusData'), nowPromise('OK')),
      },
    },
  }
}

type Bundle = ReturnType<typeof makeDeps>

function installMod(bundle: Bundle) {
  const mod = requireCjs('../src/server/screeps/arena-mod.cjs')
  mod._testInject(bundle.deps)
  mod._testReset()
  mod({ backend: { router: { use: () => {} } } })
  return { routes: bundle.routes, mod }
}

function fakeReqRes({ body = {}, query = {} }: { body?: any; query?: any } = {}) {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, any> | undefined,
    json(payload: Record<string, any>) { this.body = payload; return this },
    status(code: number) { this.statusCode = code; return this },
  }
  return { req: { body, query, socket: { remoteAddress: '127.0.0.1' }, get: () => undefined, headers: {} }, res }
}

/** 经 /system 路由发命令（走 ensureRoomStatusOnce 全链，与生产一致）。 */
async function systemCmd(bundle: Bundle, cmd: string, value?: unknown) {
  const { req, res } = fakeReqRes({ body: { cmd, ...(value !== undefined ? { value } : {}) } })
  await bundle.routes.post['/system'](req, res)
  return res
}

describe('arena mod（S2 打表）', () => {
  let bundle: Bundle
  beforeEach(() => {
    bundle = makeDeps()
    installMod(bundle)
  })

  it('保留项①：generateRoom 后 8 邻墙桩 + 同房恰好一行地形 + accessibleRooms 落地', async () => {
    const res = await systemCmd(bundle, 'generateRoom', 'E5N5')
    expect(res.body?.ok).toBe(true)
    const terrain: any[] = bundle.db._collections['rooms.terrain']
    // 同房恰好一行（removeWhere 清桩先生效）
    expect(terrain.filter((t) => t.room === 'E5N5')).toHaveLength(1)
    // 8 邻墙桩（2500 个 '1'）
    const neighbors = ['E4N4', 'E5N4', 'E6N4', 'E4N5', 'E6N5', 'E4N6', 'E5N6', 'E6N6']
    for (const n of neighbors) {
      const stub = terrain.find((t) => t.room === n)
      expect(stub, `neighbor ${n}`).toBeDefined()
      expect(stub!.terrain).toBe('1'.repeat(2500))
    }
    // accessibleRooms JSON 列表落地（规范形态：JSON 字符串，非 sadd）
    expect(JSON.parse(bundle.envStore.get('accessibleRooms')!)).toEqual(['E5N5'])
  })

  it('[M2/S6] 重掷语义：房已存在（rooms/objects 有记录）时先清后生成，不抛 already exists', async () => {
    ;(bundle.db._collections.rooms as any[]).push({ _id: 'E5N5', invaderGoal: 1 })
    ;(bundle.db._collections['rooms.objects'] as any[]).push({ _id: 'o1', room: 'E5N5', type: 'spawn' })
    const res = await systemCmd(bundle, 'generateRoom', 'E5N5')
    expect(res.body?.ok).toBe(true)
    expect((bundle.db._collections.rooms as any[]).some((r) => r._id === 'E5N5')).toBe(false)
    expect((bundle.db._collections['rooms.objects'] as any[]).some((o) => o.room === 'E5N5')).toBe(false)
    // 链尾照常：accessibleRooms 落地（重掷与首生成同一条路）
    expect(JSON.parse(bundle.envStore.get('accessibleRooms')!)).toContain('E5N5')
  })

  it('保留项②：generateRoom 链顺序——addWalledNeighbors 早于 updateTerrainData（B4）', async () => {
    await systemCmd(bundle, 'generateRoom', 'E5N5')
    const gen = bundle.cliMapCalls.findIndex((c) => c.startsWith('generateRoom:E5N5'))
    const wall = bundle.cliMapCalls.indexOf('updateTerrainData')
    expect(gen).toBeGreaterThanOrEqual(0)
    expect(wall).toBeGreaterThan(gen)
    // 且墙桩在 updateTerrainData 之前已入 db（blob 含斜角桩的前提）
    const terrain: any[] = bundle.db._collections['rooms.terrain']
    const stubsBefore = terrain.filter((t) => t.terrain === '1'.repeat(2500))
    expect(stubsBefore.length).toBe(8)
  })

  it('保留项③：resume 强刷 world meta（updateAccessibleRoomsList + updateRoomStatusData）', async () => {
    const res = await systemCmd(bundle, 'resume')
    expect(res.body?.ok).toBe(true)
    expect(res.body?.worldMetaRefreshed).toBe(true)
    expect(bundle.driverCalls).toEqual(['updateAccessibleRoomsList', 'updateRoomStatusData'])
    expect(bundle.envStore.get('mainLoopPaused')).toBe('0')
  })

  it('保留项④：roomStatusData 播种（arena 路由首秀时）', async () => {
    await systemCmd(bundle, 'getTickDuration')
    expect(bundle.envStore.get('roomStatusData')).toBe('{"closed":{},"novice":{},"respawn":{}}')
  })

  it('保留项⑤：ok:false 熔断——unknown command 经路由返回 ok:false', async () => {
    const res = await systemCmd(bundle, 'noSuchCommand')
    expect(res.statusCode).toBe(400)
    expect(res.body?.ok).toBe(false)
    expect(res.body?.error).toContain('unknown system command')
  })

  it('roomsDone 订阅惰性挂载（ensureEventCollector 在路由首秀时执行）', async () => {
    expect(bundle.pubsubListeners).toHaveLength(0)
    await systemCmd(bundle, 'getTickDuration')
    const channels = bundle.pubsubListeners.map((l) => l.channel)
    expect(channels).toContain('roomsDone')
  })

  it('roomsDone 回调：事件入 ring（hmget 读 roomEventLog，整组去重）', async () => {
    await systemCmd(bundle, 'getTickDuration') // 触发订阅
    const listener = bundle.pubsubListeners.find((l) => l.channel === 'roomsDone')!.listener
    // 预置一个房间 + 事件日志
    bundle.db._collections.rooms.push({ _id: 'E5N5', status: 'normal' })
    bundle.envStore.set('roomEventLog:', JSON.stringify({ E5N5: JSON.stringify([{ event: 1, objectId: 'o1' }]) }))
    listener('42')
    await new Promise((r) => setTimeout(r, 10))
    // 经 eventLog 命令读回
    const res = await systemCmd(bundle, 'eventLog', 0)
    expect(res.body?.ok).toBe(true)
    expect(res.body?.events).toHaveLength(1)
    expect(res.body?.events[0]).toMatchObject({ tick: 42, eventsByRoom: { E5N5: [{ event: 1, objectId: 'o1' }] } })
    // 同一事件重放（陈旧 hash）→ 不重复入 ring
    listener('43')
    await new Promise((r) => setTimeout(r, 10))
    const res2 = await systemCmd(bundle, 'eventLog', 0)
    expect(res2.body?.events).toHaveLength(1)
  })

  it('裁剪面：replay* 已删（unknown command 拒绝）；M5/S1 回迁后 arenaGen/arenaProbe 已在（参数校验拒绝）', async () => {
    for (const cmd of ['replayStart', 'replayPage', 'replayStop', 'replayStatus']) {
      const res = await systemCmd(bundle, cmd, {})
      expect(res.body?.ok, cmd).toBe(false)
      expect(res.body?.error, cmd).toContain('unknown system command')
    }
    // M5/S1：arenaGen/arenaProbe 回迁（plan-M5 D2）——空参走各自的参数校验拒绝而非 unknown
    const g = await systemCmd(bundle, 'arenaGen', {})
    expect(g.body?.ok, 'arenaGen').toBe(false)
    expect(g.body?.error, 'arenaGen').toContain('arenaGen requires')
    const p = await systemCmd(bundle, 'arenaProbe', {})
    expect(p.body?.ok, 'arenaProbe').toBe(false)
    expect(p.body?.error, 'arenaProbe').toContain('arenaProbe requires')
  })

  it('保留命令：setTickDuration / pause / resetArena 可用', async () => {
    const t = await systemCmd(bundle, 'setTickDuration', 100)
    expect(t.body).toMatchObject({ ok: true, tickDuration: 100 })
    const p = await systemCmd(bundle, 'pause')
    expect(p.body).toMatchObject({ ok: true, paused: true })
    const r = await systemCmd(bundle, 'resetArena')
    expect(r.body).toMatchObject({ ok: true, reset: true })
  })

  it('createUser：users.code 带 timestamp（VM 冻结坑）+ spawn 部署 + controller 预赋权', async () => {
    // 预置已生成房间（controller 中立）
    bundle.db._collections['rooms.terrain'].push({ room: 'E1N1', terrain: '0'.repeat(2500) })
    bundle.db._collections['rooms.objects'].push({ _id: 'c1', room: 'E1N1', type: 'controller', user: null, level: 0 })
    const { req, res } = fakeReqRes({ body: { username: 'agent_a', room: 'E1N1', code: { main: 'module.exports.loop=function(){}' } } })
    await bundle.routes.post['/users'](req, res)
    expect(res.body?.ok).toBe(true)
    const code = bundle.db._collections['users.code'][0]
    expect(code.user).toBeDefined()
    expect(typeof code.timestamp).toBe('number')
    expect(code.timestamp).toBeGreaterThan(0)
    const objects: any[] = bundle.db._collections['rooms.objects']
    expect(objects.some((o) => o.type === 'spawn' && o.user === code.user)).toBe(true)
    const controller = objects.find((o) => o.type === 'controller')!
    expect(controller.user).toBe(code.user)
    expect(controller.safeMode).toBeGreaterThan(0)
  })

  // ---- M3/S1（plan-M3 D2）----

  it('[M3/S1] removeUser：删用户全集（code/objects 所有权/memory env 键），幂等，系统用户拒', async () => {
    // 预置：用户 + code + 房内对象（controller/spawn 均归 user）+ memory env 键
    bundle.db._collections['rooms.objects'].push({ _id: 'c1', room: 'E1N1', type: 'controller', user: 'u1' })
    bundle.db._collections['rooms.objects'].push({ _id: 's1', room: 'E1N1', type: 'spawn', user: 'u1' })
    bundle.db._collections['users'].push({ _id: 'u1', username: 'agent_a' })
    bundle.db._collections['users.code'].push({ _id: 'k1', user: 'u1', modules: {} })
    bundle.envStore.set('memory:u1', '{}')

    const r = await systemCmd(bundle, 'removeUser', 'agent_a')
    expect(r.body).toMatchObject({ ok: true, removed: 'agent_a', found: true, id: 'u1' })
    expect(bundle.db._collections['users']).toHaveLength(0)
    expect(bundle.db._collections['users.code']).toHaveLength(0)
    // rooms.objects 的 {user:'u1'} 全清（controller 所有权随删——同名重建不撞 owned）
    expect(bundle.db._collections['rooms.objects']).toHaveLength(0)
    expect(bundle.envStore.has('memory:u1')).toBe(false)
    // 幂等：再删 found:false
    const r2 = await systemCmd(bundle, 'removeUser', 'agent_a')
    expect(r2.body).toMatchObject({ ok: true, found: false })
    // 系统用户拒
    const sys = await systemCmd(bundle, 'removeUser', 'Invader')
    expect(sys.body?.ok).toBe(false)
  })

  it('[M3/S1] removeRoom：清五集合 + 全墙桩回插（blob 重建前）+ accessible/active 逆向 + 幂等', async () => {
    bundle.db._collections['rooms.terrain'].push({ room: 'E1N1', terrain: '0'.repeat(2500) })
    bundle.db._collections['rooms.objects'].push({ _id: 'c1', room: 'E1N1', type: 'controller' })
    bundle.db._collections['rooms'].push({ _id: 'E1N1', status: 'normal' })
    bundle.envStore.set('accessibleRooms', '["E1N1","E3N3"]')
    bundle.envStore.set('activeRooms', 'E1N1\nE3N3')

    const r = await systemCmd(bundle, 'removeRoom', 'E1N1')
    expect(r.body).toMatchObject({ ok: true, removed: 'E1N1', found: true })
    expect(bundle.db._collections['rooms.objects']).toHaveLength(0)
    expect(bundle.db._collections['rooms']).toHaveLength(0)
    // 全墙桩回插：同房恰好一行、全 '1'
    const terrain = bundle.db._collections['rooms.terrain']
    expect(terrain).toHaveLength(1)
    expect(terrain[0]!.room).toBe('E1N1')
    expect(terrain[0]!.terrain).toBe('1'.repeat(2500))
    // env 逆向：accessibleRooms 剔除本房、activeRooms del+sadd 重建（他局房保留）
    expect(JSON.parse(String(bundle.envStore.get('accessibleRooms')))).toEqual(['E3N3'])
    expect(bundle.envStore.get('activeRooms')?.split('\n')).toEqual(['E3N3'])
    // blob 重建 + VM 元数据刷新
    expect(bundle.cliMapCalls).toContain('updateTerrainData')
    expect(bundle.driverCalls).toContain('updateAccessibleRoomsList')
    expect(bundle.driverCalls).toContain('updateRoomStatusData')
    // 幂等：不存在房 → found:false（不再动 cliMap）
    const callsBefore = bundle.cliMapCalls.length
    const r2 = await systemCmd(bundle, 'removeRoom', 'E1N1')
    expect(r2.body).toMatchObject({ ok: true, found: false })
    expect(bundle.cliMapCalls.length).toBe(callsBefore)
  })

  it('[M3/S1] dbProbe：按 username 清点关联行数 + memory 键字节；按 id 清点（删号后残留检测）', async () => {
    bundle.db._collections['users'].push({ _id: 'u1', username: 'agent_a' })
    bundle.db._collections['users.code'].push({ _id: 'k1', user: 'u1' })
    bundle.db._collections['rooms.objects'].push({ _id: 'c1', room: 'E1N1', type: 'controller', user: 'u1' })
    bundle.envStore.set('memory:u1', '{"x":1}')

    const byName = await systemCmd(bundle, 'dbProbe', 'agent_a')
    expect(byName.body?.user).toMatchObject({ _id: 'u1' })
    const rows = Object.fromEntries(byName.body?.rows ?? [])
    expect(rows['users']).toBe(1)
    expect(rows['users.code']).toBe(1)
    expect(rows['rooms.objects']).toBe(1)
    expect(byName.body?.memoryKeyBytes).toBe(7)
    // 删号后按 id 清点（此时 username 查不到）
    await systemCmd(bundle, 'removeUser', 'agent_a')
    const byId = await systemCmd(bundle, 'dbProbe', { id: 'u1' })
    const rows2 = Object.fromEntries(byId.body?.rows ?? [])
    expect(rows2['users']).toBe(0)
    expect(rows2['rooms.objects']).toBe(0)
    expect(byId.body?.memoryKeyBytes).toBe(null)
  })
})
