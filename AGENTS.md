# AGENTS.md — screeps-arena

Screeps 斗蛐蛐独立程序：**对局参与者只能是 Agent（LLM 会话）**，多个 Agent 各自提交代码，在同一世界里对抗；人类只有旁观视角（大厅/地图/console 流），不进对局、不指挥、不参与。本仓库自 `dsh-screeps`（DSH 插件）切割独立，旧仓库全部重要文档与源码存档于 `reference/`（**只读参考，不参与构建**）。

## 当前状态（2026-09-15，M6 实施完成）

- **M6 回放/战报已实施（2026-09-15）**：记录器 + 查询面 + 前端战报区/回放器全部落地——
  mod enrich（`objectInfo/targetInfo`：x/y/type/via 兜底链 live/tombstone/ruin）、
  `KillLedger.consume` 归因明细、`MatchRecorder`（append-only JSONL；混跑按房名过滤、
  (tick,objectId) 去重、软上限降频、恢复续写 + `recovered` mark）、`ReplayStore`
  （stat/mtime 失效 + LRU 4；404/partial/`eventsIncomplete`/`incompleteAfterRestart` 派生）、
  `GET /api/replays/:matchId`（`?frames=none`/`?from=&to=`）、driver `worldObserve` 相位门控、
  compose 第 6 卷 `arena-replays`。S0 探针（ring/enrich 两相位）实测钉死前提后已按计划清理。
- **M6 前浏览器全链实测绿（2026-09-14）**：真实私服 + 真实 qwen Agent 在浏览器走完整链
  （直建 arena 局 → 交码 → 自动开局 → 观战 → ticksExhausted 结算 → 历史表）两局全绿；
  实测暴露并修复三洞（1047583 + 784ce76 + 489ea9f，审查闭环复审 PASS）：① 直建局初始
  唤醒缺失 + 永停 creating（无自动开局——directStarter 补）；② console 流恒空（对象帧
  被前端过滤——formatConsoleFrame 平移）；③ 席位表恒 0（username≠agent_<slug>——
  matchView 加 screepsUsername 旁观投影）。测试基线升至 181/181。过程教训：后台服务须
  `setsid` 脱离（nohup 不挡进程组 SIGTERM，长轮询调用超时连坐杀服务）。
- **M0–M5 全部完成关闭**：M5（arena-blitz，plan-M5 v2 复审 PASS）已实施完毕——
  单房 1v1 镜像歼灭（mod arenaGen/arenaProbe 回迁：W15N15 + 东邻镜像对称生成，禁 NPC）、
  preset/form 数据模型（PRESETS 表 + configFromPreset，锦标赛 matchConfig 直传吃 arena
  预设基底）、对称 spawn 建号（host 按真实地形选互为镜像的坐标——固定坐标落墙会被
  placeSpawn 静默重掷，live IT 实证）、150ms tick × 2000 预算（ensure 链 form 感知 +
  started 显式 set + resume；prepareArena 后世界 paused 防竞态）、Agent live 热更
  （arena running 期 submitCode 放宽 + machine 登记 [N8]；world FROZEN 负向钉住）、
  结算（归因器回迁 + KillLedger + lastStanding/ticksExhausted 决策 + bound:false 溢出
  警告）、房间池冲突启动守卫、HTTP botCode 剥除负向（公平红线）、前端 form 标签。
- **M5 验证基线（全部实测）**：`npm test` **180/180 绿**（30 文件）+ typecheck/build 零错；
  `test:live` **9/9 绿**（M5 增补：镜像对称+复用探针 22.8s + 真实 blitz 短局 51.6s
  对称 draw）；m2-smoke 13 步全绿；compose 冒烟绿；**真实 LLM（qwen）验收局**：锦标赛
  通道 → 双 Agent 真写码（tool_end ×11）→ 自动开局 → ticksExhausted 结算（100:100
  完美镜像 draw）→ 届终 + 积分榜，errors=[]，teardown done。
- **M5 期间修复的关键 bug**（真实链路暴露）：① 无主 accessible 房被 backend 墙钟
  cronjob（genStrongholds/genInvaders，不受 MAIN_LOOP_PAUSED 控制）殖民——invaderCore
  + controller 归 Invader → 第二席建号撞 already owned。修复：createUser force 通道
  （host 侧 Arena 战场专用，LLM 不可达）+ arenaGen 清 invaderCore/rampart 残留 +
  prepareArena 先 pause（准备+建号窗口世界暂停，started 统一 resume）。② [N2] 固定
  对称坐标落墙被 placeSpawn 静默随机重掷破坏对称 → prepareArena 按真实地形选互为镜像
  的非墙对。③ 锦标赛 matchConfig 直传 form=arena 丢 maxTicks → 以 arena-blitz 预设
  为基底合并。④ arenaGen 复用撞 "Exits don't match"（镜像房残留）→ mod 预清镜像房
  三集合。⑤ prepareArena 与 bindUser 并发竞态（arenaRooms 同步登记 + 坐标存实例自取）。
- **M4 能力**（仍有效）：round-robin 配对轮转（circle method，奇数 bye）、逐场状态机
  scheduled→created→settled、pump 单飞、启动恢复三态、开局驱动（starter 5s 轮询 +
  有界初始唤醒 3 次/席，在途 prompt 不重发不耗配额，超界落届 errors 可查面）、积分榜
  （积分→胜场→净胜分→抽签序）、API `GET/POST /api/tournaments`（无 provider 400 拒建）。
