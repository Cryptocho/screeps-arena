# TEST.md — 用户手测指导（M1 + M2 + M3 + M4）

> 纪律：本文件每条命令均已由 Agent 在本环境真实执行并验证通过（最近：2026-09-13 M4）。
> 需要您手测的仅限浏览器交互观感；未实测项均如实标注。

## 0. 前置

- Node 22（fnm）：`fnm exec --using=22 -- node -v` → v22.x
- 依赖已装：`fnm exec --using=22 -- npm install --legacy-peer-deps`

## 0.5 M2 真实组装（单进程全链，已实测 2026-09-11）

M2 起真实私服 + HTTP/WS 桥 + 静态前端由统一入口提供（不再散在 IT 里）：

```sh
fnm exec --using=22 -- npm run build && fnm exec --using=22 -- npm run build:client
fnm exec --using=22 -- node dist/server/main.mjs --port 8787 --host 127.0.0.1
# 预期：[main] http://127.0.0.1:8787 data=<cwd>/.arena-data (real world; wake=…; journal-restored=0)
# 首次启动含私服安装（≈6 分钟）；浏览器打开 http://127.0.0.1:8787 即观战前端
```
（已实测：等价冒烟 `sh scripts/m2-smoke.sh` 9/9 PASS——起服/world/建局/settle/
journal 无残留/中断局重启恢复 journal-restored=1/相位还原。中断恢复复现法：
对局进行中 kill 进程 → 重启 → 日志 journal-restored=1。）

## 0.6 M2 compose 容器化（**已实测 2026-09-12**）

```sh
docker compose up --build -d   # 构建含私服安装，首次 ≈5 分钟
# 预期：http://localhost:8787 可用；docker compose down && docker compose up 后世界库仍在（卷持久）
```

实测记录（2026-09-12，Docker 29.7.2 + Compose v5.4.0）：
- 构建→起服→真实私服 ready（`[main] screeps server ready`）→ `/api/matches`/`/api/world` 正常；
  容器内 create→settle 真实计分（manual settle → scores 注入）通过。
- **持久性实测**：`docker compose down`（保卷）再 `up` —— 启动日志 0 次 reseed/reinstall，
  卷内 db.json 存在且被 storage 正常改写，世界读回正常；settled 对局 journal 无残留
  （journal-restored=0，与 m2-smoke 一致）。
- 实测中修了 2 个只有真 Docker 才能暴露的 bug：① Dockerfile 漏装 `git`
  （checkToolchain 四件套要求）→ `--install-only` 阶段 toolchain-missing 构建失败；
  ② compose 卷挂错路径——世界库实为 `server/db.json` 文件，原挂 `server/db/` 子目录
  从未被写 → 改挂整个 `server/` 目录（named volume 首挂自动从镜像拷入）。

## 0.7 M3 多局生命周期（已实测 2026-09-13）

M3 起：settle 后自动定点拆解（删席位用户 + 房间，幂等，崩溃重启补拆解）→ 房间池全量可复用；
**多活跃对局**（可用池 = `--rooms` 池 − 在占房间）；对局历史 `GET /api/history`（大厅「历史对局」表）。

```sh
docker compose up --build -d   # 或裸机 node dist/server/main.mjs
# 换席位再建局（M2 时会拒绝）→ 应成功：
curl -s -X POST http://localhost:8787/api/matches -H 'content-type: application/json' \
  -d '{"players":[{"seatId":"x1","username":"x1"},{"seatId":"x2","username":"x2"}]}'
# 池耗尽（默认 2 房，建第三局 2 席位）→ 应 400 room pool exhausted；扩池：--rooms "E5N5,E7N5,E9N5,E5N7"
curl -s http://localhost:8787/api/history   # settle 后出现记录，teardown: pending→done
curl -s http://localhost:8787/api/teardown-failures   # 应为空
```

