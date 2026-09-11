# M0 调试记录 —— 新会话接手前必读

状态截至本文件当前修订（孤儿泄漏已修、间歇冻结已破案修复，见下）。分三档可信度标注：✅ 已亲验 / ⚠️ 强假设待一次探针 / ❓ 未钉死。

## 一、已解决且在代码里（不用重查）

1. **users.code 缺 timestamp → VM 冻结**（fd405fd）✅
   `arena-mod createUser` 的 insert 现在带 `timestamp: Date.now()`。
   根因链：`driver/lib/runtime/data.js` L204 `userCodeTimestamp: result[1] && result[1].timestamp || 0`，
   官方 `/api/user/code`（`backend-local/lib/game/api/user.js` L106）恒写 timestamp。
   缺失时 VM 缓存/内存序列化路径异常：`Game.time` 冻结、Memory 不回写，但 runner 每 tick 都在跑。
   回归断言在 `src/runtime/arena-mod.test.ts`。
2. **房间生成后必须 restart**（runner 地形缓冲进程级缓存，S7a 已验）✅
3. 孤儿进程互踩的**现象**：多组服务器共享 db.json 每 10s autosave 互相覆盖，
   拖慢后续测试启动 + 世界状态错乱。判定方法：清场后同测试即绿。✅
4. **孤儿进程泄漏已根治**（4f94fd5）✅
   根因：`service.ts` disposer `() => void this.shutdown()`。cordis `runDisposable`
   （`node_modules/@deepseek-ai/cordis/lib/index.js` L963-966、dispose 链 L1178-1182）
   只 await disposer 返回的 thenable——`void` 丢弃 promise，`await fiber.dispose()` 不等
   ~14s 停服序列（pause + 10.5s autosave 窗口 + SIGTERM），vitest worker 跑完即退 →
   detached 进程组（6 进程/组）整体孤儿。修复：disposer 返回 promise + `shutdown()`
   先 await 在途 `ensurePromise`（dispose 早于就绪时不漏半拉起的组）+
   进程组 spawn 后挂 `process.on('exit')` SIGKILL 兜底（正常停服注销）。
   回归单测：`src/host/service.test.ts`（disposer 语义/ensure 交接/失败路径/守卫，fake server）。
   验证：连续两轮 IT + 单文件全绿，每轮后 `pgrep -af "dsh-screeps-server-smok[e]"` 恒空。

## 二、M0 间歇冻结（flaky ~50%）—— 已破案修复 ✅

### 旧假设（地形交接竞态/persistence gap）—— 大部分被探针否定 ⚠️→✅

探针 C（`scripts/probe-terrain-race.ts` + arena-mod `terrainRooms` 命令）实测 3 轮：
**stop 窗口内 LokiJS autosave 稳定落盘（stop_mtimeΔ ≈ +9.3~9.5s），boot 后 env.terrainData
完整**。持久化交接不是主因。setup 全程（resetArena+generateRoom×2）可以完全落在一个
10s autosave 窗口内（gen_mtimeΔ=-505s 的证据），全靠 stop 窗口兜底——但 stop 兜得住。

### 真正的机制链（pf 探针实证，全链亲验）✅

给 `driver/native/src/pf.cc` 注入 fprintf 探针（load_terrain 逐房打印 + MISS 路径打印查询的
map_pos.id），在失败 run 中抓到：

```
load_terrain: id=17190 (38,67) ... id=17189 (37,67) ...   ← blob 6 房齐全（2 实房+4 墙桩）
MISS: id=17191 (39,67) room_table_size=1                   ← A* 探进了从未生成的房间！
```

完整链：
1. `resetArena` 清空 `db['rooms.terrain']` → **基础地形覆盖被摧毁**（stock 私服装好时全图有地形，
   m0 世界只剩 generateRoom 的两个房）。
2. `updateTerrainData`（blob 重建）只给 db.rooms 里的房间补 **x+1/y+1 两个方向**的墙桩，
   x-1/y-1/对角与更远处全是缺口。
3. pf.cc（`driver/native/src/pf.cc` L20-35）的 A* 从用户房间边界探测邻接房间时，
   `terrain[map_pos.id] == nullptr` → 直接 `Nan::ThrowError("Could not load terrain data")`
   （pf.h：terrain 是 `static std::array<uint8_t*, 1<<16>`，按房间 (xx,yy) 索引，**从不清理**，
   load_terrain 累积填充）。
4. 触发与否取决于 **spawn/控制器的随机位置离房间边界的远近**（A* 是否探出房间）→ ~50%。
   「从某 tick 起 100% 抛错」= creep 出生后第一次 moveTo；「瞬态自愈」= 新 creep 从
   不同出生点换了一条不出界的路径。VM 每 tick 都跑、用户房/城net断言照常通过 ✓。

### 伴随发现（同批探针捎带的真 bug）✅

- **`arena-mod` 的 `addAccessibleRoom` 从未定义**（S7a 742df22 引入的调用，无定义）：
  generateRoom 命令生成房间后 ReferenceError → 返回 400 `{ok:false}` →
  **accessibleRooms 从此断供**（VM 的 WorldMapGrid 按它构建且按 isolate 缓存）。
  被静默吞掉的原因：`service.system()` 不检查 `ok:false`。
- **backend crash-loop**：stock `cronjobs.run` 丢弃所有 job 返回 promise
  （`backend-local/lib/cronjobs.js` L48-52），Node ≥15 对 unhandled rejection 默认 throw
  （stock 代码是 q 时代假设 swallow）→ 任一 cronjob 链路 rejection
  （例：LokiJS 查询异常经 storage `cb(e.message)` 变成字符串 rejection 传回）
  → **backend 整个退出 → launcher crash-loop** → 对局中 HTTP 请求 "other side closed"。
  曾让探针第 3 轮、m0 连跑 run 2 直接失败。

