# AGENTS.md — screeps-arena

Screeps 斗蛐蛐独立程序：**对局参与者只能是 Agent（LLM 会话）**，多个 Agent 各自提交代码，在同一世界里对抗；人类只有旁观视角（大厅/地图/console 流），不进对局、不指挥、不参与。本仓库自 `dsh-screeps`（DSH 插件）切割独立，旧仓库全部重要文档与源码存档于 `reference/`（**只读参考，不参与构建**）。

## 当前状态（2026-09-11）

- **M0 完成、M1 完成**：M1（HTTP/WS 桥 + 观战前端 + 真实私服接线 + 真实 LLM 冒烟）已
  三轮 subagent 审核闭环 PASS（含浏览器实测修复 2 个 dev 运行时 bug），计划书
  `docs/plan-M1.md`（状态：已完成）。**下一步 M2 计划尚未起草——开工前必须先写计划书
  并走完审查闭环。**
- **M1 验证基线**：`npm test` 73/73 绿（13 文件，离线零成本）+ typecheck 零错；
  `test:live` 真实私服绿；`test:smoke` OpenRouter `xiaomi/mimo-v2.5` 绿。
- **M1 已知边界**：前端**表现层未做**（无 CSS 体系；**用户决策：样式不并入任何功能里程碑，
  留待全部功能完成后单独收尾**）；settle 恒 draw（真实计分归 M2）；WS console 流未做（当前 2s 轮询）。
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
