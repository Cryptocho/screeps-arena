# plan-M1 — HTTP/WS 桥 + 观战前端 + 真实私服接线 + 真实 LLM 冒烟

状态：**已完成（M1 全部落地）**；审查历史见文末（含 M1 复审修复记录）
前置：M0 完成（31/31 测试绿 + typecheck 零错；S4 IT 2 mock 席位 1 轮闭环；审查 PASS）
决策记录（用户拍板，2026-09-11）：

| 决策 | 内容 |
|---|---|
| 范围 | **M1 全做**：HTTP/WS 桥 + 前端 SPA + 真实私服接线 + 真实 LLM 冒烟，一个里程碑 |
| 前端 | 大厅 + 对局详情 + 地图 canvas——「尽量能观察到基础功能」 |
| 私服形态 | M1 bare-metal（node 22 工具链本机可编译，m0-findings 已验）；compose 双服务 M2 |
| LLM provider | OpenRouter（`OPENROUTER_API_KEY` 环境变量在位，73 字符，未读取内容）；**默认模型 = `xiaomi/mimo-v2.5`**（用户拍板，S6 冒烟与后续真实对局均用它，可配置覆盖） |

## 1. 目的

M0 交付了 Agent 运行时与对局状态机的内存闭环（mock LLM + MemoryArena）。M1 把它接到真实世界：
① 真实 Screeps 私服（arena mod 平移 + ScreepsService 裁剪版）让 Agent 代码真正跑起来；
② Fastify HTTP/WS 桥把控制面/投影暴露给人类；③ React/Vite SPA 让人类旁观（大厅/对局详情/
地图/console 流）；④ 真实 LLM（OpenRouter）冒烟验证 mock 与真实 provider 的行为差异。
M1 完成后产品形态首次完整：**Agent 对战、人类观战**。

## 2. 范围

### 在范围内

- **S1 ScreepsService 裁剪版**（`src/server/screeps/service.ts`）：managed 模式私服生命周期
  （provision→running→stopped/failed）、db.json 播种、arena-mod.cjs 装载、
  **七个最小面**：`createUser`/`submitCode`/`getWorld`/`getTerrain`/`consoleOutput`/
  `system`/`restart`——`system` 含 `setTickDuration`/`pause`/`resume`/`resetArena`
  （对局重置必须走 `resetArena`，**勿用 `resetAllData`**，会毁 v5 格式对象，m0-findings §2）；
  `ok:false` 一律抛错（m0-flake 熔断纪律）。对照 `reference/src/host/service.ts` 裁剪，
  去 cordis/DSH 化，纯类 + 显式依赖注入。
  生命周期坑全部平移：users.code 带 timestamp（VM 冻结坑）、房间生成后 restart（地形缓冲）、
  ensure 链内禁 ensureRunning（自死锁坑）、进程组 exit guard + 停服 await（孤儿进程坑）。
  **provisioning 前置检查单**（bare-metal 硬前置，m0-findings §1 + map-fairness §4）：
  ① screeps npm 安装（`--allow-git` + `install-scripts approve` 五包：screeps/@screeps/driver/
  isolated-vm/uglifyjs-webpack-plugin/es5-ext，≈8 分钟 + native 编译）；
  ② `assets/map/zoom{2,4,8}` 目录补建（缺目录 → generateRoom 写预览 png 时 backend 直接崩溃）；
  ③ db.json 播种（lokijs `loadJSON(db.original)`，空库 storage 启动即崩）；
  ④ mods.json 双进程 guard（仅 backend/cli 进程注册 mod 路由）。
