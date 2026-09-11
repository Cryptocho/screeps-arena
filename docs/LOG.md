# 工程日志（倒序）

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
