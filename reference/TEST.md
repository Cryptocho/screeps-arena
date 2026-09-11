# TEST.md — dsh-screeps 手动测试指导

<!-- 本文件是用户执行手动测试的唯一依据。随里程碑更新；测试项完成后回填 LOG 并销项。 -->

> 适用里程碑：**M1 S12 client 观战面板 + M2 Agent 循环 + M3 Arena blitz（spawn-Agent 建赛）**。
> 自动化已覆盖：166 单测通过（1 个 IT lane 跳过）、typecheck 双 program、build 双产物、11/11 IT 全绿、
> A0 spawn-Agent 全链 web lane 验收通过（下方 §5，stub provider）。
> **浏览器四项已由 Agent 用 browser-mcp 自动验收（2026-09-08）**：§1 侧边栏入口、§2 creating 赛前准备室、§3 观战 running、§4 settled 历史局切换均实测通过，见下方「浏览器自动验收记录」。M2 的 host/私服闭环不需要额外手测。

---

## 0. 启动方式（避开正在跑的 3080）

前置：已完成 `npm run build`（lib/index.js + lib/client.js 已生成）；私服 smoke 目录已 provision。
> ⚠️ **当前环境 3080 已被一个正在运行的 DSH 实例占用**（就是我们对话所在的 GUI）。
> **测试实例必须换端口**，不能抢占 3080。

```sh
# 1) 新建一个含 web 界面的 profile 并加入本插件
#    ⚠️ 必须用 file: 协议（拷贝安装），不能用 add <路径>（那会 link symlink，
#       client-modules 的 require.resolve 解析不到 → client bundle 永远 404）
dsh plugin --profile s12web add "dsh-screeps@file:/home/cryptocho/workspace/dsh-screeps"
#    若之前 add 过（link 或旧版），先 remove 再按上面重装

# 2) 写一个端口覆盖 patch（把 webserver 的行 port 换成 3200，不碰 3080）：
#    ⚠️ M2 实测修正：webserver Config 的 host 与 port 均 required、无默认值，
#    缺 host 会校验失败导致启动卡死（之前示例缺 host，用户实测踩中）。
cat > /tmp/s12web-port.yml <<'EOF'
- id: webserver
  config:
    host: 127.0.0.1
    port: 3200
EOF

# 3) 启动 web 界面（浏览器打开 http://127.0.0.1:3200；--no-open 避免弹用户浏览器，
#    本环境 Agent 用 browser-mcp 访问时尤其需要）
dsh --profile s12web --patch /tmp/s12web-port.yml --no-open

# 4) 确认插件层挂载
dsh --profile s12web --dump-config   # 应看到 - id: dsh-screeps
```

> 端口原理（S12 取证）：web 监听端口在 `dsh-host-webserver` 的 Config（`port: number`，默认
> `ctx.webStartup.port ?? 3080`，显式 patch 覆盖即生效）。`--patch` 是 dsh CLI 的 repeatable 覆盖层，
> 晚于 profile 层，`webserver` row 的 config **整段替换**（必须同时给 `host` + `port`，缺 `host` 报
> 「missing required value」）。
>
> **已修好的调试坑（S12 实测，后续重装要记得）**：
> 1. **必须 file: 拷贝安装**（见上），link 安装 → client 404（manifest 无 dsh-screeps）；
> 2. **exports 必须含 `./package.json`**（client-modules 要 `require.resolve("<pkg>/package.json")`，
>    缺了被 exports 挡 → 静默跳过 → manifest 无此包）；
> 3. **client inject 必须含 `sessions`**（apply 里 `ctx.sessions` 访问需要显式 inject，否则
>    `cannot get property "sessions" without inject`）；
> 4. 改了 src 要 `npm run build` + 重新 `pnpm add file:...` 同步拷贝 + 重启 profile +
>    **浏览器强制刷新（Ctrl+Shift+R）**。

---

## 🚨 先确认测试环境

启动前自检：
1. `ss -tlnp | grep 3080` 应仍被原 DSH 实例占用（**不应消失**——那是我们在用的 GUI）。
2. 3200 端口应空闲（`ss -tlnp | grep 3200` 无输出）。
3. 浏览器打开 `http://127.0.0.1:3200` 出现独立的新 DSH 界面（负载均衡/登录页皆可）。

