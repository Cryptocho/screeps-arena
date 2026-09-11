# Spike M4-A0 — canonical replay source（回放规范源取证与正式 bridge）

> 结论：M4 回放的规范源是 **arena-mod 在 `roomsDone` 边界产出的 canonical public frame**（schemaVersion=1），不是 raw sockjs `room:`/`roomMap2:`，也不是官方 `/map-stats` HTTP 原始响应。本 spike 记录取证、设计契约与真实私服实测证据（对应 plan-M4 v6 §5 A0 gate）。

## 1. 为什么 raw sockjs / 官方 map-stats 不直接作为 normative source

对 `reference/screeps`（screeps 4.3.0 / backend 3.3.0）源码的只读取证：

1. **`room:<room>` 是"每连接/每用户独立维护 prev 快照 + getDiff"的增量**
   - `backend-local/lib/game/socket/rooms.js` L22-139：`roomsDone` 回调对每个订阅房间做
     `db['rooms.objects'].find({room}) + common.getGametime() + rooms.flags`，然后
     `common.getDiff(i.objects, roomObjects)`（L75）按**该连接自己上一份对象基线**产出增量；
     首帧是 `getDiff([], roomObjects)` 的全量（L204）。
   - 每个用户最多 `USER_LIMIT=2` 房间订阅（L9、L37-41）；推送经 `config.socketUpdateThrottle`
     （200ms）节流（L139）。这不是"每 tick 全量公开快照"，而是"按用户视角、节流、限量"的
     diff 流——**多视角各自不同、有丢失/合并窗口、无每 tick 完整公开面**。
2. **`roomMap2:<room>` 是 MAP_VIEW env 的当前值推送**
   - `backend-local/lib/game/socket/map.js` L15-44：`roomsDone` 时对已订阅房间读
     `env.keys.MAP_VIEW+roomName`（L30-34），把 mapView 原文 `_writeEventRaw` 推送（L35-38）。
     它不携带玩家代码/内存等，但也只是单个房间的当前 mapView，无持久化、无回放游标。
3. **官方 `POST /api/game/map-stats` 是按需 tokenAuth 聚合，不是每 tick 自动帧**
   - `backend-local/lib/game/api/game.js` L186-257：`auth.tokenAuth`，body 需 `rooms` 数组 +
     `statName`（带 `\d+` 后缀的 interval）；返回 `gameTime/stats/statsMax/users`（controller
     own/level、reservation/sign/safeMode、mineral）。**必须用用户 token 调用、只返回请求时刻的
     聚合、无持久化流**。把它当回放源意味着 host 每 tick 以玩家身份拉取，触达 token 管理与
     每用户视角边界，且它不是官方存档格式。
4. **`roomsDone` 本身是每 tick 的信号**
   - `driver/lib/index.js` L350-352 `notifyRoomsDone(gameTime)` → `pubsub.publish(ROOMS_DONE, gameTime)`。
   backend 订阅 `roomsDone` 是官方模式（rooms.js L22、user.js L51、map.js L15）。arena-mod
   事件采集器（`screeps_report` 原料）已在该边界工作。

**结论**：以上三种都是"当时那一下"的投影/增量，不具备"每 tick 完整公开回放流 + 持久游标"语义；
要用它们做回放需要 host 逐 tick 以多个用户身份抓取并自行拼接 diff 基线——权限面、节流、双基线
一致性都是不可简化的负担。因此 M4 采用 arena-mod 在 `roomsDone` 边界一次查询 db/env 白名单，
产出**canonical public frame**（公开对象+房间元数据+事件摘要），每条 frame 占一个 record seq，
由 host 决定是否持久化；这只对 db 做只读查询，不依赖用户 token，天然满足"观战公共视角不含
私有 console/代码/内存"的边界。

## 2. bridge 正式契约（schemaVersion=1，arena-mod 内 createReplayBridge 工厂）

- 一条 **record** = `{schemaVersion:1, sourceGeneration, replayId, seq, kind:'frame'|'gap', …}`；
  每条 record 占一个 seq，seq 从 0 单调递增。
- **frame**：`{gameTime, rooms:[{room,status,novice,respawnArea,openTime,own:{username,level}|null,
  publicObjects:[{kind,x,y,username?,level?,hitsBucket?}]}], events:[]}`；events 由 M4-D 事件映射
  扩展；字段是白名单（无 `_id/userId/code/memory/store/intents`；hits 只进 0..15 bucket）。
- **gap**：覆盖闭区间 `[fromTick,toTick]`，reason ∈ busy|backpressure|ring-overflow|restart|reset；
  队列满时把连续 accepted tick 并入/扩展一个未发布 gap；不静默丢。
