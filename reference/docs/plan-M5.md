# M5 计划 v3 定稿 — 删干净 world-live + world-rounds 回合制（产品主线的 Agent 参与形态）

> 审查记录：
> - **一审（subagent 441cc69b，2026-09-09）：不 PASS → 2 阻塞 + 6 次要 + 提示（v2 全部吸收）**。
>   阻塞 1：§3.3「暂存 MatchPlayer.code、下轮生效」缺「把代码真正传入私服」步骤——唯一上传通道是
>   `svc.submitCode→POST /api/user/code`（service.ts L674-685），creating 注入只发生在 lifecycle.start 的
>   createUser（lifecycle.ts L210-216，round 2+ 不可复用）→ v2：resumeNextRound 开跑前对每个 ready 玩家上调
>   `svc.submitCode`（代码真正进私服、下一轮生效）。
>   阻塞 2：autoRound 探测 `worldTime - phaseTick >= roundTicks` 依赖的 phaseTick **全仓库无写入点**
>   （model.ts L176 仅定义；`store.transition` extra 白名单 store.ts L298 不含 phaseTick；lifecycle.start L232
>   不写）→ v2：transition extra 白名单加 phaseTick；start 以当时 worldTime 初始化（round break 起点）；
>   resize 维护。
>   次要 ① driveOnce 只扫 tournaments（service.ts L886）→ v2：驱动面扩展普通 world-rounds 局（§4-D）。
>   次要 ② m2-closed-loop 改造悬空、bot 在 roundBreak 不会 commit（__bot__ 不调 submit）→ v2：botCode 座位
>   roundBreak 自动 ready（沿用原代码，不给 bot 提交能力）；Agent 座位显式 commit。
>   次要 ③ m2-battle 迁移到 world-rounds 方向性错误（running 期 submit + 双房 rooms 冲突）→ v2：m2-battle
>   改为「round0 战斗 → roundBreak 提交新 bot 代码 → round1 新代码生效」验收（正是 rounds 核心语义），
>   双房保留（world form 支持 rooms）。
>   次要 ④ roundBreak→settling 需改 settle/beginSettlement/legacy settle 三处白名单 → v2：§4-B/D 列全三处。
>   次要 ⑤ roundTicks/maxRounds required 化打爆存量 state.json（isMatchConfig 是 readState schema 闸）
>   → v2：roundTicks/maxRounds **optional + 默认 0**（0 = 不启用/不限）；maxRounds>0 才 [1,100] 校验。
>   次要 ⑥ DTO 白名单在 client `guardMatch`（api.ts L32-61）不在 model/store → v2：位置修正 + guardMatch
>   扩展收下 roundIndex/player.ready（就绪状态公开合理，不泄代码）。
>   提示（一审已吸收）：superseded 补 plan-M4 L282；codeMode 实为 **MatchState 字段**（非 MatchConfig）；
>   maxRounds 范围与 0=不限矛盾（并次要⑤）；board.tsx PHASE_META 补进 client 清单；AGENTS 坑③修订列进
>   实施任务；送审点 §3.5 结论=**成立**（证据 M4 tournament/orchestrator.ts L196 已在用 handle.agent.followup）
>   → v2 定案为正文，不再待审。
> - **二审（subagent，2026-09-09）：PASS（阻塞 0，次要 4，提示 4）**。源码级复核：pause 冻结 gameTime
>   （`reference/screeps/engine/src/main.js` L26-27+L94-99 notifyTickStarted reject → 整条 tick 链不执行）、
>   `$activeWorld` 覆盖建号注入分支（user.js L90-96 + arena-mod L810-818；上传后 `env.del(scrScriptCachedData)`
>   清 VM 缓存 → resume 首 tick 读新代码）、上传-续跑无竞态、phaseTick 无写入确认、followup/rooms/driveOnce/
>   serialize/guardMatch 全部核过。**无新阻塞**。
>   - 次要 1：roundBreak→settled 白名单实为 **4 处**（计划只列 3）——漏最主要的 journal 入口
>     `store.ts` L412-420 `beginSettlement`（`phase!=='running'&&!=='paused'` throw）。→ v3 §4-B 显式列全 4 处。
>   - 次要 2：**删 world-live 会打爆存量 state.json 且自相矛盾**——isMatchConfig 硬校验 `preset in PRESETS`
>     （model.ts L215），删后旧 world-live 局 → readState 抛 corrupt → list()/active() **静默跳过**
>     （store.ts L236-241）→ 旧局不可见/无法 settle/markInterrupted 扫不到、且可能绕过单活跃不变量。
>     → v3 §4-A 补升级迁移（扫描旧 `preset:'world-live'` 态显式标 interrupted/剔除 + 单测钉死）。
>   - 次要 3：失败降级语义要写精确——钉死「任一失败 → **该玩家沿用旧代码，已成功玩家保持新代码，照常
>     resume + match.error 落盘**」（部分更新混合跑），不做「整轮不 resume」（会与世界 pause 死锁）；单测断言
>     N-1 成功 1 失败 → resume 且 error 落盘。→ v3 §3.3 精确化。
>   - 次要 4：roundBreakTimeoutMs 计时基准未落点 → v3 定案 `MatchState.roundBreakSince?`（进入 roundBreak 的
>     墙钟时间戳；内存记录即可，重启即标 interrupted 不恢复）。
>   - 提示 1：codeMode 派生落点——store.create（store.ts L162）按 `config.frozenCode` 默认派生，world-rounds
>     （frozenCode:false）会得 'live' 而非 'rounds' → 必须走 create 现有 `meta.codeMode` 参数（L150）或按 preset
>     特判，否则 submit_code 掉进 else 立即热更分支（tools.ts L354）。→ v3 §3.1/§4-B 钉死。
>   - 提示 2：「code 有更新」判定无字段支撑 → v3 改 **roundBreak 对每个 ready 玩家无条件重传当前 code**
>     （幂等覆盖同一 $activeWorld 分支，省 diff）。
>   - 提示 3：observe 保持无副作用——**只有 drive 循环调 enterRoundBreak**（single-writer，与 settle 同构）；
>     observe 只返回 autoRound.due，client 轮询不驱动 phase 迁移。→ v3 §3.4 钉死。
>   - 提示 4：路径勘误——`src/client/match/board.tsx`（非 `src/client/board.tsx`；PHASE_META L47）。
>
> 依据（用户拍板，2026-09-09 晚，AGENTS.md「玩法方向」已钉死）：
> **world-live 连续世界（200-500ms/tick）与 LLM 分钟级决策 turn 难以结合**——LLM 改完代码世界已跑过几百
> tick、上下文扛不住长局高频介入；**故 Agent 参与对局形态 = world-rounds 回合制**：每个 Agent（DSH 会话）
> 一个席位，每周期各自提交脚本（commit = 进入本周期准备态）；仅开局由用户/观战者触发，之后所有 Agent
> 就绪即自动进入下一周期（周期边界暂停 → 战报唤醒 → 各自修改 → 全就绪 → 续跑）。LLM 的「拍」与世界
> 「周期」刻意对齐。
>
> 用户指令（本计划范围）：**① 把 world-live 删干净；② 实现 world-round（回合制）**。world-frozen
> （BotArena 式代码冻结纯 AI 对撞，M3 已验收）与 arena-blitz（1v1 镜像歼灭）**不在删除范围**——但 world-frozen
> 与 world-rounds 同属 form:'world'，计划内明确两者并存语义。

