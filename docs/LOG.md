# 工程日志（倒序）

## 2026-09-14 M5 成果审查闭环：PASS——M5 关闭

**一审 FAIL（1 阻塞）**：KillLedger 观察游标误存 gameTime（tick 数值）而 mod eventLog
契约是 ring 下标（since 越界静默回退 0）→ 观察拍每 500ms 全量重消费整个 ring，击杀分
随拍数膨胀且新旧事件重消费倍率两席不对称——双淘汰/maxTicks 兜底的击杀分比较可被翻转
（live IT 因 103:103 对称保号未暴露）。修复：consume 不写游标；游标只由 raw.cursor
（ring 下标）在两个唯一写点（main.observeArenaMatch / live IT）推进 + 守恒用例。
**复审 PASS**（0 阻塞 / 2 非阻塞）：修复论证成立 + 恢复局基线（非阻塞 1）已落实 +
180/180 与 typecheck 审查员实跑复核。非阻塞 2/3（prepareArena × teardown 并发窗口、
restart 选项合并语义）维持记录不阻塞。M4 遗留的手测项已在验收局一并覆盖。

**M5 验证基线（最终）**：同下条——180/180 + typecheck/build 零错 + test:live 9/9 +
m2-smoke 13 步 + compose 冒烟 + 真实 LLM（qwen）验收局 errors=[]。

## 2026-09-14 M5 arena-blitz：实施 + 全链实测 + 5 bug 修复

**实施（plan-M5 v2 S0–S6）**：D1 preset/form 数据模型（PRESETS 表 + configFromPreset，
DEFAULT 回归 world/0）；D2 mod 回迁 arenaGen/arenaProbe（预清链 + 镜像房三集合清理 +
invaderCore/rampart 残留清除）；D3 prepareArena 单飞（pause → arenaGen → generatedRooms
登记（B3）→ restart resume:false，对称坐标按真实地形选定存实例）；D4 arena 语义
（running 热更 / advance no-op / seatBackendFor [N8] 扩展 / 30s 状态唤醒 / 无 provider
拒建）；D5 归因器回迁 + KillLedger（观察游标 host 独立 n2）+ arenaSettleDecision/
ticksExhaustedDecision + driver arenaObserve 分支（B2 新增件）+ bound:false 溢出警告
[N4]；D6 HTTP preset + botCode 剥除 + 锦标赛 arena 校验 + ARENA_MODEL→maxTicks 预设
基底合并。测试：m5-model 9 + m5-arena 13 + m5-arena-stub IT 1 + live M5 段 2。

**验证基线（全部本机实测）**：`npm test` **180/180 绿**（30 文件）+ typecheck/build 零错；
`test:live` **9/9 绿**（M5 增补：镜像对称+复用探针 22.8s、真实 blitz 短局 51.6s——
botCode 双席对撞，ticksExhausted 103:103 完美对称 draw）；m2-smoke 13 步全绿；compose
冒烟绿；**真实 LLM（qwen/qwen3.7-flash）验收局**：锦标赛 matchConfig:{form:'arena'} 通道
→ maxTicks=2000 生效 → 双 Agent 真写码提交（tool_end ×11，含 ERR 自修重试）→ starter
自动开局 → 150ms tick 真跑 → ticksExhausted 结算（za=100/zb=100 完美镜像 draw）→ 届终
+ 积分榜，errors=[]，teardown done。

**本轮修复的关键 bug**（均由真实链路暴露）：
1. **NPC 要塞殖民**：无主 accessible 房被 backend 墙钟 cronjob（genStrongholds/
   genInvaders，每 5-15 分钟墙钟拍，**不受 MAIN_LOOP_PAUSED 影响**）殖民——invaderCore
   + rampart + controller 归 Invader（user='2'）→ 双席建号撞 already owned。三层修复：
   realCreateUser 加 force 通道（host 侧 Arena 战场专用，svc.createUser 透传，LLM 工具
   面无此通道——公平边界负向测试钉住）+ arenaGen 预清 invaderCore/rampart +
   prepareArena 先 pause（准备+建号窗口世界暂停，wireMachine started 统一 resume）。
   取证链：backend.log「controller.user='2' hasEntity=true」→ invaderCore 实体 dump。
2. **[N2] 固定对称坐标落墙**：(25,25)/(24,25) 在某次生成的地形里落墙 → placeSpawn
   静默随机重掷 → spawn 不再镜像（live IT 实证 33≠19）。修复：prepareArena 读真实
   terrain 选双房同时非墙的对称对（镜像逐行反转 ⇒ base 非墙 ⇔ mirror (49-x,y) 非墙）。
3. **锦标赛 matchConfig 直传丢预设**：`matchConfig:{form:'arena'}` 展开后 maxTicks=0
   （DEFAULT 基底）→ blitz 无 tick 预算。修复：form=arena 无 preset 时以
   PRESETS['arena-blitz'] 为基底合并。
4. **arenaGen 复用撞 "Exits don't match"**：上局镜像房墙桩/db 登记残留 → stock
   generateRoom exits 校验失败。修复：mod arenaGen 预清镜像房 terrain/objects/rooms。
5. **prepareArena × bindUser 并发竞态**：arenaRooms 延迟登记导致并发 bindUser 误走
   prepareRooms（生成镜像房覆盖域）；.then setSpawnCoords 微任务时序漏首席坐标。
   修复：arenaRooms 同步登记（任何 await 之前）+ 终身保留（force 语义依赖）+
   坐标存实例 arenaSpawnCoords 由 bindUser 按房间自取。

**伴生**：dbg 探针（scripts/dbg-arena-owned.ts，保留现场取证）； Loki findOne 投影
异常（username/_id undefined，backend.log 取证）——归因判据改实体占位（spawn/creep
实体存在才算真冲突），不依赖 users 表查询。