- `accepted roomsDone` = bridge active 且未 closed 时通过 `(sourceGeneration,gameTime)` 去重登记
  的 tick；每个 accepted tick 最终必须以 frame 或 gap 闭区间覆盖。
- `queueCapacity`（默认 256）与一个待发布 gap：producer（帧工厂）异步跟不上时 queue 增长 →
  backlog ≥ capacity×4 或 gap 跨度 ≥ max(16, capacity×4) → `fatalBackpressure`（显式、拒绝新
  tick、stop 报 partial）。绝不静默丢弃。
- `replayStart/{replayId,matchId,rooms}`：单 active bridge；新 generation `g-…`；冲突返回错误。
- `replayPage{cursor,limit}`：cursor=record seq 水位；nextCursor=最后返回 seq+1；live 时
  `complete:false`；stop 后 `status=complete|partial`。
- `replayStop`：closed → drain queue → 发布最后 gap → final manifest；幂等；无 gap 时
  `complete:true`；fatal/backpressure/reset/restart → `partial`。
- `resetArena/restart` → `invalidate()`：finalize 当前为 partial、释放 active；新 replay 新
  generation，旧 generation 的 page/stop 被拒（隔离）。

## 3. 生产接线（arena-mod.cjs）

- `createReplayBridge` 工厂 + `defaultFrameProducer(gameTime, bridgeState)`（只读 db/env 白名单）。
- `getReplayBridge()`/`resetReplayBridge()`；`systemCommand` 增加 `replayStart/Page/Stop/Status`。
- `roomsDone` 订阅回调在事件采集之外调 `bridge.acceptTick(gameTime)`（并行、互不阻塞）。
- `resetArena` 调 `resetReplayBridge()`（旧场不留 bridge）。
- `ScreepsService` host 侧新增 `replayStart/replayPage/replayStop/replayStatus` 客户端方法
  （arenaFetch 薄封装）。

## 4. 单测 / 契约测试证据

- `src/runtime/replay-bridge.test.ts`（纯状态机 11 条）：start 单 active/generation；
  accepted→frame 单调 seq；duplicate/stale 拒绝；队列满→闭区间 gap 后恢复；异步 producer 失败
  → busy gap 不丢；stop 幂等+complete；page cursor/limit/status；invalidate 后新 generation 隔离；
  reset 清空；持续失败→fatalBackpressure 且已 accepted 全覆盖。
- `src/runtime/arena-mod.test.ts` 集成 3 条（+26 回归）：replayStart→roomsDone→page→stop complete、
  frame 白名单（own.username/level、无 userId/_id/code）、reset 后 invalidate、新 generation、stale
  page/stop 拒绝、未知 replay 拒绝。

## 5. 真实私服实测证据（A0 gate 1-4）

探针 `scripts/replay-bridge-probe.ts`（managed server + resetArena + arenaGen W15N15/W14N15 +
createUser probe_a + restart + resume + replayStart → 等 5 tick → 逐 page 收集 → stop；再
resetArena 验证 generation 隔离）。结果（临时 dataDir + symlink smoke server）：

```
tick=100: records=5 frames=5 gaps=0 monotonic=true  → stop complete=true finalCursor=5
tick=150: records=5 frames=5 gaps=0 monotonic=true  → stop complete=true finalCursor=5
tick=200: records=5 frames=5 gaps=0 monotonic=true  → stop complete=true finalCursor=5
after reset, stale page: rejected ✓
new gen after reset = g-…（isolated ✓）
```

即：每 accepted tick 一帧、seq 单调、无静默丢、stop 完整、reset 后旧 generation 拒绝/新
generation 隔离。单测基线 182 passed / 1 skipped；typecheck 双 program 干净。

## 6. 与 eventRing 的关系（不混用）

既有 `eventRing`（eventLog，M2 记分/cursor）仍是"有变化 tick"的稀疏事件环，服务
`screeps_report` 与 kills/losses 归因；canonical replay bridge 是独立 generation/seq 流，
每 tick 产 frame 或 gap。两者独立游标：ring overflow/busy 走各自 `bound/scoreWarning` 与
replay `gap`，不互相影响（M4-D 落 ReplayStore 时按 §plan 处理）。

## 7. 遗留/后续

- frame 的 `events` 摘要字段由 M4-D 从事件映射填充（当前为空数组）。
- `queueCapacity=256`、`fatal` 阈值是首个实现值；真实长局（arena 2000 tick / world 20000）
  的压测留 M4-D 的 ReplayStore IT。
- host ReplayStore（frames.jsonl/manifest/checkpoint 可见水位）、history/settlement journal、
  tournament 全部属 M4-B/C/D，不在本 spike。
