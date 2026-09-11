/**
 * arena mod 单测：注入假 @screeps/* 依赖，验证 guard、建户流程、token、世界快照、系统控制。
 * 真实 backend 集成由 S3/S6 的起停与 M0 e2e 覆盖。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const requireCjs = createRequire(import.meta.url)

/* ---------------- 假依赖构建 ---------------- */

function nowPromise(value: unknown) {
  return Promise.resolve(value)
}

/** fake LokiJS 查询匹配：支持等值、点路径、{ $in: [] }、$and。 */
function matchDoc(doc: any, q: any): boolean {
  if (q == null || typeof q !== 'object') return true
  if (Array.isArray(q.$and)) {
    return q.$and.every((cond: any) => matchDoc(doc, cond))
  }
  return Object.entries(q).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) {
      return v.$in.includes(doc[k])
    }
    if (v && typeof v === 'object' && '$ne' in v) {
      return doc[k] !== v.$ne
    }
    if (k.includes('.')) {
      let cur = doc
      for (const p of k.split('.')) {
        if (cur == null) return false
        cur = cur[p]
      }
      return cur === v
    }
    return doc[k] === v
  })
}

function makeDb() {
  const collections = {
    users: [] as any[],
    'users.code': [] as any[],
    'rooms.objects': [] as any[],
    'rooms.terrain': [] as any[],
    rooms: [] as any[],
  }
  let nextId = 1
  const id = () => String(nextId++)
  const db = {
    _collections: collections,
    users: {
      findOne(q: any) {
        const user = collections.users.find(u => q.username === undefined || u.username === q.username)
        return nowPromise(user ?? null)
      },
      find(_q: any) {
        return nowPromise(collections.users.slice())
      },
      insert(doc: any) {
        const rec = { _id: id(), ...doc }
        collections.users.push(rec)
        return nowPromise(rec)
      },
      removeWhere(q: any) {
        const kept = collections.users.filter((u: any) => !matchDoc(u, q))
        collections.users = kept
        return nowPromise(collections.users.length)
      },
    },
    'users.code': {
      insert(doc: any) {
        collections['users.code'].push({ _id: id(), ...doc })
        return nowPromise(doc)
      },
    },
    'rooms.objects': {
      findOne(q: any) {
        const hit = collections['rooms.objects'].find((o: any) => matchDoc(o, q))
        return nowPromise(hit ?? null)
      },
      find(q: any) {
        const out = collections['rooms.objects'].filter((o: any) => matchDoc(o, q))
        return nowPromise(out)
      },
      insert(doc: any) {
        const rec = { _id: id(), ...doc }
        collections['rooms.objects'].push(rec)
        return nowPromise(rec)
      },
      update(q: any, { $set }: any) {
        let n = 0
        for (const o of collections['rooms.objects']) {
          if (matchDoc(o, q)) {
            Object.assign(o, $set)
            n++
          }
        }
        return nowPromise(n)
      },
      removeWhere(q: any) {
        const before = collections['rooms.objects'].length
        const kept = collections['rooms.objects'].filter((o: any) => !matchDoc(o, q))
        collections['rooms.objects'] = kept
        return nowPromise(before - kept.length)
      },
    },
    'rooms.terrain': {
      findOne(q: any) {
        return nowPromise(collections['rooms.terrain'].find(t => t.room === q.room) ?? null)
      },
      find(_q: any, projection?: { room?: boolean }) {
        const items = collections['rooms.terrain'].slice()
        return nowPromise(projection?.room ? items.map((t: any) => ({ room: t.room })) : items)
      },
      insert(doc: any) {
        collections['rooms.terrain'].push({ _id: id(), ...doc })
        return nowPromise(doc)
      },
      removeWhere(q: any) {
        const before = collections['rooms.terrain'].length
        const kept = collections['rooms.terrain'].filter((t: any) => t.room !== q.room)
        collections['rooms.terrain'] = kept
        return nowPromise(before - kept.length)
      },
    },
    rooms: {
      find(_q: any, _projection?: { _id?: boolean }) {
        return nowPromise(collections.rooms.slice())
      },
      update(q: any, { $set }: any) {
        for (const r of collections.rooms) {
          if (r._id === q._id) Object.assign(r, $set)
        }
        return nowPromise(1)
      },
    },
  }
  // resetArena 会对白名单集合逐一遍历 clear()——fake 全部补上，避免 TypeError
  const dbAny = db as Record<string, any>
  const collectionsAny = collections as Record<string, any[]>
  for (const key of Object.keys(collections)) {
    const coll = dbAny[key]
    if (coll && typeof coll.clear !== 'function') {
      Object.defineProperty(coll, 'clear', {
        configurable: true,
        value: () => {
          collectionsAny[key]!.length = 0
          return nowPromise('OK')
        },
      })
    }
  }
  return db
}

interface MakeDepsOverrides {
  db?: ReturnType<typeof makeDb>
}

