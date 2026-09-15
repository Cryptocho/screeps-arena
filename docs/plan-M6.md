# plan-M6：回放与战报详情（replay + battle report）

> 状态：v5（**v3 二审 PASS、v4 增量三审 PASS**，5+2 处非阻塞订正全部吸收；开工就绪，
> 进入实施 S0/S1）。v4 订正：① world 挂点补相位门控 `form==='world' && phase==='running'`；
> ② R4 溢出语义订正为「**饱和即停投**」而非「重消费」（去重降级为防御）；③ frame.kills
> 的 `type` 改可选并归一 'unknown'；④ 三处失效行号/路径订正；⑤ D4 补 `?frames=none`
> 供 running 期 summary 轮询）。v2 = 一审 FAIL 4 阻塞 + 7 非阻塞全部吸收。v3 = 二审
> 自查事实订正 3 处（**键=房名**、objectInfo.type 取值链、world 节流 + idmap 惰性补写）。
> 前置复核（2026-09-15，v2 订正；v4 行号订正）：src/server/match/{arena-observe,
> attribution,journal}.ts + src/server/history.ts（**订正：history.ts 不在 match/ 下，
> 在 src/server/history.ts**，79 行，其 L44 逐行 catch 就是本计划 D3 引用的残行跳过语义、
> L75-77 才是 tmp+rename 整写）、src/server/main.ts（observeArenaMatch /
> historyRecordFor / teardown 链）、
> src/server/screeps/arena-mod.cjs（eventLog ring EVENT_RING_MAX=4096、roomObjects system
> 口、resolveEventUsers tombstone/ruin 兜底链）、src/server/http/{routes,server,driver}.ts、
> src/client/{app,api,terrain-canvas}.tsx、reference/src/host/replay/（**recorder.ts 184 行
> 完整 ReplayRecorder + store.ts 477 行 checkpoint/batch/残批自愈持久层——一审订正：
> 并非骨架；store.ts 读端残行自愈语义为本计划 D3 直接参考。二审订正：**不搬 reference
> 实现不是「bridge 已裁剪」——reference/screeps-mod/arena-mod.cjs 仍带 replayStart/
> Page/Stop bridge（L1184+），是**本仓裁剪**且**设计口径不同**（本计划 = append 随流、
> running 期可读、逐行崩溃语义；reference = generation/seq + gap/partial manifest），
> 本计划显式不复用其实现**）、
> docker-compose.yml（持久卷清单）。
> 结论：**数据采集器是新组件**，但事件归因（attributeTick）、观察链（observeArenaMatch）、
> terrain canvas、roomObjects system 口全部现成——本计划 = 新增「记录器 + 查询面 + 前端
> 回放器」+ 一处 mod enrich（D1）；对局结算/公平面语义零改动（回归保护，mod enrich
> 为只加字段的显式豁免项，见 D1）。

## 0. 目标与非目标

**目标**：
1. **战报详情**（battle report）：每局（含已结束历史局）可查——结算结果、击杀账本时间线
   （kills/losses 逐事件归因）、人口/分数曲线、关键事件（spawn 被毁、歼灭达成、结算）。
2. **回放**（replay）：浏览器内按游戏 tick 拖动/播放，地图 canvas 上重现逐采样帧的
   单位位置（creep/spawn）与战斗事件标记。

**非目标**：console 历史回放（私服 console ring 会溢出且量大——M7+ 候选，本计划只记
战斗/位置/分数）；2v2 双房；击杀分到 T 变体；表现层样式统一（用户决策：不并入功能
里程碑）；锦标赛积分榜重构；跨容器拆分；replay 文件清理策略（体积成问题再另立）。

## 1. 现状复核（写实现时直接引用，不重推导）

- **事件源**：mod eventLog ring（`EVENT_RING_MAX=4096` 条 {tick, eventsByRoom}，条=有
  事件的 tick 数非事件数；ring 是**全服全局**的——混跑期多局共享容量，溢出阈值按全服
  有事件 tick 合计，v2/R4）。observeArenaMatch 每 500ms 增量消费（游标=ring 下标），
  `ledger.consume` 已按 attributeTick 归因出 kills/losses/decayLosses——**记录器挂同一
  消费点**，避免第二游标二次消费（M5 一审阻塞 1 的教训：游标纪律）。