## 1. 目的与范围

**目的**：产品主线的 World 形态从「连续实时（live 热更）」切换为「回合制（周期提交）」。Agent 是唯一
参与者；人类只观战 + 仅开局触发。

**范围（做）**：
- A. 删干净 world-live：模型/工具面/HTTP/client/文档/测试用例全线移除 `world-live` 预设与「live 热更」产品
  语义（arena-blitz 仍保留 live 热更语义——它是 1v1 短平快预设法，不冲突）。
- B. world-rounds 机制：新预设 + 周期边界状态机 + 第三种 commit 语义 + 周期调度 + 工具/HTTP/client 适配。
- C. 验证：单测 + 真实私服 IT（≥2 周期真实对局）+ 真实 LLM 循环演练路径（TEST.md §9）。

**明确不做（范围外）**：world-frozen 产品建赛（维持 A0「人类建赛仅 live/rounds」）、arena-blitz 改动、
2v2 双房、击杀分到 T、interrupted 完整恢复演练、world-rounds 的复杂规则变体（多房/联机/竞猜/认证）。

## 2. 现状事实（已取证 + 一审复核，动手前再复核行号）

- **Preset/类型**：`src/host/match/model.ts` L19 `MatchPreset = 'world-live' | 'world-frozen' | 'arena-blitz'`；
  L50 `PRESETS['world-live'] = { form:'world', frozenCode:false, tickDuration:400, maxTicks:20_000, seats:4,
  scoring: DEFAULT_SCORING }`；`MatchState.codeMode`（**MatchState 字段，非 MatchConfig**）L22 类型
  `CodeMode = 'live' | 'frozen' | 'round'`（round = M4 赛事轮 token 门槛，**保留**，与新增 rounds 语义区分）。
