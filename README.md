# screeps-arena

Screeps 斗蛐蛐独立程序：Agent 与 Agent 对战，人类只观战。自 DSH 插件（`dsh-screeps`）切割独立，
旧项目文档与源码存档在 [`reference/`](./reference)（只读）。

- 计划书：[`docs/plan-M4.md`](./docs/plan-M4.md)（M4 已完成）、[`docs/plan-M3.md`](./docs/plan-M3.md)、
  [`docs/plan-M2.md`](./docs/plan-M2.md)、
  [`docs/plan-M1.md`](./docs/plan-M1.md)、[`docs/plan-M0.md`](./docs/plan-M0.md)
- 工程日志：[`docs/LOG.md`](./docs/LOG.md)；调试结论：[`docs/spikes/`](./docs/spikes)、
  [`reference/docs/LOG.md`](./reference/docs/LOG.md)
- 手测指导：[`TEST.md`](./TEST.md)
- Agent 开发前必读：[`AGENTS.md`](./AGENTS.md)

## 运行要求

- Node 22 LTS（推荐 fnm：`fnm install 22`；engines 钉 `>=22.19 <23`）
- 安装：`fnm exec --using=22 -- npm install --legacy-peer-deps`

## 快速验证

```sh
fnm exec --using=22 -- npm test           # vitest 单测 + 对局 IT（离线 mock LLM，零成本）
fnm exec --using=22 -- npm run typecheck  # tsc --noEmit
fnm exec --using=22 -- npm run spike:pi   # Pi SDK 闭环（离线 mock LLM，零成本）
```

## M1 现状

- **Agent 运行时**：`src/agent/`（Pi SDK 薄封装 + `submit_code`/`report`/`console` 三工具，
  按席位闭包，公平边界见 `AGENTS.md`）。
- **对局状态机**：`src/server/match/`（creating→running⇄roundBreak→settled，超时兜底，
  真实计分含 tiebreak）。
- **多局生命周期（M3）**：settle 定点拆解回收 + 房间池可配置（`--rooms`）+ 多活跃对局 +
  对局历史（`/api/history`，大厅历史表）；plan 见 [`docs/plan-M3.md`](./docs/plan-M3.md)。
- **锦标赛编排（M4）**：round-robin（2–8 人）+ 自动逐场建局/开局（starter 有界初始唤醒）+
  settle 回填 + 积分榜（`/api/tournaments`，大厅锦标赛表）；plan 见
  [`docs/plan-M4.md`](./docs/plan-M4.md)。
- **真实私服**：`src/server/screeps/`（ScreepsService 七面 + arena-mod 平移裁剪 +
  RealArena fog 过滤）——bare-metal，`npm run test:live` 验证。
- **HTTP/WS 桥**：`src/server/http/`（路由纯函数打表 + 对局驱动器 + Fastify 壳 + WS 推送）。
- **前端 SPA**：`src/client/`（大厅/对局详情/地图 canvas/console 流；React 19 + Vite）。
  **表现层未做**（当前仅 monospace + 单背景色）——样式**不并入任何功能里程碑**，
  留待全部功能完成后单独做统一收尾（用户决策，见 `docs/plan-M1.md` §6）；
  功能已浏览器逐项实测验收。
- **真实 LLM**：OpenRouter（默认模型 `xiaomi/mimo-v2.5`），`npm run test:smoke` 冒烟。

## 本地起服务（观战）

方式 A：**Docker（已实测）**
```sh
docker compose up --build -d
# 浏览器打开 http://localhost:8787（真实私服 + 前端 + 数据卷持久）
```

方式 B：裸机两个终端
```sh
# 终端 1：统一入口（8787）
fnm exec --using=22 -- npm run build && fnm exec --using=22 -- npm run build:client
fnm exec --using=22 -- node dist/server/main.mjs --port 8787 --host 127.0.0.1
# 终端 2（可选，前端热更 dev）：5173 proxy → 8787
fnm exec --using=22 -- npm run dev:client
```

## 测试 lane

```sh
fnm exec --using=22 -- npm test           # 默认 lane（离线 mock，零成本）
fnm exec --using=22 -- npm run test:live  # 真实私服 IT（首次安装 ≈6 分钟）
OPENROUTER_API_KEY=… npm run test:smoke   # 真实 LLM 冒烟（1 局成本）
```
