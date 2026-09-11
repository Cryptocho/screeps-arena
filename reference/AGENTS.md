# AGENTS.md — dsh-screeps

把 Screeps（开源私有服务器）做成 DeepSeek Harness 插件：**对局参与者只能是 Agent（DSH 会话）**，多个 Agent 各自提交代码，在同一世界里"斗蛐蛐"。**产品只做斗蛐蛐，两种对局形态：World（MMO 持久世界扩张战，多 Agent）与 Arena（1v1 单房快速歼灭战）**；人类只有旁观视角（观战大厅/地图/console 流），**不进对局、不指挥、不参与**——斗蛐蛐是 Agent 之间的事；不做完整客户端，界面自绘 + 官方开源素材。

本文件是这个仓库的持久交接文档：任何 Agent 继续开发前先读完它，不要重新推导已验证的结论。所有引用都给了文件与行号，动手前先复核。**工程日志在 `docs/LOG.md`（每个里程碑/调试条目倒序，含验证证据与遗留），每个里程碑完成后必须追加一条。** Spike 结论与调试记录在 `docs/spikes/`（索引见各里程碑条目）。

**工作纪律（用户要求，最高优先级）**：任何多步任务，必须先把逻辑理清楚、列成一步步的计划（todo），**每一步动手前想清楚、做完后向用户汇报**（做了什么、证据是什么、下一步是什么）。不要一口气闷头做完再总结。**汇报是进度透明，不是请求确认——已批准的计划在执行过程中不因阶段汇报而停下等待；纠偏发生在计划阶段（见里程碑标准流程），开工后用户不再逐段给口令。**只有四类情况必须停下：① 用户明确要求停下/提交时（复杂阶段前先提交）；② 需要用户手动测试时（见测试协作纪律，须同时给 TEST.md）；③ 出现计划外的新决策点需要用户拍板；④ 审核循环要求的 PASS 前等待。**汇报语言（用户要求）**：所有面向用户的汇报、阶段说明、消息一律使用**中文**（代码、命令、测试输出、文件名等原文保留），不得夹杂英文叙述。

**委托纪律（用户补充）**：已经交给 subagent 的任务，**自己不并行重复**——subagent **一律用 `run_in_background: false` 前台阻塞等待其结果**（工具调用阻塞到该 subagent 完成为止，**机制上杜绝一切轮询**），别一边委托审查一边自己也在做审查（抢活既重复劳动又可能两头结论打架）。委托后只做与 subagent 任务无关的准备工作，或干脆停下等结果（等 = 前台阻塞，不是后台等通知）。

**审核循环纪律（用户补充，S12 起）**：计划/成果交给 subagent 审查后，**不存在"终审"**——结论不是 PASS 就必须**修改后复审**，循环直到通过为止；任何一次「PASS 前开工」都是违规。不得用「这是最后一轮」的表述给审核设限或暗示通过。审核轮次只做计数（一审/二审/三审…），不改变「不通过就改到通过」的循环语义。PASS后等待用户确认开工。

**里程碑标准流程（用户拍板，S12 起）**：每个里程碑正式开工前必须走完闭环——**① 写计划书（`docs/plan-<M>.md`，含目的/范围/步骤/验证/遗留）→ ② 交 subagent 审查（`run_in_background: false` 前台阻塞等结果）→ ③ 停下等待审查结果（等 = 前台阻塞，不得并行开工）→ ④ PASS 才开工；不 PASS 则修改后重新送审**，循环至 PASS。计划书里记录审查轮次历史（一审/二审/…）与每轮结论，供追溯。

**测试协作纪律（用户补充，S12 起；2026-09-09 修订）**：任何时候需要用户手动测试——**仅限 MCP/browser-mcp 确实无法自动达成的验证（如主观审美偏好）**，可自动化的一律 Agent 自己做（见环境操作纪律）——**必须直接、明确地告诉用户**（"需要您测一下 X"），不能藏在遗留列表里等用户自己发现；**并且必须同时提供测试指导文档 `TEST.md`**（仓库根，随里程碑更新，含：启动方式、被测功能清单、每项的操作步骤与预期结果、已知遗留）。TEST.md 是用户执行测试的唯一依据，Agent 不得假设用户知道怎么点。测试项完成后在 LOG 里同步结果并销项。

**TEST.md 自证纪律（用户补充，M2 收尾；血的教训）**：凡是写进 TEST.md 的**启动命令、patch 内容、curl/操作步骤，必须由 Agent 在本环境先真实执行一遍并验证通过**，才能提交给用户；禁止只凭文档/推理撰写。反例（M2 收尾实测）：TEST.md 第 0 节 webserver patch 示例只写 `port: 3200` 缺 `host`，而 webserver Config 的 host/port **均 required 无默认**（dsh-host-webserver/lib/index.js L98-101）——同一文件前文还写着「必须同时给 host+port」，示例却自相矛盾，用户照做启动卡死；第 3 节 `curl start` 也漏了 creator `sessionId` body（http.ts L290 无 sessionId → 400）。两处都是"写文档时没实测"的直接证据。防复发：TEST.md 改动的每一行命令，提交前必须逐条跑通（前台/后台均可，但必须真实执行并看到成功输出），并顺手把「已实测」标注进文档。

**后台任务纪律（用户补充，M2 起）**：长耗时命令（provision/编译/下载等）放后台后，**等待结果只用一次 `job_output(job_id, {wait: true})` 阻塞等待**（可带 timeout 上限），**禁止反复无 wait 轮询刷屏**——每轮空转浪费回合、也刷屏打扰用户。无 wait 的 job_output 只用于「随手确认状态」，不得循环调用等价于轮询。job 完成会收到通知，收到后再处理结果。**subagent 不适用本条（见委托纪律：一律 `run_in_background: false` 前台阻塞等结果）。**