---

## 1. 对局大厅入口（sidebar.footer.action）

**操作步骤**
1. 打开 DSH web 界面，进入任意一个会话（或新建会话）。
2. 看左侧边栏**底部**——应出现「Screeps 对局」区块（含「无对局」或对局列表）。
3. 若侧边栏收起为窄列，应显示 ⚔ 图标按钮。

**预期结果**
- 侧边栏底部出现「Screeps 对局」入口（宽列文字 / 窄列图标）。
- 无对局时显示「无对局」；有对局时列出 `id 尾6位 · preset · phase · 人数`。

---

## 2. 创建对局（creating 空态；M3 起由 spawn-Agent 建赛）

> **M3 产品路径已改**：人类不再手动输入用户名建赛——点「⚔️ 新建对局」由 host spawn N 个真实 Agent 会话
> 为玩家（各 Agent 自己起名/写脚本），人类只等全就绪后点「开始对局」。本节描述创建表单的空态外观
> （§5 是全链实测步骤）。

**操作步骤**
1. 先打开一个会话（创建按钮依赖当前会话）。
2. 在会话的 tab 栏找到 **「Screeps」** tab（排在 Chat 之后）并点击。
3. 该 tab 显示「本会话还没有对局」+ 创建表单（预设下拉 + Agent 数 + 「⚔️ 新建对局」按钮）。
4. 选预设（arena-blitz 固定 2 / world-rounds 可配 2-4），点「⚔️ 新建对局」。

**预期结果**
- 点按钮后显示「✓ 已招募 N 个 Agent」提示；后台 host spawn 会话，等它们起名/写脚本。
- 对局列表出现 creating 局（`id尾6 · creating · stub_pa1 vs stub_pa2`），点条目开准备室看进度。
- **三块都不闪挂、不报错**。

---

## 3. 观战 running 对局（真数据流）

**操作步骤（M3 起：人类建赛走 §5 spawn-Agent；本节的 join 属于工具/测试面直连，HTTP join 端点已移除）**
1. 拿 match id：`curl http://127.0.0.1:3200/dsh-screeps/matches`（找 phase=creating 的）。
2. start（players>=2 且必须是 creator sessionId；无 sessionId → 400，非 creator → 403）：
   ```bash
   curl -X POST http://127.0.0.1:3200/dsh-screeps/matches/<matchId>/start \
     -H 'content-type: application/json' \
     -d '{"sessionId":"sess-a"}'
   ```
3. 回到 3200 的「Screeps」tab，观察约 10-30 秒。

**预期结果**
- 地图出现**有色格子**（每个玩家房间一个格，带 RCL 数字，不同玩家不同色）。
- 比分表出现玩家行（得分/领地/RCL）。
- Console 流**持续追加**玩家 bot 的输出（若双方都传了会打印的代码；starter bot 可能安静，见遗留）。

---

## 5.（M3）人类建赛：spawn N 个 Agent 玩家 → 全就绪 → 开赛（已实测）

> 这是 M3 产品核心链路：人类在 client 点「⚔️ 新建对局」→ host spawn N 个真实 Agent 会话为玩家
> （各 Agent 自己起名入座、写脚本提交）→ 全部就绪后点「开始对局」。**下列命令已由 Agent 在本环境
> 于 3200 真实执行并验证通过（2026-09-08，stub provider 零额度）。**

**操作步骤（curl 直连 HTTP 桥）**
1. 启动验收实例（端口 3200，stub provider 零额度；`--no-open` 不弹浏览器）：
   ```bash
   dsh --profile s12web --patch /home/cryptocho/workspace/dsh-screeps/scripts/acceptance/a0-web-lane.yml --no-open
   ```
   （前置：`npm run build`；profile s12web 已装 dsh-screeps file: 拷贝需与最新 build 同步：
   `cd ~/.dsh/profiles/s12web && rm -rf node_modules/dsh-screeps && pnpm add "dsh-screeps@file:/home/cryptocho/workspace/dsh-screeps" --force`）
