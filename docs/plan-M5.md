# plan-M5：arena-blitz（单房 1v1 快速歼灭）

> 状态：v2 复审 **PASS**（2026-09-14，一审 FAIL 3 阻塞 + 8 非阻塞全部吸收；复审新增
> n1/n2 两条非阻塞已补入 D3/R7 与 D5，随实现处理）。
> 前置复核（2026-09-14）：reference/AGENTS.md「玩法设计」节（arena 模式规则全节）、
> reference/src/host/match/{model,lifecycle,attribution}.ts（旧 M3 blitz 实现）、
> reference/screeps-mod/arena-mod.cjs L1098-1365（arenaGen/arenaProbe 镜像克隆）、
> 本仓 src/server/match/score.ts（isDefeated 已预留 form:'arena' = spawns==0 判定）。
> 结论：**旧仓库 blitz 已完整实现过一轮，本计划以「回迁 + 适配新架构」为主路径**，
> 不重新发明规则；world-rounds 主线行为零改动（回归保护）。

## 0. 目标与非目标

**目标**：在现架构（ScreepsService/RealArena/MatchMachine/driver/tournament）上落地
`arena-blitz` 预设——单房 1v1 镜像歼灭战：固定基准房 W15N15 + 东邻镜像 W14N15（mod
arenaGen 生成对称地形/资源/controller），对等兵力建号，Agent live 热更迭代，
歼灭/击杀分结算，1-7 分钟一局。

**非目标**：world-frozen 预设（BotArena 式代码冻结——规则预设表里留位但不实现）；
2v2 双房变体；回放/战报详情（M5+ 另排）；表现层样式（用户决策：全部功能后单独收尾）；
锦标赛多世界拆分（边界沿用 M4：单世界多局共用）。

## 1. 旧结论复核（写规则时直接引用，不重推导）

- **镜像克隆**（reference mod arenaGen）：基准房 W15N15 生成后，东邻 W14N15
  （`getRoomNameFromXY(x+1,y)`）terrain 逐行反转（x'=49-x，y 不变——出口格天然对称，
  exits 登记钉死不写 db.rooms 字段）、objects 坐标水平翻转（source/mineral/controller
  对称）、addWalledNeighbors + addAccessibleRoom 防越界；sourceKeepers=false（禁 NPC）。
  **arenaProbe** 契约探针返回双房 terrain 编码串 + 对称对象坐标，供 IT 断言对称性。
- **preset 表**（reference model.ts PRESETS）：`arena-blitz = { form:'arena',
  frozenCode:false, tickDuration:150, maxTicks:2000, seats:2, scoring:{kills:1,losses:1,
  territory:0,rcl:0,energy:0} }`。
- **建号对称**：双席固定对称坐标建号（x'=49-x），初始 spawn 能量对等（mod 面读
  spawnEnergy=Σspawn store.energy 作 IT 断言数据源）；「already owned」竞态先 pause
  再建（旧 lifecycle A 节防 flake 链）。
- **结算判定**（本仓 score.ts 已预留）：`isDefeated(s, 'arena') = spawns==0`
  （world 是 spawns==0 且 creeps==0——二者不同，勿混）。
- **击杀归因**（reference attribution.ts）：eventLog 增量消费，同 tick 内
  `DESTROYED.objectId ↔ ATTACK.data.targetId` 匹配 → 击杀归攻击发出方；**匹配不到
  ATTACK 的 DESTROYED（老死/自杀/回收/降解）不计击杀也不计 combat loss**（记
  decayLosses 独立计数，lifecycle 只在 `attribution.combat===true` 才计 losses——
  一审 B1 订正：v1 误写「损失归属 owner」会污染击杀分结算）。
- **单房语义**：arena 局拒收 rooms 参数（镜像由 mod 保证，不随机选房、不走公平重掷）；
  房间分配不占房间池。

## 2. 设计决策

### D1 preset/form 数据模型（回迁 reference model.ts 精华，裁剪到最小面）