**环境操作纪律（用户补充，M2 收尾）**：
- **启动 dsh 一律加 `--no-open`**：`dsh --profile <name> --patch <cfg> --no-open`（web 命令可用 `dsh web --no-open`）。不加会在用户桌面弹默认浏览器，干扰用户；启动飞快（数秒），等待用 10-20s 短超时即可，不要设 60s+ 长超时。
- **本 Agent 支持视觉（2026-09-10 修订：切换模型后生效；旧版「不支持视觉、禁用 browser_screenshot」作废）**：可以用 `browser_screenshot` 截图/读图作验证手段，UI 验收不再局限于 accessibility 快照；浏览器交互仍推荐 accessibility 快照（`browser_snapshot`）+ 点击/输入（`browser_click`/`browser_type`）驱动（定位更稳），截图用于确认视觉观感。若截图调用报错，退回快照方式驱动并提醒用户排查，不要反复重试截图。
- **browser-mcp 默认已连接（2026-09-09 用户纠正）**：直接发起 MCP 调用即可，**不存在「需用户先手动 Connect」的前置步骤**（M4 时代的说法作废）；仅当调用报连接类错误时，才明确提醒用户排查扩展/连接。注意 click 的 WebSocket ack 偶发 30s 超时但点击实际生效——超时后先 snapshot 确认现场再决定下一步，不要盲目重试点击（toggle 语义会关掉刚打开的面板）。
- **测试凡 MCP 可自动化完成的一律自动化（2026-09-09 用户拍板）**：UI/DOM 级验证（文本、选项、徽标、快照可达的交互）不推给人工，Agent 直接经 browser-mcp 完成；人工测试仅限 MCP 确实达不成的验证（如主观审美偏好），且须按测试协作纪律给 TEST.md。不要把「可能要人工」当结论——先试再说。
- **清进程严禁宽匹配 pkill（血的教训，M3 开工当天）**：**绝不能用 `pkill -9 -f 'dsh'` 或任何含宽泛关键词（如 `dsh`/`node`/`screeps` 不带精确路径）的 pkill/pgrep 杀进程**——`dsh` 会匹配到**本 Agent 自己的 DSH 宿主进程**（命令行同样含 dsh），一条命令当场自杀中断会话。清孤儿私服必须**精确锚定**：`pkill -9 -f 'screeps.js start'`（launcher）、`pkill -9 -f '@screeps/storage'` 等，或 `ps aux | grep -E 'storage/bin/start|backend/bin/start|engine/dist' | awk '{print $2}' | xargs kill` 按 PID 批量杀；杀之前先 `pgrep -af <精确模式>` 预览确认不会命中自己。宁可多分几步查证，不可一条宽命令带走自己。

## 结论（已验证）

**可行，不需要 fork Screeps。** 核心判断依据：

1. Screeps 私服自带完整受控面：REST API、TCP CLI、sockjs 实时推送、mods 扩展钩子。所有我们要的能力（建用户、传代码、控 tick、读战局）都是官方扩展点，不是 hack。
2. DSH 插件形态已被两个先例验证：`github.com/linconz/agentduel-dsh`（host 桩 + client 重集成）与 `github.com/AwesomeHou/dsh-doudizhu`（client 为主 + 共享引擎）。
3. Screeps 是 ISC 许可：可以 fork、可以打包、可以按需修改，只需保留版权声明。mods 机制让 fork 变成最后手段而非前提。

## 三层架构

```
┌─ DSH client bundle ──────────────────────────────┐
│ 观战地图(canvas)、对局大厅、Agent 代码查看器、     │
│ 控制台日志流、排行榜      [本仓库 src/client]      │
└──────────────┬───────────────────────────────────┘
               │ DSH webserver 路由 (/dsh-screeps/*)
┌──────────────▼───────────────────────────────────┐
│ DSH host 插件                                     │
│  ScreepsService: 服务器生命周期(拉起/停止/复用)    │
│  arena 客户端: 调 Screeps HTTP + CLI              │
│  工具: 会话→Screeps 用户映射后的上传/指挥/查询     │
│  持久化: 对局记录、比分、时间线    [src/host]      │
└──────────────┬───────────────────────────────────┘
               │ loopback HTTP(21025) + CLI TCP(21026)
┌──────────────▼───────────────────────────────────┐
│ Screeps 私服（独立进程组，stock + arena mod）      │
│  arena mod: /api/arena/* 建用户/发token/读分      │
│  driver+engine: 在 vm 里逐 tick 执行玩家代码       │
└──────────────────────────────────────────────────┘
```

- **client 不直连 Screeps**：token 管理与公平边界都在 host 侧收口，浏览器只认 DSH 路由。
- **arena mod**（本仓库 `screeps-mod/`，随插件分发，写入服务器目录并挂进 mods.json）：跑在 Screeps backend 进程内，可直接 `require('@screeps/common')` 拿 `storage.db`/`authlib`，并通过 `config.backend.router` 挂 `/api/arena/*`。这解决了两个官方 HTTP 面做不到的事：无 Steam 凭据建用户/发 token（官方 auth 只有 steam-ticket：`backend-local/lib/game/api/auth.js` L137），以及绕过 stub（`/room-overview` 是 TODO：`game/api/game.js` L583-602）。

## 已验证的 Screeps 集成面速查

路径均相对 `reference/screeps/`（版本：screeps 4.3.0 / backend 3.3.0 / engine 4.3.2 / driver 5.3.0）。