### 修复（全部在 mods/host 层，无 fork）✅

1. `arena-mod`：`addWalledNeighbors(room)` —— generateRoom 后给 8 邻居插全墙地形桩
   （pf A* 读到墙即停，不外溢到第二环；规则中立、双方对称），然后重跑
   `updateTerrainData` 重建 blob。
2. `arena-mod`：`addAccessibleRoom` 落地为 JSON 列表读写（与 driver
   `updateAccessibleRoomsList`、runtime.js `JSON.parse` 的规范形态一致，不用 sadd 混写）。
3. `arena-mod`：`resume` 在放行世界前强制 `driver.updateAccessibleRoomsList()` +
   `updateRoomStatusData()`（main loop 每 20 tick 才刷一次且 fire-and-forget，
   resume 后用户首 run 若赶在刷新前，WorldMapGrid 按陈旧列表构建并随 isolate 缓存）。
4. `arena-mod`：`process.on('unhandledRejection')` 守卫（backend/engine/storage 全进程），
   记录完整栈、进程存活——恢复 q 时代的 rejection 语义，杀掉 crash-loop 类故障。
5. `service.system()`：`ok:false` → 抛错。半执行的命令不能再静默穿过测试与生命周期。
6. `arena-mod`：roomStatusData 播种从 mod 加载期（storage 未 connect 必抛）
   改为首路由惰性播种。
7. **generateRoom 前清本房潜在桩行**（stub 修复后的残留失败，m0stub2-2 实证
   "no free terrain cell found in W64N58"）：B 房相邻于 A 房时，A 的 ring stub 先占位
   db['rooms.terrain']，stock generateRoom（L417 存在性检查只查 db.rooms，L558 直接
   insert）再插一行真地形 → 同房两行 → placeSpawn 的 findOne 命中全墙桩 → 200 次随机
   全是墙。修复 = generateRoom 链前置 `removeWhere({room})`，保证一房恰好一行。

### 验证 ✅

- 契约/单测：`arena-mod.test.ts`（generateRoom stub+accessibleRooms+去毒、resume 刷新、
  惰性播种、守卫幂等）、`service.test.ts`（ok:false 熔断）全绿。
- m0-match：stub 修复后连跑 6+6（一败暴露残留）、去毒修复后连跑 8 全绿
  （修复前 ~40-50% 失败率），每轮后 pgrep 恒空。
- 探针仪器保留：`scripts/debug-mod.cjs`（DSH_SCREEPS_DEBUG_TERRAIN=1 包 GATD/PF.init、
  DSH_SCREEPS_DEBUG_FIND=1 包 storage Collection.find）、`scripts/probe-terrain-race.ts`。

## 三、已知噪音（重启后看到不要当新 bug）

1. `arena-mod` 在 engine/storage 进程第二加载路径打
   "no backend router in this process, routes skipped"（每启动 1 条）。
2. q 双响应打印 `ERR_HTTP_HEADERS_SENT`（`backend-local/lib/index.js` L32 自跟踪输出，
   rejection guard 会接住并打 "[dsh-screeps] unhandledRejection (process kept alive)"，
   进程不崩）。
3. `engine_main.log` 刷 "Game time set to N"（每 tick 一条，stock 行为）。
4. stock `genDeposits` 的正则把 `\\d` 写成了 `\d`（`cronjobs.js` L574），
   `'^[WE]d*5[NS]d*5$'` 匹配不到任何房间——stock bug，对我们无影响（不依赖 deposits）。
5. smoke 私服的 driver native 当前带 `[pfprobe]` fprintf 探针（本轮破案工具，
   只打 stderr 不改行为；重装私服即恢复 stock）。

## 四、工程纪律（血泪，别再踩）

1. **pkill/pgrep 自匹配**：模式串必须 `[x]` 方括号化，且**同一命令的其他参数**
   （如 `ls /tmp/xxx-server-smoke/server`）也会被另一条模式命中——pgrep 单独跑最稳。
2. **共享 smoke 目录是单写者资源**：`/tmp/dsh-screeps-server-smoke` 被所有 IT 共享，
   并行会话/代理同时跑必互踩。
3. **tests 的 mkdtemp 目录从不清理**：磁盘垃圾 + 上面第 2 条的放大器。
4. **并行 subagent 纪律**：让 subagent 只碰指定文件；没读 reference 代码不下探针结论。
5. **服务层不得静默吞 ok:false**（本次教训：generateRoom 半执行藏了三个里程碑）。
6. **遇到"间歇性"先跑探针再修代码**：本轮 persistence-gap 假设（旧文档 §三）在探针下
   三轮全绿，直接证伪；真实根因在 pf 层，靠 fprintf 探针一锤定音。

## 五、新会话入口（按序）

1. ~~一行修复泄漏~~ ✅ 4f94fd5
2. ~~探针 A/B/C + 修 m0 flake~~ ✅ 本文第二节（pf 探针破案 + 8 邻居 stub 修复）
3. **S9b：service 适配 ArenaBackend + 真实结算 e2e**（生命周期编排层 53ed678 已备好，
   ArenaBackend 接口 = ensureRunning/system/createUser/restart/getWorld，
   ScreepsService 已结构化满足，只差 MatchService 接线与真实结算 e2e）
4. S11 HTTP 桥（契约已核对：`ctx.webServer.register({kind,path,handler})` +
   `ctx.effect` 注销；no-store）；S13 工具面（`defineTool` + `ctx.tools.register`，
   peerDep 需加 `@deepseek-ai/dsh-tools`）。
5. S14：README + AGENTS.md 回写。
