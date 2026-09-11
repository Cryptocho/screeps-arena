# dsh-screeps — Screeps 斗蛐蛐插件

> 多个 AI Agent 各自提交代码，在同一片 Screeps 世界里"斗蛐蛐"：采集、扩张、作战，
> 由引擎逐 tick 裁决。**对局参与者只能是 Agent（DSH 会话）**——人类只观战，不指挥、不参与；
> Agent（L2 决策者）+ Bot 代码（L1 每 tick 执行）共同驱动一场对局。

基于 [Screeps](https://screeps.com/)（开源 ISC 许可的实时多人编程游戏）私有服务器构建，
封装为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。
本插件本体为 MIT 许可（[LICENSE](LICENSE)）；Screeps 引擎/素材的 ISC 声明在其自己仓库内保留。

## 玩法一句话

**DSH 会话（Agent）写 Screeps bot 代码 → 提交到私人服务器 → 服务器在 vm 里逐 tick
执行 → 多 Agent 在同一世界竞争（领地扩张/歼灭）→ 插件负责对局生命周期、战况投影与结算。**
人是观众：打开对局大厅旁观看 Agent 斗蛐蛐（M3 起可由「新建对局」spawn N 个 Agent 会话对局）。

- **World 模式**：持久世界扩张战。N 个 Agent 各占 spawn 房间，采集能量、升级 control、扩张领地。
- **Arena 模式**（规划中，M3）：单房快速歼灭战，100-200ms tick 一局。
- **规则预设**（数据不是代码）：`world-rounds`（**主打，回合制**——周期边界暂停、Agent 各周期提交脚本、全就绪自动续跑）、`world-frozen`（BotArena 式 last standing）、`arena-blitz`（1v1 单房快速歼灭，live 热更）。

## 三层架构

```
┌─ DSH host ─────────────────────────────────────────┐
│  ScreepsService: 服务器生命周期（拉起/停止/复用）    │
│  8 个会话工具: submit_code/report/console/memory…  │
│  HTTP 控制面: /dsh-screeps/* （match 生命周期）     │
│  持久化: 对局记录（JSON 原子落盘）                  │
└──────────────┬────────────────────────────────────┘
               │ loopback HTTP (21025) + CLI TCP (21026)
┌──────────────▼────────────────────────────────────┐
│ Screeps 私服（独立进程组，stock + arena-mod）        │
│  arena-mod: /api/arena/* 建用户/发token/读战况      │
│  driver+engine: vm 里逐 tick 执行玩家代码           │
└────────────────────────────────────────────────────┘
```

- **client 不直连 Screeps**：token 管理、公平边界都在 host 侧收口。
- **arena-mod**（`screeps-mod/`）：跑在私服 backend 进程内，无 Steam 凭据建用户/发 token、
  生成房间、维护世界元数据、订阅 pubsub 捕获 console。

## 安装

> 安装命令经全新 profile 实测，见 [docs/LOG.md](docs/LOG.md)（S14 条目）。

```sh
# 1) 构建（src/ → lib/：host 半身 lib/index.js + client 半身 lib/client.js）
#    （Git 分发前需保证产物入包，本地开发用 link 安装则自动指向当前产物）
npm run build

# 2) 安装到 scratch profile（link 语义：改动 lib/ 后无需重装）
dsh plugin --profile scratch add /path/to/dsh-screeps

# 3) 验证插件层挂载
dsh --profile scratch --dump-config   # 应看到 # == dsh-screeps / - id: dsh-screeps
```

## 配置

```jsonc
// profile 的 cordis.patch.yml 覆盖（id: dsh-screeps 的 config 整段替换）
{
  "serverMode": "managed",          // managed=插件拉起私服 | external=连已有的
  "dataDir": "~/.dsh-screeps",      // 私服数据目录（含服务器安装）
  "externalUrl": "http://127.0.0.1:21025", // external 模式连接地址
  "port": 0,                        // 0=随机端口（避开 21025 冲突）
  "tickDuration": 200,              // ms/tick
  "readyTimeoutMs": 180000,
  "agentRecruitTimeoutMs": 180000,  // 建赛 recruit/spawn 单阶段超时
  "driveIntervalMs": 1000           // 赛事自动编排驱动周期（submitted→start / autoSettle→settle）
}
```

> external 模式（连用户自己跑的私服）配置以 schema 为准；真机验证待后续里程碑
> （S14 只实测了 managed 模式，external 的 arena API 访问未真机验证）。

## HTTP 面（观战/建赛入口，/dsh-screeps/*）

- `GET /matches`、`GET /matches/:id[/observe|console|replay]` — 对局公开投影/回放
- `POST /spawn-agents {preset,count,provider?}` — 人类建赛：host spawn N 个 Agent 会话（202 异步）
- `POST /tournaments {requestId,seats:4|8,provider?,model?,tickDuration?}` — 建赛事（202 + quotaWarning）
- `GET /tournaments`、`GET /tournaments/:id`、`POST /tournaments/:id/start`、`POST /tournaments/:id/retry`
- `GET /tournaments/:id/bracket` — bracket 纯投影（公开 alias，无 sessionId）
- `GET /history/leaderboard?tournamentId=&limit=` — 稳定积分榜（rank/tie）
- `GET /matches/:id/replay?cursor=&afterTick=&limit=` — canonical 回放（sanitize 后，unavailable 不伪造）

M4 redaction 契约：Tournament DTO/replay/history **绝不返回 sessionId**；PublicMatchDTO 仅普通
M3 局保留 players[].sessionId（start/settle 信任边界，文档化）。

## 工具面（会话映射后）

- `screeps_submit_code(modules, branch?)` — 上传/热更自己的代码
- `screeps_report(sinceTick?)` — 战报 delta（分数/事件聚合/己方报错/CPU）
- `screeps_wait(ticks?|seconds?)` — 阻塞等待下一观察点（≤120s，可取消）
- `screeps_console(expression)` — 己方身份执行控制台表达式并取回输出
- `screeps_read_memory(path?)` / `screeps_write_memory(value, path?)`
- `screeps_world_status()` — 公开战况投影（gameTime、房间归属、玩家）
- `screeps_match(action, …)` — 对局控制：create/join/start/pause/resume/settle（creator-only）

**roundToken（M4 赛事）**：赛事 attempt 是 round-submit——`screeps_submit_code` 需带
`roundToken`（明文只出现在发给该 Agent 的 prompt；MatchState 只存 sha256）；旧 attempt
token 失效。普通 world/arena 局热更语义保持 M3。

**公平边界（红线）**：一个 DSH 会话 = 一个 Screeps 用户，映射只在 host 侧。
工具只允许操作当前会话映射到的那个用户；对方代码/console/memory 永不可见。观战
只消费 host 公开桥（canonical replay frame），浏览器永远拿不到裸 Screeps token。

## 信任模型（请务必阅读）

用户/Agent 代码跑在 Screeps 的 node `vm` 里，**vm 不是安全边界**。多个 Agent 的代码
同进程执行，理论上可越沙箱互查、甚至碰私服宿主机。缓解措施：

- 私服是独立进程组（与 DSH host 隔离）；
- 进阶可让用户在容器里跑私服（配置文档另给 compose 模板）。

对"斗着玩"的本地场景这是合理风险，但本插件**不承诺沙箱**。不要在本机跑不可信的
捆绑代码。

## 开发与验证

```sh
npm run build          # 构建 lib/（tsdown）
npm run typecheck      # host/client 双 program 类型检查
npm test               # 单测（不碰私服）
npm run test:it        # 集成测试（需已 provision 的私服，DSH_SCREEPS_SERVER_DIR 指向 server 目录）
npm run watch          # client HMR 双启：先 tsc --watch 再 tsdown --watch（两个终端）
```

> 本插件含 **host + client 双半身**：`lib/index.js`（host）+ `lib/client.js`（浏览器 bundle，
> ModuleLoader 包装）。client 半身提供对局大厅（sidebar 入口）与「Screeps」对局 tab
> （地图/统计/console 流），消费 host 的 `/dsh-screeps/*` 桥，不直连私服。

工程细节、已验证结论与调试陷阱见 [AGENTS.md](AGENTS.md)；逐里程碑日志见 [docs/LOG.md](docs/LOG.md)。

## License

MIT（本插件本体，见 [LICENSE](LICENSE)；Screeps 引擎/素材为 ISC，其声明保留在上游仓库）。