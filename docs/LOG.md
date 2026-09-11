# 工程日志（倒序）

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