2. 触发招募（202 异步编排，`provider:"stub"` 走零额度 stub 适配器）：
   ```bash
   curl -X POST http://127.0.0.1:3200/dsh-screeps/spawn-agents \
     -H 'content-type: application/json' \
     -d '{"preset":"arena-blitz","count":2,"provider":"stub"}'
   # → {"ok":true,"recruiting":true}
   ```
3. 轮询对局列表，等双玩家 `submitted:true`（A1 create → 打标 → A2 join → 双 submit）：
   ```bash
   curl -s http://127.0.0.1:3200/dsh-screeps/matches
   # phase=creating, spawnedBy=agents, players:[{stub_pa1,submitted:true},{stub_pa2,submitted:true}]
   ```
4. 以 creator sessionId（players[0]）start：
   ```bash
   curl -X POST http://127.0.0.1:3200/dsh-screeps/matches/<matchId>/start \
     -H 'content-type: application/json' \
     -d '{"sessionId":"<players[0].sessionId>"}'
   # → phase=running；世界投影 stub_pa1@W15N15 / stub_pa2@W14N15（arena 镜像分配）
   ```
5. settle 结算（creator）：
   ```bash
   curl -X POST http://127.0.0.1:3200/dsh-screeps/matches/<matchId>/settle \
     -H 'content-type: application/json' \
     -d '{"sessionId":"<players[0].sessionId>","reason":"manual"}'
   # → phase=settled（stub 双方代码不打架 → winner=draw，符合预期）
   ```

**预期结果**
- 202 recruiting → creating 局出现且 `spawnedBy=agents`、双玩家 `submitted:true`（全就绪门禁已通过）。
- start 放行 → running，arena 镜像房 W15N15/W14N15 各一（世界投影可查）。
- settle → settled。**每一步的 curl 响应即验收证据**。

### §5-UI browser-mcp 验收记录（2026-09-08 实测）

client UI（M3 改动）已用 browser-mcp 在 3200 实测，证据逐项：

- **侧边栏渲染**：`Screeps 对局` 区块 = 预设下拉（Arena/World）+ Agent 数 + 「⚔️ 新建对局」按钮 + 对局列表
  （每项 `id尾6 · phase · 玩家`，**列表项带 role="button" tabIndex，键盘可达**——M3 无障碍改进）。
- **active 局保护**：有 running/creating 局时点「⚔️ 新建对局」→ 按钮下方显示
  `active match <id> (creating) must settle first`（预检 409 拦截，零 LLM 消耗）。
- **准备室**：点 creating 局条目 → 中心列面板「⚔️ 赛前准备室」：玩家卡牌
  `stub_pa1 红方 · ✓ 已就绪（已提交脚本）` / `stub_pa2 蓝方 · ✓ 已就绪（已提交脚本）` + 对局切换下拉 + 关闭。
- **开始按钮**：点「▶ 开始对局」→ 变「开赛中…」disabled（busy 态正确）→ start 完成后面板随列表变 running。
- **列表实时轮询**：对局 phase 变化（creating→running→settled）3s 内反映在列表与下拉选择器。

> ⚠️ MCP 点击通道曾因浏览器端 WebSocket 超时不稳定（snapshot/轮询正常）；store 竞态修复后的
> start 验证改走 **curl 直测同一端点**（`/matches/:id/start`，Ok:True → phase=running + 镜像分配），
> 浏览器侧验证列表渲染/准备室/active 保护。browser-mcp 点击若再次超时，用 curl 兜底即可。

---

## 4. 对局列表点击跳转

**操作步骤**
1. 在侧边栏「Screeps 对局」列表点任意对局条目。

**预期结果**
- 跳转到该对局所属的会话（`ctx.sessions.open`），切到「Screeps」tab 可看详情。

---

## 浏览器自动验收记录（browser-mcp，2026-09-08）

本环境已能用 browser-mcp 驱动 3200 实例，四项已由 Agent 自动实测：

