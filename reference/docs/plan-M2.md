# M2 计划 v9 — Agent 循环（世界模式全流程闭环）
> **2026-09-09 M5 superseded 注**：本计划所述 `world-live`（连续实时热更）已按用户拍板废弃并删除（M5 改 world-rounds 回合制）；其余机制（会话映射/热更语义/事件链路）沿用。

> 审查记录：v1（一审 5 阻塞+6 次要+5 提示）→ v2（二审 1 阻塞+2 次要+8 提示）
> → v3（三审 2 阻塞+5 次要+7 提示）→ v4（四审 2 阻塞+6 次要+4 提示）
> → v5（五审 2 新阻塞+6 次要+5 提示）→ v6（六审 1 阻塞+5 次要+5 提示）
> → v7（七审 1 阻塞+5 次要+5 提示）→ v8（八审 1 阻塞+4 次要+5 提示）
> → v9（九审 **PASS**，b964ce31）→ v9.1（本版：吸收九审 5 条非阻塞次要 + 开工前复核清单落位）
>
> 八审要点（34602794，已取证实）：
> - **阻塞 N3 修正（headless 加速来源假命题）**：`lifecycle.ts` L97 用 `match.config.tickDuration`（model.ts L44 world-live=400）；
>   `--patch tickDuration:100` 的 service config 只在 ensure 期生效一次即被覆盖（service.ts L198-201）；create 全链路
>   （tools.ts L330-339 / match-service.ts L32-34 / http.ts L199-208）无 override。**修法：tools create 加可选 tickDuration 参数 →
>   透传 `configFromPreset(preset, {tickDuration})`（model.ts L145-156 已支持）→ 模板显式传 100；删「--patch 会生效」假命题**。
> - 七审阻塞 N1（整组去重）**已修对**：`_damage.js` L93 / `_die.js` L97 保证含 DESTROYED 的 tick 相邻必不等 → 致死 tick 永不被去重。
> - 次要 4 条：①ring 稀疏消费语义未钉死（sinceTick/tickCursor 是 tick 数值还是下标、eventsByRoom 只含变化房、bound 按条目数）；
>   ②busy-guard 丢 tick 窗口会覆盖唯一致死 tick——IT1「kills==0→fail」宜区分「无任何 DESTROYED 采集」与「采集到但 kills==0」；
>   ③start rooms 形状 string[]→{room,exits?}[] 波及 tools/http/lifecycle/test 未写明；④`__bot__` 前缀应 username+sessionId 双拒、
>   写清 addBot 走 store.addPlayer 内部路径豁免。
> - 提示：event-stream.md L41-43 与主循环（每 tick 处理 ACTIVE_ROOMS）对齐；ObjectId↔字符串统一；attack 返回值断言防
>   ERR_NO_BODYPART 误报；frozen 校验取活跃对局 config；busy-guard 处理中标记。

## 现状事实（已取证，动手前复核行号）

- **S13 工具面已就绪**（`src/host/tools.ts`，8 工具全绿）；会话映射 `resolveBinding`（L50-52）。
- **M2 核心缺口 = 事件流未落地**（lifecycle.ts L127-133 kills/losses 恒 0；arena-mod L104-114 探针只数 tick）。
- **frozen 未生效**（model.ts L45；tools.ts L219 不校验）。
- **report 只有分数 delta**；CPU 源是配额常量；**lastUsedCpu 真实存在**（driver/lib/runtime/make.js L64/75/197，worldSnapshot 现不带）。
- **公平边界现状**：工具面 observe/pause/resume 校验缺失（tools.ts L359-383）；**HTTP 面 http.ts L276-302 零校验**。
- **开局 safe mode 20000 tick**（arena-mod.cjs L256）→ 战斗 IT 先 clearSafeMode（免 restart）。
- **房间边界**：W15N16 是 W15N15 的**北邻**；`exits` 形状 = `{top/right/bottom/left: [格点坐标]}`（map.js L14-26/L275-299）；
  跨房 = creeps/tick.js L54-76 边界格 interRoom；`Game.roomObjects` 只含用户所在房间物件（data.js L103/136）。
- 事件形态：`{event, objectId, data:{targetId?, damage?, attackType?}}`；**ATTACK damage 固定**（30/部件/tick 逐部件加和）；
  DESTROYED 只 objectId；ATTACK 无 targetUser；攻击者可能同 tick 死亡。
