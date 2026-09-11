# plan-M2 — 真实计分 + WS console 流 + 容器化 + 健壮性补全

日期：2026-09-11 · 前置：M1 已关闭（commit `58728ef`，plan-M1 §6 遗留全部认领至本里程碑）
状态：**已实施完成（2026-09-11），待成果审查**——v2（两轮 subagent 审查后 PASS；tiebreak 顺序与单容器拓扑已用户确认）；验证证据见 docs/LOG.md M2 条目

## 0. 目标

把 M1 的「能跑起来、能观战」推进到「**分得出胜负、经得起中断、可一键部署**」：

1. settle 接真实计分，替换恒 draw（M0 语义遗留）
2. console 从 2s 轮询换 WS 增量推送
3. 容器化：**单 app 容器**（host + 私服 runner 同进程，managed 模式进容器）+ 数据卷；跨容器拆分归 M3+ 评估
4. interrupted 对局恢复
5. 地图公平性距离校验重掷
6. 席位目录名/用户名碰撞加固
7. 统一真实组装入口（`src/server/main.ts`：真实私服版组装，供 dev/compose/IT 共用，M1 复审问题 3 教训）

**明确不进 M2**：样式/表现层（用户决策：全部功能完成后单独统一收尾）；M3+ 项（锦标赛/回放/arena-blitz 镜像克隆/房间可见性精确化）。

## 1. 现状与差距（锚点）

| 项 | 现状 | 差距 |
|---|---|---|
| 计分 | `machine.settle()` 全 0 → draw（`src/server/match/machine.ts` L128-141）；两条触发路径：routes `m.settle('manual')`、resume 内 `settle('roundsExhausted')` | 无快照取分、无出局判定 |
| console | 前端 `setInterval(2s)` 轮询 `/api/matches/:id/console`（`src/client/app.tsx` L155-177）；服务端 `RealArena.consoleSince` 游标增量已在 | WS 推送通道 |
| 部署 | bare-metal：`ensureScreepsServer` 装 serverDir（dev 模式）；真实组装只存在于 test:live IT 装置（`scripts/dev-server.ts` L8 明言真实接线归 M2 CLI 子命令） | 容器 + 卷 + 统一组装入口 |
| 恢复 | M0 裁掉 interrupted 相位（`src/server/match/model.ts` L4-5 注释）；对局状态全内存 | journal + 启动恢复 |
| 地图 | `RealArena.bindUser` 直接 `generateRoom({room, sources:2})`（`arena.ts` L50-63），无校验 | 距离校验 + 重掷 |
| 席位命名 | `seatId.replace(/[^A-Za-z0-9_-]/g,'_')` 两处：runner cwd（`runner.ts` L104-114）、agent username（`arena.ts` L58）——`a:b` 与 `a_b` 碰撞 | sanitize + 短 hash |

**计分规则来源**（`reference/AGENTS.md` 玩法设计 + 旧 M3 结论，平移复核）：
- 出局判定：**arena = spawns==0；world = spawns==0 且 creeps==0**
- 一方出局 → 对方胜；双方同轮出局 → 比 creeps→rooms→rclTotal，仍平则 draw
  （**tiebreak 顺序为 M2 新增设计**：reference 玩法设计节只定「拆 spawn/击杀分/最后 creep」，
  旧 M3 节只定出局判定，无 tiebreak 出处；顺序待用户确认）
- 双活到 maxRounds → draw（延续当前语义；记分字段保留快照原始计数）
- 数据源：`svc.getWorld()` → `world.users[]`（rooms/rclTotal/spawns/creeps，`RealArena.report` 已用同源字段）

**地图公平性来源**（`reference/docs/spikes/map-fairness.md`）：
每房算 Σ(source→controller 距离)，偏离全体中位数超阈值 → 重掷该房，预算 ≤3 次。

## 2. 实施面

### S1 真实计分

- `MatchMachine` **保持同步纯类**：`settle(reason, now?, scores?)` 增加可选分数参数。
  注意 `resume()` 是 **private**（`machine.ts` L155），外部时钟唯一触面是 `advance()`（无参）——
  公开签名改为 `advance(now?, scores?)`，透传 private `resume → settle('roundsExhausted')`。
  不传 scores → 维持 M0 行为（全 0 draw），保证既有 73 测不破。
- 新增纯函数 `computeOutcome(snapshot)`：入参 `{seatId → {spawns,creeps,rooms,rclTotal}}`，
  出参 `{scores, winner}`（出局判定/同轮双出局 tiebreak，见 §1 规则）。放 `src/server/match/score.ts`。
- 编排层注入：`ArenaHttpServices` 增加 `getScoreSnapshot(): Promise<Record<...>>`。
  两条触发路径的取分时机：
  - manual：routes settle handler 先 `await getScoreSnapshot()` 再 `m.settle('manual', now, scores)`；
  - roundsExhausted：**该路径不发 `round_resume` 事件**（resume 内到顶直接 settle return，
    `machine.ts` L157-159）——driver `tick()` 对 phase==='roundBreak' 的机器在 `advance()` 前
    await 快照（tick 本就是 async，`driver.ts` L90-98）。**不做** round_break 时刻预取：
    会拿到最多提前 roundBreakTimeoutMs（默认 300s）的过时快照，私服还在跑、计数会变。
  - score 注入闭包统一收在 S0 组装模块，dev/compose/IT 共用同一份代码。
