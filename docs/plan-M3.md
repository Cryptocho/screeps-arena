# plan-M3 — 多局生命周期（会话拆解回收 + 房间池可配置 + 多活跃对局 + 对局历史）v3

> 范围拍板（2026-09-12，用户授权自主推进）：M2 已关闭，M3 做锦标赛/arena-blitz 的**共同地基**
> ——「多局」。一次性消除 M2 显式边界（settle 后再建局仅同席位可行、房间池固定 2、单活跃对局）。
> 锦标赛调度、回放、arena-blitz 镜像克隆、表现层收尾不在本计划。
>
> **v2（一审 FAIL 11 条→修订）**：订正 D5 事实错误（generateRoom 无 already-exists
> 拒绝——mod 侧主动清库后覆盖生成，防误重掷唯一防线 = host 侧 generatedRooms 判定）；
> D2 补 removeRoom 完整语义（terrainData blob / ACCESSIBLE_ROOMS / 邻居桩 + restart 时序）；
> roomsPrepared 标志退役；restart 爆炸半径策略；恢复局房间占池；m2-smoke 判据改写；
> teardown 残留持久化 + 可查面；S0 范围扩至 env 键与 mod 进程内状态；compose 判据降级路径；
> history 字段/契约对齐。详见各条内嵌标注。
>
> **v3（二审 FAIL 2 阻塞 + 3 非阻塞→修订）**：D7 history 补 `rooms` 映射（补拆解的数据载体，
> 二审问题 1）；D2 removeRoom 收尾必须对被删房插回全墙桩（防被删房成为活跃局的无桩邻居，
> 二审问题 2）；D2 env 逆向清单补 ACTIVE_ROOMS / rooms.intents / rooms.flags（二审问题 3，
> S0 实测兜底）；D3/D4 竞态窗口语义定义为「接受瞬时拒绝」（二审问题 4）；D7 history 按
> match id 幂等（二审问题 5）。

## 1. 背景与动机

- M2 边界（AGENTS.md）：settle 后 `machines` 已释放但 `usedSeats`/`arena.rooms`/`users`/
  `runners` 保留 → 换席位再建局命中房间池耗尽；房间池硬编码 `['E5N5','E7N5']`；
  createMatch 守卫 `machines.size > 0` 直接拒绝（单活跃）。
- 后续所有产品模式（锦标赛 = 多局编排；arena-blitz = 独立对局形态）都要求「一局结束干净回收、
  新局可用全池」乃至「多局并存」。现在做地基，M4+ 只做编排不再动底层。
- 公平红线不变：拆解与回收全部发生在 host 侧与私服管理面，Agent 工具面（submit_code/
  report/console）零改动。

## 2. 设计决策（D 系列）

- **D1 拆解粒度 = per-match targeted teardown，不是整世界 resetArena**。
  resetArena 清全场用户/房间（保留 Invader），多活跃对局下会砸掉别局的世界——只用于
  「无任何活跃对局时的显式清场」（可选运维口，不默认）。settle 拆解走定点删除：
  该局每个席位 → 删私服用户 + 删其房间（rooms.objects / rooms.terrain / rooms 三集合 +
  逆向 env/元数据操作，见 D2）。
- **D2 mod 新增两个 system 命令：`removeUser`（按 username 幂等删）与 `removeRoom`
  （幂等删）**。generateRoom 内已有按房清库序列（arena-mod.cjs L758-766）可抽出复用，
  但 removeRoom **不止删三集合**，必须完整逆向 generateRoom 链路：
  ① 三集合（rooms.objects / rooms.terrain / db.rooms）；
  ② `updateTerrainData()` 重建 env terrainData blob（否则其余房 runner 地形视图与 db 失配，
  寻路触发 m0-flake「Could not load terrain data」）；
  ③ ACCESSIBLE_ROOMS 移除该房（addAccessibleRoom 的逆向）+ **ACTIVE_ROOMS 移除**
  （placeSpawn 链尾 activateRoom 会写入，残留使 runner 每 tick 尝试跑死房）+
  `rooms.intents` / `rooms.flags` 该房条目清理（与 resetArena 清场粒度对齐；
  env 逆向全集以 S0 实测清单兜底，二审问题 3）；
  ④ **邻居桩检查（防「删掉别人的桩」）**：若被删房是仍活跃对局房间的 8 邻 walled 桩源
  （或反之），删房会连带破坏活跃局寻路——实现为：removeRoom 拒绝删除「当前 generatedRooms
  中活跃局房间的邻居桩房」，桩房本身不独立回收（随其主房同批拆解）；
  ⑤ **收尾插桩（防「被删房变成别人的无桩邻居」）**：removeRoom 删 terrain 后、
  updateTerrainData 重建 blob **之前**，对被删房插回 2500 全墙桩（复用 addWalledNeighbors
  插桩逻辑插向自身）——否则该房成为「未生成房」，活跃邻房 A* 探测到它即触发
  m0-flake「Could not load terrain data」（二审问题 2）；
  **removeUser 完整性（S0 实测钉子定清单）**：db.users 关联集合全集 + **env 侧键**
  （memory 存 `env.keys.MEMORY+uid` 等——注意现 resetArena 也不清 env 键，S0 一并实测）
  + mod 进程内 `consoleBuffers`（按 userId 键控，删号需同步清防泄漏）。