- **状态机**：`MatchPhase` L18 = creating/placing/running/paused/settling/settled/interrupted；
  `ACTIVE_PHASES` L189；转移表 `TRANSITIONS` L199 附近 = running⇄paused 等。**无「周期边界」态**（AGENTS 坑②）。
- **`store.transition` extra 白名单**：`src/host/match/store.ts` L298 `Partial<Pick<MatchState,
  'startTick'|'endTick'|'winner'|'scores'|'assignments'>>`——**无 phaseTick**（阻塞 2）。
- **roundBreak→settled 相位白名单实为 4 处**（二审确认；投入时 grep `'running'` 相位比较逐一核对）：
  ① `store.transition` 拦截（store.ts L302-307）；② **`beginSettlement` journal 入口（store.ts L412-420，
  `phase!=='running'&&!=='paused'` throw——roundBreak 局可 settle 的必经点）**；③ lifecycle `settle()`
  gate（L368-370）；④ legacy settle（store.ts L358-373）。
- **submit 代码唯一通道**：`src/host/service.ts` L674-685 `submitCode(username, modules, branch='$activeWorld')`
  → `POST /api/user/code`（x-token）。creating 注入仅发生一次：lifecycle.start L210-216
  `createUser({ code: player.botCode ?? player.code ?? EMPTY_CODE })`（阻塞 1）。
- **submit_code 现状**（`src/host/tools.ts` L279-355）：frozen → 拒（L306）；round（赛事轮）→ roundToken +
  only-creating（L309-323）；creating → A0 暂存 `MatchPlayer.code` + `submitted=true`（L335-344）；placing 拒
  （L350）；else（live）→ `svc.submitCode` 立即热更（L354）。
- **preset enum 工具面**：tools.ts L455 `enum: ['world-live','world-frozen','arena-blitz']`；L474/480 create
  默认 `'world-live'`。
- **HTTP**：`src/host/http.ts` L71 `PRESETS: readonly MatchPreset[] = ['world-live','world-frozen','arena-blitz']`。
- **client**：`src/client/lobby/index.tsx` L36-39 预设数组含 `{id:'world-live', label:'World 持久扩张', seats:4}`
  + L9/L235 注释「人类建赛仅 live 预设」；**`src/client/match/board.tsx` PHASE_META L47（phase 文案/徽章映射）需补 roundBreak**。
- **client DTO guard**：`src/client/m4/api.ts` L32-61 `guardMatch`（名单在 client 侧，非 model/store）。
- **驱动面**：`service.ts` L886 `driveAllTournaments` 只扫 running tournaments；普通对局（含 world-rounds）
  **无自动驱动**（次要①）。
- **M4 followup 先例（送审点证据）**：`src/host/tournament/orchestrator.ts` L196 已在真实路径用
  `handle.agent.followup(...)` 驱动子会话——**host followup 为主通道成立**。