- `MatchForm = 'world' | 'arena'`；`MatchPreset = 'world-rounds' | 'arena-blitz'`；
  `PRESETS` 表回迁：world-rounds = `{form:'world', tickDuration:200, maxTicks:0,
  seats:2, scoring:全0}`（**注意：这是按本仓现网默认对齐的裁剪值，非旧表原值
  400/20000/4**——一审 N1；旧表仅 arena-blitz 行取原值）——world-rounds 现行为
  零改动；arena-blitz = 旧表原值（tickDuration:150, maxTicks:2000）。
- `MatchConfig` 增：`form`（默认 'world'）、`maxTicks`（0=不限；world 默认 0）。
  `scoring` 权重暂**不进 config**——M5 的 arena 胜负只由歼灭/击杀分判定，权重固定
  {kills:1, losses:1}（YAGNI：旧仓库权重进配置但从未被改过；要做变体时再参数化）。
- `createMatchInternal` 增 `preset` 入参（默认 'world-rounds'，经 configFromPreset 展开，
  显式 config 字段覆盖）。journal/history 记录透传 form（恢复路径 D8）。
- **[N6] 测试 bot 代码注入通道**：live IT 需要双席注入测试 bot 代码，而
  createMatchInternal 入参只有 `{config, players[{seatId,username}]}`。方案：
  createMatchInternal 增可选 `botCode?: Record<string,string>`（**仅 server 内部
  IT/调度链可用，HTTP 路由层显式剥除该字段**——LLM 永不经由 HTTP 注代码，公平
  边界负向测试钉住）；实现=建号时经 createUser 的 code 参数注入（per-call 覆盖，
  不用 RealArena 构造级 initialCode）。

### D2 mod 回迁 arenaGen/arenaProbe

- 从 reference/screeps-mod/arena-mod.cjs 原样回迁两命令到本仓 arena-mod.cjs
  （含 reverseTerrain/addWalledNeighbors/addAccessibleRoom/防 flake 链——本仓 mod 已有
  同名基础设施，逐函数比对后合并，**不整文件覆盖**：本仓独有 removeUser/removeRoom/
  dbProbe 必须保留）。
- 现文件头「裁剪：arenaGen/arenaProbe」注释同步订正。

### D3 arena 局准备链（RealArena 增 arena 分支 + createMatchInternal 接线）

- **房间**：form=arena 时不用房间池——分配固定 base='W15N15' / mirror='W14N15'，
  `arenaGen {room:'W15N15', sources:2}` 一条命令生成双房；**守卫**：若房间池（ARENA_ROOMS）
  含 W15N15/W14N15 则启动时报错拒起（防 world 局与 arena 局撞房）。
- **B3（一审阻塞）镜像房防覆盖登记**：arenaGen 完成后必须把 W15N15/W14N15 登记进
  `RealArena.generatedRooms`——否则 prepareRooms 的处理域（所有 assigned 且未登记的房）
  会在**之后任何 world 局**的 createMatchInternal → prepareRooms 时 stock-generate +
  公平重掷**覆盖镜像战场**（mod generateRoom 是覆盖语义）。实现取「登记 generatedRooms」
  方案（比 prepareRooms 加房间级排除更贴近现有数据流），**负向测试钉住**：arena 局
  运行中再建 world 局 → 断言无 generateRoom 调用落在镜像房。
- **建号**：双席 createUser 固定对称坐标（base 席 (25,25)、mirror 席 (24,25)——
  x'=49-x 对称；本仓 mod placeSpawn 已支持显式 x/y），初始能量对等由镜像生成保证；
  createUser 的「already owned」先 pause 再建的防 flake 语义保留。
  **[N2]** 显式坐标落墙会被 placeSpawn 静默随机重掷（破坏对称）——S0 探针加断言：
  对称坐标非墙 + 双房 spawn 位置严格镜像对称。