function makeDeps(overrides: MakeDepsOverrides = {}) {
  const db = overrides.db ?? makeDb()
  const envStore = new Map<string, string>()
  const published: Array<[string, unknown]> = []
  const driverCalls: string[] = []
  const cliMapCalls: string[] = []
  const pubsubListeners: Array<{ channel: string; listener: (payload: string) => void }> = []
  const env = {
    keys: {
      MEMORY: 'memory:',
      MAIN_LOOP_PAUSED: 'mainLoopPaused',
      MAIN_LOOP_MIN_DURATION: 'tickRate',
      TERRAIN_DATA: 'terrainData',
      ROOM_STATUS_DATA: 'roomStatusData',
      ACCESSIBLE_ROOMS: 'accessibleRooms',
      ACTIVE_ROOMS: 'activeRooms',
      ROOM_EVENT_LOG: 'roomEventLog:',
    },
    set: (k: string, v: unknown) => (envStore.set(k, String(v)), nowPromise('OK')),
    get: (k: string) => nowPromise(envStore.get(k)),
    del: (k: string) => (envStore.delete(k), nowPromise('OK')),
    // roomEventLog 是 env hash（单 key 内嵌 {field: value}，storage lib/db.js dbEnvHmget L686-699）
    hset: (k: string, field: string, v: unknown) => {
      const hash = JSON.parse(envStore.get(k) || '{}')
      hash[field] = String(v)
      envStore.set(k, JSON.stringify(hash))
      return nowPromise(String(v))
    },
    hmget: (k: string, ids: string[]) => {
      let hash: Record<string, string> = {}
      try { hash = JSON.parse(envStore.get(k) || '{}') } catch { hash = {} }
      return nowPromise(ids.map(id => hash[id] ?? null))
    },
    smembers: (k: string) => {
      const v = envStore.get(k)
      return nowPromise(typeof v === 'string' && v.length > 0 ? v.split('\n') : [])
    },
    sadd: (k: string, v: string) => {
      const cur = envStore.get(k)
      const parts = typeof cur === 'string' && cur.length > 0 ? cur.split('\n') : []
      if (!parts.includes(v)) parts.push(v)
      envStore.set(k, parts.join('\n'))
      return nowPromise('OK')
    },
  }
  const common = {
    storage: { db, env, pubsub: {
          publish: (k: string, v: unknown) => (published.push([k, v]), nowPromise('OK')),
          subscribe: (channel: string, listener: (payload: string) => void) => {
            pubsubListeners.push({ channel, listener })
            return () => {}
          },
        }, resetAllData: () => nowPromise('OK') },
    configManager: {
      config: {
        common: {
          constants: {
            GCL_MULTIPLY: 1000000,
            GCL_POW: 2.4,
            SPAWN_ENERGY_START: 300,
            SPAWN_ENERGY_CAPACITY: 300,
            SPAWN_HITS: 2500,
            TERRAIN_MASK_WALL: 1,
          },
        },
      },
    },
    checkTerrain: (terrain: unknown, x: number, y: number, mask: number) => {
      void terrain
      void mask
      return x === 0 && y === 0 // (0,0) 视为墙，其余可放
    },
    getGametime: () => nowPromise(1000),
    // stock @screeps/common 的坐标映射（path-finder.js parseRoomName 的逆变换）
    roomNameToXY: (roomName: string) => {
      const m = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName)!
      const xx = m[1] === 'W' ? 127 - Number(m[2]) : 128 + Number(m[2])
      const yy = m[3] === 'N' ? 127 - Number(m[4]) : 128 + Number(m[4])
      return [xx, yy]
    },
    getRoomNameFromXY: (xx: number, yy: number) =>
      (xx <= 127 ? 'W' + (127 - xx) : 'E' + (xx - 128)) + (yy <= 127 ? 'N' + (127 - yy) : 'S' + (yy - 128)),
  }
  return {
    db,
    envStore,
    published,
    driverCalls,
    cliMapCalls,
    pubsubListeners,
    deps: {
      common,
      authlib: { genToken: (uid: string) => nowPromise('token-for-' + uid) },
      backendUtils: { activateRoom: (room: string) => { void room; return nowPromise('OK') } },
      cliMap: {
        // 仿 stock generateRoom：真实地形行插入 db（L558）；opts（exits 等）透传记录到
        // cliMapCalls，测试断言调用形状
        generateRoom: (room: string, opts?: Record<string, any>) => {
          db._collections['rooms.terrain'].push({ _id: 'gen-' + room, room, terrain: '0'.repeat(2500) })
          cliMapCalls.push('generateRoom:' + room + ':' + JSON.stringify(opts ?? {}))
          return nowPromise('generated ' + room)
        },
        updateTerrainData: () => (cliMapCalls.push('updateTerrainData'), nowPromise('OK')),
      },
      express: fakeExpress(),
      driver: {
        updateAccessibleRoomsList: () => (driverCalls.push('updateAccessibleRoomsList'), nowPromise('OK')),
        updateRoomStatusData: () => (driverCalls.push('updateRoomStatusData'), nowPromise('OK')),
      },
    },
  }
}

