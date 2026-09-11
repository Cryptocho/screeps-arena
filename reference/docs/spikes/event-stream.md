# Spike S7b — 事件流采集点（对局播报的原料从哪来）

结论先行：**不 hook 引擎、不 fork。arena mod（backend 进程）订阅 pubsub `roomsDone`，每 tick 从 env hash `roomEventLog:` 批量拉全部房间事件日志，按 tick 落入内存环形缓冲，经 `/api/arena/events?sinceTick=` 供 host 做战报。** 所有依据都来自 stock 源码，无一行魔改。

## 证据链（版本 screeps 4.3.0 / driver 5.3.0 / engine 4.3.2）

1. **事件在哪产生**：引擎 processor 处理每个房间时维护 `eventLog` 数组，intent 处理器往里 push
   （`engine/src/processor/intents/_damage.js`：`eventLog.push({event: C.EVENT_OBJECT_DESTROYED, ...})`）。
   scope 里带着它：`engine/src/processor.js` L38 `let eventLog = []`。
2. **事件在哪落盘**：每个房间处理完 → `processor.js` L497 `driver.saveRoomEventLog(roomId, eventLog)`
   → `driver/lib/index.js` L583 `env.hset(env.keys.ROOM_EVENT_LOG, roomId, JSON.stringify(eventLog))`。
   即：**env hash `roomEventLog:`，field=roomId，value=该房间最近一次处理的事件数组 JSON**。
   key 定义：`common/lib/storage.js` L48 `ROOM_EVENT_LOG: 'roomEventLog:'`。
3. **tick 对齐信号**：主循环在引擎 main 进程（`engine/src/main.js` L85-87）每个 tick
   房间批处理完后 `driver.notifyRoomsDone(gameTime)` → `pubsub.publish('roomsDone', gameTime)`
   （`driver/lib/index.js` L351）。
4. **backend 进程能收到吗**：能。pubsub 走 storage RPC socket（`common/lib/storage.js` L139-146，
   `rpcClient.subscribe`，storage 进程负责扇出）。backend 订阅 `roomsDone` 是官方模式——
   sockjs 房间推送就是这么做的（`backend-local/lib/game/socket/rooms.js` L22
   `listen(/^roomsDone$/, …)`，另有 `game.js` L726 统计 tick 耗时）。我们的 sockjs console 流已实测可用。

## 采集器形态（M1 落地时写进 arena-mod）

```js
// backend 进程内（mod 已在那里加载，config.backend.router 存在时）
pubsub.subscribe(pubsub.keys.ROOMS_DONE, function (gameTime) {
  env.hgetall(env.keys.ROOM_EVENT_LOG).then(function (hash) {
    // hash: { W5N3: '[{"event":1,...},...]', ... }
    ring.push({ tick: +gameTime, rooms: mapValues(hash, JSON.parse) })
    if (ring.length > RING_MAX) ring.shift()
  })
})
```

- `env.hgetall` 在 env API 清单里（storage.js L130 起的 env 段有 hmget/hmset/hget/hset/sadd/smembers，
  hgetall 由 storage RPC 提供；实现时若发现缺 hgetall 则用 `smembers`+`hget` 退化，或按 roomId 列表 hget）。
- 环形缓冲深度按对局长度配置（默认 ~2000 tick），host 拉取时按 `sinceTick` 增量取走。

## 已知边界

- **hash 只反映"最近被处理的房间"**：某房间这个 tick 没被调度，它的 field 保持旧值（tick 号不同步）。
  采集器以 `roomsDone` 的 gameTime 为准打 tick 戳，读到的条目统一归属当前 tick（与本 tick 内活跃房间的
  事件语义一致；未处理房间重复上报旧事件由 host 去重：同一 objectId+event+tick 窗口内合并）。
- **引擎事件 ≠ 全部信息**：EVENT_* 覆盖攻击/摧毁/治疗/升级/reserve 等；采集/建造完成等状态变化走
  db diff（`roomsDone` 时对 `rooms.objects` 做快照差分），作为事件流的补充通道，同在 mod 内做。
- **fog of war 在报告层执行**：mod 读的是全服事件（引擎视角）；`screeps_report` 给会话前必须按
  "己方完整视图 + 有视野房间" 过滤（AGENTS.md 观察分层），这一职责在 host，不在采集器。
- CPU/内存类遥测（`user:<id>/cpu` 通道）不在此通道，走 sockjs/user 通道或 db 直读。

## 与 schedule 桥的关系（S7c）

`roomsDone` 的 tick 节奏就是天然观察点：host 侧对局控制器在"每 N tick"观察点生成战报后，
用 schedule 桥给相关会话排 follow-up（S7c 结论：`schedule_create` one-shot，`every_seconds ≥ 300` 太粗，
用一次性 follow-up 而非周期任务）。