- **S2 arena-mod 平移**（`src/server/screeps/arena-mod.cjs`）：`reference/screeps-mod/arena-mod.cjs`
  平移 + 裁剪（保留 createUser/submitCode/world 快照/terrain/system 控制面 + console 采集；
  删锦标赛/回放/DSH 专属面）。
  **保留项清单（不属裁剪范围，m0-flake §二防 flake 修复链全集）**：`addWalledNeighbors`
  8 邻墙桩、`generateRoom` 前置 `removeWhere` 清桩行、`resume` 强制刷新
  accessibleRooms/roomStatusData、`process.on('unhandledRejection')` 守卫、
  `addAccessibleRoom` 落地。删掉任何一条都会重现 ~50% 间歇冻结（pf A* 探进未生成房间抛错）。
  mod 端点打表单测逐条断言：generateRoom 后 8 邻有墙桩、同房恰好一行地形、resume 刷新、
  ok:false 熔断。
  **roomsDone 订阅时序**（m0-findings §5）：mods 加载早于 `storage._connect()`，mod 内订阅
  必须轮询 `_connected` 后再挂，否则静默失效——打表单测加「订阅在 storage 连接后生效」断言。
  事件流采集（S7b：roomsDone → roomEventLog 环形缓冲）M1 只做**最小版**：
  `/api/arena/events?sinceTick=` 端点 + 环形缓冲，供战报与观战 tick 推进。
  **已知边界**（event-stream.md）：hash 只反映最近处理房间，未处理房间重复上报旧事件——
  host 按 objectId+event+tick 窗口去重；tick 戳以 `roomsDone` 的 gameTime 为准。
- **S3 真实 ArenaBackend**（`src/server/screeps/arena.ts`）：实现 M0 的 `SeatRegistry` +
  `ArenaBackend` 接口——`bindUser`（createUser + spawn 部署）、`submitCode`（真传私服）、
  `runConsole`（consoleOutput 游标）、`report`（world 快照 + 事件流按 fog-of-war 过滤——
  己方完整视图 ∪ 有视野房间，不透视，AGENTS.md 红线）。
  **视野判定函数**（负向测试的断言锚点）：`visibleRooms(user) = 己方 owned rooms ∪
  己方 creep/建筑所在房间`（Screeps 官方视野规则）；report 事件流仅保留
  `visibleRooms(user)` 内的事件，其余一律剥离。
- **S4 HTTP/WS 桥 + 对局驱动器**（`src/server/http/`）：Fastify 5 + `@fastify/websocket` +
  `@fastify/static`。路由核心 = 纯函数打表（对照旧 http.ts 设计）：对局 CRUD
  （create/list/get/start/settle）、世界快照/terrain、逐用户 console 增量（游标）、
  WS 通道（对局状态变更 + tick 推进 + console 流推送）。公平边界：桥只暴露控制面与公开投影，
  无「以任意用户身份执行」通道；监听 `127.0.0.1`（M1 无鉴权，不对外暴露）。
  **对局驱动器**（`src/server/http/driver.ts`，M0 遗留接线的落点）：常驻 interval →
  `machine.advance(真实时钟)`（running 周期到点 / roundBreak 超时兜底）；MatchEvent →
  席位 `AgentRunner.prompt()` 唤醒接线（`round_break` → 战报唤醒、`started`/`round_resume`
  → 开跑通知）。真实时钟下的超时兜底触发路径加 IT 断言（防接线引入语义漂移）。
- **S5 前端 SPA**（`src/client/`）：React 19 + Vite。三视图：
  ① **大厅**——对局列表（phase/round/玩家/胜负）+ 创建表单（preset/roundMs/maxRounds）；
  ② **对局详情**——状态时间线、玩家榜（world 快照投影：rooms/RCL/spawns/creeps）、
  console 流（逐用户 tab，WS 增量）；
  ③ **地图 canvas**——terrain 位域渲染 + 归属色投影（对照旧 client/match 投影纯函数平移）。
  状态管理最小化（fetch + WS 订阅，不引状态库）。