- 前端：详情页展示 winner/scores（字段已透出，`routes.ts` matchView L59-64，补渲染即可）。
- 测试：computeOutcome 纯函数表驱动单测（arena/world 两形态、双出局 tiebreak、双活 draw）；
  settle 带/不带 scores 两路径单测（manual 走 routes、roundsExhausted 走 driver tick）。

### S2 WS console 流

- 服务端：现 WS 为**单向**广播（`server.ts` 无 `socket.on('message')`），S2 升级为双向。
  新增消息 `{type:'subscribe_console', user}` / `{type:'unsubscribe_console'}`；
  订阅后服务端定时（1s，间隔可调）拉 `consoleSince(user, cursor)`，增量以
  `{type:'console_lines', user, lines, cursor}` 推送；cursor 持久在 RealArena（现有 Map）。
  连接断开自动退订；未 bind 用户推 `{bound:false}` 一次即静默。
- 前端：`app.tsx` console tab 改订阅/退订，删 2s 轮询（HTTP 端点保留为降级与测试口；
  降级口**必须显式传 `since`**——HTTP 与 WS 共享 `RealArena.consoleCursors`，缺省会互吞增量）。
- 测试：WS 协议 IT（订阅 → 写 console → 收增量 → 退订停推）；前端逻辑纯函数部分单测。

### S0 统一真实组装入口（新增，复审 B3）

- 现状：`src/server/` **无 main.ts**；真实接线（ScreepsService + RealArena + driver + HTTP/WS 桥 +
  静态托管）只存在于 test:live IT 装置；`scripts/dev-server.ts` L8 明言真实接线归「M2 CLI 子命令」。
  若不收口，S1 score 注入、S3 main.js 入口都悬空，且重演「mock 自证、真实路径漏接」（M1 复审问题 3）。
- 新增 `src/server/main.ts`：真实私服版 services 组装 + CLI 入口
  （`node dist/server/main.js [--port N] [--data-dir D] [--host H]`），**dev/compose/IT 共用同一份**。
- S1 的 score 注入闭包、S6 的 prepareRooms 接线均收在该模块；`dev-services.ts`（mock 组装）保持不变。
- 测试：组装 IT（真实 main 起服 → 建号 → settle 全链）。

### S3 容器化 + S4 数据卷（单 app 容器口径）

- 拓扑拍板（复审专项已核）：**单 `app` 服务容器**（host + 私服 runner 同进程，managed 模式原样进容器）
  + 数据卷；compose 文件**无** `screeps` 服务定义。理由：`ScreepsService` 只有 managed 模式，
  external 连接模式未平移；generateRoom 后必须重启的坑（`service.ts` L310-312）在双容器下变成
  跨容器编排重启（比同进程 `restart()` 含 stop 序列/exit guard 更脆）。跨容器拆分归 M3+ 评估。
- `Dockerfile`（node:22 slim + 构建期 native 工具链）：**构建期**跑一次 `ensureScreepsServer`
  把安装产物（mods/assets/steam 资产）打进镜像；卷只挂**可变数据**（db/、journal）——
  消除「卷为空时仅校验存在」的行为分叉（安装产物留镜像、可变数据进卷）。
- `docker-compose.yml`：单 `app` 服务 + 两卷：`screeps-data`（db 可变部分）、`arena-data`（对局 journal）。
- 监听地址参数化：`server.ts` 写死 127.0.0.1（无鉴权安全前提），容器内需 0.0.0.0 才能端口映射——
  增加 `--host`（默认仍 127.0.0.1，compose 显式传 0.0.0.0；宿主直跑行为不变）。
- bare-metal 路径保留为 dev 模式，不删。
- 测试：`docker compose config` 校验；有 Docker 时 up smoke（`/api/world` 200 + 重启后 db 仍在）
  写 TEST.md 手测（**如实标注是否实测**）；无 Docker 环境则以 config 校验 + S0 组装 IT 兜底。

### S5 interrupted 恢复

- 语义平移自 `reference/src/host/match`（journal 先例：`reference/src/host/match/store.ts`）。
- M2 最小闭环：对局状态（MatchState + config + players + **seatId→username 映射**）在
  **每次相位迁移后**原子落盘 `arena-data/matches/<id>.json`；启动时扫描未 settled 的 journal →
  恢复机器并以 errors[] + log 标记 interrupted（**不新增 MatchPhase**，与 M0 裁剪一致）→
  按 phase 恢复（running/roundBreak 回到 roundBreak，**roundBreakSince 重置为恢复时刻**，
  否则超时兜底立即触发；等兜底自然续跑）。