| 能力 | 位置 | 备注 |
|---|---|---|
| mods 加载 | `common/lib/config-manager.js` | mods.json 列 JS 文件，`mod(config)` 修改配置树；`bots` 字段注册 bot AI 目录 |
| HTTP 路由扩展 | `backend-local/lib/game/server.js` L33,137,176 | `config.backend.router` 是 express Router，挂载在 `/api`；另有 `expressPreConfig` 事件 |
| 上传代码 | `game/api/user.js` L82 `POST /api/user/code` | `{branch, modules, hash}`；分支即版本，激活分支切运行代码 |
| 控制台 | `game/api/user.js` L341 `POST /api/user/console` | 以该用户身份执行，需该用户 token |
| 读/写 Memory | `game/api/user.js` L255/285；segment L318/329 | |
| 地图战况 | `game/api/game.js` L186 `POST /api/game/map-stats` | 每房间控制权(user+level)、safeMode、玩家 badge——观战地图的数据源 |
| 地形 | `game/api/game.js` L263 `GET /api/game/room-terrain` | |
| 放置 spawn | `game/api/game.js` L328 `POST /api/game/place-spawn` | 新用户开局用 |
| 实时推送 | `backend-local/lib/game/socket/`（sockjs） | 通道：`room:<r>` 房间对象增量（rooms.js，订阅上限 USER_LIMIT=2）、`roomMap2:<r>` 地图视图、`user:<id>/console`、`user:<id>/cpu`（user.js）；`socketUpdateThrottle` 200ms |
| CLI（TCP 端口+1） | `backend-local/lib/cli/` | `system.pauseSimulation()/resumeSimulation()`（system.js）、`system.setTickDuration(ms)`、`system.resetAllData()`、`map.generateRoom()`（map.js）、`bots.spawn(botAiName, room, opts)`/`bots.reload()`/`bots.removeUser()`（bots.js） |
| CLI 扩展 | `cli/sandbox.js` | `config.cli.on('cliSandbox', sandbox => …)` 可挂自定义命令（arena mod 用） |
| bot AI（静态 NPC） | `backend-local/lib/cli/bots.js` + `utils.js` L271 | 从目录读代码建用户、spawn、claim controller；`bots.reload` 热更。**测试 bot（`tests/fixtures/bots/`）不走这条路**（与 Agent 玩家同走 arena createUser 通道，用户类型/公平一致；此 NPC 通道仅保留给静态 NPC 场景，当前无产品使用） |
| token 机制 | `backend-local/lib/authlib.js` L5 `genToken` | HMAC+60s TTL 滑动续期；arena mod 调它给用户发 token |
| tick 节奏 | `driver/lib/index.js` L21 `mainLoopMinDuration: 1000` | 默认 1 tick/s；CLI `setTickDuration` 可加速/减速——对局加速、观战放慢都靠它 |
| 暂停世界 | `common/lib/storage.js` L43 `mainLoopPaused` env key | CLI 封装好了 |
| 引擎事件落盘 | `driver/lib/index.js` L583 `saveRoomEventLog` | env hash `roomEventLog:`（field=roomId，每 tick 覆盖）——事件流采集的数据源，结论见 `docs/spikes/event-stream.md` |
| runner 地形缓存 | `driver/lib/runtime/make.js` | 一次性初始化 + 进程级缓存：generateRoom 后必须重启私服，见「生命周期与调试陷阱」 |
| 渲染器/素材 | `renderer/`、`renderer-metadata/`（PixiJS, ISC） | 引擎与 sprite 素材（ground/creep-mask/flare 等齐全）均开源、浏览器可打包（demo 是 webpack 网页应用）。使用策略见「客户端面」：自绘为主 + 素材复用，不搬完整渲染引擎 |
| Steam 依赖 | 见下节「STEAM_KEY 真相」 | 默认模式由 arena mod 消除，用户不需要申请 key |
| 存储 | LokiJS → `db.json` | 私服默认；插件配置里显式指定数据目录，别用 cwd |

其他事实：Node >= 22.9 才能跑私服（`screeps/package.json` engines）；世界 202×202（`common/lib/constants.js` L108）；`runners_cnt`/`processors_cnt` 可调成 1 降占用；`system.getTickDuration()` 可查当前值。便携 Node 22 LTS（实测 v22.23.2）下 isolated-vm + driver native 编译通过（~6 分钟），managed 模式由 `src/runtime/node-runtime.ts` 自动供给。

### 生命周期与调试陷阱（S7a/S7b 实证，动手前先读）

以下每条都付过学费，完整实证与未解决项在 `docs/spikes/m0-flake.md`：

- **`users.code` 插入必须带 `timestamp: Date.now()`**：缺失 → `userCodeTimestamp=0`（`driver/lib/runtime/data.js` L204）→ VM 缓存/内存序列化异常，表现为 VM 内 `Game.time` 冻结、Memory 不回写，但 runner 每 tick 都在跑。官方姿势见 `game/api/user.js` L106。
- **generateRoom 后必须重启私服**：见上表 runner 地形缓存行。附带结论（m0-flake.md 第二节，pf 探针实证）：resetArena 会清空 db['rooms.terrain'] 摧毁基础地形覆盖，pf.cc 的 A* 探测到未生成的邻接房间时直接 "Could not load terrain data"——**arena-mod 的 generateRoom 已自动给 8 邻居插全墙地形桩并重建 blob**，不要再往"地形交接竞态/persistence gap"方向挖。
- **停服序列**：pause → 等 **~10.5s**（LokiJS 10s autosave 窗口）→ SIGTERM → 5s → SIGKILL。不等窗口就杀会丢最近写入。
- **cordis disposer 必须 return promise**：`() => void this.shutdown()` 的 promise 被 `void` 丢弃，cordis `runDisposable` 只 await 返回的 thenable（`node_modules/@deepseek-ai/cordis/lib/index.js` L963-966）→ `fiber.dispose()` 不等停服 → detached 进程组整体成孤儿。**已修**（4f94fd5：disposer 返回 promise + shutdown 等待在途 ensure + exit 兜底 SIGKILL，语义由 `src/host/service.test.ts` 钉死）。同族陷阱：Node ≥15 的 unhandledRejection 默认 throw，stock cronjobs 丢弃 job promise → backend crash-loop——arena-mod 已装 rejection guard。
- **对局重置用 arena-mod 的 `resetArena`，禁用 `resetAllData`**：后者 loadJSON 会把 env `databaseVersion` 重置 → storage 重启重跑 v4→v5 转换器 → 毁掉 reset 后新建的 v5 格式对象（spawn 的 store 被掏空）。
- **arena-mod 必须同步维护两个 env 键**：`accessibleRooms`（VM WorldMapGrid 按它索引地形缓冲，缺 → 每次用户 run TypeError）与 `roomStatusData`（缺 → `JSON.parse(undefined)` 每 60s 崩一批 run）。
- **测试纪律**：pkill/pgrep 模式必须 `[x]` 方括号化防自匹配；共享 smoke 服务器目录是单写者资源，并行跑 IT 必互踩。
- **pubsub 回调是单参 payload**（S13 实证，血的教训）：`storage.pubsub.subscribe(channel, cb)` 内部经 `RpcClient.subscribe`（`common/lib/rpc.js` L143-145）包装成 `(channel, ...args) => cb.apply({channel}, args)`——**用户回调只收到一个实参 = payload**（channel 借 `this.channel`），不是 `(channel, data)`！订阅 `user:<uid>/console` 后 `function (payload)` 单参收 JSON 串（`{messages:{log,results},userId}`）；订阅 `roomsDone` 收到 gameTime。**千万别写双参签名**——payload 会被当成 channel 存错字段，现象是"publish 到了但 buffer 全 null / selfLoop 假阴性"。契约测试的观察点必须来自源码实参形状（本轮就是测试写双参、实现单参，"单测绿实测红"并存一天）。
- **程序化 spawn 会话 create 必须带 `meta.cwd`**（M3 A0 web lane 实证）：DSH persona 组装要 `{{cwd}}` 变量（`deployment:persona` section），缺 → A1 turn 直接 error `prompt variable "{{cwd}}" has no value`，对局永不建出——headless/stub 装置测不到（inactive-context 挡住），真实 web lane 才暴露。同理 `agentModel` Config 无默认值，patch 不配 → spawn 出的 agent 无 model → `{{model}}` 同崩；验收 stub adapter 侧兜底 stub-model。**已修（2026-09-09 真实链路实测实锤，commit 64a6881）**：真实 spawn 不带 model 时 persona 组装 `{{model}}` 无值 → 子会话 turn 直接 error、对局永不建出、零可读报错（stub lane 全靠请求体/插件喂了 model 才躲过）→ 三层防线：`orchestrator.spawn` 前置抛可读错误、HTTP `spawn-agents` 同步 400 预检（`body.model ?? services.agentModel`）、Service `agentModel` getter；+2 单测。**真实 LLM 全链测试路径见 TEST.md §8**（real-web-lane.yml 无 stub，首次闭环 2026-09-09：TacticalShrimp vs DeepSeekNest，2847 tick 真实对局，DeepSeekNest 冠军）。
- **MatchStore 写操作必须串行化（M3 UI lane 实证，已修）**：`lifecycle.start` 的 `transition('placing')`
  与循环内 `store.update`（回填 userId）并发**读-改写**会互相覆盖——晚写者基于旧 creating 快照写回，
  把 phase 打回 creating → `transition('running')` 报 `creating → running not allowed`（UI 点击 start
  实锤；curl 偶发不中）。修复 = MatchStore 全部写操作经内部 promise 链 `serialize()` 串行（读改写排队，
  每个操作用上一个操作落盘后的最新 state）+ tmp 随机后缀（防 rename 踩踏，之前只修到这一层）。
  **注意 serialize 内禁嵌套调用**（settle/markInterrupted 原本调 this.transition = 经同一链排队 → 死锁，
  已改直接写 state）；补并发单测钉死（store.test.ts `serialized writes` / `settle no deadlock`）。