- **S6 真实 LLM 冒烟**：S4 IT 换 OpenRouter baseUrl + 默认模型 `xiaomi/mimo-v2.5` 跑一次真链路（1 局 2 席位 1 轮），
  验证 mock 与真实 provider 的 SSE/工具调用行为差异；差异记入 LOG。
  **定位（M1 复审施工决定）**：本 lane 是「真实 provider 行为探针」——钉 SSE / 工具调用行为；
  「代码真落私服」由 `test:live` 承担（不重复跑 6 分钟私服安装）。
- **S7 收尾**：LOG 条目、README、TEST.md（浏览器观战验收项——需用户手测的唯一部分，
  命令逐条实测后写入）。

### 不在范围内（后续里程碑）

- compose 双服务容器化（M2）、锦标赛/回放/历史（M3+）、arena-blitz 镜像克隆（M3）、
  interrupted 恢复、地图公平性校验重掷（World 同参数生成 M1 先落，距离校验重掷 M2）。

## 3. 步骤与依赖

| 步 | 内容 | 依赖 | 验证 |
|---|---|---|---|
| S1 | ScreepsService 裁剪版 | — | 单测（fake server 进程面）+ 真实启动 IT（播种→ready→setTickDuration） |
| S2 | arena-mod 平移 | S1 | mod 端点打表单测 + 真实私服 createUser/submitCode IT |
| S3 | 真实 ArenaBackend | S1 S2 | 真实私服 IT：bind→submit→console→report（fog 过滤断言） |
| S4 | HTTP/WS 桥 | S3 | 路由纯函数打表单测 + supertest 级 IT + WS 集成 IT |
| S5 | 前端 SPA | S4 | 组件单测（vitest+testing-library）+ build 零错 + 对局详情/地图投影纯函数单测 |
| S6 | 真实 LLM 冒烟 | S3 S4 | OpenRouter 真链路 IT（1 局 2 席位 1 轮，成本上限 1 局；provider 行为探针，真落私服由 S3 live lane 承担） |
| S7 | 收尾 | 全部 | 全量测试绿 + typecheck 零错 + LOG/README/TEST.md |

串行推进（每步做完汇报）；S1/S2 是关键路径（私服起不来后面全堵）。

## 4. 验证

- **单测**：ScreepsService 生命周期状态机（fake 进程面）、mod 端点打表、HTTP 路由打表、
  前端投影纯函数、fog-of-war 过滤（负向：无视野房间的事件不得出现在 report）。
- **真实私服 IT**（bare-metal，`fnm exec --using=22 --`）：播种→启动→createUser→submitCode→
  getWorld 断言用户/房间出现→consoleOutput 游标。标记为独立 lane（`npm run test:live`），
  默认 `npm test` 不跑（避免 CI/离线环境挂）。
- **HTTP IT**：真实 Fastify listen（127.0.0.1 随机端口）+ fetch/WS 客户端断言。
- **真实 LLM 冒烟 IT**：OpenRouter 真链路，断言 `submit_code` **工具调用确实发生**（按 `tool_end`
  事件计数 + 有界重试）× 状态机闭环。**「代码真落私服」由上面的真实私服 IT（`test:live`）承担**，
  本 lane 只做 provider 行为探针，不重复私服安装成本。独立 lane（`test:smoke`），需 `OPENROUTER_API_KEY`。
- **公平边界**：桥端点无身份通道（负向打表）；report fog 过滤负向测试。
- 全部命令真实跑通后记入 `docs/LOG.md`。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 私服 native 编译/启动失败（isolated-vm ABI 等） | m0-findings 已验 node 22 可编译；失败先对照 m0-flake.md 排坑；S1 单独 IT 钉住启动面 |
| arena-mod 平移引入行为漂移 | mod 端点打表单测逐条对照 reference 版行为；裁剪项在 LOG 记录取舍 |
| mock 与真实 provider 行为差异（SSE/工具调用格式） | S6 冒烟专门验证；差异记 LOG；必要时在 runner 层适配（唯一 Pi 触面） |
| WS 推送与状态机事件时序 | 桥订阅 MatchEvent 单一来源；IT 断言事件序（复用 S4 口径） |
| 前端与桥契约漂移 | 投影/DTO 类型放 `src/shared/`，前后端同源引用；契约单测钉住 |
| 真实 LLM 成本失控 | 冒烟限 1 局 2 席位 1 轮；mock lane 保持默认（零成本） |
| 孤儿进程/VM 冻结（旧仓库血泪坑） | 生命周期坑逐条平移（见 S1 清单）+ 停服序列 IT + `pgrep -af` 精确锚定清理 |
| 真实私服 IT 互踩（共享目录/进程泄漏） | per-test `mkdtemp` 独立 serverDir + 结束清理进程与目录（m0-flake §四.2/3）；pgrep 模式 `[x]` 方括号化 |