- **事件字段缺口（一审阻塞 4，D1 拍板依据）**：mod 加工后的事件仅
  `{event, objectId, data, attackerUser, targetUser}`——**无 x/y/type**；且被杀对象同
  tick 已从 rooms.objects 移除（mod 注释 L169-171，tombstone/ruin 兜底链
  resolveEventUsers 本就在查这两集合）。
  〔**v3 订正（一审阻塞 4 的附带错误，v1/v2 沿用未查）：eventsByRoom 的键就是房名**
  （`W\d+N\d+` 形态），不是「db roomId」。证据链：mod L216-217 取 `db.rooms` 的 `_id`
  当 field 去 hmget（键 = `rooms._id`），而本私服 `rooms._id` 即房名——同文件 L782
  `db.rooms.findOne({_id: roomName})`、L1021 `db.rooms.insert({_id: aMirror})` 均以
  房名当 `_id`（L970 房名正则校验、L1163 roomObjects 同款）；旁证：arena.ts report 的
  fog 过滤（L432）直接拿键与 `visible`（房名集合，L57-67 由 owned rooms/对象 room 构造）
  求交；tests/m5-arena.test.ts:50-51（`eventsByRoom: { W15N15: [...], W14N15: [...] }`）
  与 tests/arena-mod.test.ts:319 断言 `eventsByRoom: { E5N5: [...] }`，锚点更强的是
  tests/real-arena.test.ts:109-130（fog 负向：输出字面 `event tick 101 room E5N5`、
  E7N5 被剥离——键若为 objectId 该过滤会全丢）。〔v4 订正：v3 曾引
  `tests/arena-mod.test.ts L672`，该文件仅 445 行、行号不存在〕。
  **故：混跑过滤无需映射 enrich，直接按键判定；D1 的 `rooms: {roomId→roomName}` 条
  作废**（S0 探针仍以真实私服复核一次键形态）。〕
- **分数源**：scoreSnapshotFor（world users 的 spawns/creeps/rooms/rclTotal 聚合），
  observeArenaMatch 每拍已拉取（结算用）；**world form 的 driver 路径目前只在
  roundBreak 相位取分**（driver.ts tick 的 scoreSnapshot 分支），running 期无每拍快照
  ——world 帧的 scores 依赖 D1 新挂点补拉（每拍一次 getWorld，arena 链已有同款成本）。
- **位置源**：`svc.system('roomObjects', room)` 返回
  `{room, objects:[{type,x,y,user,name,hits,store,spawning,safeMode}]}`——mod 已有；
  **`user` 是 Screeps userId 非 username**（v2：meta/idmap 行携带映射，D1）。
- **生命周期**：settle → historyRecordFor（含 seatUsers/rooms）→ journal.remove →
  **异步 teardown（removeUser/removeRoom）**。replay 数据必须 **append 随流落盘**，
  不能靠 teardown 前的一次性 dump（崩溃窗口丢整局；且 running 期浏览器就要能看战报）。
  锦标赛对局走同一 createMatchInternal/wireMachine/observe 接线——自动被记录，无需
  额外步骤（v2 明示）。
- **前端**：TerrainCanvas（terrain 位域 + 归属色投影，纯函数 terrainColor/ownerColor
  已单测）复用于回放帧绘制——props 改造为接受帧数据而非 WorldSnapshot（D6）。
- **journal 恢复**：restoreFromJournal 恢复 running 局（浏览器实测已验证）；恢复局不会
  再触发 started 事件——记录器须续写既有 replay 文件 + 补 'recovered' mark 行；
  重启后 ledger 重建为空 → end 行的 ledger/killTimeline 只含重启后增量，summary 须
  标注不完整（v2）。
- **路由纪律**：routes.ts 是纯函数打表（不碰 node:http、有纯函数单测）——文件 IO/解析/
  缓存放独立模块经 ArenaHttpServices 注入（v2，一审非阻塞 4）。
- **compose**：docker-compose.yml 持久面 5 卷（server/journal/history/tournaments/
  agents），replays 目录需第 6 卷（S7，一审阻塞 3）。

## 2. 设计决策

### D1 记录器（新组件 src/server/match/recorder.ts）+ mod enrich（一审阻塞 4 拍板）