实测记录（2026-09-13）：S0 探针（removeUser/removeRoom/重建闭环，`scripts/s0-removal-probe.ts`
exit=0）；test:live 4/4（M3 增补：拆解闭环+相邻房活跃房不受损+崩溃恢复真实残留补拆解）；
m2-smoke 13 步全绿（含 history+teardown done / 换席位再建局 / teardown-recovered=1）；
compose 全链（create→settle→history done→换席位再建局）。**注意边界**：建局 prepareRooms 完成
时私服 restart 一次，会短暂中断他局 run/console（现有游标/重试吸收，plan-M3 D5 显式接受）。

## 0.8 M4 锦标赛编排（已实测 2026-09-13）

M4 起：round-robin 锦标赛（2–8 人，配对轮转）→ 自动逐场建局/开局 → settle 回填 →
积分榜（积分→胜场→净胜分→抽签序）。API：

```sh
# 建锦标赛（需 provider：有 OPENROUTER_API_KEY 才接受，否则 400）
curl -s -X POST http://localhost:8787/api/tournaments -H 'content-type: application/json' \
  -d '{"name":"duel","participants":[{"seatId":"a","username":"a"},{"seatId":"b","username":"b"}]}'
curl -s http://localhost:8787/api/tournaments            # 列表 + 积分榜
curl -s http://localhost:8787/api/tournaments/<id>       # 详情：matches 逐场 status/matchId/result
```

**Agent 实测记录（2026-09-13，mock provider 全链）**：本环境无真实 LLM key，用
`scripts/mock-llm.ts`（OpenAI 兼容 mock，首轮回 submit_code）驱动了完整链路：

```sh
fnm exec --using=22 -- npx tsx scripts/mock-llm.ts &        # 宿主 mock LLM（:8901）
OPENROUTER_API_KEY=mock SMOKE_BASE_URL=http://host.docker.internal:8901/v1 \
  ARENA_MODEL=mock-1 docker compose up --build -d
# → POST /api/tournaments → 首场自动 created（真实房间生成+建号）
# → 双席位收到初始 prompt → mock 提交代码 → starter 自动开局（phase=running，errors=[]）
# → POST /api/matches/<mid>/settle → 锦标赛 status=settled、finishedAt 落、standings 出
# → docker compose down（保卷）再 up：锦标赛状态/history 均在（tournaments 卷持久化）
```

本次实测顺带修了 3 个只有全链才暴露的 bug：① Agent `submit_code` 只上传私服未登记进
对局机器 → starter 开局门槛永不可达（`seatBackendFor` 补登记）；② 席位 waker 并发重入
重复建号（单飞收口）；③ compose 持久卷缺 history/tournaments/agents（重建即丢）。
**带真实 LLM 的锦标赛全程（双 Agent 真写代码分出胜负）需要您的 key**，命令同上——
把 mock 环境变量换成您的 `OPENROUTER_API_KEY`、去掉 `SMOKE_BASE_URL`/`ARENA_MODEL` 即可（此条未实测，待您手测）。

## 1. 启动（两个终端，dev mock 模式）

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

## 2. 浏览器验收项（已由 Agent 用浏览器工具实测完成，2026-09-11）

打开 http://127.0.0.1:5173 —— 下表 6 项已逐项实点实截验证，**您只需按需复查观感**：

| # | 操作 | 实测结果 |
|---|---|---|
| 1 | 打开首页 | ✅ 深色界面，标题「Screeps Arena」，大厅 tab |
| 2 | 创建（seat-a/seat-b/60000ms） | ✅ 列表出现行：creating / round=-1 / `seat-a… vs seat-b…` |
| 3 | 点 start（未提交代码） | ✅ 红色提示 `start failed: HTTP 409`，phase 不变 |
| 4 | 点查看进详情 | ✅ 状态行 `creating · round -1`，玩家表 ready/code 为空 |
| 5 | 回大厅点 settle | ✅ phase→settled，winner→draw，操作列只剩「查看」 |
| 6 | 详情页 console tab | ✅ 切换 seat-a/seat-b，显示 `(no output)` |