- **losses/归属来源**：**都在 `rooms.objects`**——`{type:'tombstone', creepId}`（_die.js L21-35）与 `{type:'ruin', 'structure.id'}`
  （_destroy.js L21-49）；白名单集合确认可查。
- **stock env 无 hgetall**；官方 hmget 先例：driver/lib/runtime/data.js L141。
- **tickDuration 链路（八审修正）**：lifecycle.start L97 用 `match.config.tickDuration`（预设值）；service config 的 tickDuration
  只在 ensure 期 setTickDuration 一次（service.ts L198-201）后被 start 覆盖；`configFromPreset(preset, overrides)`（model.ts L145-156）
  **支持 tickDuration override**——工具 create 需显式透传。
- **client 现状**：panel.tsx start 无 body（用 `current.players[0].sessionId`）；board.tsx observe 轮询是 GET、http 是 POST-only → 恒 405。

## M2 目标（AGENTS 里程碑对齐）

1. bot 座位（addBot + BotRegistry）；2. 事件采集（ring + hmget + exits 透传 + clearSafeMode + 房间整组去重）；
3. kills/losses 归因（ATTACK↔DESTROYED + rooms.objects 内 tombstone/ruin + 攻击者死亡兜底）；
4. frozen 拒 submit；5. report 增强（事件聚合+报错+lastUsedCpu 趋势+分层）；6. headless 闭环验收。

## 任务清单

> 执行回填（2026-09-08）：A-D、E1、两项真实 IT 与 E3 headless 均已完成并由顶部 M2 收尾日志签收；下列原始设计条目保留审查轨迹，F 的提交仍需用户确认。

### A. arena-mod：事件采集 + exits 透传 + clearSafeMode（screeps-mod/arena-mod.cjs）
- [ ] 事件采集：订阅 roomsDone → `db.rooms.find({},{_id:true})` → `env.hmget(ROOM_EVENT_LOG, ids)`（data.js L141 先例）→
  环形缓冲 `[{tick, eventsByRoom}]`（4096 + ringFull → bound=false → settle 记 scoreWarning）。
  **ring 稀疏语义钉死（八审次要 1）**：
  - **只 push「有变化的 tick」**（去重后）；条目 = `{tick, eventsByRoom}`，eventsByRoom **只含变化房**（键=roomId，值=该房事件数组）；
  - **游标语义**：host 的 sinceTick 是 **ring 下标**（不是 tick 数值）；eventLog 返回自下标起的事件条目列表 + 新下标 +
    bound；tick 数值在每个条目里，host 端不用假设连续；
  - **bound 按条目数**（不是 tick 数）——可供消费的条目数上限，满了置 ringFull。
- [ ] 事件预处理在 roomsDone 回调内即时执行：
  - 批量一次 `db['rooms.objects'].find({_id: {$in: ids}})` 解析 ATTACK.objectId→attackerUser；
  - **ATTACK.objectId `_id` miss（攻击者同 tick 死亡，_damage.js L16-19/L86-91 → _die.js L12 remove）→
    查 `{type:'tombstone', creepId: id}` 兜底**；
  - **DESTROYED.objectId 与 ATTACK.data.targetId**：`{type:'tombstone', creepId: id}` 取 user；
    `{type:'ruin', 'structure.id': id}` 取 structure.user（兜底顶层 user）——集合是 rooms.objects；miss 记 null；
  - 加工 `{event, objectId, attackerUser?, targetUser?, data:{targetId, damage, attackType?}}`，ring 只存已解析结果；
  - **ObjectId↔字符串统一（八审提示）**：db 的 _id 是字符串（storage/db.js L316-322），事件 JSON 里 id 也是字符串——预处理里
    保持字符串比较，不混 Buffer/hex；
  - **busy-guard（防重叠）**：回调加处理中标记，find 链慢于下一 tick 发布时**丢弃/合并**（只保留最新）；丢 tick 窗口
    可能覆盖唯一致死 tick——**IT1 的 kills==0 fail 分支区分「无任何 DESTROYED 采集到」（采集断链 → 检查 busy-guard/dedup）
    与「采集到 DESTROYED 但 kills==0」（归因断链）**（八审次要 2）；
  - **去重（房间整组数组比较）**：记录每房上一 tick 原始事件数组（JSON 串）；当前与上一 tick 完全相等 → 整组跳过；
    不等 → 整组保留（死亡 tick `[ATTACK,DESTROYED] ≠ [ATTACK]` → 保留；连续攻击 `[ATTACK]` 恒等 → 跳过）；