- **测试引用面（一审已逐文件比对全仓 grep，118 处 world-live 与计划 §2 清单一致）**：model.test L59/66/71、
  store.test L21/70/123、lifecycle.test L97/107/129/136/165/174/229/237/333/528-529、agents.test
  L83/144/188/189/194/246、admission/gate.test L72、tools.test L98/158/173/200/227/243/252/261/273/302/324/346/365/429
  （L324 是 live 热更语义专用用例）、http.test L74/107/132/160/175/220/258/288/319/349/416/422/429、http-m4.test
  L261/271、tournament/model.test L79（验证 world-live 被赛事拒→改 world-rounds 同样被拒）、IT match.it L45/67、
  tools.it L46、m2-battle L106（running 期 submit + L119 双房 rooms）、m2-closed-loop L97、http.it L89、
  scripts/probe-tools-it.ts L42、docs/plan-S12 L150、plan-M2 L10/130/149/154、plan-M3 L74/292/340/570/580、
  plan-M4 L282（round-submit 差异行涉及普通 world-live 热更）、TEST.md L91/212、README L19、AGENTS
  L193-202/272/283、LOG 历史条目。历史计划文档保留正文但加 superseded 标注。
- **M4 赛事不依赖 world-live**：tournament preset 只收 arena-blitz（`validateTournamentConfig` 拒 world-live
  是类型收窄，删后自动成立）。
- **m2-closed-loop 语义**：它测 Agent 循环（wait/report/热更跟随 + 世界推进结算）。world-live 删除后需要
  rounds 语义的等价循环验收（见 D 节改造）。

## 3. 设计定案（world-rounds 机制）

### 3.1 预设与配置
- `MatchPreset` 增加 `'world-rounds'`（AGENTS 既有命名；用户口语 world-round 等价，文档统一 world-rounds）。
- `MatchConfig` 增加 **optional** 字段（**不是 required——避免打爆存量 state.json，isMatchConfig 是 readState
  schema 闸，store.ts L141）**：`roundTicks?: number`（0 = 不启用周期边界，默认 0）、`maxRounds?: number`
  （0 = 不限，默认 0；>0 时校验 ∈[1,100]）。`PRESETS['world-rounds'] = { form:'world', frozenCode:false,
  tickDuration:400, maxTicks:20_000, seats:4, roundTicks:1000, maxRounds:8, scoring: DEFAULT_SCORING }`。
- `MatchState.codeMode`：world-rounds → 派生 `'rounds'`；world-frozen → 'frozen'；arena-blitz → 'live'
  **（落点钉死，二审提示 1）**：`store.create`（store.ts L162）按 `config.frozenCode` 默认派 codeMode，
  world-rounds（frozenCode:false）会得 'live' → 必须走 create 现有 `meta.codeMode` 参数（L150）显式传
  'rounds'，或 configFromPreset 时按 preset 特判——否则 submit_code 掉进 else 立即热更分支（tools.ts L354）。
- `PRESETS['world-live']` 条目**删除**；`MatchPreset` 类型去掉 `'world-live'`。

### 3.2 状态机（周期边界态）
- `MatchPhase` 增加 **`roundBreak`**（周期边界暂停：世界已 pause，等待全员 commit）。
- 转移：`running → roundBreak`（本轮 tick 已尽，自动）；`roundBreak → running`（全员 ready，自动续跑）；
  `roundBreak → settling`（maxRounds 尽 / lastStanding / 手动 settle）；`roundBreak → interrupted`（host
  启动扫描）。`ACTIVE_PHASES` 增加 roundBreak（暂停态算活跃，另一局不可并发）。`TRANSITIONS` 同步。
- **roundBreak → settled 白名单三处**（次要④，不能漏）：① `store.transition` 的 settling 拦截
  （running/paused→settled 走 journal）需把 roundBreak 列入「只能经 journal 离开 settled」的判定
  （roundBreak 也在其中）；② lifecycle `settle()` 的 phase 前置白名单；③ legacy settle 路径
  （若有独立 running/paused 枚举，全部加 roundBreak）。投入实现时 grep `'running'` 的相位比较逐一核对。
- `MatchState` 增加：`roundIndex?: number`（从 0 起）、`roundReady?: boolean`（roundBreak 期间全员是否已
  commit，resume 时清空）、`roundBreakSince?: number`（进入 roundBreak 的墙钟时间戳，roundBreakTimeoutMs
  计时基准；内存记录即可，重启即标 interrupted 不恢复）。