## 6. 遗留（后续里程碑）

- M2：compose 双服务（app + screeps，node:22 镜像）、数据卷、地图公平性距离校验重掷、
  interrupted 恢复、席位目录名碰撞加固（M0 审查建议 1）、**真实计分**（world 快照 →
  胜负判定；M1 的 settle 仍是 manual/roundsExhausted → draw，M0 语义）。
- M3+：锦标赛/回放/历史、arena-blitz 镜像克隆、房间可见性精确化。

## 7. 审查历史

- 一审（subagent，2026-09-11）：**FAIL**，3 项：① S1 面清单漏 `system`/`restart` 且
  provisioning 前置清单不完整（setTickDuration/resetArena 走 system 面；`--allow-git`/
  install-scripts approve/zoom 目录/db 播种/mods guard 未列）→ 已补七面清单 + 前置检查单；
  ② S4 缺「对局驱动器」（MatchMachine 时钟与 AgentRunner 唤醒接线无人认领，S6 冒烟无法发生）
  → 已增 `src/server/http/driver.ts` + 真实时钟超时兜底 IT；③ S2 裁剪缺「保留项」清单
  （m0-flake 防 flake 修复链不得被当 DSH 专属裁掉，否则重现 ~50% 间歇冻结）→ 已列保留项
  全集 + 打表断言。非阻塞建议已采纳：事件流去重边界、roomsDone 订阅时序断言、IT 装置纪律
  （mkdtemp/方括号 pgrep）、settle 真实计分归 M2、桥绑 127.0.0.1、fog 视野判定函数锚点。
- 二审（subagent，2026-09-11）：**PASS**。三项修复逐条核实到位（七面清单与 service.ts
  公开面逐一对应；驱动器落点与唤醒语义吻合；保留项五条与 m0-flake §二无缺漏）；
  未引入新问题，达到可开工标准。非阻塞建议 3 条（实现期处理，不改计划书）：
  驱动器 interval 粒度与 advance 幂等语义写进 driver.ts 单测口径；S6 冒烟失败退路
  （限流/格式差异 → 记 LOG 不阻塞 S7）；S2 打表加「addWalledNeighbors 早于
  updateTerrainData」顺序断言（arena-mod.cjs L1329-1337 B4 结论）。
- 状态：**PASS，等待用户确认开工**。

### M1 实施后复审（subagent，2026-09-11）

- 第一轮：**FAIL**，7 项（默认 lane 扫到真实 LLM 冒烟致红 / 冒烟断言无回归性 / 驱动器未接线 /
  report 未消费事件流 / `visibleRooms` 死代码 / 冒烟定位与 §4 矛盾 / 文档漂移）。已全修
  （见 `docs/LOG.md`「M1 复审修复」条目与 commit `836e596`）。
- 第二轮：功能项 1–5 独立核实修实；第 6/7 项文档一致性问题残留于本计划书自身
  （§2 S6、§4 冒烟判据仍写「真落私服」；S5 仍写 React 18）→ 已在本文件订正
  （S6 定位澄清 + §4 判据改「工具调用确实发生」+ React 19 + 状态线更新）。
- 状态：**M1 完成**。