- [ ] **generateRoom 透传 exits**：`{room, exits?}`（兼容字符串）；`{top/right/bottom/left:[格点坐标]} → cliMap.generateRoom(room,{exits})`；
  顺序：removeWhere → generateRoom → addWalledNeighbors → updateTerrainData → addAccessibleRoom；**带 exits 生成后必须 restart**。
- [ ] clearSafeMode(room)：db 直改 controller.safeMode = gameTime - 1；免 restart；roomObjects 命令补 safeMode 字段。
- [ ] 新增 `eventLog(sinceTick?)`：`{ok, events, bound, cursor}`（cursor=ring 下标）。
- [ ] **ring 跨场卫生（九审次要 2）**：resetArena（arena-mod.cjs L370-391）不清 roomEventLog env hash——在 resetArena 链追加
  `env.del(env.keys.ROOM_EVENT_LOG)`（或 eventLog 首读按对局 startTick 过滤 stale；选前者，简单且干净）。
- [ ] mod 契约测试：roomsDone 采集 + 整组去重（连续攻击→死亡 tick 双事件齐全）+ hitback 攻击者死亡兜底 + eventLog 稀疏语义 +
  clearSafeMode + generateRoom 带 exits + tombstone/ruin 解析 + resetArena 清 env hash。
- [ ] 修正 docs/spikes/event-stream.md L35-36（hgetall 错结论）**与 L41-43（已知边界描述与主循环一致：每 tick 处理 ACTIVE_ROOMS，
  hash 保留旧值 → 整组去重正是为它服务）**。

### B. host 事件读取 + kills/losses（src/host/）
- [ ] `ScreepsService.eventLog(sinceTick?)`（service.ts，arenaFetch cmd=eventLog，游标=ring 下标）。
- [ ] counters 内存累积：MatchService 持 `Map<matchId,{cursor,counters}>`；**归因合并点放 lifecycle.observe 内（或 observe
  接收可选 counters 注入；settle 内部调 observe（lifecycle.ts L151-172）与工具 observe 复用同一路径，防 settle 漏 kills）**；
  territory/rcl 现算、kills/losses 累积；不落盘、落盘在 settle；删除/结算清 Map；host 重启→interrupted 作废；bound=false→scoreWarning；
  **首次消费 cursor=0 → 全量（consoleOutput since 缺省全量先例：http.ts L137-160）**。
- [ ] kills/losses 归因：
  - kills：同 tick `DESTROYED.objectId` ↔ `ATTACK.data.targetId` 匹配 → 归 attackerUser；多命中去重计 1；hitback 反转按方向区分；
  - losses：同 tick DESTROYED.objectId 归属 targetUser（mod 已解析）计 1 loss；无 ATTACK 匹配的老死/自杀/回收不计（记 decayLosses）；
  - 核对表：_damage.js L51/88-93、creeps/_die.js L12/21-35/94/97、_destroy.js L21-49、attack.js、rangedAttack.js、towers/attack.js。
- [ ] 单测：kills/losses/score；负向：无事件、重复 observe 不重计（游标幂等）、bound 缺陷、多 ATTACK 去重、hitback、
  自然死亡不计、Map 清理、tombstone/ruin miss 兜底、攻击者死亡兜底。

### C. frozen + 角色校验全收口（tools.ts + http.ts + match + client）
- [ ] submit_code：**取该会话活跃对局的 config.frozenCode**（resolveBinding → store.get(matchId)；frozenCode=true → 拒）。
- [ ] 工具面 observe/pause/resume：会话须是对局玩家；start/settle creator-only。
- [ ] **HTTP 面（含 client 回归 + GET observe 分流位置）**：
  - `POST /matches/:id/{pause,resume,settle}` body 必须带 sessionId（ArenaRequest 补可选 sessionId）→ 校验 ∈ 对局 players；负向测试；
  - GET /matches/:id/observe 新端点（公开投影）——分流位置在 http.ts L253-254 POST-only 405 检查之前（照 console GET L238-249 先例）；
    保留 POST observe；打表：GET observe 200 / POST observe 200 / GET pause 405；
  - start 带 body.sessionId（client 用 `current.players[0].sessionId`）+ creator 校验；
  - **`__bot__` 前缀双拒（八审次要 4）**：HTTP 与工具面的 **create/join 里 username 与 sessionId 都以 `__bot__` 开头的都拒**
    （USERNAME_RE 拦不住）；**addBot 走内部路径（store.addPlayer + BotRegistry）豁免该检查**——写清豁免边界。