- **phaseTick（阻塞 2 修复）**：`state.phaseTick` 已有类型（L176）但无写入 → ① `store.transition` extra
  白名单加 `'phaseTick'`（L298）；② `lifecycle.start` 写 `transition('running', { startTick, phaseTick:
  snapshot.gameTime, assignments })`（第 0 周期起点）；③ `enterRoundBreak` 不写（pause 时 worldTime 冻结，
  phaseTick 保持本轮起点——autoRound 探测以「obs 的 gameTime - phaseTick」为准）；④ `resumeNextRound` 写
  `phaseTick: 当前 gameTime`（下一周期起点）。**autoRound 探测 `snapshot.gameTime - (state.phaseTick ?? startTick) >= roundTicks`**。

### 3.3 第三种提交语义（CodeMode 'rounds' + 代码真正进私服）
- `submit_code` 在 world-rounds：
  - `phase === 'creating'`：维持 A0 暂存（准备期脚本 = 第 0 周期前代码，start 注入）。
  - `phase === 'roundBreak'`：**commit = 就绪**——暂存到 `MatchPlayer.code`（覆盖本周期代码）+ `MatchPlayer.ready
    = true`（新增字段）+ submitted 保持 true；返回「已提交，待下一周期生效」。**此处只暂存不传私服**——真正
    上传在 resumeNextRound（见下）。
  - `phase === 'running'`：**拒绝**——「周期内代码已冻结，请在周期边界（roundBreak）提交下轮代码」。
  - `phase === 'placing'/'paused'(非 roundBreak)/settling'`：拒，说明原因。
- **resumeNextRound 必须先真正传代码（阻塞 1 修复）**：对每个 `ready===true` 的玩家**无条件重传当前 code**
  （二审提示 2：无 lastUploaded diff 字段，幂等覆盖同一 `$activeWorld` 分支无害，省 diff 判定），在
  **resume 世界之前**上调 `svc.submitCode(username, code, '$activeWorld')`（唯一上传通道，service.ts
  L674-685；窗口：已建号、世界 pause 中 → 安全；user.js L113 上传后清 VM 缓存 → resume 首 tick 读新代码）。
  - **失败降级语义（二审次要 3，钉死）**：任一玩家 submitCode 失败 → **该玩家沿用上一轮代码，已成功的玩家
    保持新代码，照常 resume + match.error 落盘**（部分更新混合跑是合理降级）；**不做「整轮不 resume 等
    超时」**（会与世界 pause 死锁）。单测断言「N-1 成功 1 失败 → resume 且 error 落盘」。
- 全就绪判定：roundBreak 续跑门槛 = `players.every(p => p.ready===true)`（botCode 座位自动 ready，见 3.4）。

### 3.4 周期边界调度（observe 驱动 + 驱动面扩展）
- `lifecycle.observe` 增强：若 `config.form==='world' && (config.roundTicks??0)>0 && phase==='running' &&
  gameTime - (phaseTick ?? startTick) >= roundTicks` → `autoRound: {due:true, index}`（复用「autoSettle
  探测同构」，**不落地、无副作用**——observe 保持只读，二审提示 3）。
  **只有 drive 循环调用 enterRoundBreak**（single-writer，与 settle 同构；client 轮询/观战者 observe 只拿
  `autoRound.due`，不驱动 phase 迁移）。
- `enterRoundBreak`：pause 世界（失败只记 error，round 边界语义仍成立——下一周期从 pause 前的 worldTime
  续跑）→ `transition('roundBreak')` → 触发「唤醒」（host followup，见 3.5）→ **botCode 座位自动置
  ready=true**（bot 无提交能力，沿用原代码；次要②）。
- 全员 commit 检测（每一次 observe / driveOnce）：roundBreak 且 `players.every(ready)` →
  `resumeNextRound(matchId)`（真传代码 → roundIndex+1、清 each ready、phaseTick 更新 → resume 世界 →
  running）。**自动续跑，无需人类介入**（用户定义：全就绪即自动进入下一周期）。
- 终止：`maxRounds>0 && roundIndex >= maxRounds` → 进 settle 判定（记分制，同 world）；lastStanding / 手动
  settle 不变。
- **超时/掉线兜底**（坑④）：`roundBreakTimeoutMs`（Config，默认 300s，**计时基准 = `roundBreakSince` 墙钟
  戳**）。roundBreak 停留超时后，未 commit 的玩家**沿用上一周期代码自动 ready**（不惩罚不卡死，error 记入
  match.error）+ 自动续跑；世界 pause 期间 host 重启 → 启动扫描按现状标 interrupted（roundBreak 是暂停态，
  标记路径与 paused 一致）。**bot 座位秒级自动 ready 不受超时影响**（与超时兜底是两条独立路径：bot 入场即
  ready；超时只针对迟迟未 commit 的 Agent 座位）。