- **验收 stub LLM adapter 不能按调用次数判阶段**（M3 A0 web lane 实证）：DSH 一个 turn 内会多次调 stream（工具结果后还会再调生成），按计数判 step 会漂移；改按**消息内容**判（含「编写你的 Screeps 脚本」→ submit；含工具结果 → 已入座）。matchId/preset 在 followup 的 user message 里，不在 system prompt。

### STEAM_KEY 真相（为什么存在、怎么消除）

1. **根因是账号模型**：Screeps 是 Steam 游戏，玩家身份就是 Steam 身份。开源私服**唯一的登录路由是 `POST /api/auth/steam-ticket`**（`game/api/auth.js` L137）——没有密码登录（`/me` 响应里的 `password: !!request.user.password` 只是官方 MMO 的 schema 残留，全库无任何密码校验路由）。
2. **验票需要找 Steam**：客户端带着 Steam 会话 ticket 来登录，服务器必须找 Steam 验证。两条路：本机 greenworks（Steamworks 绑定，要求本机跑着 Steam 客户端）本地解票；或 Steam Web API `authenticateUserTicket`（需要 Web API key = STEAM_KEY）。
3. **启动时强制二选一**：`game/server.js` L110-126，有 STEAM_KEY 走 Web API 路径；没有就找 greenworks，找不到直接 throw——因为任何一条验票路径都没有的私服对官方客户端毫无意义。
4. **quirk（L74-90）**：有 key 时 `connectToSteam()` 会先调 `steamApi.ready()` → `GetSupportedAPIList` 拉接口表；**它的错误分支既安排 1 秒重试又顺手 resolve 了启动 promise**——所以无效 key 也能开服，但会每秒发一次失败的 HTTPS 请求并刷 "Steam Web API connection error" 日志，永不停止。
5. **消除方案**：mods 在 `configManager.load()` 阶段加载（`backend-local/lib/index.js` L14），**早于** Steam setup；arena mod 可以自设占位 `process.env.STEAM_KEY` 并 stub 掉 `steam-webapi` 的 `ready`（`require('steam-webapi')` 是同一模块对象，改 export 属性即生效），默认模式零 Steam 依赖、零日志噪音。**插件的任何用户（包括作者）都不需要申请 key**——key 唯一的真实用途是验官方客户端的登录票，插件用户走 arena mod 的 token 通道，永远不经过 Steam。
6. **可选增强**：给配置项接受真实 key（Steam 免费申请）且不 stub 时，官方 Steam 客户端可以直接连私服——玩家可以用完整游戏渲染器观战对局，作为插件内置观战图的补充。key 在服务端配置一次即可，不是每个用户的事。

### 客户端开源边界

- **开源（ISC）**：服务器全家（launcher/storage/backend-local/driver/engine/common）、`@screeps/renderer` 渲染引擎 + `renderer-metadata` 素材包、docs。官方文档原话："We released game server software under open license"（`docs/source/community-servers.md`）。
- **闭源**：官方游戏客户端（Steam 应用 / screeps.com 网页端）。玩家用它的「Change Server」连私服。它进不了 DSH，我们也不需要它。
- **自写客户端是社区验证过的路**：emtee40/screeps-client（PixiJS 自绘客户端）、xxscreeps（从零重写）、screeps-steamless-client（免 Steam 启动官方客户端的 wrapper）。客户端-服务器协议（REST + sockjs 通道）在服务器源码里完全可见，零猜谜。本插件的 client 半身就是「为 DSH 定制的 Screeps 客户端」——与 agentduel-dsh 同模式。

## 运行面

- **host**：Service（Screeps 生命周期 + arena 客户端）+ tools + HTTP 路由 + 持久化。必选。
- **client**：观战与对局 UI。必选（没有 Web UI 这个插件就失去意义）。
- **Screeps 侧 mod**：随包分发的普通 JS 文件，运行在私服进程里。必选。
- 服务器进程管理两种模式都支持，配置切换：`managed`（插件拉起/停止，默认；`ctx.effect` 持 disposer，停服顺序：先 pauseSimulation 再杀进程）与 `external`（连接用户自己跑的私服，只读 arena API）。

## 公平边界（这条是红线）

**一个 DSH 会话 = 一个 Screeps 用户，映射只存在 host 侧。**