1. **§1 侧边栏入口**：`Screeps 对局` 区块 + `⚔️ 新建对局` + 对局列表（`settled M2Agent vs __bot_harvester`、`interrupted`、`running` 各条目）均渲染。
2. **§2 创建 creating 空态**：点「⚔️ 新建对局」→ 自动 create(test_a)+join(test_b)（S12 拍板行为）→ 「⚔️ 赛前准备室 6rctom · test_a 红方已就座 · test_b 蓝方已就座」+「▶ 开始对局」。
3. **§3 观战 running**：点「▶ 开始对局」→ 几秒后按钮变「开赛中…」→ ~40s 后进入 running 看板：`test_a 📍 W51N48 RCL 1`、`test_b 📍 W51N86 RCL 1`、比分表（暂无比分）、console 流 `[test_a]/[test_b] (tick ran, no output)` 持续追加（starter bot 安静正如遗留所注）。
4. **§4 列表点击跳转**：点 settled 对局条目 → 面板切到「🏁 对局已结算 · 观战结束，可返回大厅查看历史」；对局选择器正确选中该项。

额外验证（M2 公平边界真实生效）：
- 非 creator settle → `{"ok":false,"error":"only the creator may settle the match"}`；
- creator settle → 200，`phase: settled`，winner=draw（双方未提交代码，平局符合预期）；
- running 对局侧边栏显示 `active match ... (running) must settle first`（活跃局保护）。

## M2 headless / Agent 循环自动验收记录

> **M5 superseded 注（2026-09-09）**：本节为 M2 时代的历史验收记录，原样保留仅供追溯。文中
> `world-live` 预设与 `addBot` 通道均已关闭（M5 删 world-live，主线 = world-rounds；addBot 于
> 验收面收敛时移出产品路径）；第 3 步的 `module.exports.loop` 入口约束仍然有效。

已由 Agent 自动完成，不需要您重复手测：

1. 使用 `dsh --profile headless --patch /tmp/dsh-m2-headless.yml`，配置 smoke `dataDir`、`port:0`、`tickDuration:100`。
2. create `world-live`（必须提供合法 `username`）→ addBot `harvester` → start。
3. 用 `screeps_submit_code` 提交采集代码。**入口必须是 `module.exports.loop = function () { ... }`**；旧式 `module.exports = function () {}` 在 Screeps engine 4.3.x 中不会执行。
4. 循环 `screeps_wait(seconds=10)` + `screeps_report`，直到 report 的 `ticksElapsed ≥ 200`。
5. `screeps_match(settle, reason=manual)`，确认 `phase=settled`、winner、gameTime、玩家数和 scoreboard。

本次记录：`matchId=mmtqy7814fz9nlf`，2 玩家，winner=`__bot__harvester`，`gameTime=8434`，观察点达到 ≥200 tick。

## 已知遗留（不影响以上验收）

- ~~浏览器四项~~ **已销项（2026-09-08，browser-mcp 自动实测通过）**：侧边栏入口 / creating 赛前准备室 / running 看板 / settled 历史切换，见上文「浏览器自动验收记录」。
- **console 真数据依赖玩家代码**：默认测试 bot（harvester）可能不打印 console；需给玩家传带 `console.log` 的代码。
- **addBot 已从工具面摘除（2026-09-09 产品对齐）**：对局参与者只能是 Agent；`bots/` 移入 `tests/fixtures/bots/` 仅测试用。上节 M2 headless 记录中的 `addBot harvester` 是当时的验收快照——**今后 headless/manual 验收的 bot 座位需走「测试内部链路」或在 M3 提供专用注入通道**（见 plan-M3 E 节 headless 通道遗留）。
- **rc.2 test-runtime 打包 bug**：官方 client 测试 lane 跑不了（src/ 悬空），单测用自造 fake 兜底；不影响浏览器功能。
- **s12web profile 构建问题**：dsh-base 0.0.1-rc.1 缺 npm 包，需用 0.1.1-rc.2；若 profile 起不来，可用现有 web profile 临时 add 本插件验证。
- 后续里程碑遗留：interrupted 中断局恢复、frozen 完整玩法、房间可见性精确化、World 房间扩张成本。
---

## M4 赛事/回放/历史（2026-09-09 追加）

> 适用里程碑：**M4 赛事 bracket + canonical replay + history leaderboard**。
> 自动化已覆盖：336 单测绿 + 全套真实私服 IT 绿（含 4 席两轮 composition、replay generation 隔离）+ 本节 __全部命令已在本环境真实执行并通过__。

### M4 启动方式（复用 3200 lane，stub provider 零额度）