- [ ] 单测：frozen 拒；工具面/HTTP 面非玩家拒（body 缺 sessionId 400）；`__bot__` 前缀拒（username+sessionId 双维度）；
  GET observe 端点。

### D. report 增强 + 分层（tools.ts + lifecycle + arena-mod）
- [ ] report 增：事件聚合（己方视角一行摘要）；己方报错（顶层 `{userId, error}`（driver/lib/index.js L409））；
  CPU 趋势：worldSnapshot 补 lastUsedCpu（mod 侧：arena-mod.cjs L272-315 投影加 db.users.lastUsedCpu）→ reportCursors 扩存 → 差分。
- [ ] 分层：`attackerUser==我 || targetUser==我 || room 属于我`；room 属于我=保守近似；map-stats 公开投影不动。
- [ ] 单测：分层打表；lastUsedCpu 差分；报错帧解析。

### E. 闭环验收（tests/ + headless）
- [ ] bot 座位：`screeps_match action="addBot" {matchId, bot="harvester"}`：BotRegistry.load → 固定 username `__bot_<name>` +
  固定 sessionId `__bot__<name>` 入局（store.addPlayer 内部路径）；BotRegistry 装配挂 `svc.bots`；同局重复 addBot 被
  store sessionId 拒；跨局天然免疫（创建只在 start 的 resetArena 后）；lifecycle.start bot 座位代码 = BotRegistry.load；
  **bots/ 入 package.json files**。
- [ ] **create 加 tickDuration（八审阻塞 N3 修法 + 九审次要 4 补链）**：
  - `screeps_match action=create` 参数加可选 `tickDuration`（数值 ms）→ match-service.createMatch → **lifecycle.createMatch
    （lifecycle.ts L57-60，configFromPreset 实际调用点——这层同步加 tickDuration 参数）** → `configFromPreset(preset,
    {tickDuration})`（model.ts L145-156 已支持）→ lifecycle.start L97 setTickDuration 用新值；
  - **`tickDuration` 未提供时省略该 key（勿传 undefined——`...overrides` 会把 undefined 覆进去致 isMatchConfig 失败）**；
  - HTTP create 同步加可选 tickDuration；**删掉「--patch tickDuration 会生效」假命题表述**；
  - IT/headless 模板显式传 `tickDuration:100`。
- [ ] **新 IT 一：战斗 IT（kills>0）**：
  1. create（world-live, tickDuration:100）→ addBot(harvester) → `start(rooms=[{room:'W15N15', exits:{top:[22,23,24]}},
     {room:'W15N16', exits:{bottom:[22,23,24]}}])`（南北邻、同 x 坐标逐格一致；lifecycle.start 透传 exits；
     start 内 resetArena → 带 exits 生成 → addWalledNeighbors → createUser → restart → resume）；
  2. clearSafeMode 清双方 safeMode → roomObjects 断言 controller.safeMode < gameTime → 失败即判 IT 前置失败直接 fail；
  3. A 提交攻击 bot（两阶段 + energy 分工）：
     - **damage=60/tick（[ATTACK,ATTACK,MOVE] 逐部件加和）**；拆 B spawn（5000 hits）≈ 84 tick；总预算 ≈ 9+100+84 ≈ 200 tick ≪ 4000；
     - cost=210 ≤ SPAWN_ENERGY_START=300 → 开局直接 spawn（剩 90）；
     - 阶段 1：首房无敌人 → `creep.moveTo(22,0)`（A* 绕墙到北出口）→ interRoom 自动转移；
     - 阶段 2：进 B 房有 non-self 对象 → `creep.moveTo(target)` → `creep.attack(target)`；
       **attack 返回值断言（八审提示）**：`ERR_NOT_IN_RANGE` 正常移动、`OK` 计数、`ERR_NO_BODYPART` 视为代码 bug（attack creep 必有 ATTACK 部件）；
     - 不要给 attack creep 写 harvest（HARVEST_POWER=0 空转）；
  4. **tick 预算：4000 tick 内 kills==0 → fail + dump**（report 全文 + worldSnapshot + A 的 Memory + 原始事件尾段 + ring bound +
     双方 gameTime + **该局 DESTROYED 事件计数**（按有无 DESTROYED 区分采集/归因断链，九审次要 5））；**区分「无任何 DESTROYED
     采集到」（采集断链）与「采集到但 kills==0」（归因断链）**；
  5. 多次 report 断言 kills>0 + losses 匹配 + 事件聚合 + 分层不泄露。