### 3.5 唤醒通道（定案：host followup 为主，自调度为备）
- **证据**：M4 `tournament/orchestrator.ts` L196 已在真实路径用 `handle.agent.followup(...)` 驱动子会话
  （一审复核确认）；2026-09-09 真实测试亦证明 followup 底层 wakeDriver 自带 withInitiator 自动开子 turn。
- **定案**：roundBreak 时 host 对每个 Agent handle `followup(周期战报 + 提交邀请)`（主通道，可靠可测；
  spawn-Agent 局有 handle）。Agent 侧仍可用 schedule_create 自调度（备选，Agent 主动提前观察）。
- **AGENTS 坑③修订**（实施任务 A 含此项）：把「再激活机制」通道 2 与「玩法方向」坑③从「必须用 Agent
  自调度」改为「rounds 局 host followup 为主、自调度为备」。

### 3.6 工具/HTTP/client 适配
- `screeps_report(sinceTick?)`：roundBreak 阶段返回本周期战报（delta：分数变化、事件、己方报错、CPU），
  并提示「可在周期边界提交下轮代码」；`screeps_wait(ticks|seconds)` 跨周期语义 = 等下一观察点。
- HTTP：`PRESETS` 数组去 world-live；`GET /matches/:id` DTO 增加 **roundIndex / roundBreak / 每玩家 ready**
  （read-only，不泄 code/session；就绪状态公开合理，与 submitted 同级）——**动手点：client `guardMatch`
  （api.ts L32-61）白名单扩展**（次要⑥：名单在 client 侧，不在 model/store）。
- client lobby：预设数组 `[{id:'world-rounds', label:'World 回合制', seats:4},{id:'world-frozen',...},
  {id:'arena-blitz',...}]`；**`match/board.tsx` PHASE_META 补 roundBreak 文案/徽章**；详情面板周期进度
  （roundIndex/maxRounds、roundBreak banner、每玩家 ready ✅）；注释「人类建赛仅 rounds/live（arena-blitz）」。

## 4. 任务清单（删 world-live → 实现 world-rounds → 验证）

### A. 删干净 world-live
- [ ] model.ts：`MatchPreset` 去 'world-live'；`PRESETS` 删条目；`CodeMode` 注释去掉 live 与 world 绑定
  （live 仅剩 arena-blitz）；`configFromPreset` 分支同步。
- [ ] tools.ts：preset enum 去 'world-live'；create 默认改 `'world-rounds'`（无 preset 时走 rounds）——
  **默认值改动影响既有「无 preset 建赛」用例，全部显式化**（见测试迁移）。
- [ ] http.ts：`PRESETS` 去 'world-live'。
- [ ] client `lobby/index.tsx` + `match/board.tsx`（PHASE_META）：预设数组/注释/phase 映射同步（见 3.6）。
- [ ] **测试迁移（全量 grep 清单，§2）**：所有 `world-live` 用例按语义改：
  - 基础机制类（model/store/lifecycle/admission/http/http-m4/agents 的 count 范围/IT match/tools/http）→
    **`world-rounds`**（form:'world'，seats 2-4，tickDuration 覆盖逻辑不变）；
  - live 热更语义专用（tools.test L324 附近）→ **`arena-blitz`**（live 语义保留地）；
  - tournament/model.test L79（赛事拒 world）→ world-rounds；
  - scripts/probe-tools-it.ts → world-rounds；
  - **m2-battle 改造**（次要③）：world-rounds 下 round0 双 raider/raider-vs-idle 战斗（保留 links 双房
    rooms，world form 支持）→ roundBreak 提交新 bot 代码（如 idle→raider）→ round1 断言「新代码生效」
    （行为变化/战斗结果）→ settle。**删掉 running 期 submit 断言**（该语义随 world-live 消失）。
  - **m2-closed-loop 改造**（次要②）：world-rounds 下 Agent 循环（report/wait 跨周期、boundary 提交）→
    至少 2 周期推进 → settle；bot 座位自动 ready（见 3.4）。