- **D3 回收时序与可查面**：`settled` 事件（wireMachine 现有分支）→ **先写 history
  （teardown:pending，含 rooms 映射）** → journal.remove → 异步 teardown：dispose runners →
  releaseSeat（unbind + removeUser + removeRoom）→ usedSeats/arena.rooms 释放 →
  history 补记 `teardown:done`。**teardown 失败或进程在 pending 与 done 之间崩溃**
  → 重启时扫描 history 中 `teardown:pending` 的记录，以记录内 **seatUsers + rooms 映射**
  （见 D7）为输入做幂等补拆解（removeUser/removeRoom 本身幂等，天然可重放），补完改 done。
  **竞态窗口语义（二审问题 4）**：teardown 在飞时 roomsSnapshot 仍含在拆房间，
  createMatch 按「可用池 = ROOM_POOL − roomsSnapshot」判定会被瞬时拒绝——**接受瞬时拒绝，
  建局方重试**（窗口 = 秒级 HTTP system 调用链；不引入 pending 扣减的复杂度）。
  teardown 失败实时可见面 = services 级 `teardownFailures` 列表 + `GET /api/teardown-failures`
  （settle 后 machine 已删、m.state.errors 不可达，故不能走 errors 通道——一审问题 11）。
- **D4 createMatch 守卫从「无活跃对局」改为「池可容纳」**：
  **可用池 = ROOM_POOL − arena.roomsSnapshot() 全部在占房间（含 journal 恢复局的房间
  ——恢复局灌回 arena.rooms 但从没写 usedSeats，必须以 roomsSnapshot 为唯一在占事实源，
  一审问题 5）**。席位数 ≤ 可用池余量才放行；席位→房间从可用池按序取。
- **D5 prepareRooms 重构（多局语义）**：
  - **事实订正（一审问题 1）**：generateRoom 对已存在房间**没有** already-exists 拒绝
    ——M2 fix 后它是先清三集合再生成（覆盖语义）。防误重掷的**唯一防线在 host 侧**，
    mod 层不兜底。RealArena 维护 `generatedRooms: Set<string>`，重掷路径只允许碰
    「本局新分配且 ∉ generatedRooms」的房间；对 ∈ generatedRooms 的房调用重掷必须被
    host 侧拒绝（S2 负向单测钉住，不依赖 mod 抛错）。
  - **`roomsPrepared` 全局标志退役（一审问题 3）**：改为 generatedRooms 判定 +
    per-match 待生成集合；bindUser 惰性兜底改为「该席位房间 ∈ generatedRooms 或本局
    prepare 已完成」。markRoomsPrepared 语义改为「把恢复局房间灌入 generatedRooms」。
  - **restart 爆炸半径（一审问题 4）**：prepareRooms 完成时仍需一次 `restart({resume:true})`
    （runner 地形缓存刷新硬要求，S7a spike）。多局并存下这会短暂中断其他活跃局的 run/console
    ——策略：**建局 prepare 全程互斥锁**（模块级 prepare 串行化，现 preparePromise 已是雏形）+
    中断窗口可接受性显式写入 TEST/AGENTS 边界（观战与 runner 重连由现有游标/重试语义吸收；
    M4 若不可接受再评估免 restart 刷新路径）。S5 验证场景含「建局 prepare 与活跃局并存」。
