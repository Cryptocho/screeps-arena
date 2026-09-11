# 工程日志（倒序）

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