function fakeExpress() {
  const routes: { post: Record<string, any>; get: Record<string, any> } = { post: {}, get: {} }
  const router = {
    _routes: routes,
    post(path: string, handler: any) {
      routes.post[path] = handler
    },
    get(path: string, handler: any) {
      routes.get[path] = handler
    },
  }
  const express = { Router: () => router }
  return express
}

function loadMod() {
  const mod = requireCjs('../../screeps-mod/arena-mod.cjs')
  return mod
}

function installMod(depsBundle: ReturnType<typeof makeDeps>) {
  const mod = loadMod()
  const mounted: Array<{ path: string; mw: any[] }> = []
  const fakeRouter = {
    use(path: string, ...mw: any[]) {
      mounted.push({ path, mw })
    },
  }
  mod._testInject(depsBundle.deps)
  mod._testReset()
  mod({ backend: { router: fakeRouter } })
  const arena = mounted[0]
  if (!arena || arena.path !== '/arena') throw new Error('arena router not mounted under /arena')
  const guard = arena.mw[0]
  const routes = arena.mw[1]._routes
  return { guard, routes }
}

interface FakeReqOptions {
  body?: any
  query?: any
  headers?: Record<string, string>
  remoteAddress?: string
  get?: (h: string) => string | undefined
}

function fakeReqRes({ body = {}, query = {}, headers = {}, remoteAddress = '127.0.0.1', get = () => undefined }: FakeReqOptions = {}) {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, any> | undefined,
    json(payload: Record<string, any>) {
      this.body = payload
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
  }
  const req = {
    body,
    query,
    socket: { remoteAddress: remoteAddress },
    get,
    headers,
  }
  return { req, res }
}

/* ---------------- 测试 ---------------- */

describe('arena mod guard', () => {
  it('rejects non-loopback sources', async () => {
    const bundle = makeDeps()
    const { guard } = installMod(bundle)
    const { req, res } = fakeReqRes({ remoteAddress: '10.1.2.3' })
    guard(req, res, () => {
      throw new Error('next should not be called')
    })
    expect(res.statusCode).toBe(403)
    expect(res.body?.ok).toBe(false)
  })

  it('passes loopback without secret file', async () => {
    const bundle = makeDeps()
    const { guard } = installMod(bundle)
    const { req, res } = fakeReqRes()
    let nextCalled = false
    guard(req, res, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBe(200)
  })

  it('enforces shared secret when the file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-secret-'))
    writeFileSync(join(dir, '.dsh-arena-secret'), 'sekrit')
    const oldCwd = process.cwd()
    process.chdir(dir)
    try {
      const bundle = makeDeps()
      const { guard } = installMod(bundle)
      const bad = fakeReqRes({ get: (h: string) => (h === 'x-arena-secret' ? 'wrong' : undefined) })
      guard(bad.req, bad.res, () => {
        throw new Error('next should not be called')
      })
      expect(bad.res.statusCode).toBe(403)
      const good = fakeReqRes({ get: (h: string) => (h === 'x-arena-secret' ? 'sekrit' : undefined) })
      let nextCalled = false
      guard(good.req, good.res, () => {
        nextCalled = true
      })
      expect(nextCalled).toBe(true)
    } finally {
      process.chdir(oldCwd)
    }
  })
})