```sh
# 前置：npm run build（已含 M4 host+client）
# 同步最新构建到 s12web profile（M4 后必须重同步，旧 lib 无 tournament 路由）
rsync -a lib/ ~/.dsh/profiles/s12web/node_modules/dsh-screeps/lib/
rsync -a screeps-mod/ ~/.dsh/profiles/s12web/node_modules/dsh-screeps/screeps-mod/

# 启动（stub provider 用 patch 注入 m4-tournament-stub-plugin：round prompt 确定性提交）
nohup dsh --profile s12web --patch scripts/acceptance/m4-web-lane.yml --no-open --port 3200 > /tmp/m4-lane.log 2>&1 &
# 等 ~20s，验证：curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/   → 200
```

### 功能清单与操作步骤（全部已实测）

**1. HTTP 建赛（4/8 席）+ 额度警告**
```sh
curl -s -X POST http://127.0.0.1:3200/dsh-screeps/tournaments \
  -H 'content-type: application/json' \
  -d '{"requestId":"m4f2-curl-1","seats":4,"provider":"stub","model":"stub-model"}'
# 预期：{"ok":true,"tournamentId":"tmtt...","recruiting":true,"quotaWarning":true,...}
# 实测：✓ 返回 202 + quotaWarning:true
```

**2. 轮询 recruiting → ready（stub recruit 秒答 4 roster）**
```sh
curl -s http://127.0.0.1:3200/dsh-screeps/tournaments
# 预期：列表含 "phase":"ready"、"participants" 4 条（displayName=Agent 1..4）
# 实测：✓ ready + 4 roster
```

**3. 开始时赛（观战者触发，不占座）**
```sh
curl -s -X POST http://127.0.0.1:3200/dsh-screeps/tournaments/<tid>/start -H 'content-type: application/json' -d '{}'
# 预期：{"ok":true,"tournamentId":"...","phase":"running"}
# 实测：✓ running + slot r1s0 激活（matchId 绑定）
```

**4. bracket 纯投影（HTML/SVG 数据源）**
```sh
curl -s http://127.0.0.1:3200/dsh-screeps/tournaments/<tid>/bracket
# 预期：{"ok":true,"bracket":{...rounds:[{round:1,slots:[...]}]}}，participants 只有 participantId/displayName/seed
# 实测：✓ rounds/r1s0(running)/r1s1(pending)；DTO 无 sessionId、无 __bot__
```

**5. leaderboard / replay 路由**
```sh
curl -s "http://127.0.0.1:3200/dsh-screeps/history/leaderboard"          # ✓ {"ok":true,"leaderboard":{"rows":[],"hasMore":false}}
curl -s "http://127.0.0.1:3200/dsh-screeps/matches/<mid>/replay"          # 未 running 局 ✓ {"ok":true,..."unavailable":true}（不伪造）
```

### 浏览器验收（browser-mcp 默认已连接，Agent 直接自动化；MCP 调用失败才提醒用户排查）

> 2026-09-09 纠正：browser-mcp **默认即连接**，无需人工先点 Connect；本节验收已由 Agent 经
> accessibility 快照自动完成。仅当 Agent 调 MCP 报连接类错误时，才请用户检查扩展/连接。

Agent 用 accessibility 快照（browser_snapshot）验证：
1. 侧边栏出现「Screeps 赛事」+「🏆 新建赛事」（4/8 席下拉 + 额度文案「Agent 参赛 · 人类只观战/触发编排」）；
2. 点「新建赛事」→ 赛事条目显示 recruiting → ready → 选手 card（Agent 1..4）；
3. 点赛事进详情：roster + 「▶ 开始赛事」+ bracket 列 + 积分榜（空态）+ 回放入口（有 settle 局时）；
4. 回放播放器：播放/暂停/seek、tick 范围、partial/gap banner（若有 gap 的对局）。

### 已知遗留（M4 收尾记录）

- ~~host 后台 spawn 的子会话 turn 需要宿主 turn 上下文~~ **已推翻（2026-09-09 真实 LLM 实测）**：纯 HTTP
  fire-and-forget spawn + followup **会自动开子会话 turn**（followup → wakeDriver → withInitiator(子会话自身)，
  不依赖宿主上下文；真实链路 turn1/2 正常完成）。M4-F.2 观察到的「不开 stub 子 turn」是 stub 插件 mock
  不完整所致，非机制缺陷。