- 映射恢复（复审 B4）：`RealArena.users` 与 console/event 游标全在内存（`arena.ts` L39-42）——
  恢复时把 journal 的 seatId→username 灌回 RealArena；游标重置 0（文档注明重启后 console 可能重放）。
- 原子写：临时文件 + rename（先例：M0 store 已有）。
- 测试：落盘/恢复单测（各相位杀进程模拟 → 重启 → 状态与映射一致）；原子写单测。

### S6 地图公平性距离校验重掷

- 落点：`RealArena` 建号流程。bindUser 改两步：`prepareRooms(seatIds)`（批量 generateRoom →
  距离校验 → 超阈值重掷，预算 ≤3；重掷仍超 → 取最接近的一次 + error 落盘告警）→
  createUser（含 code 写入）。
- 已知坑（`service.ts` L310-312）：generateRoom 后地形缓存不刷新，**必须重启私服**才能 run——
  M2 策略：建号期（run 尚未发生）可连续 generateRoom，重掷定稿后统一重启一次；不逐次重启。
- 坐标来源（复审订正）：mod `generateRoom` 返回 `{generated, exits, detail}`，**无坐标**——
  走已有 `roomObjects` 命令过滤 source/controller 取 x/y（零 mod 改动），不补 mod 端点。
  阈值以 map-fairness.md §决策复核；**同房名重复 generateRoom 的行为无 spike 依据，
  先 IT 钉住**（必要时先清 terrain/objects 再重掷）。
- 测试：纯函数 `roomDistanceScore(sources, controller)` 单测 + 重掷预算逻辑单测（mock 坐标序列）；
  IT 用真实私服断言两房距离差 ≤ 阈值。

### S7 席位目录名/用户名碰撞加固

- 统一 `seatSlug(seatId)` = sanitize（截断 ≤16 字符）+ `sha1(seatId)` 前 8 位后缀，
  落 `src/shared/seat-slug.ts`；替换两处调用（runner cwd、agent username；
  `agent_` 前缀 + 截断名 + 8 位 hash 控制在 30 字符用户名惯例上限内）。
  同 seatId 幂等（同串必同 slug）。HTTP 路径 `USERNAME_RE`（`routes.ts` L36）已挡特殊字符，
  本项实际保护 runner cwd 与绕过 HTTP 的内部建号路径。
- 负向测试：`'a:b'` 与 `'a_b'` 得到不同 cwd/username；幂等测试；公平边界既有测试不回退。

## 3. 验证判据

1. `npm test` 全绿（现 73 条 + 新增）；`npm run typecheck` 零错；`npm run build`（tsdown 服务端产物，
   compose 镜像前提）+ `npm run build:client` 零错
2. `npm run test:live` 绿，且新增断言：真实世界 settle 后 winner 非 draw（或 scores 非全 0）
3. WS console IT 绿（订阅/增量/退订）
4. compose：`docker compose config` 过 + 有 Docker 时 up smoke 手测（写 TEST.md，如实标注是否实测）
5. interrupted：单测模拟中断恢复闭环
6. 审查闭环：本计划书 subagent 审查 PASS 后开工；成果再审 PASS 后收尾

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| settle 注入 scores 破坏同步纯状态机 | scores 走 advance/settle 可选参数由编排层注入；不传维持旧行为，73 测零改动 |
| roundsExhausted 自动 settle 拿不到快照 | driver tick 对 roundBreak 相位机器在 advance() 前 await 快照（取分新鲜）；单测钉住 manual 与 roundsExhausted 两路径 |
| generateRoom 重掷 × 重启成本叠加 | 建号期批量重掷、定稿后一次重启；预算 ≤3 封顶 |
| compose 内 native 模块构建失败 | 优先 slim 基镜像 + 构建期安装工具链；失败降级 node:22 完整镜像；不可解则记 LOG 提请决策 |
| journal 与内存 machines 双写不一致 | 唯一写点 = 事件回调内同步落盘（onEvent 已是单一来源接线，dev-services 注释先例）；journal 增落 seatId→username 映射，恢复时灌回 RealArena |
| WS 订阅泄漏（前端 tab 切换/断连） | unsubscribe 消息 + 连接 close 钩子双向清理；IT 断言退订后停推 |
| HTTP 降级口与 WS 推游标互吞 | 降级口显式传 `since`，不入共享游标（S2） |
| compose 监听 127.0.0.1 不可端口映射 | `--host` 参数化，默认 127.0.0.1 不变，compose 显式 0.0.0.0（S3） |
| 同房名重复 generateRoom 行为未知 | 先 IT 钉住行为，必要时先清 terrain/objects 再重掷（S6） |
| arena username 变更影响既有对局 | slug 函数对含 hash 后缀保持幂等；live IT 全链回归覆盖建号 |

## 5. 遗留（后续里程碑）

- M3+：锦标赛/回放/历史、arena-blitz 镜像克隆、房间可见性精确化、runner 跨容器拆分评估
- 表现层收尾：**不在任何功能里程碑内**，全部功能完成后单独统一做（用户决策，plan-M1 §6 延续）