**实测中发现并已修复的 2 个 dev 运行时 bug**（`build:client` 覆盖不到，只有浏览器能暴露）：
1. **白屏**：`vite.config.ts` 的 proxy `'/api'` 是前缀匹配，把客户端源模块 `/api.ts`
   也劫持给 8787 后端 → 404 → 模块加载失败 → 整页白屏。改为正则 `^/api/`、`^/ws/`。
2. **静默失败**：大厅 start/settle 的 `await` 无 catch，失败时无任何提示（unhandled rejection）。
   已加错误显示（实测点 start 显示 `start failed: HTTP 409`）。

**已知边界（M2 更新）**：地图 canvas 在 mock 世界无房间数据时不显示；console 流已改
WS 订阅增量（M2，2s 轮询已删）；**样式仍未做**（全部功能完成后单独统一收尾）。
另外：真实私服组装下，观战 console 订阅按席位（seatId）解析真实用户名（agent_<slug>），
若席位尚未建号则显示 (no output)（bound:false 静默）。

## 3. 自动化 lane（已实测，供回归）

```sh
fnm exec --using=22 -- npm test           # 157/157 绿（27 文件，离线 mock，零成本；M4 含 bracket/store/scheduler/flow/fairness）
fnm exec --using=22 -- npm run typecheck  # 零错
fnm exec --using=22 -- npm run build && fnm exec --using=22 -- npm run build:client  # 服务端 main.mjs + vite 前端零错
fnm exec --using=22 -- npm run test:live  # 真实私服 IT（首次安装 ≈6 分钟；M4 后 7/7 绿，含 restart 竞态回归+锦标赛链+kill-9 恢复）
OPENROUTER_API_KEY=… fnm exec --using=22 -- npm run test:smoke  # 真实 LLM 冒烟（已实测 418s 绿）
sh scripts/m2-smoke.sh                     # main.mjs 全链冒烟（M3 后 13 步，含 teardown/换席位再建局/恢复）
fnm exec --using=22 -- npx tsx scripts/s0-removal-probe.ts   # M3 拆解原语真实私服探针（幂等可重跑）
fnm exec --using=22 -- npx tsx scripts/mock-llm.ts           # M4 mock LLM（compose 锦标赛链驱动，见 §0.8）
```

> **lane 隔离说明**：`test:live` / `test:smoke` 各用独立 vitest config
> （`vitest.live.config.ts` / `vitest.smoke.config.ts`）——主 config 把这两条 lane
> exclude 掉，所以默认 `npm test` 绝不触网、零成本；vitest CLI 的 `--exclude` 是追加语义
> 无法撤销主 config 的排除，故走独立 config 文件。
>
> **冒烟 lane 的定位**：钉「真实 LLM 的 SSE / 工具调用行为」（按 tool_end 计数断言工具调用
> 确实发生 + 有界重试）；「代码真落私服」由 `test:live` 承担。

## 4. 已知遗留

- ~~compose 容器化未实测~~ → **已实测通过（2026-09-12，见 §0.6）**，M2 遗留清零。
- M3 已落地多局生命周期（见 §0.7）；遗留：prepare 期 restart 短暂中断他局（D5 显式接受，
  M4 评估免 restart 刷新）；锦标赛/回放/arena-blitz 归 M4+；样式统一收尾仍待全部功能后。
- 真实计分 / WS console 流 / interrupted 恢复 / 地图公平性重掷已在 M2 落地（test:live +
  m2-smoke 实测）；端到端一局真实对局（双 Agent 真跑代码分出胜负）的浏览器完整验收，
  建议 M3 首个周期做一次实拍。
- dev-server 默认是 **mock 世界**（无房间/无真实代码执行）；带 `OPENROUTER_API_KEY`
  时挂真实 AgentRunner 唤醒（`.dev-agents/` 下建席位目录）。真实私服版常驻服务在 M2 CLI。