describe('arena mod routes', () => {
  let bundle: ReturnType<typeof makeDeps>
  let routes: ReturnType<typeof installMod>['routes']

  beforeEach(() => {
    bundle = makeDeps()
    ;({ routes } = installMod(bundle))
  })

  function seedRoom(room: string, owned: string | null) {
    bundle.db._collections['rooms.terrain'].push({ room, terrain: '0'.repeat(2500) })
    bundle.db._collections['rooms.objects'].push({ _id: 'c1', room, type: 'controller', user: owned ?? null, level: 0 })
  }

  it('POST /users creates user, code, spawn and claims controller', async () => {
    seedRoom('E1N1', null)
    const { req, res } = fakeReqRes({ body: { username: 'agent_a', room: 'E1N1', code: { main: 'module.exports.loop=function(){}' } } })
    await routes.post['/users'](req, res)
    expect(res.statusCode).toBe(200)
    expect(res.body?.ok).toBe(true)
    expect((res.body?.user as any)?.username).toBe('agent_a')
    // 副作用断言
    expect(bundle.db._collections.users).toHaveLength(1)
    expect(bundle.db._collections['users.code']).toHaveLength(1)
    expect(bundle.db._collections['users.code'][0]!.modules.main).toContain('loop')
    // timestamp 缺失会导致 userCodeTimestamp=0 → driver VM 缓存异常（S7a 根因），必须带上
    expect(typeof bundle.db._collections['users.code'][0]!.timestamp).toBe('number')
    expect(bundle.db._collections['users.code'][0]!.timestamp).toBeGreaterThan(0)
    const spawn = bundle.db._collections['rooms.objects'].find((o: any) => o.type === 'spawn')
    const uid2 = (res.body?.user as any)?.id
    expect(spawn?.user).toBe(uid2)
    const controller = bundle.db._collections['rooms.objects'].find((o: any) => o.type === 'controller')
    expect(controller?.user).toBe(uid2)
    expect(controller?.level).toBe(1)
    expect(controller?.safeMode).toBe(1000 + 20000)
  })

  it('POST /users rejects owned rooms and duplicate usernames', async () => {
    seedRoom('E1N1', 'someone')
    const res1 = fakeReqRes({ body: { username: 'a', room: 'E1N1' } })
    await routes.post['/users'](res1.req, res1.res)
    expect(res1.res.statusCode).toBe(400)
    expect(res1.res.body?.error).toContain('already owned')

    seedRoom('E2N2', null)
    bundle.db._collections.users.push({ _id: 'u9', username: 'dup' })
    const res2 = fakeReqRes({ body: { username: 'dup', room: 'E2N2' } })
    await routes.post['/users'](res2.req, res2.res)
    expect(res2.res.statusCode).toBe(400)
    expect(res2.res.body?.error).toContain('already exists')
  })

  it('POST /users validates username and room format', async () => {
    for (const body of [{ username: 'bad name!', room: 'E1N1' }, { username: 'ok', room: 'nonsense' }]) {
      const { req, res } = fakeReqRes({ body })
      await routes.post['/users'](req, res)
      expect(res.statusCode).toBe(400)
    }
  })

  it('POST /token issues token for existing user', async () => {
    bundle.db._collections.users.push({ _id: 'u1', username: 'agent_a' })
    const { req, res } = fakeReqRes({ body: { username: 'agent_a' } })
    await routes.post['/token'](req, res)
    expect(res.body).toMatchObject({ ok: true, token: 'token-for-u1' })
  })

  it('POST /token 404s unknown user', async () => {
    const { req, res } = fakeReqRes({ body: { username: 'ghost' } })
    await routes.post['/token'](req, res)
    expect(res.statusCode).toBe(404)
  })

  it('GET /world shapes the snapshot', async () => {
    seedRoom('E1N1', null)
    const { req, res } = fakeReqRes({ body: { username: 'agent_a', room: 'E1N1' } })
    await routes.post['/users'](req, res)
    const uid = (res.body?.user as any)?.id
    const { req: r2, res: res2 } = fakeReqRes()
    await routes.get['/world'](r2, res2)
    expect(res2.body?.ok).toBe(true)
    expect(res2.body?.gameTime).toBe(1000)
    const u = (res2.body?.users as Array<Record<string, unknown>> | undefined)?.find(x => x.id === uid)
    expect(u).toMatchObject({ username: 'agent_a', ownedRooms: 1, rclTotal: 1, spawns: 1 })
  })

  it('POST /system handles pause/resume/tick/reset and rejects unknown', async () => {
    const pause = fakeReqRes({ body: { cmd: 'pause' } })
    await routes.post['/system'](pause.req, pause.res)
    expect(pause.res.body).toMatchObject({ ok: true, paused: true })
    expect(bundle.envStore.get('mainLoopPaused')).toBe('1')

    const tick = fakeReqRes({ body: { cmd: 'setTickDuration', value: 200 } })
    await routes.post['/system'](tick.req, tick.res)
    expect(tick.res.body).toMatchObject({ ok: true, tickDuration: 200 })
    expect(bundle.envStore.get('tickRate')).toBe('200')
    expect(bundle.published).toContainEqual(['setTickRate', 200])

    const badTick = fakeReqRes({ body: { cmd: 'setTickDuration', value: -5 } })
    await routes.post['/system'](badTick.req, badTick.res)
    expect(badTick.res.statusCode).toBe(400)

    const unknown = fakeReqRes({ body: { cmd: 'selfDestruct' } })
    await routes.post['/system'](unknown.req, unknown.res)
    expect(unknown.res.statusCode).toBe(400)
  })

  it('POST /system terrainRooms reports runner-view env blob vs db terrain', async () => {
    // env.terrainData 是 runner init 一次性读取的整包（deflate+base64，updateTerrainData 产物）
    const zlib = await import('node:zlib')
    const blobRooms = [
      { room: 'E5N5', terrain: '0'.repeat(2500) },
      { room: 'W7N8', terrain: '1'.repeat(2500) },
    ]
    bundle.envStore.set('terrainData', zlib.deflateSync(Buffer.from(JSON.stringify(blobRooms))).toString('base64'))
    bundle.db._collections['rooms.terrain'].push({ room: 'E5N5', terrain: '0'.repeat(2500) })

    const probe = fakeReqRes({ body: { cmd: 'terrainRooms' } })
    await routes.post['/system'](probe.req, probe.res)
    expect(probe.res.statusCode).toBe(200)
    expect(probe.res.body).toMatchObject({
      ok: true,
      envBlobPresent: true,
      envRooms: ['E5N5', 'W7N8'],
      blobError: null,
      dbTerrainRooms: ['E5N5'],
    })
  })

  it('POST /system terrainRooms tolerates missing env blob', async () => {
    const probe = fakeReqRes({ body: { cmd: 'terrainRooms' } })
    await routes.post['/system'](probe.req, probe.res)
    expect(probe.res.body).toMatchObject({ ok: true, envBlobPresent: false, envRooms: [], blobError: null, dbTerrainRooms: [] })
  })

  it('installs at most one unhandledRejection guard (survives repeated loads)', async () => {
    const before = process.listenerCount('unhandledRejection')
    installMod(makeDeps())
    const afterOne = process.listenerCount('unhandledRejection')
    installMod(makeDeps())
    const afterTwo = process.listenerCount('unhandledRejection')
    // 重复加载不叠加守卫
    expect(afterTwo).toBe(afterOne)
    // 首次加载（此前无人安装时）要装上守卫
    expect(afterOne).toBeGreaterThanOrEqual(before + (before === 0 ? 1 : 0))
  })

  it('seeds roomStatusData lazily on first arena route hit (not at mod load)', async () => {
    // mod 加载期 storage 未 connect，env.get 不存在——加载期不得触碰 env
    expect(bundle.envStore.has('roomStatusData')).toBe(false)
    const probe = fakeReqRes({ body: { cmd: 'getTickDuration' } })
    await routes.post['/system'](probe.req, probe.res)
    expect(probe.res.body?.ok).toBe(true)
    expect(bundle.envStore.get('roomStatusData')).toBe('{"closed":{},"novice":{},"respawn":{}}')
  })

  it('POST /system generateRoom appends accessibleRooms and walled-neighbor stubs', async () => {
    // 回归 1：addAccessibleRoom 曾未定义 → generateRoom 半执行（房间生成了、accessibleRooms
    // 断供）→ VM WorldMapGrid 缺房 → 永久 "Could not load terrain data"（m0-flake §三）
    // 回归 2：resetArena 清空基础地形后，A* 探测到未生成的邻接房间 → pf.cc throw
    //（~50% flake 的真身，pf 探针实证 MISS id）→ 8 邻居 walled stub 让 A* 读墙即停
    bundle.envStore.set('accessibleRooms', '[]')
    const res = fakeReqRes({ body: { cmd: 'generateRoom', value: 'W45N74' } })
    await routes.post['/system'](res.req, res.res)
    expect(res.res.body).toMatchObject({ ok: true, generated: 'W45N74' })
    expect(JSON.parse(bundle.envStore.get('accessibleRooms')!)).toEqual(['W45N74'])
    // blob 在 stub 插入后重建
    expect(bundle.cliMapCalls).toContain('updateTerrainData')
    // 8 个邻居全部拿到 walled stub（terrain 全 1）
    const terrain = bundle.db._collections['rooms.terrain']
    const stubs = terrain.filter((t: any) => t.terrain === '1'.repeat(2500))
    const stubNames = stubs.map((t: any) => t.room).sort()
    expect(stubNames).toEqual(['W44N73', 'W44N74', 'W44N75', 'W45N73', 'W45N75', 'W46N73', 'W46N74', 'W46N75'])

    const res2 = fakeReqRes({ body: { cmd: 'generateRoom', value: 'W68N70' } })
    await routes.post['/system'](res2.req, res2.res)
    expect(res2.res.body?.ok).toBe(true)
    expect(JSON.parse(bundle.envStore.get('accessibleRooms')!)).toEqual(['W45N74', 'W68N70'])
  })

  it('POST /system generateRoom clears its own stale stub so one room has exactly one terrain row', async () => {
    // 回归（m0stub2-2 实证）：B 房相邻于 A 房时，A 的 ring stub 先占位，stock generateRoom
    // 再插真地形行 → 同房两行 → placeSpawn 的 findOne 命中全墙桩 → "no free terrain cell"
    bundle.envStore.set('accessibleRooms', '[]')
    // 预置：W44N74 的墙桩已存在（上一房 ring 留下）
    bundle.db._collections['rooms.terrain'].push({ _id: 'stub-1', room: 'W44N74', terrain: '1'.repeat(2500) })
    const res = fakeReqRes({ body: { cmd: 'generateRoom', value: 'W44N74' } })
    await routes.post['/system'](res.req, res.res)
    expect(res.res.body?.ok).toBe(true)
    const rows = bundle.db._collections['rooms.terrain'].filter((t: any) => t.room === 'W44N74')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.terrain).toBe('0'.repeat(2500)) // 真 terrain，非墙桩
  })

  it('POST /system consoleOutput buffers console messages per user', async () => {
    // createUser 订阅 user:<uid>/console；模拟 engine publish → buffer → 取回
    seedRoom('E1N1', null)
    const created = fakeReqRes({ body: { username: 'agent_a', room: 'E1N1' } })
    await routes.post['/users'](created.req, created.res)
    const uid = (created.res.body?.user as any)?.id as string
    expect(uid).toBeTruthy()

    // 模拟 driver 的 console publish（经 pubsub 监听器进入 ring buffer）。
    // 真实链路：RpcClient.subscribe 包装 (channel, ...args) => cb.apply({channel}, args)，
    // 用户回调只收到一个实参 = payload（JSON 串）——不是 (channel, data) 两参。
    // 真实 publish 形状（driver.sendConsoleMessages）：{messages:{log,results},userId}
    const listener = bundle.pubsubListeners.find(l => l.channel.startsWith('user:'))?.listener
    expect(listener).toBeDefined()
    if (!listener) return
    listener(JSON.stringify({ messages: { log: ['TOOL_E2E 1', '2'], results: [] }, userId: uid }))

    const probe = fakeReqRes({
      body: { cmd: 'consoleOutput', value: { user: 'agent_a', since: 0 } },
    })
    await routes.post['/system'](probe.req, probe.res)
    expect(probe.res.body?.ok).toBe(true)
    expect(probe.res.body?.bound).toBe(true)
    const lines = probe.res.body?.lines as Array<{ messages: { log: string[]; results: string[] }; userId: string }>
    expect(lines).toHaveLength(1)
    expect(lines[0]!.messages.log).toEqual(['TOOL_E2E 1', '2'])
    expect(lines[0]!.userId).toBe(uid)
  })

  it('POST /system resume refreshes world meta before unpausing', async () => {
    bundle.envStore.set('mainLoopPaused', '1')
    const res = fakeReqRes({ body: { cmd: 'resume' } })
    await routes.post['/system'](res.req, res.res)
    expect(res.res.body).toMatchObject({ ok: true, paused: false, worldMetaRefreshed: true })
    // 顺序即语义：先重建 accessibleRooms/roomStatusData，再放行世界
    expect(bundle.driverCalls).toEqual(['updateAccessibleRoomsList', 'updateRoomStatusData'])
    expect(bundle.envStore.get('mainLoopPaused')).toBe('0')
  })

  it('POST /system eventLog collects roomsDone -> roomEventLog with whole-room dedup (sparse ring)', async () => {
    // 触发事件采集器订阅（首个 /system 调用会 ensureEventCollector）
    await routes.post['/system'](fakeReqRes({ body: { cmd: 'getTickDuration' } }).req, fakeReqRes({ body: { cmd: 'getTickDuration' } }).res)
    // 房间存在（db.rooms 是采集器拉房表的来源）
    bundle.db._collections.rooms.push({ _id: 'W15N15', invaderGoal: 1000000 })

    const roomsDone = bundle.pubsubListeners.find(l => l.channel === 'roomsDone')?.listener
    expect(roomsDone).toBeDefined()
    if (!roomsDone) return

    const setHash = (room: string, raw: string) => {
      const hash = JSON.parse(bundle.envStore.get('roomEventLog:') || '{}')
      hash[room] = raw
      bundle.envStore.set('roomEventLog:', JSON.stringify(hash))
    }
    const pump = async (tick: number) => {
      roomsDone(String(tick))
      await new Promise(r => setTimeout(r, 5))
    }

    const attack = { event: 15, objectId: 'att1', data: { targetId: 'victim1', damage: 30, attackType: 2 } }
    const destroyed = { event: 4, objectId: 'victim1', data: { type: 'creep' } }

    // tick 100：ATTACK（连续攻击场景）
    setHash('W15N15', JSON.stringify([attack]))
    await pump(100)
    // tick 101：完全同形（整组相同 → 去重跳过，不 push）
    setHash('W15N15', JSON.stringify([attack]))
    await pump(101)
    // tick 102：死亡 tick [ATTACK, DESTROYED] ≠ [ATTACK] → 必须保留
    setHash('W15N15', JSON.stringify([attack, destroyed]))
    await pump(102)

    const probe = fakeReqRes({ body: { cmd: 'eventLog', value: 0 } })
    await routes.post['/system'](probe.req, probe.res)
    expect(probe.res.body?.ok).toBe(true)
    expect(probe.res.body?.bound).toBe(true)
    expect(probe.res.body?.cursor).toBe(2)
    const events = probe.res.body?.events as Array<{ tick: number; eventsByRoom: Record<string, any[]> }>
    expect(events).toHaveLength(2)
    expect(events[0]!.tick).toBe(100)
    expect(events[0]!.eventsByRoom['W15N15']).toHaveLength(1) // 中间 tick 整组去重
    expect(events[1]!.tick).toBe(102)
    expect(events[1]!.eventsByRoom['W15N15']).toHaveLength(2) // 死亡 tick 双事件齐全（kills 归因不断链）
  })

  it('eventLog resolves user via rooms.objects then tombstone/ruin fallback', async () => {
    await routes.post['/system'](fakeReqRes({ body: { cmd: 'getTickDuration' } }).req, fakeReqRes({ body: { cmd: 'getTickDuration' } }).res)
    bundle.db._collections.rooms.push({ _id: 'W15N15' })
    // 攻击者还活着（rooms.objects 里有）；目标已死（只有 tombstone）
    bundle.db._collections['rooms.objects'].push({ _id: 'att1', type: 'creep', user: 'uA' })
    bundle.db._collections['rooms.objects'].push({ _id: 't1', type: 'tombstone', creepId: 'victim1', user: 'uB' })

    const roomsDone = bundle.pubsubListeners.find(l => l.channel === 'roomsDone')?.listener!
    bundle.envStore.set(
      'roomEventLog:',
      JSON.stringify({
        W15N15: JSON.stringify([
          { event: 15, objectId: 'att1', data: { targetId: 'victim1', damage: 30, attackType: 2 } },
          { event: 4, objectId: 'victim1', data: { type: 'creep' } },
        ]),
      }),
    )
    roomsDone('500')
    await new Promise(r => setTimeout(r, 5))

    const probe = fakeReqRes({ body: { cmd: 'eventLog', value: 0 } })
    await routes.post['/system'](probe.req, probe.res)
    const entry = (probe.res.body?.events as any[])[0]
    const [attackEv, destroyedEv] = entry.eventsByRoom['W15N15']
    expect(attackEv.attackerUser).toBe('uA') // objectId 活体解析
    expect(attackEv.targetUser).toBe('uB') // targetId 经 tombstone 兜底
    expect(destroyedEv.attackerUser).toBe('uB') // DESTROYED.objectId 经 tombstone 兜底
  })

  it('POST /system generateRoom passes exits through (string and {room, exits} forms)', async () => {
    bundle.envStore.set('accessibleRooms', '[]')
    const stringForm = fakeReqRes({ body: { cmd: 'generateRoom', value: 'W15N15' } })
    await routes.post['/system'](stringForm.req, stringForm.res)
    expect(stringForm.res.body).toMatchObject({ ok: true, generated: 'W15N15', exits: null })

    const objectForm = fakeReqRes({ body: { cmd: 'generateRoom', value: { room: 'W15N16', exits: { bottom: [22, 23, 24] } } } })
    await routes.post['/system'](objectForm.req, objectForm.res)
    expect(objectForm.res.body).toMatchObject({ ok: true, generated: 'W15N16', exits: { bottom: [22, 23, 24] } })
    // 透传给 stock cliMap.generateRoom(room, {exits})
    expect(bundle.cliMapCalls).toContain('generateRoom:W15N16:{"exits":{"bottom":[22,23,24]}}')
    // 8 邻居墙桩依旧（addWalledNeighbors 只补未生成邻居，已生成房跳过）
    const stubs = bundle.db._collections['rooms.terrain'].filter((t: any) => t.terrain === '1'.repeat(2500))
    expect(stubs.length).toBeGreaterThan(0)
  })

  it('POST /system clearSafeMode zeroes controller safeMode and roomObjects exposes it', async () => {
    seedRoom('E1N1', null)
    const created = fakeReqRes({ body: { username: 'agent_a', room: 'E1N1' } })
    await routes.post['/users'](created.req, created.res)
    const controller = bundle.db._collections['rooms.objects'].find((o: any) => o.type === 'controller')
    expect(controller?.safeMode).toBe(1000 + 20000) // 开局自带

    const clear = fakeReqRes({ body: { cmd: 'clearSafeMode', value: 'E1N1' } })
    await routes.post['/system'](clear.req, clear.res)
    expect(clear.res.body?.ok).toBe(true)
    expect(clear.res.body?.safeMode).toBe(999) // gameTime(1000) - 1
    expect(bundle.db._collections['rooms.objects'].find((o: any) => o.type === 'controller')?.safeMode).toBe(999)

    const probe = fakeReqRes({ body: { cmd: 'roomObjects', value: 'E1N1' } })
    await routes.post['/system'](probe.req, probe.res)
    const ctrl = (probe.res.body?.objects as any[]).find((o: any) => o.type === 'controller')
    expect(ctrl?.safeMode).toBe(999) // 断言数据源存在
  })

  it('POST /system resetArena clears roomEventLog env hash (ring cross-match hygiene)', async () => {
    bundle.envStore.set('roomEventLog:', JSON.stringify({ W15N15: '[{"event":4,"objectId":"x","data":{}}]' }))
    const probe = fakeReqRes({ body: { cmd: 'resetArena' } })
    await routes.post['/system'](probe.req, probe.res)
    expect(probe.res.body?.ok).toBe(true)
    expect(bundle.envStore.has('roomEventLog:')).toBe(false)
  })

  // ---- M4-A0：canonical replay bridge 集成（replayStart → roomsDone → page → stop）----

  async function system(cmd: string, value: any) {
    const { req, res } = fakeReqRes({ body: { cmd, value } })
    await routes.post['/system'](req, res)
    if (!res.body?.ok) throw new Error(`system ${cmd} failed: ${String(res.body?.error ?? res.body)}`)
    return res.body
  }

  function fireRoomsDone(tick: number) {
    const listener = bundle.pubsubListeners.find(l => l.channel === 'roomsDone')?.listener
    if (!listener) throw new Error('no roomsDone subscriber')
    listener(String(tick))
  }

  it('replay: start → roomsDone frames → page cursor → stop complete (single active)', async () => {
    // 准备房间元数据 + 一个 controller（白名单帧内容源）
    bundle.db._collections.rooms.push({ _id: 'W15N15', status: 'normal' })
    bundle.db._collections['rooms.objects'].push({ _id: 'o1', room: 'W15N15', type: 'controller', user: 'u1', level: 2 })
    bundle.db._collections.users.push({ _id: 'u1', username: 'player_a' })

    // 首次 /system 已确保订阅存在（routes beforeEach 里没调过；先调一次 getTickDuration）
    await system('getTickDuration', undefined)
    const started = await system('replayStart', { replayId: 'r1', matchId: 'm1', rooms: ['W15N15'] })
    expect(started.schemaVersion).toBe(1)
    expect(started.sourceGeneration).toMatch(/^g-/)
    // 第二个 active replay 被拒
    const conflict = fakeReqRes({ body: { cmd: 'replayStart', value: { replayId: 'r2', matchId: 'm2', rooms: ['W15N15'] } } })
    await routes.post['/system'](conflict.req, conflict.res)
    expect(conflict.res.statusCode).toBe(400)

    // 3 个 tick 都 accepted → frame（每个 tick 一帧）
    for (const t of [1001, 1002, 1003]) fireRoomsDone(t)
    // 等 bridge drain（异步帧产出）
    await new Promise(r => setTimeout(r, 20))

    const page = await system('replayPage', { replayId: 'r1', sourceGeneration: started.sourceGeneration, cursor: 0, limit: 10 })
    expect(page.status).toBe('live')
    expect(page.records).toHaveLength(3)
    expect(page.records.map((r: any) => r.seq)).toEqual([0, 1, 2])
    expect(page.records.every((r: any) => r.sourceGeneration === started.sourceGeneration)).toBe(true)
    // 帧白名单内容：房间有 own.username + level，不含内部字段
    const frame0 = page.records[0].frame
    expect(frame0.rooms).toHaveLength(1)
    expect(frame0.rooms[0].own).toMatchObject({ username: 'player_a', level: 2 })
    const raw = JSON.stringify(frame0)
    expect(raw).not.toContain('u1') // userId 不外泄
    expect(raw).not.toContain('_id')
    expect(raw).not.toContain('code')

    const stopped = await system('replayStop', { replayId: 'r1', sourceGeneration: started.sourceGeneration })
    expect(stopped.complete).toBe(true)
    expect(stopped.finalCursor).toBe(3)
    // stop 后同一 replay 幂等 + page complete
    const again = await system('replayStop', { replayId: 'r1', sourceGeneration: started.sourceGeneration })
    expect(again.complete).toBe(true)
    const finalPage = await system('replayPage', { replayId: 'r1', sourceGeneration: started.sourceGeneration, cursor: 0 })
    expect(finalPage.complete).toBe(true)
    // stop 后不再 accept
    fireRoomsDone(1004)
    await new Promise(r => setTimeout(r, 20))
    const fp2 = await system('replayPage', { replayId: 'r1', sourceGeneration: started.sourceGeneration, cursor: 0 })
    expect(fp2.records).toHaveLength(3)
  })

  it('replay: resetArena invalidates active bridge; new replay gets new generation', async () => {
    await system('getTickDuration', undefined)
    const s1 = await system('replayStart', { replayId: 'ra', matchId: 'ma', rooms: ['W15N15'] })
    fireRoomsDone(500)
    await new Promise(r => setTimeout(r, 20))
    // resetArena 清场 → bridge invalidated（records 保留在 state 供审计，但不可再写）
    await system('resetArena', undefined)
    fireRoomsDone(501)
    await new Promise(r => setTimeout(r, 20))
    // 新 replay 得到新 generation 且旧记录隔离
    const s2 = await system('replayStart', { replayId: 'rb', matchId: 'mb', rooms: ['W15N15'] })
    expect(s2.sourceGeneration).not.toBe(s1.sourceGeneration)
    const page2 = await system('replayPage', { replayId: 'rb', sourceGeneration: s2.sourceGeneration, cursor: 0 })
    expect(page2.records).toHaveLength(0)
  })

  it('replay: stale generation page/stop rejected; unknown replay rejected', async () => {
    await system('getTickDuration', undefined)
    const s1 = await system('replayStart', { replayId: 'rc', matchId: 'mc', rooms: ['W15N15'] })
    const stalePage = fakeReqRes({
      body: { cmd: 'replayPage', value: { replayId: 'rc', sourceGeneration: 'g-old', cursor: 0 } },
    })
    await routes.post['/system'](stalePage.req, stalePage.res)
    expect(stalePage.res.statusCode).toBe(400)
    expect(String(stalePage.res.body?.error)).toContain('stale')
    const unknown = fakeReqRes({ body: { cmd: 'replayPage', value: { replayId: 'nope', cursor: 0 } } })
    await routes.post['/system'](unknown.req, unknown.res)
    expect(unknown.res.statusCode).toBe(400)
    // 释放 active，避免影响后续测试
    await system('replayStop', { replayId: 'rc', sourceGeneration: s1.sourceGeneration })
  })
})
