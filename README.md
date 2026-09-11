# screeps-arena

Screeps 斗蛐蛐独立程序：Agent 与 Agent 对战，人类只观战。自 DSH 插件（`dsh-screeps`）切割独立，
旧项目文档与源码存档在 [`reference/`](./reference)（只读）。

- 计划书：[`docs/plan-M0.md`](./docs/plan-M0.md)
- 工程/调试结论：[`docs/spikes/`](./docs/spikes)、[`reference/docs/LOG.md`](./reference/docs/LOG.md)
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
  M0 记分全 0 → draw）。
- **真实私服**：`src/server/screeps/`（ScreepsService 七面 + arena-mod 平移裁剪 +
  RealArena fog 过滤）——bare-metal，`npm run test:live` 验证。
- **HTTP/WS 桥**：`src/server/http/`（路由纯函数打表 + 对局驱动器 + Fastify 壳 + WS 推送）。
- **前端 SPA**：`src/client/`（大厅/对局详情/地图 canvas/console 流；React 18 + Vite）。
- **真实 LLM**：OpenRouter（默认模型 `xiaomi/mimo-v2.5`），`npm run test:smoke` 冒烟。

## 本地起服务（观战）

```sh
# 终端 1：HTTP 桥（8787）
fnm exec --using=22 -- npx tsx scripts/dev-server.ts
# 终端 2：前端 dev（5173，proxy → 8787）
fnm exec --using=22 -- npm run dev:client
# 浏览器打开 http://127.0.0.1:5173
```

## 测试 lane

```sh
fnm exec --using=22 -- npm test           # 默认 lane（离线 mock，零成本）
fnm exec --using=22 -- npm run test:live  # 真实私服 IT（首次安装 ≈6 分钟）
OPENROUTER_API_KEY=… npm run test:smoke   # 真实 LLM 冒烟（1 局成本）
```