**遗留**：混跑期 world 局 tick 被同步 150ms（R7/n1 已知行为）；成果审查循环待做。

## 2026-09-14 真实 LLM 锦标赛全程实测（qwen/qwen3.7-flash，自然打满 8 周期）+ 默认模型切换

**默认模型切换（用户拍板）**：`xiaomi/mimo-v2.5` → `qwen/qwen3.7-flash`，此后所有真实
LLM 调用统一用它。main.ts / dev-server.ts / llm-smoke 三处默认值已换
（`--model`/`ARENA_MODEL`/`SMOKE_MODEL` 覆盖通道不变）。

**实测（裸机 main.mjs + 真实 key + qwen/qwen3.7-flash + 默认配置 roundMs=60s/maxRounds=8）**：
建届（非 400）→ 双 Agent 首唤醒真写代码 + submit_code（machine 登记链路实证）→ starter
自动开局 → **自然打满 8 周期**（每轮 roundBreak 唤醒 → Agent 改码重提 → 续跑，含
submit_code OK/ERR 交替的真实重试形态）→ roundsExhausted 自动结算 ra=105/rb=100（真实
计分非全 0；双活 draw，scoreDiff +5 使 ra 居积分榜首位）→ 届终回填 finishedAt +
standings，**errors=[]**，history teardown done。新观察：日志 `wake (started) failed:
prompt already in flight` 确认为驱动器串行唤醒的预期拒绝（starter 首发在途时 started
事件唤醒被拒；非致命，下轮 roundBreak 唤醒接上，对局完整推进不受影响）——记入 TEST.md
§0.8 供排查对照。进程清场纪律复核：kill 包装层 PID 后 fnm 子进程与 launcher 树会残留，
须按 `pgrep -af` 列表逐 PID 精确清理。

## 2026-09-14 真实 LLM 锦标赛全程实测通过——TEST.md §0.8 手测项清零

用户确认 `.bashrc` 末行有 `export OPENROUTER_API_KEY="sk-or-v1-…"`，但标准非交互早退守卫
（`if [[ $- != *i* ]]; then return; fi`）使其在非交互 shell 恒为空。取用方法（不落盘不打印）：
`eval "$(grep -E '^export OPENROUTER_API_KEY=' ~/.bashrc)"`。

**实测（compose + 真实 key + 默认模型 mimo-v2.5，短回合 matchConfig roundMs=20s/maxRounds=2）**：
建届 → 双 Agent 真写代码 submit_code（tool_end OK×5）→ starter 自动开局 → 2 回合真跑 →
roundsExhausted 自动结算（ra=103/rb=109 展示分；双活按规则 draw，scoreDiff +6 使 rb 居
积分榜首位——计分语义与 plan-M2 §1 一致，displayScore≠胜负判定）→ 届终回填，errors=[]，
teardown done，history done。TEST.md §0.8「待您手测」项就此清零（浏览器观感复查仍属可选）。

## 2026-09-13 M4 成果审查一轮：PASS——M4 关闭