**拍板：kills 明细走 mod 侧 enrich（方案①），降级兜底房级。**理由：闪烁标记与战报
时间线的位置价值是本计划核心；resolveEventUsers 本就对 ATTACK/DESTROYED 的
objectId/targetId 查 rooms.objects（tombstone/ruin 兜底——被毁对象在那里仍有 x/y/
type/room），顺取零额外查询。mod enrich 输出（事件加工时附加，只加字段不改既有字段
——**「结算/公平面零改动」口径的显式豁免项**，回归面 = attribution 单测（喂 enrich
后事件仍归因一致）+ live IT 对称探针 + arenaProbe）：
- 事件附 `objectInfo = {x, y, type, via}`（objectId 解析结果；`via:
  'live'|'tombstone'|'ruin'|null`）；`targetInfo` 同款（data.targetId）。房名不进
  objectInfo——由**事件所在键**给出（v3：键即房名）。
- **`type` 取值链（v3 钉死，防前端画出错图标）**：`via='live'` → 文档顶层 `o.type`；
  `via='tombstone'` → 被毁对象必为 creep（tombstone 语义）→ `'creep'`（若该引擎
  tombstone 文档带原 creep type 字段则以之优先——S0 探针钉字段集与取值）；
  `via='ruin'` → `r.structure.type`（ruin 把原 structure 挂在 `structure` 子档，mod
  L293-296 已在读它取 user）——缺失则 `'unknown'`。`x/y` 取文档顶层 `x/y`（tombstone/
  ruin 都是 rooms.objects 文档，坐标字段同款——S0 同钉）。
- **混跑过滤（v3 简化：无需映射）**：键即房名，recorder 直接按 `键 ∈ 本局房间集合`
  过滤——eventLog ring 全局共享，他局战斗事件不得进本局时间线（一审阻塞 4b）。
- **降级**：tombstone/ruin 也查不到（极端时序）→ objectInfo=null，前端标记降级为房级
  （x/y 缺省不画点），时间线仍记 tick+归因。

`MatchRecorder`：per-matchId 单例（main.ts Map 承载）。append-only JSONL：
`dataDir/replays/<matchId>.jsonl`，逐行追加（fs.appendFile 单行直写，崩溃最多丢最后一
行；读端跳残行——history.ts L41-47 同款自愈先例（v2 措辞订正：history 本体是整写
tmp+rename，此处引用的是其读端残行跳过语义））。行类型（版本化）：
- `{kind:'meta', v:1, matchId, form, config, players:[{seatId,username,screepsUsername}], rooms, createdAt, startGameTime?}`
  〔v4：`screepsUsername` **建局时必为空**（bindUser 惰性），以 idmap 行为准——summary
  由 idmap 合成显示名。〕
- `{kind:'idmap', seatId→screepsUserId}`——**惰性补写（v3 订正）**：`arena.resolveUser`
  → world.users 能解析出的**首个采样拍**写一次（两 form 通用）。不能写「bindUser 完成
  后写」——world form 的 bindUser 是惰性路径（main.ts `wakerFor`：首个 waker 创建时才
  `arena.bindUser`，**main.ts L331**），arena form 亦只在 botCode/唤醒路径绑定，建局瞬间无
  映射可查。frames 的 user 字段是 userId，settle 后用户已删，事后解析只能靠此行；
  startGameTime 在 started mark 后补记于该行或首个 frame。
- `{kind:'mark', at, type:'started'|'roundBreak'|'resume'|'settled'|'recovered'|'samplingThrottled'|'eventRingSaturated', round?, reason?, winner?, scores?, ringCapacity?, lastEventTick?}`
  〔v5：`eventRingSaturated` 由 observeArenaMatch 的 `bound:false` 分支触发（每局一次，
  对齐 arenaOverflowWarned 去重）；`ringCapacity`=ring 上限、`lastEventTick`=**最后
  成功收到的事件 tick**（R4 缺口定位）。〕
- `{kind:'frame', gameTime, round, scores:{seatId:{spawns,creeps,rooms,rclTotal}}, kills:[{tick,killer,owner,type?,room,x?,y?}], positions?:Record<room,Array<{type,x,y,user,name,hits}>>}`
  〔v3/v4 字段口径钉死〕`killer`/`owner` = **seatId**（host 经 idmap 反查；反查不到则记
  原始 userId —— 前端按 idmap 兜底显示）；`room` = 事件所在键（即房名）；
  **`type?`（v4）：objectInfo=null 的降级路径无 type 来源——recorder 侧统一归一为
  `'unknown'` 再落行**（写端恒有值；`?` 是给读端容错的前向兼容标记，非「可能缺字段」）；`positions[room]` 的 `user` 是
  **Screeps userId**（经 idmap 显示 username），`name` 是**引擎对象名**（creep/spawn
  自定义名，非 username——mod roomObjects 输出 `o.name`，L1170 实证；两者勿混）。