- **M5 边界**：arena 局单飞（同世界同时一场 blitz）；固定镜像房不占房间池、不触公平
  重掷（arenaProbe 对称断言代替 distance 校验）；初始/状态唤醒零跨局信息（M4 红线沿用）；
  混跑期 world 局 tick 被同步 150ms（全局单值 tick 耦合，R7/n1 已知行为）；世界库
  需剔除 Invader（已由 resetArena 清场链覆盖）。
- **M7+**：2v2 双房、击杀分到 T 变体、房间可见性精确化、跨容器拆分评估、
  表现层统一收尾（用户决策：不并入功能里程碑）。
- **M2/M3 能力**（仍有效）：真实计分（tiebreak creeps→rooms→rclTotal）、WS console 流、
  interrupted 恢复、地图公平性重掷、seatSlug 碰撞加固、compose 容器化+数据卷、
  settle 定点拆解回收、房间池可配置、多活跃对局、对局历史。
- **M4 边界**：单世界多局共用同一世界（锦标赛形态建议多世界，跨容器拆分待评估）；
  prepare 期私服 restart 短暂中断他局（D5 显式接受；免-restart 评估结论：不可行，
  runner staticTerrainData 进程级缓存无增量刷新钩子，见 plan-M4 附录 A）；初始 prompt
  只含本局信息（无跨局积分/排名——公平红线，负向测试钉住）；Agent 工作区目录跨局保留。

- **Pi SDK spike 已通过**：`docs/spikes/pi-sdk.md`（S1–S6 全绿 + 5 条踩坑结论）。
- 旧项目结论索引：`reference/AGENTS.md`（交接全文）、`reference/docs/LOG.md`（工程日志）、
  `reference/docs/spikes/`（Screeps 集成面/生命周期陷阱/事件流/地图公平性等 6 份）、
  `reference/screeps-mod/`（arena mod，M1 已平移）、`reference/src/`（对局状态机/工具面/HTTP 桥，去 DSH 化后已平移）。

## 技术栈（已拍板）

- **运行时**：Node 22 LTS（fnm 供给，`.nvmrc`=22，engines `>=22.19 <23`）。所有 node/npm 命令走
  `fnm exec --using=22 -- …`（本环境系统 Node 是 v26，跑不了 Screeps native 模块）。
- **Agent 运行时**：`@earendil-works/pi-coding-agent`（锁 0.85.x）。每席位一个 `AgentSession`；
  工具 = `defineTool`（typebox）；周期唤醒 = 空闲后 `prompt()`（**不是** `followUp`，见 spike 结论 3）；
  自定义 provider 走 `models.json` + 显式 `getModel`（见 spike 结论 2）。
- **后端**：Fastify 5 + `@fastify/websocket` + `@fastify/static` + zod。
- **前端**：React 19 + Vite（M1 起）。
- **测试**：vitest；stub lane = mock models.json 指向进程内 mock OpenAI server（`scripts/spike-pi-sdk.ts` 装置复用）。
- **npm 注意**：本机 npm 10.9.8 对 vitest 4 有 arborist bug，装依赖用 `--legacy-peer-deps`（spike 结论 5）。

## 公平边界（红线，从旧项目延续）

**一个 Agent 席位 = 一个 Screeps 用户，映射只存在于 host 侧。**工具按席位闭包，只允许操作映射用户；
对手代码/memory/console 永不可见；Agent 的 report 是公开投影 ∪ 己方完整视图 ∪ 有游戏内视野的对手动向，
不得透视。Agent 默认**不给**内置 read/bash/edit/write 工具（Pi `tools` 白名单只留 screeps_*），
公平边界必须有负向测试。

## 产品形态（不变）

- **World（world-rounds 回合制，主线）**：周期暂停 → 战报唤醒 → 各 Agent 改码提交 → 全就绪续跑；
  唤醒 = 后端时钟 → `session.prompt()`；超时兜底 = 沿用上轮代码自动 ready。
- **Arena（arena-blitz）**：单房 1v1 快速歼灭。
- 记分/胜负/对称镜像等规则结论见 `reference/AGENTS.md`「玩法设计」节，平移时复核。

## 工作纪律（用户要求，最高优先级，全文延续旧仓库）

- 任何多步任务先列 todo；每步做完向用户汇报（做了什么/证据/下一步）；**汇报一律中文**。
- **审核循环**：计划/成果交 subagent 审查后，不存在终审——不是 PASS 就必须修改后复审，循环到通过；
  任何「PASS 前开工」都是违规。委托 subagent 一律前台阻塞等结果，不并行抢活。
- 需要用户手动测试的项（仅限 MCP 无法自动达成的）必须直接明说并同步给 `TEST.md`；
  **TEST.md 里每条命令必须先真实跑通再写进去**（附实测标注）。
- 长耗时后台任务：一次 `wait` 阻塞等结果，禁止轮询刷屏。
- **清进程严禁宽匹配 pkill**（会误杀本 Agent 宿主进程）；只许精确锚定（如 `pgrep -af` 预览后按 PID 杀）。
- 每个里程碑完成后在 `docs/LOG.md` 追加一条（倒序，含验证证据与遗留）。

## 常用命令

```sh
fnm exec --using=22 -- npm run spike:pi   # Pi SDK spike（离线 mock，应保持全绿）
fnm exec --using=22 -- npm test           # vitest 单测（默认 lane，离线零成本）
fnm exec --using=22 -- npm run typecheck  # tsc --noEmit
fnm exec --using=22 -- npm run build:client   # 前端生产构建
fnm exec --using=22 -- npm run test:live  # 真实私服 IT（独立 lane，≈6 分钟）
OPENROUTER_API_KEY=… fnm exec --using=22 -- npm run test:smoke   # 真实 LLM 冒烟（独立 lane）
fnm exec --using=22 -- npm install --legacy-peer-deps   # 装依赖
```