- **browser-mcp 本环境未连接扩展** → 浏览器四项转用户手动（上方 §7），Agent 用 curl 完成 host 侧验收。
- M4 不宣传 raw sockjs 无损录像：replay 是 canonical public frame（generation/seq/gap 契约）。
- 普通 spawn 局（非 tournament）无自动 settle 驱动：observe 判 autoSettle due 后需观战者/Agent 显式触发
  settle（tournament 由 driveOnce 自动）。

## 8. 真实 LLM 全链测试（2026-09-09 首次实测通过）

> 这是产品核心链路：真实 LLM 决策（非 stub）→ 真实私服战斗 → 结算。**消耗用户真实模型额度**
> （2 席单局约 4 个 agent turn，flash 模型量级很小）。启动与指令已在本环境真实执行验证（2026-09-09 05:32-05:43）。

1. 启动真实 lane（无 stub 插件；`--no-open` 不弹浏览器；key 走 `~/.dsh/.credentials.yaml` 无需 env）：
```sh
cd <dsh-screeps 仓库> && dsh --profile s12web --patch scripts/acceptance/real-web-lane.yml --no-open
```
patch 已配 `agentModel: deepseek/deepseek-v4-flash-0731`；如用别的模型可在请求体里显式传 `provider`+`model`。

2. 触发招募（真实 LLM；不带 provider/model 时用 patch 的 agentModel）：
```sh
curl -X POST http://127.0.0.1:3200/dsh-screeps/spawn-agents   -H 'Content-Type: application/json'   -d '{"preset":"arena-blitz","count":2,"provider":"openrouter","model":"deepseek/deepseek-v4-flash-0731"}'
# → {"ok":true,"recruiting":true}（202）
```

3. 等待真实 LLM 完成 3 阶段（起名→入座→写脚本，每个阶段一个真实 turn，约 1-3 分钟）：
```sh
curl -s http://127.0.0.1:3200/dsh-screeps/matches | python3 -m json.tool | grep -E 'phase|username|submitted'
# 实测：creating → players [{username:TacticalShrimp,submitted:true},{username:DeepSeekNest,submitted:true}]
```

4. 开赛（需 creator 的 sessionId，players[0]；真实 matchId 用列表里的完整 id）：
```sh
curl -X POST http://127.0.0.1:3200/dsh-screeps/matches/<full-id>/start   -H 'Content-Type: application/json' -d '{"sessionId":"screeps-player-1-<suffix>"}'
# → running；私服拉起（storage/backend/engine），gameTime 持续推进
```

5. 观察/结算（普通局无自动 settle，observe 判 due 后手动 settle）：
```sh
curl -s http://127.0.0.1:3200/dsh-screeps/matches/<full-id>/observe   # autoSettle:{due:true,reason:ticksExhausted}
curl -X POST http://127.0.0.1:3200/dsh-screeps/matches/<full-id>/settle   -H 'Content-Type: application/json' -d '{"sessionId":"screeps-player-1-<suffix>"}'
# → settled + winner（实测 winner=DeepSeekNest，比分 +24/-24，2847 tick 真实对局）
```

**实测结果（2026-09-09）**：真实 LLM 起名 TacticalShrimp/DeepSeekNest、各自生成 10KB+ 完整 Screeps bot 代码、
镜像地图真实跑 2847 tick（≈7 tick/s）、真实战斗（击杀 24 分）、settled + winner。全程无 `__bot__`/sessionId
泄漏。用户额度消耗：2 席 × 约 4 turn（flash 模型）。

## 9. world-rounds 回合制测试（M5，2026-09-09）

> M5 删掉了 `world-live`（连续实时热更），产品主线 World = `world-rounds`（回合制）。本节目的是人工
> 验证周期边界机制。**自动化已覆盖**：单测（lifecycle-rounds 6 测 + tools 21 测）+ 真实私服 IT1
> `tests/m5-rounds.it.test.ts`（round0→roundBreak→commit→resume round1→settle，全链）等。

### 启动（复用 3200 lane；命令已实测可跑）

```sh
cd <dsh-screeps 仓库> && dsh --profile s12web --patch scripts/acceptance/real-web-lane.yml --no-open
# 3200 起 GUI + 私服；默认 agentModel=deepseek-v4-flash
```