- 工具从 `exec.agent` 取当前会话，只允许操作映射到的那个 Screeps 用户：上传自己的代码、读自己的 console/memory、看公开战况。
- 不提供"以任意用户身份执行"的工具；opponent 的代码、memory、console 对会话不可见（观战看到的是地图投影与统计，不是内部状态）。
- arena API 只暴露给 DSH host（loopback + 插件自有鉴权），浏览器与 Agent 都拿不到裸 Screeps token。
- **HTTP 面 sessionId 信任边界（P0 审查提示 8）**：`/dsh-screeps/*` 的 create 校验 sessionId 非空 +
  `__bot__` 保留名前缀，**不校验是否真实 DSH 会话**——浏览器端任意 sessionId 用于 Client 驱动的演示/占位
  用途。**M3 起 client 建赛已改由 host spawn 真实 Agent 会话**（`POST /spawn-agents`，替代伪造 sessionId
  占座），HTTP create 保留给工具面/测试并有文档化 sessionId 信任边界；**HTTP join 已移除**（唯一入座通道 =
  工具面 `screeps_match` join）。start/settle 只认 players[0]（creator/观战者触发，非对局内操作），值
  GET /matches 公开可读。
- 对局进行中上传代码：允许（Screeps 本来就支持热更分支），但是否计入当局由对局规则配置决定，默认"本 tick 后生效"。

## 信任模型（写进 README，不要隐瞒）

用户/Agent 代码跑在 Screeps 的 node `vm` 里，**vm 不是安全边界**。两个 Agent 的代码同进程执行，理论上可越沙箱互查、甚至碰私服宿主机。缓解：私服是独立进程组（与 DSH host 隔离）；进阶可让用户把私服跑进容器（配置文档给出现成 compose）。对"斗着玩"的本地场景这是合理风险，但不能默认成沙箱承诺。

## 玩法设计（产品核心，已拍板：只做斗蛐蛐）

### Screeps 机制速查（数值来自 `reference/screeps/` 引擎常量与官方 docs 源码，写规则时直接引用）

- **tick 循环**：所有玩家的 main 每 tick 各执行一次，动作下一 tick 生效，冲突按优先级结算（docs/source/game-loop.md, simultaneous-actions.md）。
- **经济**：Source 容量 3000、每 300 tick 回满（≈10 能量/tick，`constants.js` L136,145）；WORK harvest 2/tick；spawn 成本=部件和、耗时 3 tick/部件（L142）。部件价：move 50 / carry 50 / tough 10 / attack 80 / work 100 / ranged_attack 150 / heal 250 / claim 600（L96-105）。
- **战斗**：近战 30 伤/tick、远程 10（射程 3）、治疗 12/4（L123-126）；100 hits/部件，部件按声明顺序受击损坏；tough 减伤。
- **防御**：墙/城垒（rampart 己方可穿、其上 creep 免疫）；tower RCL3+、10 能量/发、全房射程衰减；safe mode 20000 tick、冷却 50000（L242-243）——**开局自带的 20000 tick safe mode 就是天然的 setup 缓冲期**。
- **控制权**：CLAIM 部件 claim 中立 controller；RCL1→8 升级能量 200→45k→135k→405k→1.2M→3.6M→10.9M（docs/source/control.md）；controller 不可摧毁但会 downgrade（20k~200k tick 定时器，可被 attackController 加速）。
- **视野**：只有己方 creep/建筑所在房间可见——**战报生成必须遵守 fog of war**，插件不得成为透视挂。
- **NPC**：Invader（骚扰）、Source Keeper（守矿房），可配开关。
- **事件流**：引擎每房间每 tick 产 EVENT_ATTACK/DESTROYED/HEAL/RESERVE/UPGRADE…（`constants.js` L785-796）——战斗播报的原料；**采集点已定（S7b）**：backend mod 订阅 pubsub `roomsDone` → `env.hgetall roomEventLog:`，不 hook 引擎不 fork，证据链见 `docs/spikes/event-stream.md`。

### 社区先例：BotArena（纯 AI 锦标赛，2017 起）

私人服务器 + 极速 tick（初期 ≈5 tick/s，后期 2-3）：**20000 tick ≈ 1 小时，24 小时内可跑完锦标赛全程**。规则：除 spawn 外禁止一切玩家操作、**代码开局冻结**，AI 全自主，最后活着的赢；有直播观战和竞猜；还打变体规则（全沼泽世界、NPC 加强）。
**我们与 BotArena 的差异点就是 Agent 循环**：BotArena 冻结代码比拼纯 AI 水平；DSH 里 Agent 可以边打边迭代——这是卖点不是缺陷，做成规则预设让两者并存。**BotArena 的站位是「纯 AI 无人参与」先例，与我们的「纯 Agent 对战、人类只观战」一致**；其中提到的社区 bot（TooAngel 等）仅作背景参照，**不作为产品预制对手打包**（见「对局形态」：对局参与者只能是 Agent）。

### 对局形态（纯 Agent 对战，人类只观战）

**参与者只有 Agent**：每个 DSH 会话 = 一个 Screeps 用户（公平边界）；对局由 Agent 会话创建/加入/提交代码，
**没有"人类玩家"座位**。人类通过 client 观战（大厅/地图/console 流），不提供聊天发令、地图插旗等指挥通道
（与「不进对局、不指挥、不参与」定位一致；如需人参与，只以观战者身份）。

**World 模式（MMO 持久世界扩张战）**
- 准备：arena-mod `resetArena` 拿干净世界（**勿用 `resetAllData`**，见「生命周期与调试陷阱」）；N 个 Agent
  会话入局，cpu/gcl 由对局配置统一（公平）；分配 spawn 房间——**S7d 已定**：不做引擎级地图对称，World 全
  对局用同参数 generateRoom（terrainType/sources 一致）+ source→controller 距离校验兜底，Arena 1v1 镜像
  克隆是 M3 的 mod 级工作（结论见 `docs/spikes/map-fairness.md`）。开局自带 20000 tick safe mode = 铺路期。
- 运行：tick 周期 200-500ms 可配；tick 预算（预设 20000）。
- 终止：tick 用尽 / last standing（无 spawn 无 creep 即出局）/ 分数达标 / 手动。
- 记分（权重进对局配置，所有玩家可见）：`领地数×w1 + ΣRCL×w2 + 击杀分(creep/建筑)×w3 − 损失×w4
  (+能量总采集×w5，防龟缩可关)`。

**Arena 模式（1v1 单房快速歼灭战，"等 Agent 干活时看一局"的核心产品）**
- 单房 1v1：controller 锁定中立、禁 claim 禁扩张，禁 NPC。
- arena mod 预置对称兵力（镜像克隆）：对称 spawn + 对等初始能量（storage 直灌或锁 source），双侧镜像。
- 短平快：100-200ms tick × 500-2000 tick = **1-7 分钟真实时间一局**。
- 胜负：拆光对方 spawn / 击杀分到 T / 最后活着的 creep。
- 代码策略：frozen（纯 AI 对撞）或 live（Agent 热更迭代），都只是预设。