- **D6 房间池可配置**：CLI `--rooms "E5N5,E7N5,…" / 环境变量 ARENA_ROOMS / 默认现池`。
  池大小 = 并发席位上限（沿用 2 房/局最小对局假设：N 席位对局占 N 房）。
- **D7 对局历史**：settle 时**先**写 `history/matches.jsonl`（append 单行，字段：
  id、config 摘要、winner、settleReason、scores、roundIndex、**createdAt**（对齐
  journal 现有字段名，非 startedAt——一审问题 10）、settledAt、seatUsers、
  **rooms: Record<seatId, room>**（快照自 roomsSnapshot 与 seatUsers 同时落——journal.remove
  后这是补拆解唯一可还原房间分配的载体，二审问题 1）、teardown 状态（pending→done，D3））
  + `GET /api/history`（启动时全量读入内存，追加时同刷）+ 前端大厅
  「历史」列表：**HTTP 轮询 `GET /api/history`（5s），不走 WS**（历史是低频冷数据，
  复用现有 matches 列表轮询模式即可，一审问题 10）。
  **按 match id 幂等（二审问题 5）**：history 先写 + journal 后删之间存在崩溃窗——
  重启后该局从 journal 恢复、再次 settle 会再写同 id 记录；append 前若存在同 id 记录则
  **原位更新该行**（jsonl 行内替换），保证 `GET /api/history` 同局单条。
- **D8 同 username 复用**：seatSlug 确定性 → 删号重建同名用户合法（幂等 removeUser 保证）；
  console/event 游标随 unbindUser 清除（已有）。Agent 工作区 seatSlug 目录保留（沿用上轮
  代码/记忆是特性不是垃圾——超时兜底语义依赖它），不随拆解删除。

## 3. 里程碑（S 系列）

- **S0 调研钉子（live IT 实测，先行）**：① removeUser 前置事实——db.users 关联集合全集 +
  env 侧键清单（MEMORY 等）+ mod 进程内状态（consoleBuffers）；实测删除后重建同名用户可用；
  ② removeRoom 后 updateTerrainData/ACCESSIBLE_ROOMS 逆向必要性实测（删房后另一房寻路不 flake，
  **断言形态含「被删房与活跃房相邻」——全墙桩插回的验证场景**，二审问题 2）；
  ③ **核对 generateRoom 覆盖语义**（钉死「无 already-exists 拒绝」事实，一审问题 1）；
  ④ **核对 m2-smoke 各步断言与新语义的冲突清单**（哪些步需改写——判据见 §4.3）。
  结论写进附录 A。
- **S1 mod 拆解原语**：`removeUser`/`removeRoom` system 命令（完整语义 = D2）+ 幂等 +
  mod 打表单测。
- **S2 RealArena 拆解与多局面**：`releaseSeat(seatId)`（unbindUser + removeUser +
  removeRoom）；`generatedRooms` 集合 + roomsPrepared 退役（D5）；prepareRooms 收窄 +
  per-match 互斥（D5）；**负向单测：对 ∈ generatedRooms 的房重掷被 host 侧拒绝**；
  恢复路径兼容（markRoomsPrepared → generatedRooms 灌全）。
- **S3 main.ts 生命周期接线**：settled → history(pending) → journal.remove → teardown（D3）；
  重启扫描 teardown:pending 补拆解；createMatch 守卫改 D4（可用池 = ROOM_POOL −
  roomsSnapshot，含恢复局）；房间池 D6；`teardownFailures` + `GET /api/teardown-failures`。
- **S4 对局历史（D7）**：history store（jsonl append + 内存读回）+ routes `GET /api/history`
  + 前端大厅历史列表（轮询，最小功能版，样式仍不做）。
- **S5 多活跃对局验证**：stub lane IT——双对局并存（mock 世界）房间互不重叠；一局 settle
  拆解后另一局不受影响；拆解后全池可复用；**建局 prepare 与活跃局并存**（互斥 + restart 窗口）；
  **恢复局占池**（恢复局房间不被新局分配）。dev lane 已有多局 driver waker 表（M1 修过）。
- **S6 文档**：TEST.md 新增手测段（多局 + 历史 + 池配置）；README/AGENTS.md 状态更新；
  LOG.md 条目；AGENTS.md M2 边界段标注 M3 已消除项（保留多世界未解项）。

## 4. 验收判据