- **tick**：arena 局 start 时显式 `setTickDuration(150)`（**混跑耦合 n1**：tick 是
  全局单值，arena 局活跃期间共存的 world 局同被 150ms——混跑期 world 局 tick 变速
  为已知行为，R7 观察；与 [N3] form 感知 ensure 链同一机制）。
  **[N3]** ensure 链每次 ensureRunning 都会 setTickDuration(200)（service.ts L162）——
  arena 局中私服重启会静默回 200。修法：ensure 链的 tick 值改为**服务实例当前活跃
  对局的 form 感知**（machines 里存在 form=arena 活跃局 → 150，否则 200），restart/
  崩溃恢复后 tick 自然正确；不再依赖 teardown 恢复。maxTicks 局长估算随 tick 变速
  敏感（150→200 时 2000 tick ≈ 6.7 分钟），R3 表述按 150ms 计。
- prepareRooms 公平重掷路径对 arena 局**跳过**（镜像即公平，distance 校验无意义）。

### D4 Agent 参与语义（arena-blitz = live 热更，与 world-rounds 的关键差异）

- **creating 门槛照旧**：全员 submit_code 才 start（复用现有 starter 链/初始唤醒，
  initialPrompt 文案加「arena: fast elimination」语义——无跨局信息红线不变）。
- **running 期热更**：form=arena 时 `submitCode` 在 running 相位**允许**（旧语义：
  引擎下一 tick 生效）；machine 侧更新 `player.code/submittedAt`（journal 复盘用），
  **不触发 ready/roundBreak 语义**。world-rounds 维持 FROZEN_DURING_ROUND 拒绝
  （**负向测试钉住**：form 未放宽即回退）。
- **无 roundBreak**：arena 局不进入 roundBreak 相位（无周期暂停）；driver 的
  roundBreak/resume 路径按 form 分支跳过。
- **唤醒节奏**：started 唤醒 + 每 30s 墙钟状态唤醒（pull report；串行守卫在途拒绝，
  非致命——M4 实测形态）。不做事件级唤醒（tick 150ms 下事件风暴会打爆 LLM 配额；
  战报自含事件增量，Agent 30s 一拍足够——与「等 Agent 干活时看一局」的旁观定位一致）。
- **热更登记落点（[N8]）**：`seatBackendFor` 的机器登记现按 phase
  creating|roundBreak 过滤（main.ts）——form=arena 的 running 热更需扩展该过滤
  （`phase==='running' && form==='arena'` 时同样登记 player.code/submittedAt）。
- **公平边界不变**：三工具面、fog 过滤、无身份参数全部照旧；席位只写自己的用户。

### D5 结算（歼灭 + 击杀分 + tick 预算）

- **归因器**：回迁 reference attribution.ts（同 tick ATTACK↔DESTROYED 匹配 → kills/
  losses per user；**无 ATTACK 匹配的 DESTROYED 不计 combat loss**（B1 订正，记
  decayLosses 独立计数）；事件消费与观察串行化防双计——旧 killLossByMatch 锁语义保留）。
- **B2（一审阻塞）：结算观察是新增件，不是参数调整**。本仓 driver 的 tick 只做
  `machine.advance` + roundBreak 取分（无任何 running 期观察/settle 触发），
  `SettleReason` 只有 `manual|roundsExhausted`。M5 新增：
  - `SettleReason` 增 `'lastStanding' | 'ticksExhausted'`；
  - driver 增 form 感知观察分支（form=arena 时每 tick 观察）：消费 eventLog 增量 →
    归因 kills/losses → world 快照 → 任一席 `isDefeated('arena')`（spawns==0）→
    立即 settle，winner=对手；**同 tick 双淘汰**（对撞同尽）→ 击杀分高者胜，平 → draw；
  - `gameTime ≥ maxTicks` → 按 kills−losses 加权分 settle（kills:1/losses:1），
    平 → draw。maxTicks 基线 = started 事件时的 gameTime 快照（start 时记录，
    **不假设 gameTime 归零**——resetArena 语义与重启后的 gameTime 连续性都不依赖）。
  - **观察游标 host 侧独立（n2）**：driver 观察分支自建 eventLog 消费游标，
    与 RealArena.report 的 per-user eventCursors 是同一 ring 的两套游标——不得复用
    席位游标（否则 report 增量被观察侧吃掉）。
  - **[N4]** 事件 ring 溢出防护：150ms tick 战斗事件密度高，消费侧检测
    `eventLog` 返回的 `bound:false`（游标被截断）→ 局 errors 落「事件溢出，
    击杀分可能低估」警告（对齐旧 scoreWarning 语义），不中断对局。