**规则预设（都是数据不是代码分支，M5 已删 world-live）**：`world-rounds`（**产品主线回合制**，周期提交）、
`world-frozen`（BotArena 式 last standing）、`arena-blitz`（单房歼灭，live 热更唯一承载）。同一引擎，不同配置。
**world-rounds（产品主线的 Agent 参与形态，M5 已实施）**：**为什么是回合制（用户拍板理由，必须记住）**——
连续世界 tick 级推进（200-500ms/tick），LLM 一次决策 turn 是分钟级（真实实测：起名/写脚本各近 1 分钟），
**连续实时世界与 LLM 决策拍难以结合**（LLM 改完代码世界已跑过去几百 tick、上下文也扛不住长局高频介入）；
故 Agent 参与对局形态 = **`world-rounds` 回合制**：每个 Agent（DSH 会话）一个席位，每周期各自提交脚本
（commit = 进入本周期准备态）；仅开局由用户/观战者触发，之后所有 Agent 就绪即自动进入下一周期（周期边界
暂停 → 战报唤醒 → 各自修改 → 全就绪 → 续跑）。LLM 的「拍」与世界「周期」刻意对齐。
**实施要点（plan-M5 §3，排期时解决的设计坑现已全部落地）**：① commit=就绪 = codeMode `rounds`（第三种
submit 语义：roundBreak 暂存 code+ready=true，running 拒；resumeNextRound 在 resume 前经 svc.submitCode
真传私服——round 2+ 生效）；② `roundBreak` 状态 + per-player `ready` 字段 + `roundIndex/roundBreakSince/
phaseTick`（phaseTick 由 start/resumeNextRound 写，autoRound 探测 gameTime-phaseTick>=roundTicks）；
③ 唤醒通道 = **host followup 为主**（M4 orchestrator L196 先例 + 真实测试 followup 自带 withInitiator；
AGENTS「再激活机制」通道 2 修订：rounds 局 host followup 为主、Agent 自调度为备）；④ 超时兜底 =
`roundBreakTimeoutMs`（默认 300s，到点未 commit 沿用上一轮代码自动 ready + error 落盘 + 续跑，不卡死）。
规则细节见 plan-M5；test bot 座位在 roundBreak 自动 ready（沿用原代码，无提交能力）。

**测试专用 bot（不是产品功能）**：`bots/`（如 `harvester`）**仅用于自动化测试/IT 验收**驱动对局走向
（固定行为、确定性），**不作为对局玩家开放**（对局玩家只能是 Agent 会话）；`addBot` 工具只对测试/内部
流程暴露，不对 Agent 玩家开放。社区 bot（TooAngel 等）仅背景参照，**不打包**。

### 三层循环与 Agent 循环设计（本插件的灵魂）

```
L2 Agent：观战报 → 分析 → 改代码/下指令 → 等下一观察点                  —— 每 250-500 tick 一拍
L1 Bot：  每tick跑玩家代码(采集/建造/ spawning/防御/作战)               —— 3-5 tick/s，全自主
```

（**无 L3 人层**：人类不指挥、不发令、不插旗；只有观战。Agent 是唯一 L2 决策者。）

**L2 的每拍**：`screeps_report(sinceTick)` → 紧凑 delta（分数变化、事件聚合、己方报错、CPU 趋势、有视野
的对手动向）→ LLM 判断 → 动作（`screeps_submit_code` 热更分支 / `screeps_console` 紧急干预 / 不动）→ 等待。

**再激活机制（关键工程问题：LLM 不能空转轮询）**，三通道：
1. `screeps_wait(ticks|seconds)` 阻塞等待工具：单段 ≤120s（3-5 t/s 下 ≈2 分钟对局时间），可链式调用、
   `exec.signal` 可取消——供全自动循环用（headless 完整对局已不做，见验证节；仍供 IT/自续跑场景）。
2. DSH schedule follow-up：**S7c 定案 = Agent 自调度 one-shot**（`docs/spikes/schedule-bridge.md`）——
   `screeps_report` 的 description 教 Agent 在 turn 末自调 `schedule_create(after_seconds=<下一观察点>,
   prompt="查看战报并继续对局循环")`；DSH 在 Agent 空闲后开普通 follow-up turn 自然唤醒。
   **插件不直接操作 schedule 持久层**（绕过协议风险高，spike 事实 4）。周期任务 every_seconds ≥300s
   太粗不适用，用链式 one-shot。
3. Agent 自续跑（goal 续跑等基建）：零人依赖兜底，Agent 自行决定继续观察或结束。

**观察分层（防作弊即防透视）**：Agent 的 report = 公开投影（map-stats 级）∪ 己方完整视图（自己房间细节/
console/memory）∪ **有游戏内视野**的对手动向。arena mod 生成 report 时按 engine 可见性过滤——通过插件
看到的不能超过通过游戏代码能看到的。对手代码/memory/console 永不可见。

**上下文经济**：report 只给 delta 和聚合（同类事件合并计数）；全量历史在 host 持久层（按 matchId），不塞进
对话。工具 description 里教 Agent 自打遥测（Memory.stats 模式——Screeps bot 的标准实践）。

**热更语义**：submit → 激活分支切换 → **下一 tick 新代码上线**；live 模式下迭代消耗的是真实对局时间（世界
不等人），这是自然成本。frozen 预设下 submit 被拒并说明。

## 工具面（host，session 映射后）

- `screeps_submit_code(modules, branch?)` — 上传/热更自己的代码；frozen 预设下拒绝并说明
- `screeps_report(sinceTick?)` — 战报 delta：分数变化、聚合事件、己方报错、CPU 趋势、有视野的对手动向（见「观察分层」）
- `screeps_wait(ticks? | seconds?)` — 阻塞等待下一观察点，单段 ≤120s，`exec.signal` 可取消
- `screeps_console(command)` — 自己用户身份执行并取回输出
- `screeps_read_memory(path?)` / `screeps_write_memory` — 自己的 memory
- `screeps_world_status()` — gameTime、房间归属、玩家列表（公开战况投影）
- `screeps_map_stats(rooms?)` / `screeps_room_terrain(room)`
- `screeps_match(action, …)` — 仅对局控制者（发起者会话）：create(preset)/join/start/pause/resume/setTickDuration/settle（无 CLI 通道，S14 修订；**addBot 仅测试/内部链路使用，不对 Agent 对战开放**；插旗需求由 Agent 代码内 `Game.flags` 自行实现，不做人类指挥工具——人类只观战）