- [ ] **start rooms 形状迁移波及清单（九审次要 3）**：`rooms` 从 `string[]` 迁到 `{room, exits?}[]`——需同步改：
  `lifecycle.start` L70 参数类型、`match-service.start`（现传 rooms）、`http.ts` start body 校验（L266-269 现要求 string+ROOM_RE）、
  `tools.ts` L320 rooms schema（现 items string）、既有 lifecycle 单测打表。
- [ ] **新 IT 二：主闭环 IT（事件链路+分层冒烟）**：
  1. create（world-live, tickDuration:100）→ addBot → start（随机房）；A 提交采集 bot（harvester 类，Memory.stats + console.log）；
  2. tick 规模 ≤2000（ring 4096 安全、CREEP_LIFE_TIME=1500<2000 老死 DESTROYED——聚合可见但 losses 归因后仍 0）；
     断言己方房间事件聚合 + kills/losses 均 0 + 报错聚合 + 摘要格式 + 分层不泄露；
  3. settle → winner 落盘 + scoreWarning 无。
- [ ] **headless 验收（模板 + 串行纪律）**：
  - **模板句**：`screeps_match(action=create, preset=world-live, tickDuration=100) → addBot(bot=harvester) → start →
    screeps_submit_code(采集 main，Memory.stats + console.log) → 循环 {screeps_wait(seconds≈30) / screeps_report} 直到
    ticksElapsed ≥ 200 → screeps_match(action=settle, reason=manual) → 报告 winner + gameTime + 玩家数`；
  - **加速来源 = create tickDuration=100**（不是 --patch；patch 只在 ensure 期生效已被 start 覆盖）；
  - **时长核算（400ms 风险消除）**：100ms/tick × 200 tick = 20s；wait 步长 30s 会 overshoot 到 ~300 tick——
    模板步长改为 `screeps_wait(seconds≈10)`（=100 tick）或该段只测事件链路（200 tick 内必有 harvest/upgrade 事件，
    m0 实测 ~150 tick 起效）——**写 10s 步长**；
  - **串行**：headless 与两个 IT 串行（共享 smoke dataDir 单写者）；
  - 命令：`dsh --profile headless --patch <dataDir 指向 smoke 目录、port:0> "<模板句>"`；
  - kills>0 断言在战斗 IT，headless 不要求。
- [ ] 若 headless 暴露缺口 → 顺手修工具 description/output 长度。

### F. 收尾（✅ 已完成，2026-09-08）
- [x] LOG 追加 M2（证据链 + 遗留：interrupted 死局、frozen 完整玩法、room 可见性精确化、world 房间扩张开销）；AGENTS 同步；TEST.md 确认。
- [x] 验证：140 单测通过（1 个 IT lane 跳过）、typecheck/build 通过、9/9 IT 全绿、E3 headless 闭环通过。
- [ ] 提交：实现与文档 commit 待用户确认后执行（本轮不擅自提交）。

## 验证
- 单测全绿（108 + 新增 ~30）；typecheck + build；IT 全绿零孤儿（串行）；headless 可判定；公平边界回归。

## 风险与缓解
- exits 形状/方向：以 map.js L275-299/L420-426 为准；首跑可达性断言兜底。
- safeMode：clearSafeMode 免 restart；roomObjects 断言 + 失败即 fail。
- A bot 空转：两阶段 + energy 分工 + moveTo(22,0) + attack 返回值断言；kills==0 fail-dump 区分采集/归因断链。
- 去重：房间整组数组比较（七审确认成立）；ring 稀疏语义钉死。
- 归属：rooms.objects 内 tombstone/ruin + 攻击者死亡兜底；预处理钉死在 roomsDone 回调。
- **加速**：create tickDuration 透传（八审 N3 修法）；模板 10s 步长。
- ring 溢出：bound + scoreWarning；两 IT tick ≤4000/≤2000 < 4096。
- client 回归：observe 改 GET；start 补 sessionId。
- bot 公平：`__bot__` 双拒（HTTP+工具面 create/join）+ addBot 内部豁免 + 快照不热更；clearSafeMode 仅系统命令（不暴露）。
- 分发：bots/ 入 files；串行纪律。

## 明确不做
地图/地形增强；client 新 UI；schedule 桥插件侧；energy 分；frozen 完整玩法（M3）；arena-blitz/world-frozen 兵种（M3）；
engine 级可见性精确化；interrupted 死局恢复。