- [ ] **旧 state.json 升级迁移（二审次要 2，必做）**：`isMatchConfig` 硬校验 `preset in PRESETS`
  （model.ts L215），删 world-live 后存量旧局（M2 时代真实留盘）→ readState 抛 corrupt → list()/active()
  **静默跳过**（store.ts L236-241）→ 旧局不可见/无法 settle/markInterrupted 扫不到、且可能绕过单活跃不变量。
  修法：启动扫描时对 `preset:'world-live'` 的存量 state **显式标 interrupted（带 error 注明「world-live 已废弃」）
  或剔除**，并补单测钉死「旧 world-live state 不破坏 list()/active()、被标 interrupted」。
- [ ] 文档：AGENTS（预设段 L193、玩法方向 L195-202 措辞、「验证」段落、**坑③修订见 §3.5**）、README（L19
  预设列表）、TEST.md（L91/212 及 §9 新增）、历史 plan 加 superseded 标注（**含 plan-M4 L282**；plan-S12
  L150 / plan-M2 / plan-M3 同），LOG.md M5 条目。

### B. world-rounds 模型（model.ts + store.ts）
- [ ] MatchPhase 加 roundBreak；ACTIVE_PHASES / TRANSITIONS / isActivePhase 同步；schema 校验。
- [ ] MatchConfig：roundTicks/maxRounds **optional + 默认 0** + 校验（>0 时 roundTicks∈[100,20000]、
  maxRounds∈[1,100]）+ codeMode 派生。
- [ ] MatchPlayer.ready；MatchState.roundIndex/roundReady/roundBreakSince；**transition extra 白名单加
  phaseTick**（L298）。
- [ ] store：roundBreak 持久化写路径；恢复扫描（roundBreak 算暂停态活跃 / 可 markInterrupted 除外逻辑与
  paused 一致）；**codeMode 派生走 meta.codeMode 显式传 'rounds'**（二审提示 1）。
- [ ] **roundBreak→settled 白名单 4 处**（二审次要 1，投入时 grep `'running'` 相位比较逐一核对）：①
  store.transition 拦截（L302-307）② **beginSettlement（L412-420，必加）** ③ lifecycle.settle gate（L368-370）
  ④ legacy settle（L358-373）。
- [ ] 单测：状态机各转移、rounds 配置校验（含 optional 默认 0 兼容旧 state.json）、roundBreak 持久化、
  phaseTick 写入、旧 world-live state 迁移（标 interrupted 不破坏 list/active）。

### C. rounds 提交语义（tools.ts）
- [ ] submit_code 分支：creating 暂存不变 / roundBreak commit=就绪（暂存 code+ready，不传私服）/ running 拒 /
  其他拒（见 3.3）。
- [ ] 单测：rounds 各阶段正负向（roundBreak 提交置 ready+code、running 拒、全员 ready 才续跑、超时兜底）。

### D. 周期调度（lifecycle.ts + service.ts 驱动面）
- [ ] observe：autoRound 探测（**用 phaseTick，见 3.2**）；`enterRoundBreak`（持锁幂等：pause →
  transition roundBreak → followup 唤醒 → bot 自动 ready）；`resumeNextRound`（**先 svc.submitCode 真传
  代码 → roundIndex+1、清 ready、phaseTick 更新 → resume**）；maxRounds/超时终止。
- [ ] **驱动面扩展（次要①）**：ScreepsService 的 drive 循环从「只扫 running tournaments」扩展为「同时扫
  running world-rounds 普通对局」（每拍：submitted→start / autoRound→enterRoundBreak / ready→resumeNext /
  autoSettle→settle，幂等；tournament driveOnce 保持不变）。
- [ ] **唤醒 followup**：roundBreak 对每个 Agent handle 发战报 followup（spawn-Agent 局）；测试注入 fake
  handle 断言恰一次。
- [ ] 单测：round 边界触发/幂等、超时兜底（沿用上周期代码）、maxRounds 终止、与 settle 并发单飞、
  submitCode 在 resume 前被调（fake service 断言）且失败降级。