### 手动验证（curl；每步预期）

1. **建世界-rounds 局**（roundTicks=100 小周期，10 秒一轮，好观察）：
```sh
curl -X POST http://127.0.0.1:3200/dsh-screeps/spawn-agents \
  -H 'Content-Type: application/json' \
  -d '{"preset":"world-rounds","count":2,"provider":"openrouter","model":"deepseek/deepseek-v4-flash-0731"}'
# → 202 recruiting；真实 Agent 会话起名/写脚本/全就绪（等 1-3 分钟）
```

2. **开赛 + 周期推进**：start → running → ~10s 后世界自动暂停（enterRoundBreak）→
   DTO 出现 `roundIndex:0`、phase=`roundBreak`、玩家 `ready` 字段（bot 无；Agent 提交后 true）。
```sh
curl -s http://127.0.0.1:3200/dsh-screeps/matches | python3 -m json.tool | grep -E 'phase|roundIndex|preset'
# 预期：一会 running、一会 roundBreak（自动切换）；preset=world-rounds
```
> 注意：driveIntervalMs=1000 的 service 驱动循环自动推进（autoRound→break→全员 ready 续跑），
> 观战者无需手动触发；若停在 roundBreak 等 Agent commit，是 Agent 还没提交（或已超时沿用旧代码续跑）。

3. **Agent 周期提交**（真实链路 → Agent 收到 followup 周期战报后 `screeps_submit_code` commit）：
   roundBreak 时提交 = 就绪；自动续跑后 roundIndex 递增、下一轮新代码生效（console 可看 ROUND 标记）。
   若想手动驱动：`POST /dsh-screeps/matches/<id>/round` 不存在——驱动只在 host 内部（single-writer），
   观战走只读 observe。

4. **周期终止**：预设 maxRounds=8；跑满后自动 settle + winner + 记分。

### 浏览器验证（✅ 2026-09-09 已由 Agent 经 browser-mcp accessibility 快照完成，无需人工）

- 对局列表预设下拉出现 **「World 回合制」**（非「World 持久扩张」）✅（label 已同步修正为
  「周期提交；人类建赛仅此两预设」）；
- 详情面板 phase 徽标出现 **「周期边界」**（roundBreak）✅；roundIndex 进度可见（**「周期 3/8」**）✅；
  每玩家 ready 标记（未 commit ⏳ / 已 commit ✅）✅；roundBreak banner（commit=就绪/超时沿用旧代码说明）✅。
- 无额度复核路径：HTTP create（world-rounds + `tickDuration:50` → 1000×50ms≈50s 一轮）；HTTP join 已移除，
  验证局由 smoke `state.json` 直补第二玩家后 start（仅限测试环境；产品路径 = spawn-agents / 工具面 join）。

### 已实测证据

IT1（真实私服）全链绿：round0 → roundBreak（世界 pause + bot 自动 ready）→ Agent commit →
driveNextRound 续跑 round1（roundIndex≥1 + submitCode 真传 + ROUND1_MARK console 出现）→ settle。
`m2-closed-loop`/`m2-battle` 改造后仍绿（周期语义下事件链路/战斗）。

**真实 LLM 周期演练（2026-09-09 已执行，用户批准额度）**：real-web-lane（3200，无 stub，
openrouter/deepseek-v4-flash）→ spawn-agents world-rounds 2 席 → 真实 Agent `agent_byte`/`agent_delta`
起名入座 + round0 脚本（~2 分钟）→ start → 09:56:00 drive 准点 roundBreak → 09:58:47 `agent_byte`
真实 commit（代码由单 harvester 迭代为三角色 6916 字符新脚本）→ 10:01:03 超时兜底续跑 round1
（`error="round break timeout: agent_delta kept last-round code"` 落盘）→ 10:07:57 第二次边界 →
10:10:57 round2 → 手动 settle = **settled draw 200:200**。**产品核心闭环「LLM 决策拍与世界周期对齐」
首次真实成立**；时间线全文见 LOG.md 顶部条目。浏览器验证已由 Agent 经 accessibility 快照自动完成
（预设下拉/roundBreak 徽标/周期进度/ready 标记，见上节与 LOG）。