- **world-rounds 结算路径零改动**（form 分支隔离；回归保护）。

### D6 API / 前端 / 锦标赛

- `POST /api/matches` body 增可选 `preset`（'world-rounds' 默认 | 'arena-blitz'）；
  校验：arena-blitz 强制 seats=2（players 长度 2）、拒收 rooms 类参数、preset 未知 400。
- 对局投影（GET）带 `preset/form`；前端对局行加形态标签（纯文本，样式不展开）。
- **锦标赛**：`POST /api/tournaments` 增可选 `matchConfig`（透传给每场 createMatch——
  通道 M4 已有）；补校验：matchConfig.form='arena' 时 participants 强制 2 人、
  roundMs/roundBreakTimeoutMs/maxRounds 与 arena 语义冲突时忽略并记 t.errors。
  两参赛者 arena 锦标赛 = 单场；多轮需要复赛制 → M5 仅支持 round-robin 单循环下
  每场独立镜像局（人数>2 的 round-robin 照常工作，每场都是新镜像对局）。

### D7 公平红线（M5 特有执行点）

- arena 局不触 prepareRooms/房间池/公平重掷（镜像即公平；arenaProbe 断言代替
  distance 校验：terrain 逐行反转 + objects x'=49-x + 双席 spawnEnergy 对等）。
- 热更放宽**仅限 form=arena**；world-rounds running 期提交拒绝的负向测试保持绿色。
- 初始唤醒/状态唤醒文案零跨局信息（沿用 M4 红线测试，文案黑名单复用）。
- journal/history 恢复：arena 局恢复后不能重跑 arenaGen 覆盖战场（恢复=灌回映射 +
  机器重建，房间已在——与 world 同语义；arenaGen 只在首次 start 前置执行一次）。
  **[N7]** 恢复中的 arena 局必须参与 R1 的单飞守卫与占房事实源：restoreFromJournal
  灌回的 arena 局视为「占 W15N15/W14N15」——恢复期间新 arena 局拒绝（并发守卫把
  machines 里的 arena 局计数在内），roomsSnapshot/createdRooms 同样覆盖（B3 登记在
  恢复路径同样执行：灌回时把镜像房登记 generatedRooms，防任何后续 prepareRooms
  覆盖战场）。

### D8 测试与验收判据

