# Spike S7c：schedule service 对插件/Agent 循环的可用性

日期：2026-09-05 · 结论：**通道 2 可行，采用 Agent 自调度 one-shot 方案**

## 事实（来源：安装版 @deepseek-ai/dsh-schedule 0.1.1-rc.2）

1. **模型可见工具**：`schedule_create`（`after_seconds` one-shot / `at` 绝对时刻 / `every_seconds` 固定频率）、`schedule_list`、`schedule_delete`。
2. **约束**：`after_seconds` 为正整数（秒，无更高下限）；`every_seconds` ≥ 300s（`MIN_EVERY_INTERVAL_SECONDS = 300`，domain.d.ts L10）。频率过高返回 `frequency_too_high`。
3. **投递语义**（README「Delivery lifecycle」）：到期 reminder 在 Agent 完全空闲后开一个**普通后续 turn**——正是 L2 循环需要的"被自然唤醒"。follow-up 不打断当前会话，输出走普通 transcript。
4. **程序化接口**：domain 层导出 `createAfterScheduleRecord` / `foldScheduleEvents` / `allocateScheduleId` 等，但**持久化必须经 session event log + flush barrier 协议**（`ctx.sessions.flush(session)` + post-append barrier）。插件直接追加 `schedule/change` 事件在技术上可行，但绕过了工具路径的队列/屏障协议，风险高、收益低。
5. **组合时序**：Schedule 只对"插件加载之后创建的 runtime root Agent"生效——已存在的会话拿不到工具。

## 决策

- **采用 Agent 自调度**：`screeps_report` 工具的 description 教 Agent 在结束 turn 前调用
  `schedule_create(after_seconds=<下一观察点秒数>, prompt="查看战报并继续对局循环")`。
  零插件侧管道、零协议风险；与 goal 续跑/headless 任务天然兼容。
- `screeps_wait(ticks|seconds)` 阻塞工具（≤120s/段）保留给全自动 headless 循环；
  交互会话用自调度，避免阻塞用户输入。
- 不做插件侧程序化调度（绕过协议，见事实 4）；若未来需要（例如对局结束主动通知所有参与会话），
  重新评估 `every` + 会话事件追加方案。
- every_seconds ≥ 5min 对观察点太粗——用链式 one-shot（每个观察点排下一个）。

## 对 AGENTS.md 的回写

「再激活机制」通道 2 定案：Agent 自调度 one-shot schedule_create；插件不直接操作 schedule 持久层。