- `{kind:'end', settledAt, settleReason, winner, scores, ledger:{kills,losses,decayLosses}}`

**接线点（v2 修订，一审阻塞 1/2）**：
- **arena**：observeArenaMatch 现有消费循环内顺路调 `recorder.recordTick(...)`——
  复用 ledger 归因 + **事件级明细**（KillLedger.consume 增加返回明细列表
  `Array<{tick, objectId, attribution}>`，向后兼容——现有调用忽略返回值；recorder 用
  明细 + mod enrich 字段，按 (tick,objectId) 去重（防御，见下方去重口径）+ 本局房间
  过滤）。**recordTick 入参钉死（v4）**：`(enrichedEvents
  （含键=房名 + objectInfo）, ledger 明细, world 快照, gameTime)`——frame.kills 的 `room`
  只能来自事件所在键，明细 `{tick,objectId,attribution}` 不含 room，勿只按明细构造。
  **world 快照复用**：recordTick 取 observeArenaMatch 同拍已拉的那个 world
  （main.ts L191-192 同拍内 getWorld + scoreSnapshotFor 各一次 → 记录器直接用其返回值
  传参，**零额外 getWorld**）。**去重口径（v4 订正）**：(tick,objectId) 去重是**防御**
  而非现网必要——mod 游标 = `eventRing.length`（arena-mod.cjs L1141）且饱和时 push+shift
  使其恒为 4096，host 游标恒 4096 → `slice(4096)` 恒空 ⇒ **溢出即停投，不存在重消费**
  （R4）。保留去重是为 mod 游标未来改单调序号/饱和重置时兜底。
- **world**：**driver 增 option `worldObserve?: (m) => Promise<void>`**（driver.ts tick
  的 world 分支调用，≈5 行——S2 措辞订正：driver 有小改，一审「driver 不改」陈述作废）；
  **相位门控（v4 钉死）**：`m.config.form === 'world' && m.phase === 'running'` 才调——
  对齐既有 arena 分支的门（driver.ts L136）。缺此门则 roundBreak（世界暂停、mod 停主
  循环）期注入函数仍按墙钟 ~1s/帧写出 gameTime 与坐标全同的重复帧（~150 对象/房 × 2 房），
  既反证 R3「roundBreak 无帧」、又把 D2 的 ~7MB 上界抬成数十 MB 并误触软上限降频。
  main.ts 注入「**节流后的**取分快照 + recorder.recordTick」。**节流落在注入函数内
  （v3 钉死）**：未到 `REPLAY_SAMPLE_MS` 采样点直接 return，不调 getWorld——否则
  world 局每 500ms 全量 getWorld（driver.tick 现有 getWorld 只在 roundBreak 取分，
  **driver.ts L123**），开销无谓放大（R1）。roundBreak/resume/settle mark 行由
  wireMachine 事件处理与 settle 点写（两 form 共用）。
- **recorder 生命周期**：settle 写 end 行后从 Map **删除**（machines.delete 挂点顺路；
  不照抄 arenaLedgers/arenaStartGameTime/arenaOverflowWarned 三容器无清理的既有泄漏
  ——那是 M5 遗留，本计划不扩洞，遗留单记 §5）。

### D2 位置采样策略（数据量与开销的平衡）

- **采样节流**：位置帧每 `REPLAY_SAMPLE_MS`（默认 1000ms 墙钟）至多一帧；500ms 驱动
  节拍下实际每 2 拍一帧。2000 tick × 150ms 局 ≈ 300 帧。
- **体积估算**：60B/对象偏乐观（含 store 的 ~80-100B；roomObjects 返回全房含 tombstone/
  ruin/资源堆）——量级判断成立：300 帧 × 2 房 × ~150 对象 × 80B ≈ 7MB/局 上界。
  软上限 32MB/局：超出后位置采样降频 ×4（kills/scores 永不降），再超翻倍并记
  'samplingThrottled' mark 一次；`du` 断言进 live IT（R2）。
- **kills 不占节流**：每拍 eventLog 增量归因出的战斗事件全量入（无位置采样的拍记
  kills-only frame）。
