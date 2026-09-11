'use strict'
/**
 * 临时调试 mod：挂在 runner / engine_main 进程，把 loop stage 写 /tmp/arena-debug.log。
 * 生产 mods.json 不含此文件。
 */
module.exports = function debugMod(config) {
  var fs = require('fs')
  var LOG = process.env.DSH_SCREEPS_DEBUG_LOG || '/tmp/arena-debug.log'
  function w(line) {
    try { fs.appendFileSync(LOG, new Date().toISOString().slice(11, 19) + ' ' + line + '\n') } catch (e) {}
  }
  w('--- debug mod loaded in pid ' + process.pid + ' ---')
  // storage 进程专属：记录每条经过 Collection.find 的查询（含发给它的原始 query），
  // 用于定位 "fun is not a function" 崩溃的元凶查询。DSH_SCREEPS_DEBUG_FIND=1 启用。
  if (process.env.DSH_SCREEPS_DEBUG_FIND === '1' && config.storage && typeof config.storage.loadDb === 'function') {
    try {
      var Loki = require('lokijs')
      var origFind = Loki.Collection.prototype.find
      Loki.Collection.prototype.find = function (query, firstOnly) {
        try {
          var s
          try { s = JSON.stringify(query) } catch (e) { s = 'unserializable:' + String(e.message) }
          w('FIND col=' + this.name + ' q=' + (s && s.length > 400 ? s.slice(0, 400) + '...' : s))
        } catch (e) {}
        return origFind.call(this, query, firstOnly)
      }
      w('FIND wrapper installed on Collection.prototype.find')
    } catch (e) {
      w('FIND wrapper install failed: ' + String(e && e.stack ? e.stack : e))
    }
  }
  // 探针 A（docs/spikes/m0-flake.md §三）：在 runner 实际读取 env.terrainData 的时刻
  // 记录 blob 房单（= 将被 loadTerrain 装进 native 路径finder 的内容）与 db['rooms.terrain']
  // 房单的对比。DSH_SCREEPS_DEBUG_TERRAIN=1 启用，默认零开销。
  if (process.env.DSH_SCREEPS_DEBUG_TERRAIN === '1') {
    // 直连 driver 模块单例（make.js 经 require('../index') 拿到的是同一个实例），
    // 包装 getAllTerrainData 与 pathfinderFactory.init，回答三个问题：
    // runner 调了 GATD 吗 / blob 里有几个房 / init 装进 native 了吗。
    try {
      var driverMod = require('@screeps/driver/lib/index.js')
      var origGATD = driverMod.getAllTerrainData
      driverMod.getAllTerrainData = function () {
        w('GATD call pid=' + process.pid)
        var p = origGATD.apply(this, arguments)
        Promise.resolve(p).then(
          function (rooms) {
            var envKeys = require('@screeps/common/lib/storage.js').env.keys
            var storage = require('@screeps/common').storage
            Promise.all([
              storage.env.get(envKeys.ACCESSIBLE_ROOMS),
              storage.env.get(envKeys.ROOM_STATUS_DATA),
            ]).then(function (vals) {
              w('GATD ok pid=' + process.pid + ' rooms(' + (rooms ? rooms.length : 'null') + ')=' + JSON.stringify(rooms ? rooms.map(function (r) { return r.room }) : rooms) +
                ' accessibleRooms=' + JSON.stringify(vals[0]) + ' roomStatusLen=' + (vals[1] ? String(vals[1].length) : 'undefined'))
            }, function (e) {
              w('GATD ok pid=' + process.pid + ' rooms=' + (rooms ? rooms.length : 'null') + ' envReadFail=' + String(e))
            })
          },
          function (err) {
            w('GATD REJECTED pid=' + process.pid + ' err=' + String(err && err.stack ? err.stack : err).slice(0, 300))
          },
        )
        return p
      }
      var pfFactory = require('@screeps/driver/lib/path-finder.js')
      var origInit = pfFactory.init
      pfFactory.init = function (mod, rooms) {
        w('PF.init pid=' + process.pid + ' rooms(' + (rooms ? rooms.length : 'null') + ')=' + JSON.stringify(rooms ? rooms.slice(0, 8).map(function (r) { return r.room }) : rooms))
        return origInit.call(this, mod, rooms)
      }
      w('GATD/PF wrappers installed pid=' + process.pid)
    } catch (e) {
      w('GATD wrap failed: ' + String(e && e.stack ? e.stack : e).slice(0, 200))
    }
  }
  if (config.engine) {
    config.engine.on('mainLoopStage', function (stage, users) {
      if (stage === 'getUsers' || stage === 'addUsersToQueue') {
        var n = Array.isArray(users) ? users.length : '?'
        w('main stage=' + stage + ' users=' + n + ' pid=' + process.pid)
      }
    })
    config.engine.on('runnerLoopStage', function (stage, arg) {
      if (stage === 'saveResultStart' && arg && typeof arg === 'object') {
        var consoleOut = arg.console && arg.console.log ? arg.console.log.join(' | ').slice(0, 150) : ''
        var intentCount = arg.intentsList ? Object.keys(arg.intentsList).length : -1
        var intentsDetail = ''
        if (arg.intentsList) {
          for (var room in arg.intentsList) {
            for (var obj in arg.intentsList[room].objects || {}) {
              intentsDetail += room + '/' + obj + ':' + JSON.stringify(arg.intentsList[room].objects[obj]).slice(0, 120) + ' '
            }
          }
        }
        w('saveResult pid=' + process.pid + ' user=' + arg.username + ' error=' + (arg.error ? String(arg.error && arg.error.stack ? arg.error.stack : arg.error).slice(0, 600) : 'none') + ' memLen=' + (arg.memory ? arg.memory.data.length : 'none') + ' intents=' + intentCount + ' ' + intentsDetail + ' console=' + consoleOut)
      } else {
        w('runner stage=' + stage + ' pid=' + process.pid + ' arg=' + (typeof arg === 'object' ? JSON.stringify(arg).slice(0, 80) : arg))
      }
    })
  }
}
