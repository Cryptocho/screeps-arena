'use strict'
/**
 * screeps-arena mod — 跑在 Screeps 私服 backend 进程内的控制面。
 * 平移自 reference/screeps-mod/arena-mod.cjs，裁剪：replay bridge（M4 旧仓）、
 * 路由层（本仓走 svc.system 面）；M5/S1 回迁 arenaGen/arenaProbe 镜像克隆。
 * 保留全部防 flake 修复链（m0-flake §二）：
 * addWalledNeighbors / removeWhere 清桩 / resume 强刷 world meta / unhandledRejection
 * 守卫 / addAccessibleRoom / roomStatusData 播种 / users.code timestamp。
 *
 * 职责（对应 AGENTS.md「STEAM_KEY 真相」与「公平边界」）：
 * 1. 消除 Steam 依赖：设置占位 STEAM_KEY + stub steam-webapi 的静态 ready，
 *    服务器默认模式零 Steam 请求、零日志噪音（ready 是构造函数静态属性，
 *    auth.js 持有的是同一模块对象引用，此处变更对它可见）。
 * 2. /api/arena/* 控制面：建用户(带 spawn 部署)/发 token/世界快照/系统控制/事件流。
 *    host 通过这些路由管理对局；浏览器与 Agent 永远拿不到裸 token。
 *
 * 安全边界：
 * - 仅接受 loopback 来源；
 * - 可选共享密钥：serverDir/.screeps-arena-secret 文件存在时强制校验 X-Arena-Secret 头；
 * - mods 在 configManager.load() 阶段加载，早于 Steam setup 与路由挂载。
 *
 * 本文件运行在 backend 进程（CommonJS），依赖 @screeps/common、@screeps/backend，
 * 由 serverDir/node_modules 解析；进程 cwd = serverDir。
 */