- **位置源**（v3 明示）：`svc.system('roomObjects', roomName)`（mod L1162-1173）——房名
  直接取自 meta.rooms（v3 订正后键即房名、无映射步骤）；返回**全房**对象含 tombstone/
  ruin/资源堆（体积上界估算依据，见上条）。world form 的 rooms 来自房间池分配
  （main.ts `allocateRooms(ROOM_POOL, ...)`），arena form 来自固定镜像房
  （`arena.assignRoom` + `arenaMirrorRoom`）。

### D3 崩溃安全与恢复

- append-only：崩溃最多丢最后一个未 flush 行（appendFile 每行直写，无缓冲聚合）。
- restoreFromJournal：恢复局打开既有文件 append（存在则续写；不存在则补 meta + 
  'recovered' mark）。重启后 ledger 为空 → summary 的 killTimeline/ledger 标注
  `incompleteAfterRestart: true`（v2）。
- teardown **不删** replay 文件；孤儿文件（无 history 对应）容忍——查询面按文件自身
  meta/end 判完整性（D4）。

### D4 查询面（HTTP 只读，独立 ReplayStore 模块）

- 新组件 `src/server/replay/store.ts`：`ReplayStore`（沿 MatchHistory 模式——文件 IO +
  解析 + 缓存一个不落地，routes 保持纯打表，经 ArenaHttpServices 注入，v2 修订）。
- **缓存失效（一审阻塞 2）**：cache entry = `{size, mtimeMs, parsed}`；请求时 stat 文件，
  size/mtime 任一变化即重读——running 局每秒追加自然失效，settled 局（end 行后不再
  追加）自然稳定，无需失效策略分支。LRU 上限 4 局。
- `GET /api/replays/:matchId`：`{meta, summary, frames}`，查询参数：`?from=&to=`（frames
  服务端裁剪）+ **`?frames=none`（v4 新增，running 期 summary 轮询专用）**；allPaths
  打表照旧。**收益边界（v5 订正措辞）**：running 局每次 append 都改 size/mtime → stat
  缓存必然 miss，**任何**请求都要整读整解析（summary 的 killTimeline/scoreCurve/totals
  派生自 frame 行）；`frames=none` 消除的是**序列化 + 传输**（≤7MB → KB 级，D2 上界），
  **不消除解析**。解析开销按 3s 轮询 × ~7MB 实测核对（浏览器验收看响应延迟/CPU，R1）；
  超预期则升级为按行增量解析缓存（记 §5 可选优化，不阻塞本计划）。`frames=none` 只回
  `{meta, summary}`。
- **404 语义**（v3 明示）：无该文件 / 文件为空 / meta 行损坏 → 404 `{ok:false,error}`
  （M6 之前的历史局天然落此分支——前端据此禁用「战报」入口，D6）。文件存在但无 end
  行**不是** 404：返回 `partial:true` 的 summary（running 局正常态）。
- `summary`（服务端聚合）：`{players(含 idmap), rooms, settle:{...}, killTimeline,
  scoreCurve, totals, partial, incompleteAfterRestart?, eventsIncomplete?}`——`partial` =
  无 end 行（running 期正常态，前端 3s 轮询照常更新）；`incompleteAfterRestart` = meta/mark
  含 'recovered'（D3 语义，前端显示「数据不完整」角标）；**`eventsIncomplete?`（v5）** =
  `{ringCapacity, lastEventTick, at}`，由 `eventRingSaturated` mark 派生（R4 语义：ring
  饱和后事件停投——与 `partial`（running 正常态）、`incompleteAfterRestart`（重启语义）
  三者正交互斥，前端各自显示不同角标文案）。

### D5 公平边界（红线沿用）

- replay/summary 只挂 HTTP 旁观面；**Agent 工具面零新增**——负向测试钉住：白名单
  **恰为 submit_code/report/console 三件**、无 replay/战报类新增（v2 措辞订正：report
  是既有工具，不可写「不含 report」）；mod enrich 字段不进 arena.report 的战报文本。
- 战报/回放是「全知视角」（双方位置/击杀全可见）——只给人类旁观者（红线约束 Agent
  席位可见面，非人类旁观面；M5 screepsUsername 审查已确认口径）。

### D6 前端

- **入口**：① 对局详情页加「战报」区（summary 卡片 + scoreCurve SVG 折线 +
  killTimeline 列表）；② 历史表行加「战报」按钮 → 同一组件；③ 战报区内嵌回放控件。