工具 schema 用 `@deepseek-ai/dsh-tools` 的 value-schema DSL，`output.render` 输出紧凑可判定的文本（tick、事件摘要、比分变化），长原始数据一律给引用不给全量。工具 description 里写清 Memory.stats 自打遥测的惯例——Agent 写的 bot 代码自带指标，战报才有原料。

## 客户端面

- slot 接缝（已在安装的 DSH 0.1.1-rc.2 类型里核对）：`sidebar.footer.action`（list，root scope，`dsh-client-ui-sidebar` contract）放入口；整页对局工作区走 `conversation` slot 带 priority 接管（agentduel 的模式）；浮层用 `shell.overlay`。slot 名以当前版本 `contract/slots.d.ts` 为准，升级时重新核对，不凭记忆写。
- **产品边界（已拍板）**：不做完整客户端复刻。只做三件事——对局生命周期（创建/运行/结算）、观战（地图/统计/console 流）、**Agent 代码查看（尚未实现，规划项；观战看代码不违反公平边界——「对手代码永不可见」指 Agent 侧工具，观战是人类看公开视角，实现时与观察分层文案对齐）**。市场、power creep、教程、成就等官方客户端全套功能一概不做；界面为 DSH 集成而生（slot 挂载、跟随宿主主题、会话隔离），不为通用性牺牲体积。
- 渲染（决策：自绘 + 官方素材）：世界地图用 canvas 格子（terrain + controller 归属色 + badge）；房间细节用 `renderer-metadata` 的开源 sprite 素材自绘，保证官方观感；`@screeps/renderer` 引擎仅在 spike 证明体积/集成成本可接受时局部复用，默认不搬整引擎。emtee40/screeps-client 是现成的自绘参考实现。轮询一律 `Cache-Control: no-store`、in-flight guard、失败保留最后快照。
- 浏览器不直连私服（M4-A0 取证定案，`docs/spikes/m4-replay-source.md`）：回放规范源不是 raw `room:`/`roomMap2:`/官方 `/map-stats`（它们分别受每用户 diff 基线 + 200ms 节流 + USER_LIMIT=2、单房间 MAP_VIEW、tokenAuth 按需聚合限制），而是 **canonical public frame**（arena-mod 在 `roomsDone` 边界产出，schemaVersion=1，generation/seq/gap 契约）。浏览器/Agent 都只消费 host 公开桥，永远拿不到裸 token。

## 持久化

对局记录、比分、时间线归插件所有（JSON 后端，临时文件 + fsync + 原子发布），按 `matchId` 隔离；不碰 DSH 的 session 存储。回放（M4）：规范源是 **canonical public frame**（arena-mod `roomsDone` 边界，见上），host ReplayStore 按 `frames.jsonl + manifest/checkpoint` 持久化（可见水位、torn tail、generation/seq 幂等），重放即确定性投影——不宣称 raw sockjs/官方 map-stats 无损录像。HMR/恢复不假设创建事件重放：启动时扫描未结算对局并标记 interrupted。

## 里程碑

- **M0 spike（✅ 完成）**：闭环已绿——`tests/m0-match.it.test.ts`（2 用户传码 → 加速 tick → controller progress 判胜负；连跑 12 轮全绿，pgrep 零孤儿）。spike 结论索引：事件流采集点 `docs/spikes/event-stream.md`、schedule 桥 `docs/spikes/schedule-bridge.md`、地图公平性 `docs/spikes/map-fairness.md`、调试全记录 `docs/spikes/m0-findings.md` + `docs/spikes/m0-flake.md`。**已收尾**：孤儿进程泄漏（4f94fd5）与 ~50% 间歇冻结（pf 探针破案：resetArena 摧毁地形覆盖 + A* 探测未生成房间；修复 = 8 邻居墙桩 + accessibleRooms/addAccessibleRoom/resume 刷新/rejection guard/ok:false 熔断，见 m0-flake.md 第二节）。
- **M1 观战 + World 闭环（✅ 完成）**：client 面板（地图 canvas、tick、玩家榜、对局大厅）+ host 对局生命周期（create/start/settle/记分/终止判定）。**已落地**：对局领域模型/原子存储/编排层 `src/host/match/{model,store,lifecycle}.ts`（S8+S9a，假后端单测 28 条）、测试 bot 注册表 `tests/helpers/bot-registry.ts` + `tests/fixtures/bots/harvester`（2026-09-09 移出产品路径；S10 原为 `src/host/bots.ts`+`bots/`）、S9b service 接线 ArenaBackend + 真实结算 e2e（95d8299，`tests/match.it.test.ts` 全链绿）、S11 host HTTP 桥 `/dsh-screeps/*`（ea3c62c，`tests/http.it.test.ts` 真实 node:http 承载绿）、S13 工具面 8 工具 + 会话映射（0c64fca + 收尾，`tests/tools.it.test.ts` 真实私服全链绿，console 捕获经 pubsub 单参修复后闭环）。**S12 client（已落地，本里程碑）**：host+client 双产物构建（tsdown 双 entry + tsc lib/types 官方路线）、`/dsh-screeps/matches/:id/console` 增量端点（GET + 逐用户游标 + collectConsole 打表 7 测试）、`sidebar.footer.action` 对局大厅入口、`conversation.view` 常驻「Screeps」tab（地图归属色投影/统计/console 流/创建表单，投影纯函数单测）、clean 归 build 脚本 + 双 program typecheck + watch 双启。验证：102 单测绿 + headless 加载层回归零孤儿；浏览器两段验收（creating 空态 / running 真数据）待交互环境。
- **M2 Agent 循环（✅ 完成）**：report/wait 工具 + 会话映射 + 热更语义 + 公平边界负向测试 + `world-live` 全流程；A-D/E1 实现、9/9 IT 全绿、E3 headless 自动对局（100ms tick，≥200 tick，settle/winner 复盘）均已验收。遗留：interrupted 中断局恢复、frozen 完整玩法、房间可见性精确化、World 扩张成本；M3 继续 Arena blitz。
- **M3 Arena blitz（✅ 完成）**：A0 人类建赛 spawn N Agent 玩家（`src/host/agents.ts` SpawnOrchestrator：spawn 会话 → A1 create → 打标 `spawnedBy='agents'` → A2..N join → 暂存式 submit → 全就绪；HTTP `POST /spawn-agents` 202 异步编排；**join 端点已移除**，唯一入座 = 工具面 screeps_match join）、arena mod 镜像对称兵力（`arenaGen`：W15N15 + 东邻 W14N15 镜像，terrain 反转 x'=49-x + 对称 objects）、单房歼灭结算（arena 出局 = spawns==0；world = spawns==0 **且** creeps==0）、`arena-blitz`/`world-frozen` 预设（frozen 拒 submit）。**测试 bot（raider）仅作 IT/验收驱动**（不打造成预置对手——对局玩家只能是 Agent）。验证：166 单测绿 + 11/11 IT 全绿零孤儿 + A0 web lane（s12web:3200, stub provider）全链实测通过（详见 LOG 09-08 条目）。遗留：2v2 双房、击杀分到 T、interrupted 恢复、world-rounds（另排期）。
- **M4 赛事（✅ 完成）**：锦标赛 bracket、canonical replay、历史比分。**已落地**：A0 canonical replay bridge（arena-mod schemaVersion=1，roomsDone 边界 frame/gap + generation/seq + backpressure，真实私服三档实测）；B 持久层（TournamentStore requestId 幂等 + ReplayStore frame.jsonl/manifest/checkpoint 可见水位 + HistoryStore 不可变结果/leaderboard + AdmissionStore/Gate + MatchStore settling journal revision CAS + RecoveryCoordinator 级联）；唯一结算顺序（observe→beginSettlement→pause→replay marker→history put→gateway applyResult→tournament marker→commit→onSettled）；C 赛事层（TournamentService recruit/CAS + Orchestrator 单活跃 draw-rematch + roundToken 只存 sha256 + submit_code 校验）；D ReplayRecorder/HTTP（finish 全量 drain→stop→残余 append→finalize + sanitizer + /tournaments /bracket /history/leaderboard /matches/:id/replay 路由）；E client（bracket/replay-player/leaderboard 纯投影 + strict DTO guard + 赛事面板 + 额度/纯 Agent 文案，jsdom 15 测试）；F 验证（driveOnce 驱动循环 + **restart 只停服务不 die orchestrator** + 真实私服 composition IT 4 席两轮全绿 + 13/13 IT 全绿 + web lane 3200 stub → 建赛 202 → ready → start → 到 bracket 投影无 sessionId/__bot__）。**验证**：336 单测绿 + 全套 13 IT 全绿 + 双 tsc 0 错。M4 遗留：~~host 后台 spawn 子会话 turn 需宿主上下文~~ 已推翻（2026-09-09 真实实测：followup 自带 withInitiator，纯 HTTP 触发自动开子 turn）；~~browser-mcp 需用户手动 Connect~~ 已推翻（2026-09-09 用户纠正：默认即连接，MCP 调用失败才提醒排查，见环境操作纪律；浏览器验收已由 Agent 自动完成）。**后续补测**：真实 LLM 全链闭环（TEST.md §8，2026-09-09 首次通过）。