### E. 工具/HTTP/client 适配
- [ ] report/wait 的 roundBreak 战报形状 + 描述；HTTP DTO + **client guardMatch 白名单扩展**（roundIndex /
  roundBreak / player.ready）。
- [ ] client lobby 预设/详情面板（周期进度 + ready ✅ + roundBreak banner）+ **`match/board.tsx` PHASE_META**。
- [ ] 单测：projection/report 新形状、panel 新增渲染、HTTP、guardMatch。

### F. 验证
- [ ] 单测全绿（新增 world-rounds 相关）+ typecheck/build。
- [ ] **IT1 `tests/m5-rounds.it.test.ts`（真实私服）**：create world-rounds（roundTicks 小值 如 100）→ 2 玩家
  （bot 注入 + 普通玩家）→ start → round0 running → autoRound（断言 phaseTick 驱动、roundIndex=0、世界
  pause、unwritten worldTime 冻结）→ 玩家提交下轮代码（commit=就绪 validate ready）→ **resume 前 submitCode
  被调（私服 users.code 变更新代码）** → 全员 ready → 自动续跑 round1（断言 roundIndex=1、**新代码生效——
  以 console/Memory 行为差异或战斗结果判定**）→ maxRounds 或 lastStanding → settle + winner + 记分。
  断言 zero orphan、无 `__bot__` 参赛痕迹。
- [ ] **IT2（改造 m2-closed-loop）**：world-rounds 下 Agent 循环（report/wait 跨周期、boundary 提交）→ 至少 2
  周期推进 → settle。
- [ ] **IT3（改造 m2-battle）**：round0 战斗 → roundBreak 换新 bot 代码 → round1 新代码生效 → settle。
- [ ] 旧链路零回归：全套 IT 迁移后全绿。
- [ ] **真实 LLM 周期演练**（TEST.md §9，用户批准额度后执行）：real-web-lane → spawn world-rounds 2 席 →
  真实 Agent 第 0 周期写代码 → 跑 round0 → 边界自动暂停 → **host followup 唤醒** → 真实 Agent 改代码 commit
  → 全就绪自动续跑 → 至少 2 周期 → settle。**这是「LLM 决策拍与世界周期对齐」的产品关键验收**。

## 5. 验收矩阵

| 面 | 必须证据 |
|---|---|
| 删除 | git grep 全仓库无 `world-live`（历史 plan/LOG 保留但 superseded 标注除外）；Preset 类型 / enum / PRESTETS 无残留 |
| rounds 状态机 | running→roundBreak→running 转移 + 全员 ready 自动续跑 + maxRounds 终止 + roundBreak 算活跃 + **phaseTick 有写入** |
| commit 语义 | roundBreak 提交置 ready+code（**resume 前真传私服，下轮生效**）；running 拒；开局 A0 暂存不变；bot 自动 ready；超时沿用旧代码续跑 |
| 调度 | autoRound 幂等单飞（与 settle 并发不双计）；followup 唤醒恰一次；restart 不 die rounds 状态；drive 面扩展覆盖普通 world-rounds 局 |
| 工具/HTTP/client | report roundBreak 战报；DTO 有 roundIndex/roundBreak/ready（guardMatch 白名单）无内部字段；lobby 预设含 world-rounds 无 world-live；board PHASE_META 有 roundBreak |
| 验证 | 单测全绿 + IT1（真实私服 ≥2 周期、新代码生效）+ IT2/IT3（循环/战斗改造）+ 全套 IT 零回归 + TEST.md §9 真实 LLM 演练路径（执行需用户批准额度） |
| 公平边界 | 无 `__bot__` 参赛痕迹；DTO/HTTP 无 sessionId/代码泄漏；ready/submitted 公开但隔离内部信息 |

## 6. 风险与遗留（范围外 → 持续遗留）

- world-frozen 保留（BotArena 式纯 AI 对撞，与 LLM 周期不冲突）；arena-blitz live 热更保留。
- 多 host/多赛事并行、认证继续不排。
- interrupted 完整恢复演练、2v2 双房、击杀分到 T 持续遗留。
- roundBreak 期间 host 重启：按现状标 interrupted（恢复演练遗留）。
- 真实 LLM 演练需要用户批准消耗额度；未批准前以 IT1/IT2/IT3 全绿 + TEST.md §9 就绪为准。