- **显示名映射（v3 明示）**：帧里的 `user`/`killer`/`owner` 是 userId/seatId，前端统一
  经 summary.players（含 idmap + screepsUsername）渲染为「席位名（私服用户名）」；
  idmap 缺行则落原始 userId（不留白）。历史表入口的席位对齐用 history 记录
  （seatUsers），与 replay 文件是否可读解耦（文件缺失 → 按钮禁用 + tooltip
  「无回放数据」）。
- **回放器**（ReplayCanvas/ReplayPlayer，纯受控组件——帧由父给定，方便单测）：
  TerrainCanvas 绘制逻辑抽帧版；滑条（首末帧 gameTime）+ 播放/暂停 + 速度
  （1×/4×/16× 墙钟）。kills 按帧 gameTime 对齐闪烁标记（killer 归属红/绿；x/y 缺省
  降级房级色带，D1；`type` 决定图标，'unknown' 落通用方块）。回放对 roundBreak 的 gap
  不插值（时间轴自然分段）。
- **曲线**：SVG polyline（无新依赖；creeps/spawns 双线 × 双席，图例）。
- **轮询（v4 钉形）**：running 期战报区 3s 轮询 `?frames=none`（只回 meta+summary；
  D4）；settled 停。回放控件首次 seek/播放时才拉带窗口的 frames。

### D7 测试面

- recorder 单测：行序/idmap 惰性补写/恢复续写/软上限降频/残行跳过/kill 明细 (tick,
  objectId) 去重（防御路径）+ **键=房名的混跑过滤**（喂他局房名事件须被丢弃）/
  **objectInfo=null → type 归一 'unknown'**/end 后 Map 清理/**world 相位门控
  （roundBreak 期 worldObserve 零调用）**。
- mod enrich 单测（stub 事件喂 attributeTick 仍归因一致 + objectInfo 兜底链 + **type
  取值链三档** live/tombstone/ruin + 全 miss → null）。
- ReplayStore 单测：mtime 失效/range 裁剪/**`frames=none` 不回帧**/404（缺文件/空文件/
  坏 meta）/partial（无 end 行）/**`eventsIncomplete` 派生（喂 eventRingSaturated mark）**/
  残行/`incompleteAfterRestart` 派生。
- 公平负向：工具白名单恰三件（D5 措辞）。
- live IT 增补：真实短局（botCode 攻击 bot）跑完 `GET /api/replays/:id` 断言
  meta/idmap/end/frames>0/kills 与 KillLedger 一致 + 体积 du 断言 + R1 开销实测。
- 浏览器验收：真实 qwen 直建局——战报区/曲线/回放器拖动播放（截图留档 TEST.md）。

## 3. 实施步骤

- **S0 探针**（scripts/s6-replay-probe.ts，一次性）：真实私服短局实测——① **eventsByRoom
  键形态复核**（v3：断言键 = 房名 `W\d+N\d+`，钉死 D1 过滤前提）；② DESTROYED 事件
  `data` 的**实际字段集**（type/x/y 是否原生携带 → 决定 enrich 是补字段还是全查兜底）；
  ③ tombstone/ruin 文档字段集（`x/y/type/structure.type`/原 creep type 字段是否存在
  → 钉 D1 的 type 取值链）；④ enrich 的 objectInfo 兜底命中率（live/tombstone/ruin/null
  分布）；⑤ roomObjects 采样延迟与体积；⑥ 混跑（world+arena 并行）下 ring 饱和行为
  （**验证 v4 的「饱和即停投」**：游标恒 4096、`slice` 恒空、bound:false 出现时机）。
  校准 D2 参数。
- **S0-b 相位门控验证**（v4）：world 局跑一个 roundBreak 窗口，断言 replay 文件**零
  新增帧行**（证 D1 相位门控 + R3 不被重复帧反证）。
- **S1 mod enrich + KillLedger.consume 明细返回 + 单测**（attribution 回归保护）。
- **S2 recorder 组件 + 单测**；接线：main.ts（arena 观察链 + world 新挂点）+ **driver
  增 worldObserve option（driver 有小改，v2 订正）** + wireMachine mark 行 + settle
  end 行 + Map 清理 + journal 恢复续写。