## 验证

- 私服集成测试用临时数据目录 + 随机端口（21025 被 DSH web profile 占用是现实冲突，默认端口必须可配）。
- arena mod 的路由/CLI 扩展各有契约测试；公平边界（跨用户操作必须被拒）至少一个负向测试。
- 真实组合：全新 scratch profile `dsh plugin --profile <scratch> add <本仓库>` → `--dump-config` 出现插件层 → headless 加载层任务
  `dsh --profile headless --patch <注入 dsh-screeps 的 config:dataDir 指向已 provision 的 smoke 目录、port:0、tickDuration:200> "调用 screeps_world_status 并报告 gameTime 与玩家数"` 可判定（S14 实测：gameTime/玩家数正常返回）。
  **M2 对局闭环验收（历史快照，2026-09-09 已做验收面收敛）**：当时 E3 headless 使用 `tickDuration=100`
  创建 world-live、加入 harvester bot、提交 `module.exports.loop` 代码、等待 report 达到 ≥200 tick、settle
  并报告 winner；实测 `phase=settled`、winner=`__bot__harvester`、2 玩家。**该通道已随收敛关闭（bots/ 移出
  产品路径、addBot 摘除）**——当前真实组合冒烟只到「world_status 检查」（上一行）；完整对局闭环由 IT 承担。
  **M3 A0 spawn-Agent 全链验收（2026-09-08 web lane 实测）**：`dsh --profile s12web --patch
  scripts/acceptance/a0-web-lane.yml --no-open` 于 3200 + `POST /dsh-screeps/spawn-agents
  {preset:arena-blitz,count:2,provider:stub}` → 202 recruiting → HTTP poll creating 局
  （`spawnedBy=agents` + 双玩家 `submitted:true`）→ creator start → running（`stub_pa1@W15N15` /
  `stub_pa2@W14N15` 镜像分配）→ settle → settled。**stub provider 注入途径**：e2e patch 的 insert 插件
  `scripts/e2e-stub-plugin.mjs` 注册 LlmAdapter('stub') + spawn-agents 请求体带 `provider:'stub'`。
- client 面板走 jsdom lane 测 slot 注册/清理；地图投影函数（stats→格子色）是纯函数，直接单测。

## 常用命令

```sh
npm run build          # tsdown: host index.js + client client.js（module loader banner 包装）
npm run typecheck      # host/client 双 program
npm test               # vitest 单测（不碰私服）
npm run test:it        # 集成测试（= DSH_SCREEPS_IT=1 vitest --config vitest.it.config.ts；
                       #  需已 provision 的私服，DSH_SCREEPS_SERVER_DIR 指向 server 目录）
npm run watch          # client HMR 需要 watcher 持续重写 lib/client.js
```

## 红线

- 不 fork Screeps，除非 mods 钩子确实够不到（当前清单内所有需求 mods 都够到）；fork 时保留 ISC 声明并在 NOTICE 里列出改动。
- STEAM_KEY 默认模式由 arena mod 消除（占位 env + ready stub，见「STEAM_KEY 真相」）；不要求用户申请 key，真实 key 只作为「官方客户端观战」可选项。
- 不在 client bundle 里出现任何用户 token。
- 不改 game rules 来"帮"某一方；地图/资源不对称只允许出现在对局配置里且对双方可见。
- 数据目录、端口、服务器模式全部走 Config schema，默认值写在 schema 里，不写死源码常量。