1. `npm test` 全绿（现基线 104/104 + 新增），typecheck / build / build:client 零错。
2. `test:live` 增补段绿：removeUser→removeRoom→generateRoom 重建同房 → createUser 同名
   重建 → bindUser 复用席位成功（D1/D2/S0 事实链）；删房后活跃房寻路不 flake
   （含被删房与活跃房相邻形态）；**kill -9 于 teardown pending 窗口 → 重启 → 残留
   用户/房间被补拆解清掉、generateRoom 重建可用**（D3 补拆解机制端到端，二审问题 1）。
3. **m2-smoke：先按 S0-④ 核对断言与 M3 新语义的冲突，冲突步改写为 M3 语义后全绿**
   （原「9/9 不回归」判据作废——M3 有意变更了 M2 钉住的单活跃/换席位拒绝行为，
   一审问题 6；改写条目在 LOG.md 列明）。
4. 公平性：多局并存下新局重掷不影响已生成房（S2 负向单测 + live 段断言已生成房对象未被重建）。
5. 公平红线负向测试不回退（工具面零改动的回归既有 suite 保证）。
6. compose 冒烟：起服→建局→settle→换席位再建局→down/up 卷持久。
   **降级路径：本机无 Docker 时 → 按工作纪律转为 TEST.md 手测条目并如实标注**
   （M3 实施期 Docker 已在位，预期不触发降级；一审问题 9）。

## 5. 风险与边界

- **用户关联/env 键清单不全** → S0 live 钉子先行，实测取清单；残留逐个清理；
  S0 无法闭合的集合记入附录 A 边界（宁可保守多删，不留脏账）。
- **运行中房间的 creep 在 removeRoom 后**：settle 意味着该局已终结，删房属于清理；
  跨局进犯残骸（该局用户 creep 在别局房间）接受为已知边界（removeUser 删号后 owner 失效），
  记录在案；锦标赛形态若不可接受，M4 评估多进程多世界。
- **prepare 期 restart 中断活跃局**：显式接受的窗口（D5），观战/runner 靠现有游标与重试吸收；
  不可接受的形态留 M4。
- **history 与 journal 语义**：journal = 恢复用（未完结局才存在），history = 记账用（全量），
  两者不重叠（D7）。
- **arena-blitz / 回放 / 锦标赛**：明确不进 M3。
- **表现层**：仍不做（用户决策）。

## 6. 遗留去向（M4+）

- 锦标赛（多局编排 + 淘汰/循环赛制）、回放/历史战报详情、arena-blitz（镜像克隆 mod 级）、
  单世界 vs 多世界（跨容器拆分评估）、房间可见性精确化、表现层统一收尾。

## 附录 A — S0 实测结论（2026-09-12 回填，探针 `scripts/s0-removal-probe.ts` 全绿）

- **用户关联集合全集（实测）**：`users.code`（1 行/user）+ `users` 本体 + `rooms.objects`
  （controller+spawn 共 2 行，**controller.user 即所有权**——不清则同名重建撞
  "room already owned"，实测钉出）；`users.intents/notifications/resources/money/console/
  power_creeps`、`market.orders`、`transactions` 建号期为 0，按 `{user:id}`/`$or` 侧防御性
  清理（路径保留，实测无残留）。
- **env 键**：memory = `env.keys.MEMORY + uid`（建号写 `'{}'`，removeUser 后实测
  memoryKeyBytes=null 即已清）。**resetArena 也不清此键**（已知差额，定点删除补上了）。
- **env 集合 API 差额（实测钉出）**：storage env wrapper 只有 `sadd`/`smembers`，
  **无 `srem`**——ACTIVE_ROOMS 剔除走「del 整键 + 剩余成员逐一 sadd 重建」。
- **removeRoom 逆向（实测）**：删后 roomObjects 空、terrain 恰一行全墙桩、
  accessibleRooms 剔除本房、activeRooms 重建后不含本房；`generateRoom` 同名重建 →
  roomObjects 恢复（controller+source+mineral）→ createUser 同名成功。闭环成立。
- **幂等**：removeUser/removeRoom 对不存在目标返回 `found:false`（removeRoom 存在性判定
  不得用 terrain——桩行会假阳性，改按 db.rooms/objects 判）。
- **m2-smoke 冲突清单（S0-④）**：原 9 步均未断言 M2 的「单活跃/换席位拒绝」语义，
  **无需改写**；M3 增补 4 步（history+teardown done、换席位再建局、二次 settle、
  teardown-recovered=1）。