;(function () {
  var loaded = false

  function stubSteamWebApi() {
    if (!process.env.STEAM_KEY) {
      // .screepsrc 的 steam_api_key 经 launcher 进入 backend env；这里兜底
      process.env.STEAM_KEY = 'screeps-arena-placeholder'
    }
    try {
      var SteamWebApi = require('steam-webapi')
      if (typeof SteamWebApi === 'function') {
        // 静态 ready（steam-webapi 0.6.x）：立即成功回调，阻止每秒重试刷屏
        SteamWebApi.ready = function (key, callback) {
          if (typeof key === 'function') key(null)
          else if (typeof callback === 'function') callback(null)
        }
      }
    } catch (e) {
      /* steam-webapi 不在也无所谓 */
    }
  }

  function deps() {
    // 惰性 require：测试可经 _testInject 替换
    if (module.exports._testDeps) return module.exports._testDeps
    return {
      common: require('@screeps/common'),
      authlib: require('@screeps/backend/lib/authlib'),
      backendUtils: require('@screeps/backend/lib/utils'),
      cliMap: require('@screeps/backend/lib/cli/map'),
      express: require('express'),
      // driver 仅 refreshWorldMeta 需要；backend 进程惰性 require，测试注入即可
      driver: undefined,
    }
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function ok(res, data) {
    res.json(Object.assign({ ok: true }, data || {}))
  }
  function fail(res, status, error) {
    res.status(status).json({ ok: false, error: error })
  }

  function readSecret() {
    try {
      var fs = require('fs')
      var path = require('path')
      var file = path.join(process.cwd(), '.screeps-arena-secret')
      var content = fs.readFileSync(file, { encoding: 'utf8' }).trim()
      return content.length > 0 ? content : null
    } catch (e) {
      return null
    }
  }

  function isLoopback(req) {
    var ra = (req.socket && req.socket.remoteAddress) || ''
    return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1' || ra === 'localhost'
  }

  function makeGuard() {
    var secret = readSecret()
    return function arenaGuard(req, res, next) {
      if (!isLoopback(req)) return fail(res, 403, 'arena: loopback only')
      if (secret && req.get('x-arena-secret') !== secret) return fail(res, 403, 'arena: bad secret')
      next()
    }
  }

  function badge() {
    return { type: 1, color1: '#4d6bfe', color2: '#20242c', color3: '#4d6bfe', flip: false, param: 0 }
  }

  /* ------------------------------------------------------------------ */
  /* console 捕获：订阅 pubsub user:<uid>/console，每用户 ring buffer      */
  /*（screeps_console 工具的取回通道；engine 每次 run 后 publish messages）*/
  /* ------------------------------------------------------------------ */

  var consoleBuffers = Object.create(null)
  var CONSOLE_BUFFER_MAX = 100
  // pubsub 连通性探针：backend 订阅 roomsDone（main loop 每 tick 发布），计数收到的 tick
  var pubsubProbe = { ticks: 0 } // roomsDone 接收计数（consoleOutput 探针展示；订阅主体已是事件采集器）

  function subscribeConsole(userId) {
    if (consoleBuffers[userId]) return
    var buffer = []
    consoleBuffers[userId] = buffer
    try {
      // RpcClient.subscribe（common/lib/rpc.js L143-145）把回调包成
      // (channel, ...args) => callback.apply({channel}, args) —— 用户回调只收到
      // 一个实参 = payload（channel 借 this.channel 传递）。签名必须是单参数。
      deps().common.storage.pubsub.subscribe('user:' + userId + '/console', function (payload) {
        try {
          var message = typeof payload === 'string' ? JSON.parse(payload) : payload
          buffer.push({ t: Date.now(), message: message })
          if (buffer.length > CONSOLE_BUFFER_MAX) buffer.splice(0, buffer.length - CONSOLE_BUFFER_MAX)
        } catch (e) { /* 坏帧丢弃 */ }
      })
    } catch (e) {
      console.error('[screeps-arena] console subscribe failed for ' + userId + ':', e)
    }
  }

  function bufferHasSelfTest(buffer) {
    if (!buffer) return false
    return buffer.some(function (entry) {
      var m = entry.message
      // 修复后回调收到单一 payload（字符串 JSON 或对象）
      if (typeof m === 'string') {
        try { m = JSON.parse(m) } catch (e) { return false }
      }
      return m && Array.isArray(m.messages) && m.messages.indexOf('SELFTEST') !== -1
    })
  }

  function consoleOutput(userId, since) {
    var buffer = consoleBuffers[userId]
    if (!buffer) return { lines: [], cursor: 0, bound: false }
    var from = typeof since === 'number' && since >= 0 && since <= buffer.length ? since : 0
    var lines = buffer.slice(from).map(function (entry) { return entry.message })
    return { lines: lines, cursor: buffer.length, bound: true }
  }

  function makeId() {
    // 与 arena-mod 其它随机串保持同风格；可读 + 防碰撞
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  }


  /* ------------------------------------------------------------------ */
  /* 事件流采集：订阅 roomsDone → env.hmget(roomEventLog) → ring buffer   */
  /*（screeps_report 事件聚合与 kills/losses 记分的原料；采集点 S7b 已定） */
  /*                                                                    */
  /* 语义（plan-M2 九审 PASS）:                                          */
  /* - 只 push「有变化的 tick」：逐房整组去重（与上一 tick 原始数组完全相同  */
  /*   → 陈旧重放跳过；含 DESTROYED 的 tick 必不等 → 致死 tick 永不被丢）；*/
  /* - ring 稀疏：条目 {tick, eventsByRoom}（只含变化房），游标=ring 下标；  */
  /* - bound=false = 发生过溢出丢弃（host 端 settle 记 scoreWarning）；    */
  /* - user 解析必须在 roomsDone 回调内即时做（tombstone 寿命=部件数×5 tick， */
  /*   host 拉取时再解析早已 decay）；                                   */
  /* - 被杀对象同 tick 已从 rooms.objects 移除（_die.js L12 先于 L96 push）*/
  /*   → objectId/targetId 的 user 一律经 tombstone/ruin 兜底（都在       */
  /*   rooms.objects 集合，按 type 过滤）。                              */
  /* ------------------------------------------------------------------ */

  var eventRing = [] // [{tick, eventsByRoom}]
  var EVENT_RING_MAX = 4096
  var eventRingFull = false
  var eventBusy = false // busy-guard：防回调重入堆积（find 链慢于下一 tick 发布）
  var roomPrevRaw = {} // roomId → 上一 tick 原始事件数组 JSON 串（整组去重）
  var eventCollectorReady = false

  function clearEventRing() {
    eventRing.length = 0
    eventRingFull = false
    eventBusy = false
    roomPrevRaw = {}
  }

  function ensureEventCollector() {
    if (eventCollectorReady) return
    eventCollectorReady = true
    try {
      // RpcClient.subscribe 回调单参（payload=gameTime），channel 借 this.channel
      deps().common.storage.pubsub.subscribe('roomsDone', function (gameTime) {
        pubsubProbe.ticks++
        if (eventBusy) return // 处理中丢 tick（busy-guard；host 靠 bound/dump 自查）
        eventBusy = true
        collectEventLog(Math.max(0, Number(gameTime) || 0)).then(
          function () { eventBusy = false },
          function (e) {
            eventBusy = false
            console.error('[screeps-arena] event collect failed:', e && e.stack ? e.stack : e)
          },
        )
      })
    } catch (e) {
      console.error('[screeps-arena] event collector subscribe failed:', e)
      eventCollectorReady = false
    }
  }

  /** roomsDone 回调主链：按房拉取事件 → 整组去重 → 解析 user → 入 ring。 */
  function collectEventLog(gameTime) {
    var common = deps().common
    var db = common.storage.db
    var env = common.storage.env
    return db.rooms.find({}, { _id: true }).then(function (rooms) {
      var roomIds = rooms.map(function (r) { return r._id })
      if (roomIds.length === 0) return
      return env.hmget(env.keys.ROOM_EVENT_LOG, roomIds).then(function (rawByRoom) {
        var eventsByRoom = {}
        var changed = false
        for (var i = 0; i < roomIds.length; i++) {
          var roomId = roomIds[i]
          var raw = rawByRoom[i]
          if (typeof raw !== 'string' || raw.length === 0) continue
          var events = []
          try { events = JSON.parse(raw) } catch (e) { continue }
          var key = JSON.stringify(events)
          if (roomPrevRaw[roomId] === key) continue // 整组去重（陈旧重放）
          roomPrevRaw[roomId] = key
          eventsByRoom[roomId] = events
          changed = true
        }
        if (!changed) return
        return resolveEventUsers(eventsByRoom).then(function (resolved) {
          eventRing.push({ tick: gameTime, eventsByRoom: resolved })
          if (eventRing.length > EVENT_RING_MAX) {
            eventRing.shift()
            eventRingFull = true
          }
        })
      })
    })
  }

  /** 把 eventsByRoom 里 ATTACK/DESTROYED 的 objectId/data.targetId 批量解析为 user。 */
  function resolveEventUsers(eventsByRoom) {
    var db = deps().common.storage.db
    var allIds = []
    var seen = {}
    Object.keys(eventsByRoom).forEach(function (roomId) {
      eventsByRoom[roomId].forEach(function (ev) {
        if (ev && typeof ev.objectId === 'string' && !seen[ev.objectId]) {
          seen[ev.objectId] = true
          allIds.push(ev.objectId)
        }
        if (ev && ev.data && typeof ev.data.targetId === 'string' && !seen[ev.data.targetId]) {
          seen[ev.data.targetId] = true
          allIds.push(ev.data.targetId)
        }
      })
    })
    if (allIds.length === 0) return Promise.resolve(eventsByRoom)
    var userById = {}
    var infoById = {}
    return db['rooms.objects']
      .find({ _id: { $in: allIds } })
      .then(function (alive) {
        var missing = []
        var aliveById = {}
        alive.forEach(function (o) { aliveById[o._id] = o })
        allIds.forEach(function (id) {
          if (aliveById[id] !== undefined) {
            userById[id] = aliveById[id].user != null ? aliveById[id].user : null
            infoById[id] = { x: aliveById[id].x, y: aliveById[id].y, type: aliveById[id].type, via: 'live' }
          } else missing.push(id)
        })
        if (missing.length === 0) return
        // 被杀对象已移除 → tombstone（creep）与 ruin（structure）兜底，都在本集合
        return db['rooms.objects']
          .find({ type: 'tombstone', creepId: { $in: missing } })
          .then(function (tombstones) {
            var ruinMissing = []
            var tombFound = {}
            tombstones.forEach(function (t) {
              if (t.creepId != null) {
                tombFound[t.creepId] = true
                userById[t.creepId] = t.user != null ? t.user : null
                // M6/D1 type 取值链：tombstone 语义必为 creep（引擎 _die.js 无原 type 字段，
                // 仅 creepBody——有原 type 字段则以之优先，防引擎变体）
                infoById[t.creepId] = { x: t.x, y: t.y, type: typeof t.creepType === 'string' ? t.creepType : 'creep', via: 'tombstone' }
              }
            })
            missing.forEach(function (id) {
              if (!tombFound[id]) ruinMissing.push(id)
            })
            if (ruinMissing.length === 0) return
            return db['rooms.objects'].find({ type: 'ruin', 'structure.id': { $in: ruinMissing } }).then(function (ruins) {
              ruins.forEach(function (r) {
                var sid = r.structure && r.structure.id != null ? r.structure.id : null
                if (sid == null) return
                var owner = r.structure && r.structure.user != null ? r.structure.user : r.user != null ? r.user : null
                userById[sid] = owner
                // M6/D1 type 取值链：ruin 把原 structure 挂在 structure 子档（_destroy.js L19-27）
                var stype = r.structure && r.structure.type != null ? r.structure.type : 'unknown'
                infoById[sid] = { x: r.x, y: r.y, type: stype, via: 'ruin' }
              })
            })
          })
      })
      .then(function () {
        Object.keys(eventsByRoom).forEach(function (roomId) {
          eventsByRoom[roomId] = eventsByRoom[roomId].map(function (ev) {
            var out = { event: ev.event, objectId: ev.objectId, data: ev.data || {} }
            // 字段名沿用 plan-M2 契约：objectId 归属挂 attackerUser（对 ATTACK=攻击方，
            // 对 DESTROYED=被毁对象 owner——host 归因按事件类型取用）；targetId 归属挂 targetUser。
            if (typeof ev.objectId === 'string') {
              out.attackerUser = userById[ev.objectId] !== undefined ? userById[ev.objectId] : null
            }
            if (ev.data && typeof ev.data.targetId === 'string') {
              out.targetUser = userById[ev.data.targetId] !== undefined ? userById[ev.data.targetId] : null
            }
            // M6/D1 enrich：位置/类型（只加字段，不改既有字段；解析不到 = null → 前端降级房级）
            if (typeof ev.objectId === 'string') {
              out.objectInfo = infoById[ev.objectId] !== undefined ? infoById[ev.objectId] : null
            }
            if (ev.data && typeof ev.data.targetId === 'string') {
              out.targetInfo = infoById[ev.data.targetId] !== undefined ? infoById[ev.data.targetId] : null
            }
            return out
          })
        })
        return eventsByRoom
      })
  }

  /* ------------------------------------------------------------------ */
  /* 业务：建用户 + spawn 部署（照抄 bots.spawn 的对象插入语义）           */
  /* ------------------------------------------------------------------ */

  function realCreateUser(opts) {
    var d = deps()
    var common = d.common
    var db = common.storage.db
    var env = common.storage.env
    var C = common.configManager.config.common.constants

    if (!opts || typeof opts.username !== 'string' || !/^[A-Za-z0-9_-]{1,30}$/.test(opts.username)) {
      return Promise.reject('invalid username')
    }
    if (typeof opts.room !== 'string' || !/^[WE]\d+[NS]\d+$/.test(opts.room)) {
      return Promise.reject('room is required (format like E1N1)')
    }
    var username = opts.username
    var roomName = opts.room

    return db['rooms.objects'].findOne({ $and: [{ room: roomName }, { type: 'controller' }] })
      .then(function (controller) {
        if (!controller) throw 'room controller not found in ' + roomName + ' (generate the room first)'
        if (controller.user && !opts.force) {
          // M5 live 实测：无主 accessible 房会被 backend 墙钟 cronjob（genStrongholds/
          // genInvaders，不受 MAIN_LOOP_PAUSED 影响）殖民——invaderCore + controller
          // 归 Invader（user='2'）→ 建号撞 already owned。
          // 判据（实体占位）：房内有该 user 的 spawn/creep 才算真冲突（维持拒绝）；
          // 仅 controller/invaderCore/rampart 归属（无玩家单位实体）= NPC 占位，清掉重赋权。
          // force=true（host 侧 Arena 战场专用，svc.createUser 透传，LLM 不可达）直接赋权。
          var hasEntity = db['rooms.objects']
            .findOne({ $and: [{ room: roomName }, { user: controller.user }, { type: { $in: ['spawn', 'creep'] } }] })
          if (hasEntity) throw 'room ' + roomName + ' is already owned'
        }
        // [M2 fix] 兜底：launch.it 之后 m2-battle 重跑同一房名时，stock generateRoom
        // 会从 db.rooms[room].reservedBy 拷贝 user 字段到 controller.user（即便 db.rooms
        // 被 resetArena clear 过，但 run-loop 中 placeSpawn/reserve 又会写回）。
        // 显式清 reservation 字段，避免下次 create 撞旧 owner。
        return Promise.resolve(controller).then(function (c) {
          if (c.reservation) {
            return db['rooms.objects'].update({ _id: c._id }, { $unset: { reservation: 1, user: 1 } }).then(function () { return c })
          }
          return c
        })
      })
      .then(function () { return db.users.findOne({ username: username }) })
      .then(function (existing) {
        if (existing) throw 'user "' + username + '" already exists'
        var gcl = opts.gcl && opts.gcl > 1 ? C.GCL_MULTIPLY * Math.pow(opts.gcl - 1, C.GCL_POW) : 0
        return db.users.insert({
          username: username,
          usernameLower: username.toLowerCase(),
          cpu: typeof opts.cpu === 'number' ? opts.cpu : 100,
          gcl: gcl,
          cpuAvailable: 0,
          registeredDate: new Date(),
          active: 10000,
          badge: badge(),
          bot: 'arena',
        })
      })
      .then(function (user) {
        return db['users.code']
          .insert({
            user: user._id,
            modules: typeof opts.code === 'object' && opts.code !== null ? opts.code : { main: '' },
            branch: 'default',
            activeWorld: true,
            activeSim: true,
            timestamp: Date.now(),
          })
          .then(function () { return env.set(env.keys.MEMORY + user._id, '{}') })
          .then(function () { return user })
      })
      .then(function (user) {
        subscribeConsole(user._id)
        return user
      })
      .then(function (user) {
        return placeSpawn(user, roomName, opts).then(function () { return user })
      })
  }

  function placeSpawn(user, roomName, opts) {
    var d = deps()
    var common = d.common
    var db = common.storage.db
    var env = common.storage.env
    var C = common.configManager.config.common.constants

    return db['rooms.terrain'].findOne({ room: roomName }).then(function (terrainItem) {
      if (!terrainItem) throw 'terrain not generated for ' + roomName
      var x = typeof opts.x === 'number' ? opts.x : Math.floor(3 + Math.random() * 46)
      var y = typeof opts.y === 'number' ? opts.y : Math.floor(3 + Math.random() * 46)
      var tries = 0
      while (common.checkTerrain(terrainItem.terrain, x, y, C.TERRAIN_MASK_WALL) && tries < 200) {
        x = Math.floor(3 + Math.random() * 46)
        y = Math.floor(3 + Math.random() * 46)
        tries++
      }
      if (tries >= 200) throw 'no free terrain cell found in ' + roomName
      return db['rooms.objects']
        .insert({
          type: 'spawn',
          room: roomName,
          x: x,
          y: y,
          name: 'Spawn1',
          user: user._id,
          store: { energy: C.SPAWN_ENERGY_START },
          storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
          hits: C.SPAWN_HITS,
          hitsMax: C.SPAWN_HITS,
          spawning: null,
          notifyWhenAttacked: false,
        })
        .then(common.getGametime)
        .then(function (gameTime) {
          return db['rooms.objects'].update(
            { $and: [{ room: roomName }, { type: 'controller' }] },
            { $set: { user: user._id, level: 1, progress: 0, downgradeTime: null, safeMode: gameTime + 20000 } },
          )
        })
        .then(function () {
          return db.rooms.update({ _id: roomName }, { $set: { invaderGoal: 1000000 } })
        })
        .then(function () {
          return d.backendUtils.activateRoom(roomName)
        })
    })
  }

  /* ------------------------------------------------------------------ */
  /* 业务：世界快照 / 系统控制                                            */
  /* ------------------------------------------------------------------ */

  function worldSnapshot() {
    var common = deps().common
    var db = common.storage.db
    return common.getGametime().then(function (gameTime) {
      return Promise.all([
        db.users.find({}, { _id: true, username: true, badge: true, bot: true, cpu: true, gcl: true, lastUsedCpu: true }),
        db['rooms.objects'].find({ type: 'controller', user: { $ne: null } }),
        db['rooms.objects'].find({ type: 'spawn', user: { $ne: null } }),
        db['rooms.objects'].find({ type: 'creep', user: { $ne: null } }),
      ]).then(function (results) {
        var users = results[0]
        var controllers = results[1]
        var spawns = results[2]
        var creeps = results[3]
        var byUser = {}
        controllers.forEach(function (c) {
          var entry = (byUser[c.user] = byUser[c.user] || { ownedRooms: 0, rclTotal: 0, rooms: [] })
          entry.ownedRooms++
          entry.rclTotal += c.level || 0
          entry.rooms.push({ room: c.room, level: c.level || 0, progress: c.progress || 0 })
        })
        spawns.forEach(function (s) {
          var entry = (byUser[s.user] = byUser[s.user] || { ownedRooms: 0, rclTotal: 0, rooms: [] })
          entry.spawns = (entry.spawns || 0) + 1
          // A 节：spawnEnergy = 该用户所有 spawn 的 store.energy 总和（IT1 能量对称断言数据源）
          entry.spawnEnergy = (entry.spawnEnergy || 0) + (s.store && s.store.energy ? s.store.energy : 0)
          // M6：spawn 坐标（观战坐标地图标记）。边角（spawn 房不在该用户 controller rooms[]，
          // 当前流程不可达——placeSpawn 预赋权 controller）直接丢弃，不造空 rooms 条目。
          var roomEntry = entry.rooms.filter(function (r) { return r.room === s.room })[0]
          if (roomEntry) {
            roomEntry.spawns = roomEntry.spawns || []
            roomEntry.spawns.push({ x: s.x, y: s.y })
          }
        })
        creeps.forEach(function (c) {
          var entry = (byUser[c.user] = byUser[c.user] || { ownedRooms: 0, rclTotal: 0, rooms: [] })
          entry.creeps = (entry.creeps || 0) + 1
        })
        return {
          gameTime: gameTime,
          users: users.map(function (u) {
            var stat = byUser[u._id] || { ownedRooms: 0, rclTotal: 0, rooms: [] }
            return {
              id: u._id,
              username: u.username,
              badge: u.badge,
              isBot: !!u.bot,
              cpu: u.cpu,
              lastUsedCpu: u.lastUsedCpu,
              gcl: u.gcl,
              ownedRooms: stat.ownedRooms,
              rclTotal: stat.rclTotal,
              spawns: stat.spawns || 0,
              creeps: stat.creeps || 0,
              spawnEnergy: stat.spawnEnergy || 0,
              rooms: stat.rooms,
            }
          }),
        }
      })
    })
  }

  function ensureRoomStatusData() {
    // data.js getRoomStatusData(): env 缺 key 时 JSON.parse(undefined) 崩掉该用户本次 run（60s 缓存过期复发）
    var common = deps().common
    var env = common.storage.env
    return env.get(env.keys.ROOM_STATUS_DATA).then(function (data) {
      if (!data) {
        return env.set(env.keys.ROOM_STATUS_DATA, '{"closed":{},"novice":{},"respawn":{}}')
      }
      return data
    })
  }

  /**
   * roomStatusData 惰性播种：只在 arena 路由首秀时执行一次。
   * 不能在 mod 加载期（configManager.load 阶段）调用——那时 storage 尚未 _connect，
   * env.get 不存在，同步抛 TypeError（config-manager 会吃掉它，但 arena 路由后的
   * 播种就永远丢了，还会刷一条吓人的 "Error loading arena-mod" 日志）。
   * host 的 ensure 链在就绪后立刻 setTickDuration，所以播种时机会早于一切用户 run。
   */
  var roomStatusEnsured = false
  function ensureRoomStatusOnce() {
    ensureEventCollector()
    if (roomStatusEnsured) return Promise.resolve()
    roomStatusEnsured = true
    return ensureRoomStatusData().catch(function (e) {
      console.error('[screeps-arena] roomStatusData seed failed:', e)
    })
  }

  /**
   * Node ≥15 对 unhandled rejection 默认 throw（崩进程）。stock backend 的
   * cronjobs.run 丢弃所有 job 的返回 promise（backend-local/lib/cronjobs.js L48-52），
   * 任一 cronjob 链路里的 rejection（例：LokiJS 查询异常经 storage `cb(e.message)`
   * 变成字符串 rejection 传回）都会让 backend 整个退出，launcher 随之 crash-loop，
   * 表现为对局中 HTTP 请求 "other side closed"（m0-flake §三实证）。
   * stock 代码是 q 时代写的，假设 rejection 会被吞——在 mod 层恢复这个语义：
   * 记录完整栈、进程存活。本仓库红线：mods 够到就不 fork。
   */
  function installRejectionGuard() {
    if (process.listenerCount('unhandledRejection') === 0) {
      process.on('unhandledRejection', function (reason) {
        console.error('[screeps-arena] unhandledRejection (process kept alive):')
        console.error(reason && reason.stack ? reason.stack : reason)
      })
    }
  }

  /**
   * 安全清场：清空世界集合与玩家，但保留 env 元数据行。
   * 不用 storage.resetAllData()（db.loadJSON(db.original)）——它会把 env 的
   * databaseVersion 重置为 undefined，下次 storage 启动重跑 v4→v5 升级转换器，
   * 把 reset 之后新建的 v5 格式对象（spawn 的 store 等）毁成空值（S7a spike 实测）。
   */
  function resetArena() {
    clearEventRing() // 事件 ring 是进程内状态，清场必须同步清（双保险：start 的 restart 也会重置）
    var common = deps()
    var db = common.common.storage.db
    var env = common.common.storage.env
    var collections = [
      'rooms', 'rooms.objects', 'rooms.terrain', 'rooms.intents', 'rooms.flags',
      'users.code', 'users.intents', 'users.notifications', 'users.resources',
      'users.money', 'users.console', 'users.power_creeps',
      'market.orders', 'market.stats', 'transactions',
    ]
    // common.storage.db 是 RPC wrapper（不是 LokiJS 原始 db），只暴露各 collection 的
    // clear/removeWhere 等方法，没有 getCollection。所有这里的名称都在 common.dbCollections
    // 中注册，直接调用 wrapper 的 db[c].clear()；未注册时才跳过，不能吞掉 wrapper 访问错误。
    return Promise.all(collections.map(function (c) {
      try {
        var col = db[c]
        return col && typeof col.clear === 'function' ? Promise.resolve(col.clear()) : Promise.resolve(null)
      } catch (e) { /* 集合不存在则跳过 */ }
      return Promise.resolve(null)
    }))
      .then(function () {
        // 保留系统用户 2=Invader、3=Source Keeper（引擎按 id 引用）
        return db.users.removeWhere({ $and: [{ _id: { $ne: '2' } }, { _id: { $ne: '3' } }] })
      })
      .then(function () { return env.del(env.keys.ACTIVE_ROOMS) })
      // roomEventLog hash 是每 tick 覆盖写的瞬态（plan-M2 九审次要 2）：清场时一并清，
      // 否则同房名重跑的首读会带出旧场残条
      .then(function () { return env.del(env.keys.ROOM_EVENT_LOG) })
      .then(function () { return env.set(env.keys.ACCESSIBLE_ROOMS, '[]') })
      .then(function () { return ensureRoomStatusData() })
      .then(function () { return { reset: true } })
  }

  /**
   * generateRoom 后把房间加进 accessibleRooms（VM 的 WorldMapGrid 按它索引地形视图，
   * 缺房 → 该房间内所有寻路永久 "Could not load terrain data"，见 m0-flake §三）。
   * accessibleRooms 的规范形态是 JSON 字符串列表（driver updateAccessibleRoomsList 与
   * runtime.js JSON.parse 都按此约定），不能用 env.sadd（数组语义）混写。
   */
  function addAccessibleRoom(roomName) {
    var env = deps().common.storage.env
    return env.get(env.keys.ACCESSIBLE_ROOMS).then(function (data) {
      var list = []
      if (typeof data === 'string' && data.length > 0) {
        try { list = JSON.parse(data) } catch (e) { list = [] }
      } else if (Array.isArray(data)) {
        list = data
      }
      if (list.indexOf(roomName) === -1) list.push(roomName)
      return env.set(env.keys.ACCESSIBLE_ROOMS, JSON.stringify(list))
    })
  }

  /**
   * resume 前强制重建 VM 元数据。main loop 每 20 tick 才 updateAccessibleRoomsList
   * 一次且不 await——resume 后用户首次运行若赶在刷新之前，WorldMapGrid 会按陈旧/空
   * 列表构建并随 isolate 缓存到 VM 销毁，路径查找从此永久失败。这里在放行世界之前
   * 同步把 accessibleRooms / roomStatusData 从 db 重建，竞态从根上消除。
   */
  function refreshWorldMeta() {
    var driver
    try {
      driver = deps().driver || require('@screeps/driver')
    } catch (e) {
      return Promise.resolve() // 无 driver 可用（非标准部署）时退回 main loop 自愈
    }
    return Promise.all([driver.updateAccessibleRoomsList(), driver.updateRoomStatusData()])
  }

  /**
   * 为房间补 8 邻居 walled 地形桩。root cause（m0-flake §三，pf 探针实证）：
   * resetArena 清空 db['rooms.terrain'] 摧毁基础地形覆盖后，pf.cc 的 A* 从用户房间
   * 边界探测到未生成房间时 terrain[map_pos.id] == nullptr → 直接
   * "Could not load terrain data"（spawn/控制器随机位置离边界的远近决定触发与否，
   * ~50% flake 的真身）。stub 全墙 → A* 读到墙即停，不会外溢到第二环。
   */
  function addWalledNeighbors(roomName) {
    var common = deps().common
    var db = common.storage.db
    var xy = common.roomNameToXY(roomName)
    var neighbors = []
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        neighbors.push(common.getRoomNameFromXY(xy[0] + dx, xy[1] + dy))
      }
    }
    return Promise.all(neighbors.map(function (n) {
      return db['rooms.terrain'].findOne({ room: n }).then(function (existing) {
        if (existing) return null
        return db['rooms.terrain'].insert({ room: n, terrain: '1'.repeat(2500) })
      })
    }))
  }

  /**
   * A 节：镜像 terrain = 编码字符串「每 50 字符一行反转」（x'=49-x，y 不变）。
   * 编码约定（common/index.js L25-58）：每格 1 字符 0/1/2/3，索引 = y*50+x。
   * 水平翻转下 y 不变 → 按行拆、每行 reverse 再拼接即可，无需关心字符取值。
   */
  function reverseTerrain(terrain) {
    if (typeof terrain !== 'string' || terrain.length !== 2500) throw 'reverseTerrain expects 2500-char encoded terrain'
    var rows = []
    for (var y = 0; y < 50; y++) {
      rows.push(terrain.slice(y * 50, y * 50 + 50).split('').reverse().join(''))
    }
    return rows.join('')
  }

  /**
   * M3/S1 定点拆解原语（plan-M3 D2）。与 resetArena（全场清空）相对：按用户/按房删除，
   * 多活跃对局下 settle 只拆解本局席位，不碰他局世界。
   */

  /** 用户关联集合全集（removeUser 按 user 字段清理；resetArena 清场清单的按用户子集）。 */
  var USER_KEYED_COLLECTIONS = [
    'users.code', 'users.intents', 'users.notifications', 'users.resources',
    'users.money', 'users.console', 'users.power_creeps', 'market.orders',
  ]
  var SYSTEM_USERNAMES = ['Invader', 'Source Keeper']

  function removeUser(username) {
    if (typeof username !== 'string' || SYSTEM_USERNAMES.indexOf(username) !== -1) {
      return Promise.reject('removeUser requires a non-system username')
    }
    var d = deps()
    var db = d.common.storage.db
    var env = d.common.storage.env
    return db.users.findOne({ username: username }).then(function (user) {
      if (!user) return { removed: username, found: false }
      var id = user._id
      return Promise.all(
        USER_KEYED_COLLECTIONS.map(function (c) {
          try {
            return db[c] && typeof db[c].removeWhere === 'function'
              ? db[c].removeWhere({ user: id })
              : Promise.resolve(null)
          } catch (e) {
            return Promise.resolve(null)
          }
        }),
      )
        .then(function () {
          // 交易两侧都是用户字段（sender/receiver），选择器引擎支持 $and 同款 $or
          try {
            return db.transactions.removeWhere({ $or: [{ sender: id }, { receiver: id }] })
          } catch (e) {
            return Promise.resolve(null)
          }
        })
        .then(function () {
          // 用户对象全集（含 controller.user 所有权——createUser 的 owned 检查即查它；
          // 不清则同名重建撞 "room already owned"）。跨房 creep 残骸一并清，不留孤儿 owner。
          return db['rooms.objects'].removeWhere({ user: id })
        })
        .then(function () {
          return db.users.removeWhere({ _id: id })
        })
        .then(function () {
          return env.del(env.keys.MEMORY + id) // 用户 memory 是 env 键（realCreateUser 同款），resetArena 也不清——定点删必须清
        })
        .then(function () {
          delete consoleBuffers[id] // 进程内 console ring 按 userId 键控，删号同步清防泄漏
          return { removed: username, found: true, id: id }
        })
    })
  }

  function removeAccessibleRoom(roomName) {
    var env = deps().common.storage.env
    return env.get(env.keys.ACCESSIBLE_ROOMS).then(function (data) {
      var list = []
      if (typeof data === 'string' && data.length > 0) {
        try {
          list = JSON.parse(data)
        } catch (e) {
          list = []
        }
      } else if (Array.isArray(data)) {
        list = data
      }
      var next = list.filter(function (r) {
        return r !== roomName
      })
      if (next.length === list.length) return false
      return env.set(env.keys.ACCESSIBLE_ROOMS, JSON.stringify(next)).then(function () {
        return true
      })
    })
  }

  /**
   * removeRoom：删房 + 完整逆向 generateRoom 链路（plan-M3 D2 ①-⑤）：
   * ① 三集合（objects/terrain/rooms 元数据）+ rooms.intents/rooms.flags；
   * ⑤ 删 terrain 后、updateTerrainData 重建 blob 前，对被删房插回全墙桩——
   *    否则该房成为「未生成房」，活跃邻房 A* 探测即 "Could not load terrain data"（m0-flake §三）；
   * ③ ACCESSIBLE_ROOMS 移除 + ACTIVE_ROOMS（env set）srem；
   * ② updateTerrainData 重建 runner 地形 blob + refreshWorldMeta 重建 VM 元数据。
   * 「不删他局房间/桩房」的防御在 host 侧（RealArena 只对本局房间发起），mod 层无跨局知识。
   */
  function removeRoom(roomName) {
    if (typeof roomName !== 'string' || !/^[WE]\d+[NS]\d+$/.test(roomName)) {
      return Promise.reject('removeRoom requires room name as value')
    }
    var d = deps()
    var db = d.common.storage.db
    var env = d.common.storage.env
    return Promise.all([
      db.rooms.findOne({ _id: roomName }),
      db['rooms.objects'].findOne({ room: roomName }),
    ])
      .then(function (found) {
        // 存在性判定不能用 terrain（removeRoom 自身会留全墙桩行——桩房 = 已删）
        if (!found[0] && !found[1]) return { removed: roomName, found: false }
        return Promise.resolve()
          .then(function () {
            return db['rooms.objects'].removeWhere({ room: roomName })
          })
          .then(function () {
            // intents/flags 集合在精简部署可能未注册——缺则跳过（removeWhere 一并防御）
            var extra = ['rooms.intents', 'rooms.flags']
            return Promise.all(extra.map(function (c) {
              try {
                return db[c] && typeof db[c].removeWhere === 'function'
                  ? db[c].removeWhere({ room: roomName })
                  : Promise.resolve(null)
              } catch (e) {
                return Promise.resolve(null)
              }
            }))
          })
          .then(function () {
            return db.rooms.removeWhere({ _id: roomName })
          })
          .then(function () {
            return db['rooms.terrain'].removeWhere({ room: roomName })
          })
          // ⑤ 全墙桩插回（addWalledNeighbors 同款形态：全 '1'，2500 格）
          .then(function () {
            return db['rooms.terrain'].insert({ room: roomName, terrain: '1'.repeat(2500) })
          })
          .then(function () {
            return removeAccessibleRoom(roomName)
          })
          .then(function () {
            // env 集合无 srem（S0 实测：wrapper 只有 sadd/smembers）→ del 整键后
            // 对剩余成员逐一 sadd 重建（他局房不受损）
            return env.smembers(env.keys.ACTIVE_ROOMS).then(function (list) {
              if (!Array.isArray(list) || list.indexOf(roomName) === -1) return null
              var rest = list.filter(function (r) {
                return r !== roomName
              })
              return env.del(env.keys.ACTIVE_ROOMS).then(function () {
                return Promise.all(rest.map(function (r) {
                  return env.sadd(env.keys.ACTIVE_ROOMS, r)
                }))
              })
            })
          })
          // ② blob 重建（桩插入晚于 stock update 时序，generateRoom 同款教训）
          .then(function () {
            return d.cliMap.updateTerrainData()
          })
          .then(function () {
            return refreshWorldMeta()
          })
          .then(function () {
            return { removed: roomName, found: true }
          })
      })
  }

  /**
   * [M3/S0 诊断探针] 按 username 逐集合清点关联行数 + env memory 键存在性——
   * removeUser 前后各调一次即可钉出「用户关联集合/env 键全集」实测清单（plan-M3 附录 A）。
   */
  function dbProbe(value) {
    var d = deps()
    var db = d.common.storage.db
    var env = d.common.storage.env
    // 两种入参：string=username（含 user 行）；{id}=按 id 直接清点（删号后残留检测）
    var byId = value && typeof value === 'object' && typeof value.id === 'string' ? value.id : null
    if (!byId && typeof value !== 'string') return Promise.reject('dbProbe requires username string or {id}')
    var lookup = byId
      ? Promise.resolve({ _id: byId, username: null })
      : db.users.findOne({ username: value })
    return lookup.then(function (user) {
      if (!user) return { user: null }
      var id = user._id
      var counted = USER_KEYED_COLLECTIONS.concat(['transactions', 'users', 'rooms.objects'])
      var selectors = {
        transactions: { $or: [{ sender: id }, { receiver: id }] },
        users: { _id: id },
        'rooms.objects': { user: id },
      }
      return Promise.all(
        counted.map(function (c) {
          try {
            if (!db[c] || typeof db[c].find !== 'function') return Promise.resolve([c, null])
            return db[c]
              .find(selectors[c] || { user: id })
              .then(function (rows) {
                return [c, rows.length]
              })
          } catch (e) {
            return Promise.resolve([c, null])
          }
        }),
      ).then(function (rows) {
        return env.get(env.keys.MEMORY + id).then(function (mem) {
          return { user: { _id: id, username: user.username }, rows: rows, memoryKeyBytes: mem == null ? null : String(mem).length }
        })
      })
    })
  }

  function systemCommand(cmd, value) {
    var d = deps()
    var common = d.common
    var env = common.storage.env
    var pubsub = common.storage.pubsub
    var db = common.storage.db
    switch (cmd) {
      case 'pause':
        return env.set(env.keys.MAIN_LOOP_PAUSED, '1').then(function () { return { paused: true } })
      case 'resume':
        // 顺序不可反：先重建 VM 元数据，再写入本场可见房间，最后解除暂停放行第一 tick。
        // value 为本场 assignments 时，不让全局 updateAccessibleRoomsList 覆盖竞技场边界。
        var requestedRooms = Array.isArray(value) ? value : null
        return refreshWorldMeta().then(
          function () {
            var writeRooms = requestedRooms
              ? env.set(env.keys.ACCESSIBLE_ROOMS, JSON.stringify(requestedRooms))
              : Promise.resolve()
            return writeRooms.then(function () {
              return env.set(env.keys.MAIN_LOOP_PAUSED, '0').then(function () {
                return { paused: false, worldMetaRefreshed: true }
              })
            })
          },
          function (e) {
            console.error('[screeps-arena] world meta refresh on resume failed:', e)
            var writeRooms = requestedRooms
              ? env.set(env.keys.ACCESSIBLE_ROOMS, JSON.stringify(requestedRooms))
              : Promise.resolve()
            return writeRooms.then(function () {
              return env.set(env.keys.MAIN_LOOP_PAUSED, '0').then(function () {
                return { paused: false, worldMetaRefreshed: false }
              })
            })
          },
        )
      case 'setTickDuration': {
        var parsed = parseInt(value, 10)
        if (Number.isNaN(parsed) || parsed <= 0) return Promise.reject('invalid tick duration')
        return env
          .set(env.keys.MAIN_LOOP_MIN_DURATION, String(parsed))
          .then(function () { return pubsub.publish('setTickRate', parsed) })
          .then(function () { return { tickDuration: parsed } })
      }
      case 'getTickDuration':
        return env.get(env.keys.MAIN_LOOP_MIN_DURATION).then(function (v) { return { tickDuration: v } })
      case 'setAccessibleRooms': {
        // [M2 fix] backend.restart() 后 ensureRunning 重新 fork 进程，driver/data.js 的
        // accessibleRoomsCache 模块级缓存会被丢弃，新进程第一次 getAccessibleRooms
        // 进 60s 缓存分支（Date.now() > 0 + 60s 必中）→ 返回 stale undefined → VM start
        // 时 data.accessibleRooms === undefined → JSON.parse(undefined) 抛
        // '"undefined" is not valid JSON'。修复：lifecycle.start 在 resume 前显式用
        // generateRoom 房名覆盖 env key，确保新进程读到非空字符串。
        if (!Array.isArray(value) || value.some(function (room) { return typeof room !== 'string' })) {
          return Promise.reject('setAccessibleRooms requires string array')
        }
        var encodedRooms = JSON.stringify(value)
        // storage RPC 在 backend 重启交接时可能先 resolve set、后让 runner 读到新值；
        // 做 read-after-write barrier，确保 VM 首次 runtimeData.get 不拿到 undefined/旧缓存。
        function verify(attempt) {
          return env.get(env.keys.ACCESSIBLE_ROOMS).then(function (actual) {
            if (actual === encodedRooms) return { accessibleRooms: value, verified: true, attempts: attempt + 1 }
            if (attempt >= 5) return Promise.reject('setAccessibleRooms read-after-write mismatch')
            return new Promise(function (resolve) { setTimeout(resolve, 20) }).then(function () { return verify(attempt + 1) })
          })
        }
        return env.set(env.keys.ACCESSIBLE_ROOMS, encodedRooms).then(function () { return verify(0) })
      }
      case 'resetAllData':
        // 危险：loadJSON 会重置 databaseVersion（见 resetArena 注释），仅诊断用
        return common.storage.resetAllData().then(function () { return ensureRoomStatusData() }).then(function () { return { reset: true } })
      case 'resetArena':
        return resetArena()
      case 'arenaGen': {
        // M5/S1 回迁（reference/screeps-mod/arena-mod.cjs arenaGen 原样）：镜像克隆
        // （基准房 + 东邻镜像房），生成双方对称地形/资源/中立 controller。
        // 参数透传：terrainType/sources/mineral/exits 全透传。基准房 exits.right 开向
        // 东邻镜像（B3：镜像=东邻，roomNameFromXY(x+1,y)；示例 W15N15 → W14N15）；
        // 水平翻转下 base right ↔ mirror left、y 坐标不变 → 出口格天然对称，exits 登记
        // 钉死不写 db.rooms 字段（引擎 interRoom 只读边界格 terrain）。
        if (!value || typeof value.room !== 'string' || !/^[WE]\d+[NS]\d+$/.test(value.room)) {
          return Promise.reject('arenaGen requires {room, terrainType?, sources?, mineral?, exits?}')
        }
        var aBase = value.room
        var baseXY = common.roomNameToXY(aBase)
        var aMirror = common.getRoomNameFromXY(baseXY[0] + 1, baseXY[1])
        var aGenOpts = {}
        if (typeof value.terrainType === 'string') aGenOpts.terrainType = value.terrainType
        if (typeof value.sources === 'number') aGenOpts.sources = value.sources
        if (typeof value.mineral === 'string') aGenOpts.mineral = value.mineral
        // controller:true 供后续 pre-assign（保留 controller + placeSpawn 标准赋权）；
        // keeperLairs:false 禁 NPC（禁 Invader/Source Keeper，Arena 短局无骚扰）
        aGenOpts.controller = true
        aGenOpts.keeperLairs = false
        var aRightY = value.exits && Array.isArray(value.exits.right) ? value.exits.right : [24, 25]
        aGenOpts.exits = { right: aRightY }

        return Promise.resolve()
          // 1) 基准房：同 generateRoom 清桩链（邻房已生成时 ring stub 可能占位，先清）
          .then(function () { return db['rooms.terrain'].removeWhere({ room: aBase }) })
          .then(function () {
            return db['rooms.objects'].removeWhere({ room: aBase }).then(function () {
              return db.rooms.removeWhere({ _id: aBase })
            })
          })
          // M5 复用修复（live IT 实测「Exits in room W14N15 don't match」）：镜像房若残留
          // 上一局的墙桩/db 登记，stock generateRoom 的 exits 校验会对邻房老地形校验失败
          // ——镜像房三集合先清干净（无桩），arenaGen 从干净状态开始。
          .then(function () { return db['rooms.terrain'].removeWhere({ room: aMirror }) })
          .then(function () {
            // NPC 要塞残留（genStrongholds cronjob 墙钟拍不受暂停影响）：invaderCore/rampart 全清
            return db['rooms.objects'].removeWhere({ $and: [{ room: aMirror }, { type: { $in: ['invaderCore', 'rampart'] } }] })
          })
          .then(function () { return db['rooms.objects'].removeWhere({ room: aMirror }) })
          .then(function () { return db.rooms.removeWhere({ _id: aMirror }) })
          .then(function () { return d.cliMap.generateRoom(aBase, aGenOpts) })
          .then(function (r) { return addWalledNeighbors(aBase).then(function () { return r }) })
          .then(function (r) { return d.cliMap.updateTerrainData().then(function () { return r }) })
          .then(function (r) { return addAccessibleRoom(aBase).then(function () { return r }) })
          // 2) 镜像房：清桩 → 反转地形 → 登记 db.rooms → 复制 objects → 邻桩 → 重建 blob → 入 accessible
          .then(function () {
            // 基准房的 addWalledNeighbors 已给镜像房插全墙桩（当时镜像不存在），必须先清
            return db['rooms.terrain'].removeWhere({ room: aMirror })
          })
          .then(function () { return db['rooms.terrain'].findOne({ room: aBase }) })
          .then(function (baseTerrain) {
            if (!baseTerrain) throw 'base terrain missing for ' + aBase
            return db['rooms.terrain'].insert({ room: aMirror, terrain: reverseTerrain(baseTerrain.terrain) })
          })
          .then(function () {
            // 登记（B1/B4：updateTerrainData 以 db.rooms + db['rooms.terrain'] 为准 deflate）
            return db.rooms.insert({ _id: aMirror, status: 'normal', sourceKeepers: false })
          })
          .then(function () {
            return db['rooms.objects'].find({ room: aBase }).then(function (objects) {
              return Promise.all(
                objects
                  .filter(function (o) { return o.type === 'source' || o.type === 'mineral' || o.type === 'controller' })
                  .map(function (o) {
                    var copy = {}
                    for (var k in o) {
                      if (Object.prototype.hasOwnProperty.call(o, k) && k !== '_id' && k !== '$loki') copy[k] = o[k]
                    }
                    copy.room = aMirror
                    copy.x = 49 - o.x // 水平翻转：x'=49-x，y 不变
                    if (o.type === 'controller') {
                      // 钉死：镜像 controller = 中立副本（user:null、level:0、无状态字段），
                      // 与 source 同路径；两侧各属一方由 createUser→placeSpawn 预赋权完成
                      // （无中立 controller 可 claim → 禁扩张天然达成）
                      copy.user = null
                      copy.level = 0
                      copy.progress = 0
                      if (copy.reservation !== undefined) { copy.reservation = undefined; delete copy.reservation }
                      if (copy.downgradeTime !== undefined) { copy.downgradeTime = undefined; delete copy.downgradeTime }
                      if (copy.safeMode !== undefined) { copy.safeMode = undefined; delete copy.safeMode }
                      if (copy.nextDowngradeTime !== undefined) { copy.nextDowngradeTime = undefined; delete copy.nextDowngradeTime }
                    }
                    return db['rooms.objects'].insert(copy)
                  }),
              )
            })
          })
          // B4：addWalledNeighbors(镜像) 必须早于 updateTerrainData（官方链顺序 L718-721）——
          // 新插斜角桩必须先进 blob，否则 restart 后 runner 缺斜角房 "Could not load terrain data"
          .then(function () { return addWalledNeighbors(aMirror) })
          .then(function (r) { return d.cliMap.updateTerrainData().then(function () { return r }) })
          .then(function (r) { return addAccessibleRoom(aMirror).then(function () { return r }) })
          .then(function () { return { base: aBase, mirror: aMirror, exits: { right: aRightY } } })
      }
      case 'arenaProbe': {
        // M5/S1 回迁（reference mod 原样）契约探针：返回 base/mirror 两房 terrain 编码串 +
        // 对称对象坐标（source/mineral/controller），供 IT 断言「镜像 terrain = 基准逐行
        // 反转」「objects 坐标 x'=49-x」。只读探针，不改变任何状态。
        if (!value || typeof value.base !== 'string' || typeof value.mirror !== 'string') {
          return Promise.reject('arenaProbe requires {base, mirror}')
        }
        var aReadTerrain = function (room) {
          return db['rooms.terrain'].findOne({ room: room }).then(function (t) {
            return t ? t.terrain : null
          })
        }
        var aReadObjects = function (room) {
          return db['rooms.objects'].find({ room: room }).then(function (objects) {
            return objects
              .filter(function (o) { return o.type === 'source' || o.type === 'mineral' || o.type === 'controller' })
              .map(function (o) {
                return { type: o.type, x: o.x, y: o.y, room: o.room, user: o.user || null, level: o.level || 0 }
              })
              .sort(function (a, b) { return a.type.localeCompare(b.type) || a.x - b.x || a.y - b.y })
          })
        }
        return Promise.all([aReadTerrain(value.base), aReadTerrain(value.mirror), aReadObjects(value.base), aReadObjects(value.mirror)])
          .then(function (r) {
            return { base: { room: value.base, terrain: r[0], objects: r[2] }, mirror: { room: value.mirror, terrain: r[1], objects: r[3] } }
          })
      }
      case 'removeUser':
        return removeUser(value)
      case 'removeRoom':
        return removeRoom(value)
      case 'dbProbe':
        return dbProbe(value)
      case 'generateRoom': {
        // 兼容字符串入参（旧调用）与 {room, exits} 对象入参（M2 战斗 IT 用 exits 开出口）
        var roomName = typeof value === 'string' ? value : value && typeof value.room === 'string' ? value.room : null
        if (!roomName || !/^[WE]\d+[NS]\d+$/.test(roomName)) {
          return Promise.reject('generateRoom requires room name as value (string or {room, exits})')
        }
        var genOpts = {}
        if (value && typeof value === 'object' && value.exits && typeof value.exits === 'object') {
          genOpts.exits = value.exits
        }
        return Promise.resolve()
          // 邻房已生成时，本房的 ring stub 可能已占位；不先清掉，stock generateRoom
          // 会再插一行真地形 → 同房两行 → findOne 命中全墙桩 → placeSpawn 无格可放
          .then(function () { return db['rooms.terrain'].removeWhere({ room: roomName }) })
          // [M2 fix] 重掷语义（M2/S6）：房已存在时 stock generateRoom 抛 "This room already
          // exists"——重掷与首生成必须走同一条路，先清房内对象与房间元数据（db.rooms _id=房名）
          .then(function () {
            return db['rooms.objects'].removeWhere({ room: roomName }).then(function () {
              return db.rooms.removeWhere({ _id: roomName })
            })
          })
          .then(function () { return d.cliMap.generateRoom(roomName, genOpts) })
          .then(function (r) { return addWalledNeighbors(roomName).then(function () { return r }) })
          // stub 插入晚于 stock generateRoom 内部的 updateTerrainData，必须重建 blob
          .then(function (r) { return d.cliMap.updateTerrainData().then(function () { return r }) })
          .then(function (r) { return addAccessibleRoom(roomName).then(function () { return r }) })
          .then(function (r) { return { generated: roomName, exits: genOpts.exits || null, detail: r == null ? null : String(r) } })
      }
      case 'clearSafeMode': {
        // 战斗 IT 前置：消除开局 20000 tick safe mode 免疫（引擎每 tick 从 db 直读 controller，
        // 改后下一 tick 生效，免 restart——driver L249-258 + processor.js L561 实证）
        if (typeof value !== 'string' || !/^[WE]\d+[NS]\d+$/.test(value)) {
          return Promise.reject('clearSafeMode requires room name as value')
        }
        return db['rooms.objects'].findOne({ $and: [{ room: value }, { type: 'controller' }] }).then(function (controller) {
          if (!controller) return Promise.reject('no controller in ' + value)
          return common.getGametime().then(function (gt) {
            var next = gt - 1
            return db['rooms.objects'].update({ _id: controller._id }, { $set: { safeMode: next } }).then(function () {
              return { room: value, safeMode: next }
            })
          })
        })
      }
      case 'eventLog': {
        // 事件 ring 增量拉取：since=ring 下标（非 tick 数值）；bound=false = 溢出过（事件段缺失）
        var from = typeof value === 'number' && value >= 0 && value <= eventRing.length ? value : 0
        return Promise.resolve({
          events: eventRing.slice(from),
          cursor: eventRing.length,
          bound: !eventRingFull,
          ringFull: eventRingFull,
          // M6/D1：ring 容量随应答下发（summary 的 eventsIncomplete 标注用，避免 host 硬编码）
          ringCapacity: EVENT_RING_MAX,
        })
      }
      case 'envProbe': {
        // [M2 诊断] 返回 env 关键键的原始值（排查 accessibleRooms undefined 导致 run 崩）
        return Promise.all([
          env.get(env.keys.ACCESSIBLE_ROOMS),
          env.get(env.keys.ACTIVE_ROOMS),
          env.get(env.keys.MAIN_LOOP_PAUSED),
          env.get(env.keys.GAMETIME),
        ]).then(function (v) {
          return {
            accessibleRooms: v[0],
            activeRooms: v[1],
            mainLoopPaused: v[2],
            gameTime: v[3],
          }
        })
      }
      case 'roomObjects':
        if (typeof value !== 'string' || !/^[WE]\d+[NS]\d+$/.test(value)) {
          return Promise.reject('roomObjects requires room name as value')
        }
        return db['rooms.objects'].find({ room: value }).then(function (objects) {
          return {
            room: value,
            objects: objects.map(function (o) {
              return { type: o.type, x: o.x, y: o.y, user: o.user, name: o.name, hits: o.hits, store: o.store, spawning: o.spawning, safeMode: o.safeMode }
            }),
          }
        })
      case 'terrainRooms':
        // 探针仪器（docs/spikes/m0-flake.md §三）：对比 runner 视角（env.terrainData
        // 整包 blob，runner init 一次性读取并进程级缓存）与 db 视角（rooms.terrain 逐房）。
        // restart 前后各查一次即可钉死「地形交接竞态」最后一环。
        return env.get(env.keys.TERRAIN_DATA).then(function (blob) {
          var envRooms = []
          var blobError = null
          if (typeof blob === 'string' && blob.length > 0) {
            try {
              var zlib = require('zlib')
              envRooms = JSON.parse(zlib.inflateSync(Buffer.from(blob, 'base64')).toString()).map(function (t) {
                return t.room
              })
            } catch (e) {
              blobError = String(e)
            }
          }
          return db['rooms.terrain'].find({}, { room: true }).then(function (items) {
            return {
              envBlobPresent: typeof blob === 'string' && blob.length > 0,
              envRooms: envRooms,
              blobError: blobError,
              dbTerrainRooms: items.map(function (i) {
                return i.room
              }),
            }
          })
        })
      case 'consoleOutput': {
        // screeps_console 工具的取回通道：buffer 按 user._id 键控，这里解析 username
        if (typeof value !== 'object' || value === null || typeof value.user !== 'string') {
          return Promise.reject('consoleOutput requires {user, since?} as value')
        }
        return db.users.findOne({ username: value.user }).then(function (user) {
          if (!user) return { lines: [], cursor: 0, bound: false, pubsubTicks: pubsubProbe.ticks }
          // 保证订阅已就绪（已存在的用户未必经过 createUser 的 subscribeConsole）
          subscribeConsole(user._id)
          // 自环探针：本进程 publish 应同步触发本进程订阅（同一 EventEmitter）
          try {
            common.storage.pubsub.publish('user:' + user._id + '/console', JSON.stringify({ messages: ['SELFTEST'], userId: user._id }))
          } catch (e) { /* 探针失败不影响业务 */ }
          var out = consoleOutput(user._id, value.since)
          out.pubsubTicks = pubsubProbe.ticks
          out.selfLoop = bufferHasSelfTest(consoleBuffers[user._id])
          return out
        })
      }
      case 'userDump':
        if (typeof value !== 'string') return Promise.reject('userDump requires username as value')
        return Promise.all([
          db.users.findOne({ username: value }),
          db['users.code'].find({ user: { $ne: null } }).then(function (codes) {
            var ids = {}
            codes.forEach(function (c) { ids[c.user] = (ids[c.user] || 0) + 1 })
            return ids
          }),
          env.smembers(env.keys.ACTIVE_ROOMS),
        ]).then(function (result) {
          var codeCountByUser = result[1]
          return {
            user: result[0],
            activeRooms: result[2],
            codeCountForUser: result[0] ? (codeCountByUser[result[0]._id] || 0) : 0,
          }
        })
      default:
        return Promise.reject('unknown system command: ' + cmd)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 路由安装                                                            */
  /* ------------------------------------------------------------------ */

  function installRoutes(config) {
    var d = deps()
    var common = d.common
    var db = common.storage.db
    var authlib = d.authlib

    var express = d.express || require('express')
    var arena = express.Router()

    arena.post('/users', function (req, res) {
      return realCreateUser(req.body || {})
        .then(function (user) {
          ok(res, { user: { id: user._id, username: user.username } })
        })
        .catch(function (err) { fail(res, 400, String(err && err.message ? err.message : err)) })
    })

    arena.get('/users', function (req, res) {
      return Promise.resolve(db.users.find({}, { _id: true, username: true, bot: true, cpu: true, gcl: true, badge: true }))
        .then(function (users) {
          ok(res, {
            users: users.map(function (u) {
              return { id: u._id, username: u.username, isBot: !!u.bot, cpu: u.cpu, gcl: u.gcl, badge: u.badge }
            }),
          })
        })
        .catch(function (err) { fail(res, 500, String(err)) })
    })

    arena.post('/token', function (req, res) {
      var username = req.body && req.body.username
      if (typeof username !== 'string') return fail(res, 400, 'username required')
      return db.users
        .findOne({ username: username })
        .then(function (user) {
          if (!user) throw 'user not found: ' + username
          return authlib.genToken(user._id).then(function (token) { return { token: token } })
        })
        .then(function (data) { ok(res, data) })
        .catch(function (err) { fail(res, 404, String(err && err.message ? err.message : err)) })
    })

    arena.get('/world', function (req, res) {
      return ensureRoomStatusOnce()
        .then(worldSnapshot)
        .then(function (snap) {
          ok(res, snap)
        })
        .catch(function (err) { fail(res, 500, String(err)) })
    })

    // M6：地形数据（观战坐标地图）。rooms=逗号分隔房名（≤64）；返回 {room: terrain}
    // ——terrain 是 2500 字符位域串（索引 y*50+x；bit1=wall、bit2=swamp，见
    // reference/screeps/common/index.js encodeTerrain）。地形单局内不可变（generateRoom
    // 全在 start 内），client 按 matchId 缓存一次即可。
    arena.get('/terrain', function (req, res) {
      var roomsParam = req.query && req.query.rooms
      if (typeof roomsParam !== 'string' || roomsParam === '') {
        return fail(res, 400, 'rooms required (comma-separated room names like W15N15,W14N15)')
      }
      var rooms = roomsParam.split(',').map(function (s) { return s.trim() }).filter(function (s) { return s !== '' })
      if (rooms.length === 0 || rooms.length > 64) {
        return fail(res, 400, 'rooms must contain 1..64 names')
      }
      for (var i = 0; i < rooms.length; i++) {
        if (!/^[WE]\d+[NS]\d+$/.test(rooms[i])) return fail(res, 400, 'invalid room name: ' + rooms[i])
      }
      return ensureRoomStatusOnce()
        .then(function () {
          return db['rooms.terrain'].find({ room: { $in: rooms } })
        })
        .then(function (items) {
          var terrain = {}
          items.forEach(function (item) { terrain[item.room] = item.terrain })
          ok(res, { terrain: terrain })
        })
        .catch(function (err) { fail(res, 500, String(err)) })
    })

    arena.post('/system', function (req, res) {
      var body = req.body || {}
      if (typeof body.cmd !== 'string') return fail(res, 400, 'cmd required')
      return ensureRoomStatusOnce()
        .then(function () { return systemCommand(body.cmd, body.value) })
        .then(function (data) { ok(res, data) })
        .catch(function (err) { fail(res, 400, String(err && err.message ? err.message : err)) })
    })

    arena.post('/rooms', function (req, res) {
      var body = req.body || {}
      if (typeof body.room !== 'string' || !/^[WE]\d+[NS]\d+$/.test(body.room)) {
        return fail(res, 400, 'room required (format like E1N1)')
      }
      var opts = {}
      if (body.terrainType !== undefined) opts.terrainType = body.terrainType
      if (body.swampType !== undefined) opts.swampType = body.swampType
      if (body.sources !== undefined) opts.sources = body.sources
      if (body.mineral !== undefined) opts.mineral = body.mineral
      if (body.controller !== undefined) opts.controller = body.controller
      if (body.exits !== undefined && body.exits && typeof body.exits === 'object') opts.exits = body.exits
      return Promise.resolve()
        .then(function () { return db['rooms.terrain'].removeWhere({ room: body.room }) })
        .then(function () { return d.cliMap.generateRoom(body.room, opts) })
        .then(function () { return addWalledNeighbors(body.room) })
        .then(function () { return d.cliMap.updateTerrainData() })
        .then(function () { return addAccessibleRoom(body.room) })
        .then(function () {
          // 返回生成的资源布局，供公平性校验（source/controller 位置、数量）
          return db['rooms.objects'].find({ room: body.room }).then(function (objects) {
            ok(res, {
              room: body.room,
              sources: objects
                .filter(function (o) { return o.type === 'source' })
                .map(function (o) { return { x: o.x, y: o.y } }),
              controller: objects
                .filter(function (o) { return o.type === 'controller' })
                .map(function (o) { return { x: o.x, y: o.y } })[0] || null,
            })
          })
        })
        .catch(function (err) { fail(res, 400, String(err && err.message ? err.message : err)) })
    })

    config.backend.router.use('/arena', makeGuard(), arena)
  }

  module.exports = function arenaMod(config) {
    if (loaded) return
    loaded = true
    stubSteamWebApi()
    installRejectionGuard()
    // engine / storage 进程（driver）没有 backend.router——只做 steam stub + rejection guard 后返回
    if (!config || !config.backend || !config.backend.router) {
      console.log('[screeps-arena] arena mod: no backend router in this process, routes skipped')
      return
    }
    installRoutes(config)
    console.log('[screeps-arena] arena mod installed: steam stubbed, /api/arena/* ready')
  }

  // 测试钩子（生产进程永不调用）：_testInject 替换依赖；_testReset 复位单次加载标志
  module.exports._testInject = function (testDeps) {
    module.exports._testDeps = testDeps
  }
  module.exports._testReset = function () {
    loaded = false
    roomStatusEnsured = false
    consoleBuffers = Object.create(null)
    eventCollectorReady = false
    clearEventRing()
    pubsubProbe.ticks = 0
  }
})()