**一审结论**：**PASS**（0 阻塞 / 6 非阻塞）。D1–D9 逐条符合；公平红线三项负向测试实证
实质性（tournament 导入面无 src/agent/*、buildSeatTools 调用计数=1、初始 prompt 无跨局
信息、无 provider 400）；restart barrier 同步无穿透窗口 + resume 无死锁论证成立；审查员
实跑 `npm test` 157/157 + typecheck 零错。

**非阻塞 6 条处置**：① 定时器措辞与 plan 字面不一致（实现为无条件 interval + 循环体自判，
行为等价、unref 空闲开销近零）——接受为等价实现，记录在此；② 并发 restart 参数合并语义
（第二个调用的 options 被忽略）——已加代码注释钉住前提（当前唯一形态 resume:true）；
③ restart core 内 stop 抛错时 status 停留 'stopped'/'restarting'（错误仍上抛可查）——接受；
④ releaseSeat expected.username=undefined 的极端边界（settle 前席位必已建号，概率≈0，
M3 已知形态）——接受；⑤ promptState Map 无淘汰（量级=局数×席位，微泄漏）——接受；
⑥ 审查员未独立复跑 test:live/compose（指令排除）——本日志上条已有完整实测记录。

**M4 验证基线（最终）**：同上条——157/157 + typecheck/build 零错 + test:live 7/7 +
m2-smoke 13 步 + compose 锦标赛全链（mock 驱动，errors=[]）+ 卷持久化验证。

## 2026-09-13 M4 锦标赛编排：实施 + 全链实测 + 5 bug 修复（成果审查待做）

**实施（plan-M4 v3 S0–S6）**：`src/server/tournament/`（types/bracket/store/scheduler）+
main.ts 编排接线（createMatchInternal 抽取共享、wireMachine settled→scheduler.onSettled、
启动恢复 + 定时器、SIGINT 清理）+ HTTP 3 路由（server/routes 双注册）+ 前端锦标赛表
（5s 轮询 + 积分榜 + errors 显示）。测试 5 文件 33 用例（bracket 12/store 5/scheduler 10/
flow IT 3/fairness 负向 3：模块导入面无 src/agent/*、buildSeatTools 计数=1、初始 prompt
无跨局信息）。

**验证基线（全部本机实测）**：`npm test` **157/157 绿**（27 文件）+ typecheck 零错 +
build/build:client 零错；`test:live` **7/7 绿**（M4 增补 restart 竞态回归 11.4s + 锦标赛
真实私服链 12.1s + kill-9 三真 402s）；m2-smoke **13 步全绿**；**compose 锦标赛全链**
（`scripts/mock-llm.ts` 独立 mock OpenAI server + `SMOKE_BASE_URL`/`ARENA_MODEL` 注入：
建届→自动建局→双席初始 prompt→submit_code→starter 自动开局→manual settle→届终回填→
积分榜，**errors=[]**；`down`（保卷）→`up`：锦标赛状态/history 完整保留）。

**本轮修复的关键 bug**（按发现顺序）：
1. **`ScreepsService.restart()` 竞态**（kill-9 IT 三连败取证 → 根因链见上轮条目）：stop
   窗口内 `server=undefined` 而 status 仍 'running'，并发 ensureRunning 穿透 guard 各自
   ensure() → 双/三重私服互踩 db.json 丢房（E7N5 实丢；探针无并发时 0/3 复现）。修复
   （service.ts）：restart 单飞（restartPromise）+ stop 先置 status='stopped' + 把
   stop→ensure→resume 核心作为 barrier 塞进 ensurePromise（并发调用与重启共享同一周期）
   + 删除对在途 ensure 的无条件清空（会 clobber 半拉起的世界）+ shutdown 等待在途
   restart。**回归钉死**：live IT「restart 窗口并发轮询 → 恰好一次 'server ready' +
   生成房 E15N5 不丢」。
2. **Agent submit_code 未登记进对局机器**（compose 全链暴露）：三工具只经 arena 上传私服，
   `p.code` 恒空 → starter 全员就绪门槛永不可达、锦标赛永不开局（此前 smoke 全是
   「建局即 settle」，此路径从未被真实触发）。修复：`seatBackendFor(seatId)` 包装 backend，
   上传成功后登记进该席位所在活跃对局（creating/roundBreak）。
3. **席位 waker 并发重入**：starter 5s 补发与首发并发进入 wakerFor → 重复 bindUser →
   mod createUser 'already exists' 整轮失败。修复：per-seat 单飞（wakerCreating 表）。
4. **bindUser 跨重启不幂等**：世界卷持久化后同名 agent_<slug> 用户仍在世界库，createUser
   拒绝。修复：bindUser 先查 world，用户在则收编映射不建号。
5. **compose 持久卷缺口**：仅挂 server/journal，history/tournaments/agents 在容器层
   （重建即丢）。修复：补 3 卷 + `ARENA_MODEL` 环境变量（CLI default 压制 env 的坑：
   commander default 移除改 env 兜底）+ extra_hosts host-gateway（mock 链）。

**伴生修订**：scheduler 初始 prompt 配额语义——在途 prompt 未收口前补发跳过且不计数
（首轮唤醒含建号+房间生成+restart，常超 5s starter 周期，旧语义 15s 即耗尽 3 次配额、
errors 误报；实测 errors=[] 后定稿）。compose 全链教训：持久卷会跨迭代残留旧锦标赛/
用户，验证必须 `down -v` 清卷做干净轮（残留旧届恢复后占席 → SeatInUseError 干扰判读）。

**遗留**：带真实 LLM 的锦标赛全程浏览器验收（需用户 key，TEST.md §0.8 已给命令并标注
未实测）；成果审查循环待做（下一步）。

## 2026-09-13 M3 成果复审：PASS——M3 关闭

**复审**（同审查员独立复审，范围 34f420f..8346d7f，独立复跑 124/124 属实）：**PASS**。
阻塞 1/2/3 确认真修；4 项非阻塞中 3 项当场落实（TEST.md 计数 124/124、崩溃窗口注释订正为
「微秒级、接受为已知边界」、live IT 相邻房断言补 blob 等价性注释）；1 项记 M4 遗留
（「真 kill -9 运行中 main + 真重启 + 真残留」三真合一的单点端到端，现有 live IT +
m2-smoke 两段拼图已覆盖代码路径）。

**M3 验证基线（最终，全部本机实测）**：`npm test` **124/124 绿**（22 文件）+ typecheck
零错 + build/build:client 零错；`test:live` **4/4 绿**（M3 增补拆解闭环/相邻房/崩溃恢复）；
m2-smoke **13 步全绿**；compose 重建镜像后全链绿。M2 三条边界（单活跃/房间池固定/
settle 后仅同席位）全部消除。

## 2026-09-13 M3 成果审查一轮：FAIL 3 阻塞 → 修复（待复审）

**一审结论**：FAIL——① 验收判据 2（test:live 增补段）整段缺失且未声明缩水，m2-smoke 的
teardown-recovered 用的是幽灵记录（found:false），不证明真删；② S5「双对局并存」stub IT
缩水成纯函数打表；③ **跨对局 seatId 无守卫**（前端默认席位名即可触发：静默共享映射/
teardown 窗口误删新对局用户）。非阻塞 4：settle×prepare 竞态孤儿房、恢复局+pending 并存
泄漏（核实为不成立——upsert 与 journal.remove 同 tick 同步相邻，崩溃窗口不存在，已注释
为证）、teardown rejection 未捕获、TEST.md test:live 旧计数。

**修复**：
- 阻塞 1：test:live 增补 2 段全绿（4/4）——removeUser/removeRoom 重建闭环 + **被删房与
  活跃房相邻**（活跃房 terrain/controller/spawn 不受损，被删房恰一行全墙桩）；
  **崩溃恢复真实残留**（createUser+generateRoom 造真残留 → `recoverPendingTeardowns`
  → 用户出世界/房对象清/terrain 桩/done/幂等收敛 0）——恢复逻辑抽到
  `src/server/teardown.ts` 供 main 与 IT 共用同一段代码。
- 阻塞 2：新增 `tests/multi-match.it.test.ts`（真实 RealArena + MatchMachine 装置）：
  双局并存房间不重叠、settle 拆解后另一局映射/房间完好且零 generateRoom、全池真实
  roomsSnapshot 复用、席位易主跳过删除。
- 阻塞 3：createMatch 守卫 `assertSeatsFree`（pool.ts 纯函数，活跃席位拒绝复用，前端
  默认席位名二局创建得清晰 400）；`releaseSeat(seatId, expected?)` 按 settle 快照校验
  归属——席位/房间易主即跳过删除且不抹新映射。
- 非阻塞：releaseSeat 前 await preparePromise + doPrepareRooms 收尾只标记仍在分配的房
  （孤儿房/假 generated 消除）；teardownMatch 加 .catch 入可查面；TEST.md 计数更新。

**验证**：`npm test` **124/124**（22 文件）+ typecheck 零错 + build/build:client 零错；
`test:live` **4/4**；m2-smoke **13 步全绿**（重跑无回归）。

## 2026-09-13 M3 实施（多局生命周期；待成果审查）

**计划**：`docs/plan-M3.md` v3（审查闭环：一审 FAIL 11 → v2 修订 → 二审 FAIL 5 →
v3 修订 → 三审 **PASS** + 2 非阻塞实施备注）。范围：S0 调研钉子 / S1 mod 拆解原语 /
S2 RealArena 多局面 / S3 main 接线 / S4 对局历史 / S5 验证 / S6 文档。

**S0 调研钉子（`scripts/s0-removal-probe.ts`，真实私服 exit=0，结论回填 plan-M3 附录 A）**：
- 用户关联集合全集实测：`users.code`/`users` 本体 + `rooms.objects`（**controller.user
  即所有权**，不清则同名重建撞 "room already owned"——当场钉出并修）；其余用户键控集合
  建号期为 0，防御性清理保留。
- env memory = `keys.MEMORY+uid`（resetArena 也不清，定点删除补上）；**env 集合无 srem**
  （只有 sadd/smembers）→ ACTIVE_ROOMS 剔除走 del 整键 + 剩余 sadd 重建。
- removeRoom 逆向闭环实测：删后对象空 + 全墙桩一行 + accessible/active 逆向 →
  generateRoom 同名重建 → createUser 同名成功；幂等 found:false（存在性判定改按
  db.rooms/objects——terrain 桩行会假阳性，当场钉出并修）。
- m2-smoke 冲突清单：原 9 步均未断言 M2 拒绝语义，无需改写，增补 4 步。

**交付**：
- **S1**：mod `removeUser`（用户 + 键控集合 + `{user:id}` 对象全清〔含 controller 所有权、
  跨房 creep 残骸〕 + memory env 键 + 进程内 consoleBuffers）与 `removeRoom`（五集合 +
  全墙桩回插〔blob 重建前，防无桩邻房 flake〕 + accessible/active 逆向 + updateTerrainData
  + refreshWorldMeta）+ `dbProbe` 诊断探针；系统用户拒删；双命令幂等。
- **S2**：RealArena `releaseSeat`（unbind + 双删 + 映射清理）、`generatedRooms` 集合
  （**防误重掷唯一防线**——mod generateRoom 是覆盖语义无 already-exists）、roomsPrepared
  全局标志退役、prepareRooms 只处理「已分配 ∉ generatedRooms」且偏离计算只算本局房、
  markRoomsPrepared 灌全 generatedRooms、preparePromise 互斥扩为多局并发安全。
- **S3**：main.ts settled → history(pending) → journal.remove → machines 释放 →
  异步 teardownMatch（dispose runners → 逐席位 releaseSeat，单席失败入可查面）→
  history(done)；启动私服就绪后扫描 history pending 幂等补拆解（`teardown-recovered=N`）；
  createMatch 守卫改 `pool.ts` 纯函数（可用池 = ROOM_POOL − roomsSnapshot）；池可配置
  `--rooms`/`ARENA_ROOMS`；`teardownFailures` + `GET /api/teardown-failures`。
- **S4**：`history.ts` MatchHistory（jsonl + id 幂等原位替换 + tmp+rename 原子整写 +
  残行跳过）+ `GET /api/history`（Fastify 壳补两条路由——**routes.ts 纯函数加了、壳漏接
  是冒烟当场抓到的**）+ 前端大厅「历史对局」表（5s 轮询，最小功能版）。
- **S5**：pool/history 打表单测 + real-arena 4 条 M3 单测（含防误重掷负向：已生成房
  不进重掷域）+ mod 3 条拆解单测；m2-smoke 增补 4 步。
- **S6**：TEST.md §0.7/§3/§4、README、AGENTS.md 状态更新。

**验证（全部实测）**：
- `npm test` **122/122 绿**（21 文件，+18 测试）+ typecheck 零错 + build/build:client 零错。
- S0 探针 exit=0（removeUser/removeRoom/重建/幂等闭环）。
- `sh scripts/m2-smoke.sh` **13 步全绿**：settle→journal 清→history teardown:done→
  **换席位再建局成功**（M2 边界消除端到端）→二次 settle→teardown-recovered=1→journal 恢复。
- compose 重建镜像后全链：create→settle→history done→换席位再建局（RECREATE-OK）。

**踩坑记录**：
1. Fastify 壳路由是逐条显式注册的（不是纯函数表自动生效）——`/api/history` 在 routes.ts
   加了、壳漏接 → 冒烟 404。**教训：routes.ts 与 server.ts 双处都要加**。
2. removeRoom 存在性判定用 terrain 会假阳性（自身回插的桩行）→ 改 db.rooms/objects。
3. env 集合无 srem（sadd/smembers only）→ del 整键 + sadd 重建。
4. MatchHistory 首 settle 时目录不存在 ENOENT → 构造期 mkdirSync recursive。
5. removeUser 不清 controller.user 所有权 → 同名重建撞 owned → `rooms.objects
   removeWhere({user:id})` 全清（连带跨房残骸，比计划「接受残骸」更干净）。

**遗留（M4+）**：锦标赛编排、回放/战报详情、arena-blitz、prepare 期免 restart 评估、
单世界 vs 多世界（跨容器拆分）、表现层统一收尾。

## 2026-09-12 M2 收尾：compose 实测通过（修 2 bug）——M2 关闭

Docker 环境到位后实测 compose（Docker 29.7.2 + Compose v5.4.0），**当场抓到 2 个只有
真 Docker 才能暴露的 bug**（静态核对全部漏掉）：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 构建期 `--install-only` 失败 `toolchain-missing` | Dockerfile 装了 python3/make/g++ 但漏 `git`，checkToolchain 四件套要求 git | Dockerfile apt 追加 git |
| 2 | **世界库根本没进卷**：`screeps-data` 挂在 `server/db/`（从未被写的子目录），而世界库实为 `server/db.json` 文件——`down/up` 会丢世界 | compose 挂载路径与实际落盘路径不符 | 卷改挂整个 `server/`（named volume 首挂自动从镜像拷入 node_modules + 播种 db.json，不受遮蔽影响） |

**验证（全部实测）**：
- 构建→起服：镜像构建零错，容器内真实私服 ready（`screeps server ready` + native addon 校验），
  `--host 0.0.0.0` 映射 8787 正常。
- 容器内 API 全链：create match → manual settle 真实计分（scores 注入，winner=draw）→
  settled journal 无残留（journal-restored=0，与 m2-smoke 一致）。
- **持久性**：`docker compose down`（保卷）再 `up` —— 启动日志 **0 次** reseed/reinstall
  （全部复用卷内容），卷内 db.json 存在且被 storage 正常改写（md5 演进 = 状态落卷），
  `/api/world` 读回正常（Invader 等系统用户在）。
- 代码零改动，离线回归 `npm test` **104/104 绿**（19 文件）。

TEST.md §0.6 改为已实测、§4 遗留清零。**M2 至此正式关闭**（此前唯一未实测项消除）。

## 2026-09-11 M2 成果审查一轮：FAIL 3 阻塞 → 修复（待复审）

**一审结论**：FAIL——① main.ts `createMatch` 缺 `driver.watch` + waker（真实新局驱动链断裂，
M1 复审问题 3 重演：mock 自证、真实路径漏接——wiring IT 只测 dev-services，m2-smoke 恰好
绕开该路径）；② 观战 console 身份错位（前端订阅用显示名，真实用户名 = agent_<slug>，
静默 bound:false）；③ plan 判据 3 的 WS console 协议 IT 缺失且缩水未声明。
非阻塞 5 条：settled 占坑、errors[] 中断标记、S6 重掷粒度注释、live IT 距离断言、TEST.md 过期段。

**修复**：createMatch 补 lazyWaker + driver.watch；console 口统一 seatId 语义
（前端订阅传 seatId，main.ts 组装层 resolveUser 解析，未映射→bound:false 静默）；
新增 tests/ws-console.it.test.ts（3 条：订阅→增量→退订停推 / 双客户端单拉取分发 /
bound:false 推一次即静默 / close 清理）；machines.settled 释放；恢复局 errors[] 中断痕迹；
S6 整体重掷注释声明；live IT 补距离偏离 ≤10 断言；TEST.md §2/§3/§4 过期段更新。

**验证**：`npm test` **104/104**（19 文件，+WS IT）+ typecheck 零错 + build/build:client 零错；
`sh scripts/m2-smoke.sh` 重跑 9/9 PASS（修复无回归）。

**复审**（新会话，独立）：**PASS**——3 阻塞逐条确认真修（createMatch watch 不在 restore 分支内、
console 解析在组装层且未映射透传、WS IT 连真实 match id 非假阳性）；5 非阻塞 4 项落实，
余 1 项文档计数（101/18→104/19）已随本轮改完。新增非阻塞观察 2 条：settle 后仅同席位可再建局
（usedSeats/rooms/users/runners 未清，已写入 AGENTS.md M2 边界）；console 口传任意合法 username
可直读该用户 console（固有旁观权限，127.0.0.1 无鉴权不对外，与修复前语义一致）。



## 2026-09-11 M2 实施（真实计分 + WS console 流 + 容器化 + 健壮性；待成果审查）

**计划**：`docs/plan-M2.md` v2（审查闭环：一审 FAIL 4 项 → 修订 → 复审仅余 1 项新引入 → 修 1 行 → PASS）。
范围 7 项：S1 真实计分 / S2 WS console 流 / S0 统一组装入口 / S3+S4 容器化+数据卷 /
S5 interrupted 恢复 / S6 地图公平性 / S7 席位碰撞加固。

**交付**：
- **S1**：`score.ts` computeOutcome 纯函数（world 出局 = spawns==0 且 creeps==0；arena = spawns==0；
  同轮双出局 tiebreak creeps→rooms→rclTotal——**M2 新增设计，用户已确认**）；settle/advance 可选
  outcome 注入（缺席 = M0 全 0 draw，基线不破）；manual 走 routes 预取快照，roundsExhausted 走
  driver tick 对 roundBreak 相位机器 advance 前 await 快照（该路径不发 round_resume 事件）。
- **S2**：WS 升级双向（subscribe_console/unsubscribe_console → console_lines 推送）；per-user
  单定时器分发（共享内部游标，多订阅者不互吞）；前端删 2s 轮询改累积（≤500 行）；HTTP 端点
  保留为降级口（必须显式 since，否则互吞）。
- **S0**：`src/server/main.ts` 统一真实组装（managed 私服 + RealArena + driver + 桥 + 静态托管 +
  journal），CLI `--port/--host/--data-dir/--static-dir/--agent-dir/--model/--install-only`；
  启动即拉私服（fail fast）；单世界单活跃对局（M2 约束，房间池 E5N5/E7N5）。
- **S3+S4**：Dockerfile（node:22-slim + 构建期私服安装，安装产物进镜像）+ docker-compose.yml
  （**单 app 服务** + screeps-data/arena-data 两卷，卷只挂可变数据）+ `--host` 参数化
  （默认 127.0.0.1 不变）。
- **S5**：MatchJournal（相位迁移唯一写点原子落盘；含 seatUsers/rooms 映射——复审 B4）+
  MatchMachine.restore（roundBreakSince 重置恢复时刻）+ 启动扫描恢复；恢复局房间跳过公平性重掷。
- **S6**：RealArena.prepareRooms（批量 generateRoom → Σ(source→controller) 距离偏离中位数 >10
  重掷 ≤3 → 定稿一次 restart；坐标走 roomObjects——mod generateRoom 无坐标返回）；
  **mod 侧收口重掷语义**：同房重复 generateRoom 抛 "This room already exists"（live 实测），
  修 arena-mod.cjs（[M2 fix] 先清 rooms.objects/db.rooms 再 stock 生成），打表新增一条单测钉住。
- **S7**：seatSlug（sanitize ≤16 + sha1 前 8，agent_ 前缀总长 ≤30）替换 runner cwd 与
  agent username 两处；a:b vs a_b 不再碰撞。

**验证（全部实测）**：
- `npm test` **101/101 绿**（18 文件，基线 73 + 新增 28）；`npm run typecheck` 零错
- `npm run build`（tsdown → dist/server/main.mjs 97.89kB）+ `npm run build:client` 零错；
  bundle 冒烟（ARENA_MOD_PATH 探测错误路径）✓
- `npm run test:live` **2/2 绿**（增补段实测：同房重掷语义 + bindUser + settle 真实计分 scores 非全 0）
- `sh scripts/m2-smoke.sh` **9/9 PASS**（真实 main.mjs 全链：起服→world→建局→settle→journal
  无残留→预置中断局重启→journal-restored=1→相位/roundIndex 还原→HTTP 可见）
- compose：**本机无 Docker，未实测**（静态核对；TEST.md 手测项待 Docker 环境）——plan-M2 §3.4 降级路径

**遗留**：M3+（锦标赛/回放/arena-blitz/房间可见性/跨容器拆分评估）；表现层收尾（全部功能后
单独做）；compose up 实测待 Docker 环境；多局世界/房间池扩张。


## 2026-09-11 M1 收尾（里程碑关闭）

**范围声明（避免含混）**：M1 计划判据全部达成；**前端表现层（样式）从未列入 M1 判据**，
是明确的范围外项（当前仅 monospace + 单背景色）。
**用户决策（2026-09-11 订正）**：样式**不并入 M2/M3 任何功能里程碑**，而是**等全部功能做完后
单独做一次统一的样式收尾**（理由：功能迭代期界面结构还会变，过早做样式会被推翻）。
故 M1 关闭时**无"未完成的验收项"**；功能侧剩余 2 项显式遗留（真实计分、WS console 流），
表现层收尾单列于计划书 §6。

**收尾动作**：
- `docs/plan-M1.md`：§6 补「表现层收尾（不在任何功能里程碑内）」条目（M1 判据是三视图
  能观察功能，非观感）；S6/§4 冒烟定位订正（见复审条目）。
- `README.md`：计划书链接改指 M1；补工程日志/TEST.md 链接；M1 现状加「表现层未做」标注。
- `AGENTS.md`：当前状态从过期的「M0 计划中」更新为「M0/M1 完成 + M1 基线 + 已知边界
  （含样式收尾决策）」；常用命令补 `build:client`/`test:live`/`test:smoke`。
- `TEST.md`：浏览器 6 项改为已实测（含截图）。

**交叉验证**：`npm test` 73/73 绿（13 文件）+ `typecheck` 零错 + `build:client` 零错。

**M1 交付总结**：Agent 对战、人类观战的完整链路首次打通——真实私服（信 `test:live`）+
真实 LLM（信 `test:smoke`）+ HTTP/WS 桥 + 观战前端（浏览器实测）。M1 三轮审核闭环 PASS。


## 2026-09-11 M1 浏览器观感验收（发现并修复 2 个 dev 运行时 bug）

**背景**：用户指出「有浏览器工具能截图就该自己验收，别甩给用户」。用浏览器工具实跑 dev-server +
vite dev，逐项实点实截 TEST.md 第 2 节的 6 个观感项——**当场抓到 2 个 `build:client` 覆盖不到的
dev 运行时 bug**（构建期不走 proxy/不执行交互，故 typecheck + vite build 全绿也漏掉）。

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| A | 打开首页**整页白屏**（标题在、内容不渲染，console 无报错） | `vite.config.ts` proxy 键 `'/api'` 是**前缀匹配**，把客户端源模块请求 `/api.ts`（`import './api.js'` 的解析结果）也劫持给 8787 后端 → 404 → 模块加载失败 | proxy 改正则 `'^/api/'`、`'^/ws/'`（锚定路径命名空间） |
| B | 大厅 start/settle 失败**静默无提示**（点了没反应，仅 unhandled rejection） | `app.tsx` 的 `onClick={async () => { await startMatch(...); ... }}` 无 catch | 抽 `runAction` 包装（catch → `actionError` 状态 → 红字显示） |

**浏览器实测证据（截图为凭）**：
- 首页深色界面 + 标题 + 大厅 tab + 创建表单 + 空列表表头（修复 A 后不再白屏）。
- 创建对局 → 列表行 `creating / -1 / seat-a… vs seat-b…`。
- 点 start（未提交代码）→ 红字 `start failed: HTTP 409`，phase 不变（修复 B 后可见）。
- 查看详情 → 状态行 `creating · round -1` + 玩家榜（ready/code 空、rooms/rcl/spawns/creeps 全 0）。
- settle → `settled / draw`，操作列只剩「查看」。
- console tab 切换 seat-a/seat-b → `(no output)`。

**验证**：修后 `npm test` 72/72 绿 + `typecheck` 零错 + `build:client` 零错；**浏览器 6 项复验通过**。
孤儿进程/端口已精确清理（`pgrep -af` 预览后按 PID）。

**教训**：dev 运行时行为（proxy 匹配、交互错误处理）**必须用浏览器实测**，typecheck 与
生产构建覆盖不到这些路径。


## 2026-09-11 M1 复审修复（subagent 审查 FAIL → 7 项全修）

**背景**：M1 成果送 subagent 审查（范围 `a55d28b..7679a3d`），结论 **FAIL**，7 项。
mod 保留项全集 / 公平红线 / 七面齐全 三条硬指标通过；其余逐条修复如下。

| # | 问题 | 修法 | 证据 |
|---|---|---|---|
| 1 | `vitest.config.ts` exclude 写 `*.smoke.it` 而文件是 `llm-smoke.it` → 默认 lane 扫到冒烟，真实打 OpenRouter 且红（69/70） | 通配改 `tests/*smoke.it.test.ts`；两条 lane 改**独立 config**（`vitest.live/smoke.config.ts`）——CLI `--exclude` 是追加语义无法撤销主 config 排除 | `npm test` = **72/72 绿（12 文件，1.6s，零成本）** |
| 2 | 冒烟只查代码落位、未断言工具调用发生 → 一次性偶然绿 | 按 `tool_end` 事件计数断言 `submit_code` 确实发生 + 有界重试（只追问未落位席位）×3 | `test:smoke` 418s 绿，断言确定性通过 |
| 3 | `dev-server` 从不 `driver.watch()` → tick 恒 no-op、Agent 永不唤醒；`wireMatchEvents` 空壳 | 新增 `dev-services.ts` 工厂（createMatch 内完成 watch + per-match waker 表）；driver waker 改 per-match（防多对局互相覆盖）+ 新增 `unwatch`；删空壳 `wireMatchEvents` | 新增 `tests/wiring.it.test.ts`（2 测试）：经 createMatch 后真实时钟 tick → roundBreak + 唤醒；超时兜底续跑 |
| 4 | report 未消费事件流，事件 fog 负向测试缺失 | report 接入 `eventLog` 增量（per-user 游标），只保留有视野房间事件 | `real-arena.test.ts` 新负向：`E5N5` 事件出现、`E7N5`（无视野）被剥离 |
| 5 | report 只扫 owned rooms，`visibleRooms()` 是死代码 | report 扫全部候选房间 → 交给 `visibleRooms()`；对手单位存在性用已采集 objects 判定 | 原弱用例补断言（对手 creep 进我方房 → `units visible`） |
| 6 | plan §4 要求冒烟「代码真落私服」实际用 MemoryArena | 明确定位：冒烟 = provider 行为探针；「真落私服」由 `test:live` 承担（写入测试头注 + TEST.md） | 文档一致，无双宣称 |
| 7 | 文档漂移：React 18 vs 19；`ok:false` 抛错纪律 vs ensure 内 setTickDuration best-effort | README/AGENTS 改 React 19；service 头注澄清「唯一例外：ensure 链内 setTickDuration best-effort」 | typecheck 零错 |

**验证证据（全部本机实测）**：
- 默认 lane：**72/72 绿（12 文件，1.62s）** + `typecheck` 零错。
- `test:live`：真实私服全链绿 **375s**（启动→setTickDuration→generateRoom→createUser→
  submitCode→getWorld→terrain→console→事件流；孤儿进程检查干净）。
- `test:smoke`：OpenRouter `xiaomi/mimo-v2.5` 真链路绿 **418s**（双席位 submit_code 计数断言）。
- `build:client`：vite build 零错（227KB）。
- `dev-server`：create→list→get→start(409 拒)→settle→terrain→world→console 全端点实测通过。

**新增踩坑**：① vitest `--exclude` 是**追加**语义，不能撤销主 config 的 exclude → lane 必须
独立 config 文件；② `MatchDriver` 的 waker 若全局按 seatId 存，多对局并存会互相覆盖 →
改 per-match 表。

## 2026-09-11 M1 完成（S1–S7）

**范围**：HTTP/WS 桥 + 观战前端 + 真实私服接线 + 真实 LLM 冒烟（plan-M1 全部里程碑）。

- **S1**：`src/server/screeps/`——runtime 三件套平移（node-runtime/server-installer/
  server-launcher，marker 去 DSH 化）+ `service.ts` 七面纯类（createUser/submitCode/
  getWorld/getTerrain/consoleOutput/system/restart；生命周期坑全平移：ensure 链内直连
  防自死锁、exit guard、shutdown 先 await 在途 ensure、restart 刷地形缓冲）。
- **S2**：`arena-mod.cjs` 平移裁剪（1648→1046 行；删 replay bridge/arenaGen/arenaProbe；
  **保留项全集**：8 邻墙桩/removeWhere 清桩/resume 强刷 world meta/unhandledRejection
  守卫/addAccessibleRoom/roomStatusData 播种/users.code timestamp）+ 打表 10 测试。
- **S3**：`arena.ts` RealArena——SeatRegistry/ArenaBackend 真实实现（bindUser 一次完成
  generateRoom+createUser、submitCode 真传、runConsole 官方通道+ring 游标、report fog
  过滤：对手只在有视野房间出现）；service 补 runConsoleAs/getRoomObjects。
- **S4**：`src/server/http/`——routes.ts 路由纯函数打表（公开投影不暴露 code 内容）、
  **driver.ts 对局驱动器**（advance 真实时钟 + MatchEvent→prompt 唤醒 + 去重 + 失败不中断）、
  server.ts Fastify 壳（127.0.0.1 + WS `/ws/matches/:id`、`/ws/world` + broadcast）。
- **S5**：`src/client/` SPA——大厅（创建表单/列表/start/settle）、对局详情（玩家榜/
  地图 canvas/console 逐用户 tab/errors）、`src/shared/types.ts` 共享 DTO（契约漂移防线）、
  vite build 227KB 零错。
- **S6**：真实 LLM 冒烟绿——OpenRouter `xiaomi/mimo-v2.5` 双席位提交闭环（114s）。
  **mock vs 真实差异**：① mimo 是 reasoning 模型（content=null，思考链在 reasoning 字段，
  Pi SDK 透明处理）；② 真实 LLM 先 console/report 探测环境再提交（mock 直调）；
  ③ 首次 submit_code 参数形状错（modules 传字符串）→ schema 拒 → LLM 自修正重提——
  错误回执→自愈链路真实生效；④ SSE 工具调用分片聚合正常（probe 验证）。
- **S7**：本条 + README + TEST.md。

**验证证据**：
- 默认 lane：70/70 测试绿（12 文件）+ typecheck 零错。
- `test:live`：真实私服全链绿（安装→启动→generateRoom→createUser→submitCode→getWorld→
  terrain→console→事件流，6 分钟；孤儿进程检查干净）。
- `test:smoke`：OpenRouter 真链路绿（114s，双席位提交闭环）。
- `build:client`：vite build 零错。

**踩坑记录**：
1. secret header 名不一致（service 发 `x-screeps-arena-secret`，mod 校验 `x-arena-secret`）
   → 403 bad secret。修：统一 `x-arena-secret`。
2. `npx vitest run` 不带参数会把 live IT 扫进默认 lane（每次全量测试重装 screeps 6 分钟
   超时）→ vitest exclude `*.live.it.test.ts`/`*.smoke.it.test.ts` + 文件改名匹配。
3. 冒烟 IT 首败根因：工具面 backend 直连 MemoryArena 没走状态机收口（S4 IT 有
   machineBackend 包装，冒烟漏了）→ 补 backendFor(seatId) 后绿。
4. OpenRouter mimo 首次提交参数形状错误是**预期行为**（schema 拒→自修正），不是 bug。

**遗留（M2 起）**：
- compose 双服务容器化、真实计分（world 快照→胜负判定）、地图公平性距离校验重掷、
  interrupted 恢复、席位目录名碰撞加固（M0 审查建议 1）。
- WS console 流（M1 用轮询增量）、models.json apiKey 明文落 tmpdir 的清理（M0 审查建议 2）。
- report/console 的 IT 只驱动了 submit_code（M0 审查建议 3）——冒烟已见 console/report
  真实调用，但未断言其落位内容。

## 2026-09-11 M0 完成（S0–S5）

**范围**：骨架 + Agent 运行时最小落地（plan-M0 §3 全部里程碑）。

- **S0a/S0b**：仓库骨架（fnm/Node22、vitest 白名单 exclude reference/、typebox+zod、
  Fastify5 占位）+ Pi SDK spike（`docs/spikes/pi-sdk.md`，S1–S6 全绿）。
- **S1**：`src/agent/runner.ts`——Pi SDK 薄封装。每席位隔离 cwd/agentDir、models.json 写入、
  `prompt()` 唤醒、事件归集 RunnerEvent、dispose 幂等、并发 prompt 拒绝。
  工具白名单 = customTools 名单全集（`tools:[]` 会连 custom 一起禁——实测踩坑）。
- **S2**：`src/agent/tools.ts` + `memory-backend.ts`——`submit_code`/`report`/`console`
  按席位闭包；依赖接口注入（SeatRegistry + ArenaBackend）。公平边界 = schema 无身份参数
  + 未映射拒 + 只经 `resolveUser(seatId)`；负向测试钉死（跨席位隔离/未映射拒/schema 无身份通道）。
- **S3**：`src/server/match/{model,machine}.ts`——creating→running⇄roundBreak→settled；
  running 期提交拒（FROZEN_DURING_ROUND）、roundBreak 暂存+ready、超时兜底（沿用上轮代码
  自动 ready+error 落盘+续跑）、resume 清 ready+roundIndex+1、maxRounds 到顶自动
  settle(roundsExhausted)、M0 记分全 0 → draw。时间显式注入 `now`。
- **S4**：`tests/match-stub.it.test.ts`——2 mock LLM 席位完整 1 轮闭环 IT：创建→双席位
  经 AgentRunner+buildSeatTools 提交→start→advance 到 roundBreak→round_break 触发
  prompt() 唤醒→mock 第 2 次回 submit_code→全员 ready→resume→settle。断言状态机迁移
  序列、MemoryArena 落位、事件顺序、工具白名单（零内置）、LLM 调用口径（2 工具 turn × 2 请求）。
- **S5**：本日志 + README 更新。

**验证证据**：`fnm exec --using=22 -- npm test` → 31/31 绿（4 文件，1.4s 离线）；
`npm run typecheck` → 零错；`npm run spike:pi` 全绿（S0 证据，保持）。

**遗留（M1 起）**：
- HTTP 桥（Fastify ws/console 流）与前端（React+Vite）未动工——plan-M0 明确 M1。
- MemoryArena 是内存假实现，M1 换真实 arena API（接口面不变）。
- 超时兜底的墙钟驱动方（真实时钟接线）在 M1 HTTP 桥落。
- 4 个 commit 中仅首个已推送（af96253），审查通过后补推。