- **单测**（离线）：preset 表与 configFromPreset 校验打表；归因器事件序列打表
  （含同 tick 双杀/**无 ATTACK 匹配 = 不计 combat loss**（B1）/decayLosses 独立计数）；
  arena 结算判定（单淘汰/同 tick 双淘汰/maxTicks 兜底/击杀分平局）；form 分支
  （world FROZEN 负向、arena running 热更正向）；房间池冲突守卫；**B3 负向**：
  arena 局运行中建 world 局 → 无 generateRoom 落在镜像房；HTTP 剥除 botCode 负向。
- **stub IT**（真实 RealArena + MatchMachine + fake svc）：arena 局全自动——
  分配 base/mirror（不触池、登记 generatedRooms）→ 建号（对称坐标断言）→ 提交 →
  start → 模拟事件流 → 歼灭 settle（lastStanding）→ history/teardown 复用现有链；
  并存场景：arena 局运行中 world 局正常建局互不干扰。
- **live IT**（真实私服）：① arenaGen 镜像对称断言（arenaProbe：terrain 逐行反转、
  objects 对称、双席 spawnEnergy 相等、**对称坐标非墙**[N2]）；② **[N5] 复用探针**：
  teardown（removeRoom 回插全墙桩）→ 再次 arenaGen → 战场可用（清桩链工作）；
  ③ 真实 blitz 短局（botCode 注入双席 [N6]，150ms tick，数十秒内歼灭或 maxTicks
  结算，winner/击杀分落 history）；④ restart 中断恢复：arena 局运行中重启私服 →
  tick 恢复 150（form 感知 ensure 链 [N3]）+ 对局不丢。
- **回归**：npm test 全绿（现 157 基线 + 新增）；test:live 7/7 + 新增段；
  m2-smoke 13 步不破；compose 冒烟不破。
- **验收实测**：真实 LLM（qwen/qwen3.7-flash）arena-blitz 一局全程（建局→双 Agent
  初始码→start→热更迭代→歼灭/超时结算→积分），浏览器可旁观，errors=[]。

## 3. 实施步骤

- **S0** 探针：本仓私服跑 reference mod 的 arenaGen/arenaProbe 原样冒烟（回迁前确认
  防 flake 链在新版本依赖下工作）；含 [N2] 对称坐标非墙 + spawn 镜像对称断言、
  [N5] teardown→arenaGen 复用探针。
- **S1** D1 数据模型（含 [N6] botCode 内部通道 + HTTP 剥除）+ D2 mod 回迁
  （单测打表 + mod 静态比对）。
- **S2** D3 准备链（含 **B3 镜像房 generatedRooms 登记 + 负向测试**、[N3] form 感知
  ensure 链 tick）+ D4 Agent 语义（含 [N8] seatBackendFor phase 过滤扩展；stub IT +
  负向测试）。
- **S3** D5 归因器 + 结算（**B2 新增件：SettleReason 扩展 + driver form 感知观察分支 +
  maxTicks 基线 + [N4] 溢出警告**；单测 + stub IT）。
- **S4** D6 API/前端/锦标赛接线（含锦标赛 arena 校验）。
- **S5** 全量基线复跑（npm test / typecheck / build / test:live / m2-smoke / compose）。
- **S6** 文档（TEST.md §0.9、README、AGENTS.md、LOG.md）+ 真实 LLM 验收局。
- **S7** 成果审查循环到 PASS + 关闭提交。

## 4. 风险与边界

| # | 风险 | 处置 |
|---|---|---|
| R1 | 固定房 W15N15/W14N15 与房间池/他局撞车 | 启动守卫拒含冲突房名的池；arena 局单飞（同世界同时只一场 blitz——守卫把 journal 恢复局计入 [N7]）；镜像房登记 generatedRooms 防 prepareRooms 覆盖（B3） |
| R2 | 150ms tick 下 host 事件消费压力 | 归因器按游标增量消费（现有 eventLog 面）；观察维持 500ms；ring 溢出（bound:false）→ 局 errors 警告不中断（[N4]） |
| R3 | LLM 决策拍 vs 150ms tick（旧仓库核心结论：连续实时与 LLM 拍难对齐） | blitz 的 Agent 参与=低频状态唤醒 + 热更迭代（不追 tick）；30s 唤醒节奏 + maxTicks 2000（150ms 下 ≈5 分钟；tick 变速时局长随之变化 [N3]）兜底 |
| R4 | 同 tick 双淘汰归因顺序歧义 | 击杀分优先于 draw 的规则钉死 + 专项单测 |
| R5 | 热更放宽误伤 world-rounds | form 分支隔离 + 负向测试 |
| R6 | 镜像房 removeRoom 回插全墙桩，下局 arenaGen 依赖清桩链 | 复用探针钉住（[N5]，S0）；arena 局 teardown 复用现有 releaseSeat 链 |
| R7 | arena 局与 world 局并存的资源竞争（150ms tick 抢 CPU/事件流） | 单世界多局边界沿用 M4（显式接受）；blitz 定位=短局旁观，文档标注混跑时 world 局 tick 延迟可能上升；**混跑期 world 局 tick 被同步 150ms 为已知行为（n1）**，混跑场景加一条观察 |
