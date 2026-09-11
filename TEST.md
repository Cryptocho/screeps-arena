# TEST.md — 用户手测指导（M1）

> 纪律：本文件每条命令均已由 Agent 在本环境真实执行并验证通过（2026-09-11）。
> 需要您手测的仅限浏览器交互观感（MCP 无法替代主观验收）。

## 0. 前置

- Node 22（fnm）：`fnm exec --using=22 -- node -v` → v22.x
- 依赖已装：`fnm exec --using=22 -- npm install --legacy-peer-deps`

## 1. 启动（两个终端）

**终端 1**（HTTP 桥，端口 8787）：
```sh
fnm exec --using=22 -- npx tsx scripts/dev-server.ts
# 预期输出：[dev] http://127.0.0.1:8787 (mock world; wake=disabled)
# 若已 export OPENROUTER_API_KEY，则 wake=real xiaomi/mimo-v2.5（会真实调用 LLM）
```
（已实测 2026-09-11：启动正常；`/api/matches` create→list→get→start(409 拒)→settle→
terrain→world→console 全部端点返回预期。）

**终端 2**（前端 dev，端口 5173）：
```sh
fnm exec --using=22 -- npm run dev:client
# 预期输出：VITE ready，Local: http://127.0.0.1:5173/
```

## 2. 浏览器验收项（需要您测）

打开 http://127.0.0.1:5173

| # | 操作 | 预期 |
|---|---|---|
| 1 | 打开首页 | 深色界面，标题「Screeps Arena」，默认大厅 tab |
| 2 | 大厅创建表单：默认 seat-a/seat-b/60000ms，点「创建」 | 列表出现一行：phase=creating，players `seat-a… vs seat-b…` |
| 3 | 点「start」（未提交代码） | 请求失败（409），列表不变（这是正确行为：全员提交才能 start） |
| 4 | 点「查看」进对局详情 | 状态行 `creating · round -1`，玩家表 ready/code 列为空 |
| 5 | 回大厅点「settle」 | phase 变 settled，winner 列显示 draw |
| 6 | 对局详情页 | 玩家榜表格（rooms/rcl/spawns/creeps 全 0——mock 世界无数据）、console tab 切换显示 `(no output)` |

**已知边界（M1 范围内）**：地图 canvas 在 mock 世界无房间数据时不显示（真实私服接线后
`/api/world` 返回 rooms 才渲染）；console 流是 2s 轮询增量（WS console 流 M2）。

## 3. 自动化 lane（已实测，供回归）

```sh
fnm exec --using=22 -- npm test           # 72/72 绿（12 文件，离线 mock，零成本，≈1.6s）
fnm exec --using=22 -- npm run typecheck  # 零错
fnm exec --using=22 -- npm run build:client  # vite build 零错（227KB）
fnm exec --using=22 -- npm run test:live  # 真实私服 IT（首次安装 ≈6 分钟；已实测 375s 绿）
OPENROUTER_API_KEY=… fnm exec --using=22 -- npm run test:smoke  # 真实 LLM 冒烟（已实测 418s 绿）
```

> **lane 隔离说明**：`test:live` / `test:smoke` 各用独立 vitest config
> （`vitest.live.config.ts` / `vitest.smoke.config.ts`）——主 config 把这两条 lane
> exclude 掉，所以默认 `npm test` 绝不触网、零成本；vitest CLI 的 `--exclude` 是追加语义
> 无法撤销主 config 的排除，故走独立 config 文件。
>
> **冒烟 lane 的定位**：钉「真实 LLM 的 SSE / 工具调用行为」（按 tool_end 计数断言工具调用
> 确实发生 + 有界重试）；「代码真落私服」由 `test:live` 承担。

## 4. 已知遗留

- 真实计分（world 快照→胜负）M2；当前 settle 恒 draw（M0 语义）。
- WS console 流 M2（当前轮询）；真实私服 + 前端联调的完整观战（Agent 真跑代码）在
  M1 已打通链路（test:live + test:smoke 分别验证两端），端到端一局真实对局的浏览器
  验收建议 M2 容器化后做。
- dev-server 默认是 **mock 世界**（无房间/无真实代码执行）；带 `OPENROUTER_API_KEY`
  时挂真实 AgentRunner 唤醒（`.dev-agents/` 下建席位目录）。真实私服版常驻服务在 M2 CLI。