- **S3 ReplayStore + API**（routes 打表 + mtime 失效缓存）+ 集成测试。
- **S4 前端战报区**（summary/曲线/时间线）+ 浏览器验收。
- **S5 前端回放器**（受控组件/滑条/速度）+ 浏览器验收。
- **S6 基线**：全量单测/typecheck/build/test:live（增补）/m2-smoke 回归 + 公平负向。
- **S7 compose 与文档**：docker-compose.yml 增 `arena-replays:/app/.arena-data/replays`
  卷 + 持久面注释 5→6（一审阻塞 3）；main.ts 头注数据布局（L12-16）补 `replays/  = 回放
  JSONL（append-only，D1）` 行；LOG/TEST.md/AGENTS/README；审查闭环。

## 4. 风险与对策

- **R1 采样开销**：arena 侧每秒 2 房 `roomObjects` + 复用同拍 getWorld（零额外）；
  world 侧靠注入函数内节流（未到采样点不调 getWorld——D1 v3）→ 实际 ≤1 次/秒。超预期
  则降频至 2s/帧（S0 实测校准）。浏览器验收观察 CPU。
- **R2 体积**：上界 ≈7MB/局；软上限 + 降频兜底；du 断言进 live IT。
- **R3 world form 采样与 round 语义**：frame 带 roundIndex；roundBreak 期世界暂停无帧，
  时间轴自然分段不插值。
- **R4 eventLog ring 溢出（v4 语义订正）**：ring 全服全局——**混跑期多局共享 4096 容量**，
  溢出阈值按全服有事件 tick 合计。**订正：饱和不是「重消费」而是「停投」**——mod
  游标 = `eventRing.length`（arena-mod.cjs L1141），饱和时 `push → length 4097 → shift`
  使其**恒为 4096**（L237-240），host 游标（main.ts L189）恒 4096 → `slice(4096)` 恒空
  ⇒ ring 一满，之后所有事件对所有消费者（KillLedger / report / recorder）**停投**，
  不存在重复投递（v3 的「(tick,objectId) 去重兜底重消费」前提作废，去重降级为防御）。
  本计划动作：`bound:false` 透传 mark 行 + summary 标注「事件不完整」，并**记下 ring
  水位与最后收到的事件 tick**（缺口可定位）；后果（溢出后 killTimeline 止步、arena
  结算击杀分冻结）是 M5 既有行为，**不在本计划修**（登记 §5）。位置帧/分数帧不受影响。
- **R5 双游标回归**：记录器复用 observeArenaMatch 消费点 + consume 明细输出，结构上
  杜绝第二 eventLog 消费点——审查重点项。
- **R6 前端性能**：受控单帧 canvas 绘制；拖动只 seek 不重解析；summary/frames 分离。
- **R7 契约版本化**：v:1 头行；读端未知 kind 跳过（向前兼容）。
- **R8 mod enrich 时序**（v2）：被毁对象 tombstone 写入与事件发布的同 tick 时序——
  resolveEventUsers 现有兜底已覆盖（M2 起 report 链实证），S0 探针统计命中率兜底；
  null 走降级路径。

## 5. 边界声明与遗留登记

- arena 与 world 均记录（同一记录器）；浏览器验收主用 arena 局。
- 回放帧是**采样**非逐 tick——拖动精度到采样帧；kills 事件逐条精确。
- **遗留登记（不在本计划修）**：arenaLedgers/arenaStartGameTime/arenaOverflowWarned
  三容器 settle 后不清理（M5 既有缓慢泄漏，量级=局数 × 小对象；本计划 recorder 不
  照抄，顺手修留待表现层收尾里程碑一并处理）。
- **遗留登记（v4 新增，M5 既有行为）**：eventLog ring 饱和后**事件停投**（R4 订正）——
  mod 游标恒 = ring 长度（4096）导致 `slice(4096)` 恒空，溢出后 killTimeline/击杀分
  静默冻结。可见面已由 `bound:false` → 局 errors + 本计划 mark/summary 标注覆盖；
  根治（mod 侧环形序号 + 缺口 manifest）另立里程碑，本计划只记录不修。
- **可选优化（v5 登记，不阻塞）**：ReplayStore 对 running 局的**按行增量解析**（记住
  已解析行数 + size，仅解析新增尾部）——若浏览器验收实测 3s 轮询的解析开销显著再启用；
  本计划先按整读整解析 + stat/mtime 失效实现（简单、正确优先）。
