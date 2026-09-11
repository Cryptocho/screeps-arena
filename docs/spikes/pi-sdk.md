# Pi SDK Spike（M0/S0）

日期：2026-09-11 ｜ 执行：Agent（Zed/GLM）｜ 复现：`fnm exec --using=22 -- npm run spike:pi`

## 目的

验证「独立后用 Pi SDK 替代 DSH 会话作为 Agent 运行时」的关键机制，产出对接设计结论。
全程离线（mock OpenAI SSE server），零 LLM 成本，可重复。

## 装置

- `scripts/spike-pi-sdk.ts`：单文件 spike
- mock OpenAI `/v1/chat/completions`（SSE）：第 1 次回 `tool_calls(submit_code)`，第 2 次起回纯文本
- `agentDir/models.json` 注册 `mock` provider（`api: "openai-completions"`，literal apiKey）
- `SessionManager.inMemory` + `SettingsManager.inMemory` + 隔离 cwd/agentDir

## 结论：S1–S6 全部通过（硬断言）

| # | 目标 | 断言方式 | 结果 |
|---|---|---|---|
| S1 | pi-coding-agent 0.85.1 于 Node 22 (fnm v22.23.2) 可装可跑 | 进程正常跑完 + 版本打印 | ✅ |
| S2 | models.json + openai-completions + SSE mock provider | `getModel` 与 `session.model` 非空断言（身份 = mock/mock-1 打印供核对） | ✅ |
| S3 | `tools` 白名单只留自定义工具（无内置 read/bash） | 整表相等断言：`state.tools` === `[submit_code]` | ✅ |
| S4 | prompt → tool_calls → 工具执行 → 结果回传 → 收尾 | submitted 断言 =1 且 LLM 调用数断言 =2 | ✅ |
| S5 | 空闲后重复 `prompt()` 驱动多轮（周期唤醒） | LLM 调用数断言 =3、`agent_end` ≥2 | ✅ |
| S6 | 事件流可见 `tool_execution_start` / `agent_end` | events 数组断言含 `tool:submit_code` 且 agent_end ≥2 | ✅ |

round 1 = 2 次 LLM 调用（tool turn + 收尾）；round 2 prompt 后 callCount=3，`agent_end` ×2。

## 踩坑（文档未写，实测结论）

1. **`agentDir` 必传**：SDK 文档称有默认值（expand `~`），实际 `DefaultResourceLoader` 构造里
   `resolvePath(undefined)` 直接崩（`resource-loader.js` L157）。cwd/agentDir 一并显式传。
2. **extension `registerProvider` 的模型不进入 `createAgentSession` 的 model 解析/auth 链**：
   不传 `model` 时 fallback 落到 `unknown/unknown`，prompt 报 "No API key found"。
   正路 = `agentDir/models.json` + `ModelRuntime.create({ modelsPath, authPath })` +
   `modelRuntime.getModel(provider, id)` + 显式传 `model`。
3. **`followUp()` 对已空闲 agent 是 no-op**：它只在 streaming 期间入队、由 agent 停止后的
   消费周期投递。对 world-rounds 的启示：周期唤醒由后端时钟直接再 `prompt()`（比 DSH 的
   followup turn 桥更简单）；`steer()/followUp()` 保留给「工具执行中插消息」（如超时兜底注入）。
4. **1 个工具 turn = 2 次 LLM 请求**：LLM 回 tool_calls 是第 1 次，工具结果回传后的收尾
   文本是第 2 次。计费/统计/限速口径必须按此计算。
5. **npm 10.9.8 arborist 崩溃**：vitest 4 的 peer 解析在 `loadPeerSet` 报
   `Cannot read properties of null (reading 'edgesOut')`。`--legacy-peer-deps` 绕过。
   （后续可考虑升级 npm 或换 pnpm。）

## 对接设计影响（喂给 plan-M0）

- 每席位一个 `AgentSession`；cwd/agentDir 按席位隔离（工作区 + `models.json` 模板 + auth）。
- 工具面 = `defineTool` 工厂按席位闭包（agentId → Screeps 用户映射），公平边界在工具内收口。
- 周期唤醒 = 后端时钟 → `session.prompt()`；测试/验收 = mock models.json 指向进程内 mock server
  （本 spike 装置直接复用为 stub lane）。
- Pi 侧还有 compaction/重试/成本核算免费拿，report 只给 delta 的上下文经济策略不变。
