## 09-09 M5 浏览器视觉复核（browser-mcp accessibility 快照，零额度）——暴露并修复 client 三处遗漏

**起因（用户问询纠正）**：用户问「为何要人工浏览器复核——是 browser-mcp 没连上还是本 Agent 测不了」。
实际答案：browser-mcp **默认就是连接的**（M4 记录的「需手动 Connect」说法作废——仅当 MCP 调用报连接类
错误时才提醒用户排查）；且要验的三项全是 DOM 文本级，accessibility 快照即可判定。**两条纪律（用户拍板，
已沉淀 AGENTS.md）：① browser-mcp 默认已连接，直接用，连接失败才提醒排查；② 测试凡 MCP 可自动化完成的
一律 Agent 自动做，不推给人工——人工测试仅限 MCP 确实达成的验证。**

**复核中发现并修复三处 client 遗漏（plan §3.6/E 应有项，首轮实现只做了徽标）**：
1. lobby 预设下拉的可访问名残留 M3 文案「World 持久扩张（人类建赛仅 live 预设）」→ 改「World 回合制
   （周期提交；人类建赛仅此两预设）」（`lobby/index.tsx` title）。
2. **看板缺周期进度与 ready 标记**：`board.tsx` 仅 PHASE_META 加了 roundBreak 徽标——补「周期 N/max」
   进度、roundBreak banner（commit=就绪/超时沿用旧代码说明）、每玩家 ⏳/✅ 标记；lobby 列表 phase 文案
   roundBreak → 「周期边界」+ ready ✅（PHASE_COLOR 补 roundBreak）。
3. `guardMatch`/panel 数据流缺 maxRounds（原始 DTO 嵌在 config 里）→ guardMatch 抽取 + panel 拍平。

**验证方法（可复用，零额度）**：HTTP create world-rounds + `tickDuration:50`（1000×50ms≈50s 一轮）→
smoke state.json 直补第二玩家（HTTP join 已移除，仅测试环境可行）→ start → accessibility 快照断言：
下拉「World 回合制」/ 徽标「周期边界」/「周期 3/8」/ ⏳ 标记 / banner 全文，全部在快照文本中出现。
**工具坑**：browser-mcp click 的 WebSocket ack 偶发 30s 超时但点击实际生效——超时后先 snapshot 再判断，
不要重试点击（会把刚打开的看板 toggle 关掉）。

**验证**：typecheck 0 错、344 单测绿、build 绿；复核完成后 settle+DELETE 清理验证局、停 lane、清孤儿
私服（精确 pgrep 锚定）。

## 09-09 M5 真实 LLM 周期演练收官（TEST.md §9 执行，用户批准额度）——M5 全项完成

**链路**：s12web real-web-lane（3200，无 stub，openrouter/deepseek-v4-flash）→ `POST /spawn-agents
{preset:world-rounds,count:2}` → 真实 Agent `agent_byte`/`agent_delta` 各 ~1 分钟 turn 起名入座 + 提交
round0 脚本（creator `screeps_match create`/join/submit_code creating 暂存全走工具面）→ creator sessionId
start → running（phaseTick=34620，随机房 W82N51/W80N49）。

**周期循环实测（时间线）**：
- 09:49:20 start → 09:56:00 **drive 循环准点 enterRoundBreak**（roundTicks=1000 × 400ms ≈ 6.7min，roundIndex=0）。
- 09:58:47 `agent_byte` **真实 commit**（followup 唤醒 → screeps_report 看战报 → submit_code=就绪）：
  代码从 round0 单 harvester bot **迭代为 harvester/upgrader/builder 三角色新脚本**（6916 字符）——
  「LLM 决策拍与世界周期对齐」的产品核心闭环首次真实成立。
- 10:01:03 自动续跑 round1：恰好 roundBreakSince+300s，`agent_delta` 未 commit → **超时兜底路径触发**
  （沿用旧代码自动 ready + `error="round break timeout: agent_delta kept last-round code"` 落盘，世界不卡死）。
- 10:07:57 round1 边界 → 第二次 roundBreak → 10:10:57 续跑 round2（本轮双 Agent 均超时兜底，同为设计路径）。
- 10:11:46 手动 settle → **settled，draw 200:200**（和平发育记分平局），error 保留超时注记。

**排障记录**：s12web profile 的 `node_modules/dsh-screeps` 是 **9月8日的拷贝快照而非链接**
（.modules.yaml 写 link 但实体是复制目录）→ 首 POST 撞旧 enum（`preset must be one of world-live…`）。
修复 = `dsh plugin --profile s12web add <repo>` 重装 + 精确清两个孤儿私服（`pgrep -af 'screeps.js start'`
锚定 PID 后 kill）。**教训：file: 依赖的 profile 升级后必须重装插件或核对拷贝体，不能假设链接生效。**

**M5 验收矩阵全项达成**：删除 ✅ / rounds 状态机 ✅ / commit 语义（真实 commit + 超时降级双路径）✅ /
调度（drive 准点 + followup 恰一次）✅ / 工具·HTTP·client ✅ / IT1-3 + 全套 14/14 ✅ / **真实 LLM 演练 ✅** /
公平边界（无 `__bot__` 参赛、Agent 只见自己投影）✅。

## 09-09 M5 实施收尾（代码 A–F 全落地 + IT 竞态三案根因修复；14/14 IT 全绿）

**完成（承接 plan-M5 v3，续会话）**：A 删 world-live（含旧 state.json 升级迁移）+ B/C/D/E world-rounds
全链（roundBreak 状态机/commit=就绪/resume 前真传私服/drive 面扩展/followup 唤醒/HTTP+client 适配）。
验证：typecheck 0 错、**344 单测绿**（+新增 lifecycle-rounds 专项）、build 双产物绿、**14/14 IT 全绿**
（run1:5 失败 → run3:4 → run4:2 → run5:0，逐案修复全程留痕 /tmp/m5-it-run{1..5}.log）。

**IT 竞态三案（本 session 破案与修复，均非 M5 逻辑回归）**：
1. **遗留活世界复活竞态（产品级修复）**：前局收尾 pause HTTP 失败 → SIGKILL 后 db.json 留
   `mainLoopPaused=false`；下一局 `start` 在**未停拍的遗留世界上直接 resetArena**，在途 tick 房间数据
   写回把旧 `controller.user` 复活 → `createUser` 撞 "already owned"（arena-mod realCreateUser 的
   reservation 注释同族现象，M3 时代用「另选全新房」绕过过）。修复 = `lifecycle.start` resetArena 前
   **先 pause + 1.2s 落拍等待**（`startPauseSettleMs` 构造参数，单测置 0 免拖慢）；run4 起
   "already owned" 绝迹。lifecycle.test 精确序断言同步补 `pause`。
2. **raider 测试 bot 卡 controller（潜伏 bug，随机布局抽签）**：`FIND_HOSTILE_STRUCTURES` 含敌方
   controller，而 `attack(controller)` 恒 ERR_INVALID_TARGET——controller 恰好路径更近时 raider 永久
   卡在旁边空挥（run4 实锤：两 creep 卡 (37,22) 紧贴 controller(37,23)，180s 零进展）。修复 = 显式剔除
   `STRUCTURE_CONTROLLER`（tests/fixtures/bots/raider + m2-battle ATTACK_BOT 同款）。
3. **观察窗负载性误报**：满套件尾段 CPU 饱和下 tick 显著变慢，放宽 settle/观察窗
   （m4-tournament 240s / m3-arena·m3-frozen 180s / m2-battle 150s）。

**测试迁移补漏**：m2-closed-loop/m2-battle 的「running 期热更」旧断言改 creating 暂存（plan §A）；
tools.it 热更语义用例迁 arena-blitz；m5-rounds.it 终态探测改 store.get（observe 对 settled 抛 badPhase）；
TEST.md L91 world-live 残留 + M2 历史节 superseded 标注。

**遗留**：真实 LLM 周期演练（TEST.md §9）待用户批准额度后执行；「already owned」的 pause-HTTP-失败
根源（负载下 express 卡死）未深挖，pause-first 已掐断竞态但 stop() 的 pause 失败仍会留活世界（下局
start 的 pause-first 兜底）。

## 09-09 world-rounds 记录缺失纠错（用户问责：方向写了但理由与执行全缺，拖了两个里程碑）

**背景（用户批评，属实）**：09-09 早间「验收面收敛 + world-rounds 玩法方向（用户对齐）」里，用户明确
拍板产品主线的 Agent 参与形态 = world-rounds 回合制（world-live 连续实时世界与 LLM 分钟级决策拍难以结合
是**用户给定的核心理由**）。当时 AGENTS.md 只写了「玩法方向…暂不排期」一句话，**用户拍板的理由一个字
没写进 AGENTS.md**；且此后 M3→M4 一路过去，world-rounds 从未被带回排期。恶果实锤：本 Agent 自己在
09-09 晚推荐「真实跑 world-live 验证」——恰好是用户已否定的方向，只因理由缺失而遗忘结论。

**本次纠错**：
1. AGENTS.md「玩法方向」段重写：① 补入用户给定理由「world-live 连续世界（200-500ms/tick）与 LLM 决策
   turn（分钟级）难以结合，LLM 改完代码世界已跑过几百 tick、上下文扛不住长局高频介入」；② 删「暂不排期」，
   更正为「产品主线的 Agent 参与形态；曾被误标暂不排期拖了两个里程碑，2026-09-09 晚间更正回主线」；
   ③ 已知设计坑标注「排期时解决」。
2. 教训沉淀：**用户对玩法/规则的拍板理由，必须原文记入 AGENTS.md（含「为什么」），角色定位/形态类决策
   不得自行标注「暂不排期」——只有明确说「先不做」的才算排期外**；里程碑收尾时把 AGENTS 里的玩法方向
   逐个过一遍，「已拍板未排期」应主动列进下一里程碑候选，不能躺着被遗忘。

**验证**：AGENTS.md L195 段重写生效；本条目倒序置顶；待 commit 与 AGENTS.md 同批。

## 09-09 真实 LLM 全链首次实测（开天辟地：人类指令 → 真实 Agent → 真实私服战斗 → 结算）+ {{model}} 守卫修复

**背景（用户批评成立）**：M3/M4 的 web lane 验收全部走 stub provider（零额度确定性适配器）——编排链全真、
但 Agent 决策是脚本模拟。所有「全链实测通过」的汇报都没主动提醒「真实 LLM 驱动的对局从未跑过、且需消耗
用户额度」，拖到 M4 完成后用户才发现。用户指示：立即自己跑一次真实测试。

**真实测试结果（全链闭环，2026-09-09 05:32-05:43）**：
- 真实 lane（`scripts/acceptance/real-web-lane.yml`，s12web@3200，**无 stub 插件**，provider=openrouter +
  model=deepseek/deepseek-v4-flash-0731，key 由 `~/.dsh/.credentials.yaml` 解析，无需 env 导出）。
- `POST /spawn-agents {preset:arena-blitz,count:2}` → 202 → **真实 LLM 会话 screeps-player-1/2 各完成 2 个 turn**：
  起名入座（`TacticalShrimp` / `DeepSeekNest`，screeps_match create/join）+ 编写提交 **10KB+ 完整 Screeps bot
  代码**（screeps_submit_code，player1 还迭代 5 次）。全就绪。
- start → running：arena-blitz 镜像地图真实跑 **2847 tick**（≈7 tick/s），双方 spawns=1/ownedRooms=1/rcl=1
  镜像对称分配确认；gameTime 推进实测（12s +81 tick）。
- settle：autoSettle due=ticksExhausted；**比分 +24 / -24（DeepSeekNest 击杀 24 分 vs TacticalShrimp 损失 24）**
  ——真实战斗发生；**winner = DeepSeekNest（screeps-player-2-e2c58cac）**。phase=settled revision=4。

**修复（真实链路一跑就暴露的产品级 bug，同 M2 血泪教训族）**：
- **`{{model}}` 无值崩 turn**：spawn 时 agentOptions 不传 model → persona 组装 `prompt variable "{{model}}"
  has no value` → 子会话 turn 直接 error、对局永不建出、无任何可读报错。stub lane 全靠请求体带
  `model:stub-model`/stub 插件兜底躲过去了——**插件产品层零防御**。
- 修复：① `orchestrator.spawn` 前置防御（无 model 抛可读错误、不创建会话）；② HTTP `spawn-agents` 同步
  400 预检（`effectiveModel = body.model ?? services.agentModel`，无 → 400 明确指引）；③ Service 暴露
  `agentModel` getter；④ +2 单测钉死（orchestrator 拒 / HTTP 400）。全量 **337 单测绿**、typecheck/build 过。

**验证证据**：真实会话 session.jsonl（turn 1/2 completed，无 error）；match state.json（players code 10KB+、
winner+scores 权威）；world 快照（gameTime/spawns/rcl 推进）；observe 端点（autoSettle due）；settle 后
phase=settled + revision=4。

**遗留/备注**：普通 spawn 局（非 tournament）无自动 settle 驱动——observe 判 due 后需观战者/Agent 触发
settle（tournament 由 driveOnce 自动）。真实 lane 的 agentRecruitTimeoutMs 用了 300s（真实 LLM 写代码较慢）。
真实对局每分钟烧少量额度（flash 模型，2 席单局约 4 个 turn）。下游：真实 world-live 多 Agent、world-rounds
仍排期。

## 09-09 M4 事件 2：client guardTournamentDetail 解包 bug（browser-mcp 实测实锤）

**做了什么**：
- 现象：browser-mcp @3200 点赛事详情时，面板永远停在 `recruiting 选手（0/4）`，但列表已 `ready 4`。
- 根因：`GET /tournaments/:id` 响应是 `{ok:true, tournament:{...}}`，client 的 `guardTournament(raw)` 直接拿
  `raw.tournamentId`（undefined）→ guard 失败 → 详情永不更新（列表用 `guardTournamentList` 数组元素是完整
  对象所以正常）。jsdom 单测只测了 list/直传形状，没测详情包装——**真浏览器响应形状与单测假设不一致**。
- 修复：`api.ts` 加 `guardTournamentDetail = guardTournament(raw.tournament)`；tournament-panel / bracket-view
  的详情轮询改用之；+1 单测钉死（解包成功 / 直接传完整对象失败 / null 安全）。commit `66dc25d`。
- 顺带 browser-mcp UI 全链实测通过：建赛 → 202+quotaWarning → ready（4 roster）→ 详情渲染
  （選手 4/4 + 「▶ 开始赛事」）→ start → running + bracket 列（r1s0 running Agent1 vs Agent2 + 看板入口、
  r1s1 pending）+ 頭 creation 的 attempt 对局出现在列表。DTO 无 sessionId/__bot__。

**验证证据**：client m4 测试 16 绿；typecheck/build 过；3200 GUI accessibility 快照实测（上文）。

# LOG — dsh-screeps 工程日志

约定：**每个里程碑/重要调试一条，倒序追加**。条目必须有：commit、改动、验证证据、遗留。
新会话先读：本文 + `AGENTS.md`「生命周期与调试陷阱」+ `docs/spikes/m0-flake.md`。
调试结论沉淀到 `docs/spikes/`，本文只记"做了什么、证据是什么、还欠什么"。

## 09-09 M4 赛事/回放/历史（A0→F2 全链落地）

**做了什么**（M4 里程碑 B/C/D/E/F 连续执行，commit 链：`eddaede`(A0 bridge) → `24d8dee`(M4-B) → `c4c4e8a`(AGENTS 中文纪律) → `86423cd`(M4-C) → `6153a98`(M4-D) → `f4a6287`(D 收尾) → `fb7ebc9`(M4-E client) → `e9eab4c`(F.1 编排驱动) → `34ce447`(F.2 web lane)）：
- **A0 canonical replay bridge**：arena-mod schemaVersion=1 bridge（roomsDone 边界 frame/gap + generation/seq + backpressure/fatal），真实私服三档实测。
- **M4-B 持久层**：TournamentStore（requestId 幂等/no-clobber）、ReplayStore（frame.jsonl+manifest+checkpoint、可见水位、torn tail recovery）、HistoryStore（不可变 MatchResult + leaderboard tie/rank）、AdmissionStore/Gate（`held`/`recovery`/`tournament`/`match` 检查闭合 M3 缺口）、MatchStore settling journal（begin/mark/commit/abort 全 revision CAS + roundTokenHash）、RecoveryCoordinator（独占 recovery→reconcile→级联中断→release）。
- **B5/M5 结算唯一顺序**（plan §3.2 钉死）：observe 一次固定 candidate → beginSettlement(durable) → pause(失败只记 error 保持 settling) → replay marker（replayMetaHash 权威 receipt）→ HistoryStore.put + history marker → 注入 TournamentGateway.applyResult + tournament marker → commitSettlement → 仅此后 onSettled hook/orchestrator 推进。receipt hash 三源分离（replay=replayMetaHash；history&tournament=同一 MatchResult 同一 resultHash）。reconcile 绝不重算 candidate。
- **M4-C 赛事层**：TournamentService（create/recruit/retry/dispose/handlesByTournament）、TournamentOrchestrator（start/activateCurrent/onMatchSettled/draw-rematch/single-active guard）、roundToken 只存 sha256（明文仅内存+prompt）、submit_code 对 round 局校验 token + only creating 窗口。
- **M4-D ReplayRecorder/HTTP**：bridge→store 采集（begin/drain/drainAll/finish 全量 drain→stop→残余 append→finalize）、sanitizer（username→participant）、路由 `POST/GET /tournaments`、`/start`、`/retry`、`/bracket`（纯投影）、`/history/leaderboard`、`/matches/:id/replay`（cursor/afterTick/limit + unavailable 不伪造）。
- **M4-E client**：m4/projection.ts（bracket 列/slotLabel/replay timeline/seek/leaderboard 纯函数）、m4/api.ts（strict DTO guard 丢弃 settlement/journal/session/内部 frame 字段）、replay-player（播放/暂停/seek/partial/gap banner）、bracket-view、leaderboard、tournament-panel（roster/start/retry/bracket/replay/leaderboard 一体）、lobby 接入赛事入口 + 额度/纯 Agent 文案；jsdom 测试 15。
- **M4-F 验证**：驱动循环（driveAllTournaments interval + driveOnce）、**restart 只停服务不 die orchestrator**（原 shutdown() 把 running 赛事标 interrupted，M4-F.1 dbg 实锤）、gateway conflict 附 reason、真实私服 composition IT（4 席两轮 3 场 raider vs harvester → completed + 冠军 + 4 handles 全 dispose + 无 `__bot__`）、web lane（3200 + stub provider：建赛 202 → ready 4 roster → start running → bracket 投影无 sessionId/__bot__）。

**验证证据**（全部本环境实测）：
- 单测 **336 绿 / 1 skip**（M4 +10 projection/guard、+3 replay-player、+2 tournament-panel、+3 driveOnce）。
- 双 program typecheck 0 错；`npm run build` 成功（host+client 双产物）。
- **全套真实私服 IT 13/13 全绿**（含 m0-match/m2-battle/m2-closed-loop/m3-arena/m4-replay/m4-tournament/match/http/service/tools）零孤儿零 `__bot__`。
- **M4-D.4 replay generation 隔离**：reset→begin g1→frames→pause→finish complete；resetArena 后旧 gen 不可读、新 g2 隔离、两局独立可读。
- **M4-F.1 composition**：首轮 2 场 + 决赛场全 settle → completed；记录重复推进；单活跃席位释放。
- **M4-F.2 web lane**：`POST /tournaments {seats:4,provider:stub}` → 202 recruiting+quotaWarning → ready(4) → start running → bracket 投影（Agent 1-4 alias）；DTO `不包含 sessionId`、`不包含 __bot__`；leaderboard 空态；replay unavailable 不伪造。

**遗留**：
- host 后台 spawn 子会话 turn 需要宿主 turn 上下文（withInitiator）：纯 HTTP fire-and-forget + followup 在 web lane 不会自动开 stub 子 turn → 完整对局推进由真实私有 IT 覆盖（fake registry + driveOnce 手动）。web lane 到 ready/start/bracket 全绿。
- browser-mcp 需用户手动 Connect 扩展后才能做 UI accessibility 四项（TEST.md §7 指引）；Agent 已用 curl 跑通 host 侧全链。
- World round（world-rounds）另排期；interrupted 中断局的完整恢复演练、2v2 双房、击杀分到 T 为 M3 遗留持续推进。

## 09-08 M3 UI 交互验收（browser-mcp）+ store 串行化修复（血泪 bug #4）

**做了什么**：
- **UI 交互验收（client 层，browser-mcp @3200，stub 半分层）**：侧边栏「Screeps 对局」区块渲染
  （预设下拉 + Agent 数 + 「⚔️ 新建对局」+ 对局列表）；点「⚔️ 新建对局」在活跃局存在时显示
  `active match <id> (config) must settle first`（预检 409 + 错误 UI 渲染，零 LLM 消耗）；
  点 creating 局开准备室（玩家卡牌 `red/blue · ✓ 已就绪（已提交脚本）`，M3 submitted 展示）；
  点「▶ 开始对局」→ busy「开赛中…」；列表 phase 变化 3s 内轮询反映。
- **无障碍改进（client lobby）**：对局列表项加 `role="button" + tabIndex + onKeyDown(Enter/空格)` +
  aria-label——之前是裸 div，accessibility 树不可达（browser-mcp 点不到）；这也是真实键盘可达性改进。
- **store 读-改写串行化（血泪 bug #4：UI 点击 start 暴露产品级并发 bug）**：
  - 现象：UI 点「▶ 开始对局」报 `match <id>: creating → running not allowed`（curl 没撞上）。
  - 根因：`lifecycle.start` 里 `transition('placing')` 与循环内 `store.update`（回填 userId）
    **并发读-改写竞态**——update 基于旧 creating 快照写回，把 phase 打回 creating，`transition('running')`
    被状态机拒。store 注释声称「由 MatchStore 实例串行化」但实现无锁。
  - 修复：MatchStore 全部写操作（create/update/transition/addPlayer/settle/remove/markInterrupted）
    经内部 promise 链 `serialize()` 串行；**settle/markInterrupted 内部不再嵌套调 this.transition
    （会经同一链排队 = 死锁），改直接写 state**。补单测：并发 transition+update 不覆盖 phase
    （`serialized writes` 测）+ settle 不死锁。
  - 之前第 3 条的「tmp 随机后缀」只修了 rename 踩踏（文件级），本条修了读-改写覆盖（语义级）——
    两者都是 UI lane 实测抓到的，headless/单测装置都测不到真实并发时序。
- **验证证据**：单测 166→**168 绿**（+2）；build/typecheck 过；curl 直测 start 一次通过
  （`ok:true phase:running assignments:{player1:W15N15, player2:W14N15}`）；settle → settled/draw；
  UI 列表轮询显示 creating→running→settled；**零孤儿**（本次 disposer 未等停服又成一组孤儿，
  精确锚定 pkill 清理——停服序列纪律再记一次）。

**遗留（不变）**：2v2 双房、击杀分到 T、interrupted 恢复、world-rounds；browser-mcp 点击通道不稳定
（snapshot/轮询可用，click 30s 超时偶发）——M3 UI 验收已用「curl 直测同一端点」兜底，记入 TEST.md。

## 09-08 M3 Arena blitz 全链落地（A0-A-E 实现 + F 收尾）

**本条目范围**：plan-M3 v5.5（七审 PASS）的 A0/A/B/C/D/E 全部实现 + F 文档收尾。commit 待用户确认后执行。

**做了什么（按 plan 章节）**：
- **A0 人类建赛 spawn N Agent 玩家**（P0 阻塞 1 修法）：
  - `src/host/agents.ts`（新）`SpawnOrchestrator`：spawn N 会话 → A1 create 引导 → pollUntil store.active
    → 打标 `spawnedBy='agents'` → A2..N join 引导 → script 引导（暂存式 submit）→ 全 submitted；
  - `src/host/service.ts`：`spawnAgentMatch`（HTTP 薄封装）、`getOrchestrator`（`ctx.get('agents')` 探测）、
    Config 加 `agentModel`/`agentRecruitTimeoutMs`（180s 默认，120-300 可配）；
  - `src/host/http.ts`：`POST /dsh-screeps/spawn-agents` → 202 + `{recruiting:true}` 异步编排；预检
    preset/count/activeExists；**join 端点已移除**（唯一入座通道 = 工具面 `screeps_match` join，HTTP 不暴露）；
  - client `lobby/index.tsx`：建赛 = 预设下拉 + Agent 数 + 「⚔️ 新建对局」按钮（发送 spawn-agents）；
    `board.tsx` 显示 submitted ✅。
- **A arena 镜像（screeps-mod/arena-mod.cjs）**：`arenaGen` CLI 命令（base generateRoom{controller,exits} →
  镜像=东邻 `roomNameFromXY(x+1,y)` → `addWalledNeighbors(镜像)` 先于 `updateTerrainData` → terrain 2500 字符
  每 50 一行反转（x'=49-x）→ objects 对称复制 x'=49-x）→ restart 后地形缓存生效；`reverseTerrain`/`arenaProbe`
  契约命令。
- **B host arena 接线（lifecycle.ts）**：start gate（仅 `spawnedBy==='agents'` 局要求全员 `submitted===true`，
  普通局零门槛零回归）；assertUniqueUsernames 前置；arena 拒 rooms；arena 分支 `system('arenaGen')` +
  assignments {0:W15N15, 1:W14N15}；code = `botCode ?? code ?? EMPTY_CODE`（暂存式 submit 与 botCode 同构）。
- **C world-frozen 闭环**：frozen 拒 submit（placing 显式拒）；world 出局判据 = spawns==0 **且** creeps==0
  （无 creeps 字段降级 spawns==0）；测试 bot raider（`tests/fixtures/bots/raider/`）纯 IT 驱动。
- **D 测试 bot 降级**：raider 走 `BotRegistry.load + store.addPlayer` 内部链路（产品功能不做预置对手）。
- **E 验收**：
  - IT1（`tests/m3-arena.it.test.ts`）：create arena-blitz → 注入 raider → addPlayer harvester → start →
    arenaProbe 断言镜像对称（terrain 反转 + objects x'=49-x）→ writeMemory 注入 targetRoom → 跨房战斗 →
    eliminated → lastStanding → winner。
  - IT2（`tests/m3-frozen.it.test.ts`）：create world-frozen → raider vs idle → submit 拒断言 →
    spawns+creeps==0 → settle。
  - **A0 集成验收（web GUI lane @3200，stub provider 零额度）**：`dsh --profile s12web --patch
    scripts/acceptance/a0-web-lane.yml --no-open` + HTTP spawn-agents 全链实测（见下「验收证据」）。
- **F 收尾**：本文 + AGENTS.md + TEST.md 同步。

**验证证据**：
- 单测 **166 passed / 1 skipped**（新增 agents 12 测、lifecycle 23 测、store 并发写 1 测等）；
  `npm run typecheck` + `npm run build` 通过。
- IT **11/11 全绿零孤儿**（约 6.6 分钟）：IT1 arena-blitz 62.7s（镜像对称断言 + 跨房歼灭）、IT2 world-frozen
  44.9s、旧 9 IT 零回归。
- **A0 web lane 全链实测（2026-09-08, 3200）**：`POST /spawn-agents {preset:arena-blitz, count:2,
  provider:stub}` → 202 recruiting → poll 见 creating 局 `spawnedBy=agents` + 双玩家 submitted:true →
  creator start → phase=running → world 显示 `stub_pa1@W15N15` / `stub_pa2@W14N15`（镜像分配正确）→
  gameTime 推进 → settle → phase=settled（winner=draw，双方 stub 代码不打架，符合预期）。

**调试收获（重要，已沉淀进 AGENTS「生命周期与调试陷阱」）**：
1. **spawn 会话 create 必须带 `meta.cwd`**：缺 → DSH persona 组装 `{{cwd}}` 无值 → A1 turn 直接 error
   （`prompt variable "{{cwd}}" has no value`），对局永不建出。真实 web lane 实测才暴露（headless stub
   装置被 inactive-context 挡住，见上一条 e2e 结论）。
2. **`MatchStore.writeState` 原子写竞态（真实 bug，已修）**：固定 tmp 文件名 `state.json.<pid>.tmp` 在
   同一进程并发写（start 编排与 spawn 收尾）时互相 rename 踩踏 → `ENOENT rename tmp→state.json`。修复：
   tmp 加随机后缀（`randomBytes(6).toString('hex')`），补并发写单测钉死。**这是 A0 集成验收直接抓到的
   产品级 bug**——headless/stub 装置测不到真实 HTTP start 并发。
3. **验收 stub 插件（scripts/e2e-stub-plugin.mjs）设计教训**：LLM adapter 的 stream 调用次数 ≠ 工具步骤
   （DSH 一个 turn 内多次调 stream：工具结果后还会再调）——按调用次数计数判阶段会漂移；改成**按消息内容
   判阶段**（含「编写你的 Screeps 脚本」→ submit；含工具结果 → 已入座）才稳定。matchId/preset 要从
   **user message**（followup 文案）提取，不在 system prompt。
4. **config.agentModel 无默认值**：patch 不配 `agentModel` 时 spawn 出的 agent 无 model → `{{model}}` 无值
   同崩。stub adapter 缺省兜底 stub-model（测试装置侧防御）。

**遗留（M3 排期外，见 plan-M3「明确不做」）**：2v2 双房对拼、击杀分到 T 提前终止、interrupted 恢复、
world-rounds 回合制预设（2026-09-09 方向，规则细化另排期）、world-frozen 人类建赛（仅 botCode 测试链）、
e2e-stub-plugin.mjs 是临时验收装置（验收后清理，不入发布包）。

## 09-09 验收面收敛 + world-rounds 玩法方向（用户对齐）

**背景**：用户明确「斗蛐蛐」方式——每个 Agent 一个 Session，每周期提交脚本（commit = 进入本周期准备态）；
仅开局由用户触发，之后所有 Agent 就绪即自动进入下一周期。同时澄清 Session = DSH Session（exec.agent.id
→ host 映射 → Screeps 用户，即公平边界）。

**doudizhu 调研结论（可引用证据）**：`github.com/AwesomeHou/dsh-doudizhu`（master v0.3.2, 2026-08-29）
README 的 M3「DSH Agent 桥接」**只有文档规划**（路线图.md L77-89 任务表/验收/估时 2-3 周），`src/index.ts`
仍是 M1 加载日志 + 注释占位（"M2 起在此注册本地工具"未实现），`worker/` 全是 M2 Cloudflare PVP——**无任何
Agent 作为牌手的落地代码**，无可抄实现。

**决策（三件）**：
1. **验收面收敛**：对局逻辑闭环 → IT（进程内多 session 模拟，`makeExec('sess-1'/'sess-2')` 已在 tools.test
   打底）；UI/用户触发/观战 → browser-mcp（S12 已过）；**headless 只留「加载冒烟」（world_status 检查）**。
   **headless bot 注入通道遗留关闭**——不再做「配置开关/预注入/测试工具」候选（IT 已覆盖完整战斗闭环）。
2. **world-rounds 回合制 = 玩法方向**（暂不排期）：周期边界暂停 → 战报唤醒 → 各自修改 → commit（=就绪）→
   全就绪 → 续跑；规则细节（tick 长度/超时/暂停语义）待后续细化。已写入 AGENTS「玩法方向」节 + plan-M3
   「明确不做」留档。
3. AGENTS.md「测试专用 bot」措辞 /headless 同步（"仅用于自动化测试/IT 验收"，不再提 headless 验收驱动）。

**验证**：纯文档决策，无代码改动；既有基线（140 单测 / IT 全绿）不受影响。

## 09-09 M3 计划对齐修正（纯 Agent 对战；bots/ 降级测试；M3 计划 D 节废弃预置对手）

**起因**：用户审 M3 计划书 v4 时指出——「bots/ 预制对手」从未在早期讨论中出现，AGENTS.md 对局形态
（"玩家观战、聊天发令、地图插旗/N 个用户入局"）照搬了 Screeps 原生玩法，未做 DSH 插件适配。这是
**计划阶段需求未对齐的重大失误**。

**证据链（bots/ 引入历史）**：
- `git log -- bots/` 首现：`f02a34b`「S10: 内置 starter bot 注册表 + harvester 基线对手」（M1 期间）；
- `2d59319`（M2）加入 `addBot` 工具并做进对局流程（E3 headless 用 harvester）；
- M3 计划 D 节将 bot 对手升级为产品目标（license 调研 + TooAngel/hivemind 打包）。
- 源头在 AGENTS「社区先例 BotArena」段的"可直接作为我们的预置对手（打包前查 license）"与「对局形态」
  "N 个用户入局/玩家观战、聊天发令、地图插旗"——两者都假设了人类/非 Agent 玩家参与。

**用户拍板（对齐结论）**：
1. **产品只做斗蛐蛐 = 纯 Agent 对战**：World 是 MMO、Arena 是 1v1，全部由 Agent 会话参与；人类只观战，
   不进对局、不指挥、不参与。
2. **bots/ 不应该是产品功能**：M2 建的预制 bot（harvester）只用于测试，`bots/` 目录应从产品路径摘除
   （移测试 fixture），`addBot` 工具不对 Agent 对战开放。
3. **AGENTS.md 对局形态/玩法设计照搬 Screeps 未适配 DSH**，需重写钉死定位。

**已落地（文档层）**：
- `AGENTS.md`：开头定位改为「对局参与者只能是 Agent；人类只有旁观视角」；「对局形态」重写（纯 Agent 对战、
  World=MMO/Arena=1v1、无"人类玩家"座位、无聊天发令/地图插旗指挥通道）；「三层循环」删 L3 人层（L2 Agent+
  L1 Bot）；工具面删 `screeps_place_flag`、`addBot` 标注仅测试链路；BotArena 段注明社区 bot 仅背景参照不打包；
  M3 里程碑改为"测试 bot（raider）仅作 IT/headless 驱动"。
- `docs/plan-M3.md`：目标第 4 条与 D 节改为「测试专用 bot（仅驱动 IT/headless，非产品功能）」，废弃
  license 调研 + 第三方打包方向。

**代码层降级（已完成，2026-09-09）**：
- `git mv bots/ → tests/fixtures/bots/`；`package.json files` 移除 `bots`；
- `src/host/bots.ts` → `tests/helpers/bot-registry.ts`（含单测随迁）；`service.ts` 移除 `bots` 装配；
- `screeps_match addBot` 从工具面摘除（enum + case + bot 参数 + description）；switch 加 default 拒未知 action；
  tools.test 的 addBot 用例改为「不暴露」负向断言（schema enum 校验拦截）；
- 两个 IT（m2-battle / m2-closed-loop）改用 `BotRegistry.load + store.addPlayer` 内部链路注 bot，不走工具面；
- vitest.config.ts include 加 `tests/helpers/**`。

**验证证据（本条目改动后）**：`npm test` = **140 passed / 1 skipped**（与基线持平，BotRegistry 单测随迁后仍绿）；
`npm run typecheck` + `npm run build` 通过；两个改造 IT **全绿零孤儿**（battle kills=1 losses=1 41s /
closed-loop 25.6s）。

**遗留（继续待办）**：
- **headless bot 注入通道已关闭**（见上一条「验收面收敛」）：headless 只留加载冒烟，完整对局验收由
  IT（战斗闭环）+ browser-mcp（UI/触发）承担；
- `screeps_place_flag` 已确认代码层从未实现（仅早年文档提及），AGENTS 工具面列表删掉即完全清零，无代码残留；
- world-rounds 回合制为玩法方向（见上一条），规则细节待细化，不在 M3 排期。

## 09-08 S12 浏览器四项验收（browser-mcp 自动实测通过，销项）

**背景**：s12web 修复启动后（见上一条），用本环境的 browser-mcp（browser_navigate/snapshot/click，非截图）驱动 3200 实例完成 S12 遗留的浏览器四项验收。

**验证证据（accessibility 快照逐项确认）**：
1. **§1 侧边栏入口**：`Screeps 对局` 区块 + `⚔️ 新建对局` + 对局列表（settled/interrupted/running 条目）渲染正常。
2. **§2 creating 空态**：点「⚔️ 新建对局」→ 自动 create(test_a)+join(test_b) → 「⚔️ 赛前准备室」双方就座 + 「▶ 开始对局」。
3. **§3 running 看板**：开始 → 几秒「开赛中…」→ ~40s 进入 running：`test_a 📍 W51N48 RCL 1` / `test_b 📍 W51N86 RCL 1`、比分表、console 流 200 行持续追加（starter bot 安静符合遗留预期）。
4. **§4 列表跳转**：点 settled 局 → 「🏁 对局已结算 · 观战结束」终端正确切换。

**额外（M2 公平边界真实生效）**：非 creator settle → `only the creator may settle the match`；creator settle → 200、`phase: settled`、winner=draw；running 局侧边栏 `must settle first` 保护。6rctom 实测局已 settle 清场。

**操作注意（写进 AGENTS 环境纪律）**：启动 dsh 一律 `--no-open`；启动仅数秒用 10-20s 短超时；本 Agent 无视觉，浏览器验证一律 accessibility snapshot + click/type，不用截图。

**销项**：TEST.md 顶部「4 项需您亲手验证」改为 browser-mcp 已验收；遗留列表浏览器四项标记已销项。

## 09-08 M2 文档自证修正（TEST.md 两处实测错误 + AGENTS 自证纪律）

**起因**：用户按 TEST.md 第 0 节启动 s12web 卡死、3200 无服务。逐层取证发现两处文档错误，均源于「写文档没有实测」：

1. **第 0 节 webserver patch 示例缺 `host`**：webserver Config 的 host/port 均 required 无默认（`dsh-host-webserver/lib/index.js` L98-101，z.object 里两者都 `.required()`）；示例只写 `port: 3200`，配置校验失败 → 启动卡死。同文件前文却写着「必须同时给 host+port」，示例自相矛盾。
2. **第 3 节 `curl start` 漏 `sessionId`**：M2 C 步后 start 要求 creator sessionId（`http.ts` L290-291，无 sessionId → 400，非 creator → 403）；示例 curl 无 body。正确格式从 `http.test.ts` L60-64 取证：`{ "sessionId": "<creator>" }`。

**修复**：两处 TEST.md 命令改为实际跑通的形式（host+port、start 带 sessionId）；AGENTS.md 新增「TEST.md 自证纪律」——写进 TEST.md 的命令必须由 Agent 本环境真实执行验证后才能提交，反例即本轮。

**验证证据**：修正后的 `/tmp/s12web-port.yml`（host+port）启动 s12web → `dsh web: http://127.0.0.1:3200`，`ss` 确认 3200 监听，`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/` 返回 200，返回体含 `window.__ModuleLoader__` 引导（web shell 正常）；3080 GUI 不受影响。第 3 节 curl 格式经 http.test.ts 实测断言核对。

**遗留**：TEST.md 第 3 节完整浏览器流程（creating 空态 / running 真数据 / 列表点击）仍需用户按修正后 TEST.md 手动验收；LOG 待该项完成后销项。

## 09-08 M2 收尾签收（实现未提交，E3 已通过）

**状态：M2 A-F 完成；工作区待提交。**

### 最终改动

- A-D/E1：arena-mod 事件 ring + 整组去重、击杀/损失归因、frozen/creator 公平边界、report 分层聚合、addBot 与 `world-live` 闭环。
- Installer：补上此前缺失的 `patchDriverBundle`；对 `runtime.bundle.js` 保留 ISC 许可证文件、幂等加 `accessibleRooms` fallback，并用便携 Node 重建 `runtime.snapshot.bin`。
- M2 race 修复（均由探针实测后落地）：
  1. `restart({resume:false}) → setAccessibleRooms → resume(assignments)`，避免新 VM 先于本场元数据创建；
  2. `arena-mod` resume 先刷新元数据、再解暂停，并保留本场房间边界；
  3. `resetArena` 使用 storage RPC wrapper 暴露的 `db[c].clear()`，不再错误调用不存在的 `getCollection()`；
  4. driver `data.js` 的 `accessibleRooms` cache 增加 in-flight Promise 复用，修复同一 runner 两用户首 tick 第二次读取 undefined→`[]` 的竞态；
  5. `screeps_submit_code` description 明确 `module.exports.loop` 入口契约。

### 验证证据

- `npm test`：**140 passed, 1 skipped**。
- `npm run typecheck`：host/client 双 program 通过。
- `npm run build`：`lib/index.js`、`lib/client.js` 双产物通过。
- `npm run test:it`：**9 test files / 9 tests passed**，总耗时约 312s；tools、battle、closed-loop、http、service、runtime、M0、launch、match 全绿，零孤儿。
- `scripts/probe-tools-it.ts`：`envProbe.accessibleRooms` 合法 JSON；`TOOL_E2E`、console `1+1=2`、Memory 读写均实测通过。
- E3 headless：`matchId=mmtqy7814fz9nlf`，`tickDuration=100`，2 玩家（`M2Agent` + `__bot__harvester`），report 观察点达到 ≥200 tick，manual settle 成功，最终 `phase=settled`、winner=`__bot__harvester`、`gameTime=8434`。

### 调试结论

最初把 tools 失败误判为 resume race；`envProbe` 首先证明真正的第一阻塞是 `patchDriverBundle is not defined`。之后按用户要求在 runner/data/make/VM 边界加临时 debug，最终证明：同一 runner 中第一个用户拿到完整 `accessibleRooms`，第二个用户因无 in-flight cache 拿到 undefined，`result[7] || []` 后在 VM `JSON.parse([])` 崩溃。补丁后 tools 在完整 IT 序列中稳定通过。

E3 首次还暴露两个工具使用坑：create 缺 username、旧式 `module.exports = function(){}` 在 engine 4.3.x 不执行；补上 username 与 `module.exports.loop` 后闭环通过。

### 遗留

- `interrupted` 中断局恢复策略、frozen 完整玩法、房间可见性精确化、World 房间扩张成本留给后续迭代；M3 继续 Arena blitz。
- S12 浏览器手动验收仍需用户按根目录 `TEST.md` 执行（creating/running/列表点击）；这不是 M2 自动闭环阻塞。
- commit：本条目及本轮实现仍未提交，待用户确认后提交。

## 09-08 00:30 M2 实施中（WIP，未提交；下一步从本条目继续）

**背景**：M2 计划书 v9.1 已九审 PASS（commit 1121471 含标准流程入 AGENTS + arena.js 清理）。本条目记录实施进度与遗留。

### 已落地（`npm test` = 140 passed；typecheck/build 干净）

- **A 事件采集（arena-mod.cjs）**：订阅 roomsDone → `db.rooms.find` → `env.hmget(ROOM_EVENT_LOG, ids)`（官方先例 data.js L141）；
  ring `[{tick, eventsByRoom}]`（4096 + ringFull→bound）；**整组去重**（房上一 tick 数组相同则跳过；含 DESTROYED 的 tick 必不等
  → 致死 tick 永不被丢）；预处理钉死在 roomsDone 回调；user 解析走 `rooms.objects` 内 tombstone/ruin（非独立集合名！）；
  `generateRoom` 透传 exits；`clearSafeMode(room)`；`eventLog(since)`（游标=ring 下标）；resetArena 清 ROOM_EVENT_LOG。mod 契约 23 条。
- **B 记分（attribution.ts + lifecycle）**：`attributeTick` 纯函数（DESTROYED↔ATTACK 匹配归击杀、多命中去重、hitback 归 objectId 方、
  老死不计 loss）；lifecycle 事件游标 + kills/losses 内存累积（observe 消费、settle 含全程复用 observe）；bound=false→scoreWarning；删局清 Map。
- **C 公平边界**：submit_code 拒 frozen；工具面 observe/pause/resume 需玩家、start/settle creator；HTTP 面 pause/resume/settle 需
  body.sessionId、start 需 creator sessionId + rooms 支持 `{room,exits?}`、observe 加 GET 端点（修复 board 恒 405）；
  `__bot__` 双拒（addBot 内部豁免）；panel.tsx start 补 sessionId。
- **D report 增强（report.ts）**：分层过滤（attacker/target 是我 或 我房间）；事件聚合行；报错（顶层 {userId,error}）；
  lastUsedCpu 趋势（worldSnapshot 补字段）；独立游标。
- **E addBot + 闭环**：addBot（svc.bots 装配、`__bot_*` 身份 + botCode 快照）；create 可选 tickDuration 透传；
  **两个 IT 单跑全绿**：closed-loop 25.8s（事件聚合 + kills/losses 0 + settle）；
  **battle 修复后绿 30.6s（kills=1 losses=1）**——攻击 bot 必须用 `FIND_HOSTILE_*` 玩家 API，`Game.roomObjects` 是服务器内部对象隔离环境 undefined。

### 关键破案

- **console 工具 flake**：report 预调 consoleOutput → SELFTEST 自环帧提前触发 `lines>0 break` → 修 `isSelfTestFrame` 过滤，单跑 tools.it 已绿。
- **battle `<1000` 断言脆**：共享 db.json 让 gameTime 跨测试累积 → 改 `safeMode < 当前 gameTime`。

### 本条目后续状态（已由上方 M2 收尾条目销项）

1. tools 的真实根因已通过 runner/data/make/VM 边界探针确认：`accessibleRoomsCache` 缺少 in-flight Promise，已在 installer 幂等修复。
2. E3 headless 已通过：`mmtqy7814fz9nlf`，settled，winner=`__bot__harvester`。
3. F 文档已同步；实现与文档仍待用户确认后提交，未擅自执行 commit。

### 纪律补丁

- AGENTS.md 新增「后台任务纪律」（用户 M2 拍板）：长耗时命令后台后用**一次 `job_output(wait:true)` 阻塞等**，禁止无 wait 轮询刷屏。

## 09-07 01:30 S12 体验轮（用户浏览器验收通过，M1 真正收尾）

- **验收**：用户本轮要求（拍板 Simplify）：
  1. 取消用户名输入 → 固定 `test_a`/`test_b` 占位 bot（M2 工具让 Agent 自己起名）；
  2. 取消中间 UI 创建/join/join 操作区 → 中间只做观战/准备室；
  3. **创建移到左下角**：点「⚔️ 新建对局」= create(test_a) + join(test_b) 停在 creating →
     中间面板「**赛前准备室**」（双方卡牌 + 就座态）→ 用户点「▶ 开始对局」→ running 看板。
- **交互架构（学 dsh-dice-game，去 session 化）**：
  - 侧边栏 `sidebar.footer.action` 常驻入口（列表 + ⚔️ 新建 + 🗑 删除 + 绿点运行指示）；
  - **中心列面板**（`src/client/panel.tsx`）：DOM 级挂载 + `data-dsh-screeps-active` 属性显隐 +
    CSS 覆盖（`[class*="centerCol"]`、absolute 盖对话、隐藏对话保留状态）+ MutationObserver 自愈；
    **不绑 session**——看板数据全是 host 公开桥；
  - `MatchPanelController`（`src/client/controller.ts`）驱动开/关/选中，5 单测；
  - **去掉 conversation.view「Screeps」tab**（`src/client/match/index.tsx` 删除）；
  - 看板 `src/client/match/board.tsx`：地图改**玩家卡片**（色块+用户名+房间+RCL，div 渲染，
    弃 canvas 坐标缩放——房间稀疏时画布拉长条文字模糊，用户否决）；比分表、console 增量流。
- **host 契约新增**：`DELETE /dsh-screeps/matches/:id`（终局清理，防中断累积；仅 settled/interrupted
  可删、活跃 409；http.test +1，共 8）。实测删除一个 interrupted → 4→3。
- **失败安全**：apply 包 try/catch，挂载失败 warn 不崩 shell（学 dice）。
- 验证：108 单测绿（+6：controller 5 + http DELETE 1）、typecheck 双 program、build 双产物。
- 遗留：test-runtime rc.2 打包 bug（自造 fake 兜底）；地图坐标/地形 M2；bot 名 test_a/test_b 占位
  （M2 工具让 Agent 起名）；浏览器验收已过（此轮），后续交互回归以 TEST.md 为准。

## 09-07 00:09 S12 client 观战面板（待 commit；M1 收尾）

- 前置：计划经 **九轮 subagent 审核循环**至 v9 PASS（每轮不通过→修订→复审；AGENTS 审核循环纪律）。
  计划书 `docs/plan-S12.md` 记录了全部审查历史（一审 3阻塞+6次要 → 二审 5 → 三审 5 → 四审 3(含阻塞) →
  五审 3(含阻塞) → 六审 3(含阻塞) → 七审 1否决+3提示 → 八审 4提示 → 九审 PASS）。
- 已落地（A-G 步）：
  - **host 契约扩展**：`ArenaRequest` 扩 `query?: URLSearchParams`；新增 `GET /dsh-screeps/matches/:id/console?since=`
    增量端点（**GET，插在 http.ts POST-only 405 检查前分流**；逐用户游标 URL-encoded JSON；`collectConsole`
    纯函数带 services 句柄 + 单用户失败降级空 lines；since 缺失→全量 / 非法→400 / creating 空增量）。http 单测 +3（共 7）。
  - **client 半身（从零）**：`src/client/` — `index.ts`（inject=['slots'] + apply）、`lobby/index.tsx`
    （sidebar.footer.action 入口，root scope 所以组件无 session kit → apply 层 ctx.sessions.list 快照 +
    inject 传 getCurrentSession/openSession）、`match/index.tsx`（conversation.view 常驻「Screeps」tab order 10 >
    chat 0：地图 canvas 归属色投影 + 统计（observe 前后快照前端差分）+ console 增量流 + 创建表单）、
    `match/projection.ts` 纯函数（房间名→坐标/归属色/RCL 标签/世界范围）。
  - **构建面**：tsdown 双 entry（host lib/index.js + client lib/client.js，entry 打 `lib/types/client/index.js`
    + `entryFileNames:'client.js'` + banner/intro/footer 三段 + define 三键）；`tsconfig.client.json`
    （官方路线：declaration 三件套 + rootDir src + outDir lib/types + rewriteRelativeImportExtensions，
    exclude 测试）；build=`rm -rf lib && tsc -p tsconfig.client.json && tsdown`（clean 归脚本，tsdown 两 config 全
    clean:false）；typecheck 双 program；vitest include 加 .tsx；watch 双启（先 tsc 再 tsdown）。
  - **依赖（B 步）**：react/react-dom 18.2/18.3、@types、@testing-library/react、jsdom、rc.2 的
    dsh-client-runtime/ui-sidebar/ui-conversation/ui-slots/ui-renderer/host-apiproxy/invariants + test-runtime。
- 验证证据：
  - 单测 **102 绿**（92 host + 4 投影 + 2 lobby 注册/清理 等；projection 纯函数打表 5 条，lobby fake slots 2 条）；
  - typecheck 双 program 干净；`npm run build` 双产物（lib/client.js 18.43 kB + lib/index.js 83.14 kB）；
  - headless 加载层回归零孤儿（A 步 host 改动无回归）；s12web profile `--dump-config` 插件层出现；
    `exports["./client"]` + `dsh.client.platform:"web"` + 产物在 profile link 可达（client.js 非空壳，
    ModuleLoader 包装 + 组件代码在 bundle 内）。
- **新遗留（open）**：
  - **rc.2 官方 test-runtime 打包 bug**：`dsh-client-test-runtime@0.1.1-rc.2` 的 lib 直接
    `import "@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts"` 但 rc.2 发布物 files 不含 src/
    （exports["./src/*"] 悬空）→ 官方 client 测试 lane 跑不了（Err MODULE_NOT_FOUND）。按计划 H 步
    「自造 fake 兜底」用最小 slots 桩测注册/清理。**后续**：升 0.1.2+/alpha 或源码安装时恢复官方 lane。
  - **浏览器两段验收**（H 步 creating 空态 / running 真数据）需真实浏览器交互，本环境未做——
    留待用户在 web 会话里点验；构建/注册/manifest/加载层证据链已闭环。
  - **dsh-web-app 未入 s12web profile bundles**（`remove dsh-base` 时连带移除）；完整 web 组合验证
    待用户侧按需重建 profile。
- 依赖安装备注：pnpm onlyBuiltDependencies=esbuild（防 ignored builds 告警）；test-runtime 的 peer
  版图以 npm view 实查为准。

## 09-06 20:25 S14 README/AGENTS 写回 + 真实组合验证（待 commit）

- commit: 基于 240b4e5（docs/plan-S14.md 为 v3 修订版）
- 前置：README/License 初稿在 S14 前已由用户补齐（README 正文 + MIT LICENSE 与 package.json
  license 一致）；本里程碑 = 真实组合验证 + 文档写回 + 一处 README 补漏。
- 审查：subagent 独立核实（commit/lib 产物/91 单测/cordis.patch.yml L5-7/service.ts L63-72 语义/
  AGENTS 验证句/「或 CLI」/smoke dataDir/--patch 语义全部对得上），PASS 前提是修两条次要缺陷：
  1) 计划称 README L106-108 有「ISC 矛盾」→ 实测已无（四方一致），D 步改为复核；
  2) A 步声称 external 标注已写入 README → 实测未写，D 步补写。
- 实测证据链（C0-C3 全部通过）：
  - C0 本地 add scratch → `--dump-config` 精确断言 `- id: dsh-screeps / name: dsh-screeps /
    config: {}`（与 cordis.patch.yml L5-7 逐字一致，带 `# == dsh-screeps` 注释）；
  - C1 产物存在性：`<profile>/node_modules/dsh-screeps/lib/index.js`（80279 B）+ cordis.patch.yml 均在，
    `exports["."].default → ./lib/index.js` 指向真实产物（非空壳）；
  - C2 headless 加载层任务：`dsh --profile headless --patch <config:dataDir=/tmp/dsh-screeps-server-smoke,
    port:0, tickDuration:200> "调用 screeps_world_status 并报告 gameTime 与玩家数"` → 返回
    gameTime 11820、玩家数 2（tool_a W74N44 RCL1、tool_b W72N73 RCL1，各 1 spawn）——验证插件加载 +
    工具注册 + 服务连上（复用 smoke dataDir 的）私服；
  - C3 git 分发预验证：临时 git repo 显式纳 lib/（`git add -f lib/`）→ `dsh plugin --profile s14-c3 add
    git+file://…` 安装成功 → dump-config 插件层出现 + lib/index.js/cordis.patch.yml 产物到位 +
    bundles 对账（dependent + profile.bundles 均含 dsh-screeps）→ **用完已删临时 repo 与 profile**。
- D 步写回：README external 标注补漏（L61-63 后加「真机验证待后续」说明）+ License 节复核通过；
  AGENTS.md 验证节验收句改为 headless 加载层任务（标注 M2 后恢复对局闭环验收）+ `screeps_match`
  删除「或 CLI」；docs/LOG.md 本条目；0.1.0 版本不 bump（无 src 变更）。
- **新遗留（open，本次已修复）**：C2 headless 单任务进程退出后，其拉起的 Screeps 私服进程组
  **没有随 headless 退出被清理**（实测留下 launcher + storage/backend/engine 全套孤儿，已手动
  TERM→SIGKILL 清理）。**S14 已修复**（见下「headless 孤儿修复」小节），此处保留记录以示轨迹。
  - 根因链（dsh 源码 + 自产实验三重印证）：dsh headless 退出控制器只给应用树 **5s** dispose 宽限
    （`profile-boot` PROCESS_SHUTDOWN_TIMEOUT_MS=5e3，到点强制 `process.exit()`）；而我们的
    `shutdown()` 原来在 `await server.stop()` **之前**就 `removeExitGuard()`（service.ts L426）；
    `server.stop()` 又阻塞于 ~10.5s 的 LokiJS autosave 数据安全窗口（launcher stop L153）→ 5s
    到点宿主强制退出时 **exit guard 已被卸 → 无 SIGKILL 兜底 → 私服全套孤儿**。IT/vitest 没暴露
    是因为它完整 await `fiber.dispose()`（无 5s 强制退出）。
  - 修复（service.ts shutdown）：`removeExitGuard()` 移到 `stop()` **完成之后**（finally 里）。
    stop 窗口内宿主强制退出时 guard 仍在 → `process.on('exit')` SIGKILL 整组兜底（Node 26 实验
    证实 process.exit() 确实触发 exit handlers）。回归单测 +1：stop 在途 guard 必须保持挂载。
  - **语义差异（记录给后续）**：headless 单任务路径最多 5s → 等不完整 autosave 窗口 → 停服是
    SIGKILL 兜底（零进程残留，但最近 <10s 的内存写入不进 db.json，对 smoke 测试可接受）；
    IT/vitest 路径完整 await dispose（~10.5s 窗口 + 优雅 stop）。二者不是同一停服语义。
- 遗留确认：C3 的 GitHub 分发形态标记「分发前必做」（私有仓库阶段每次只验证安装路径可用性）；
  external 模式真机验证待后续；M2 完成后恢复「双用户对局闭环」验收句。

## 09-06 S13 工具面（✅ 收尾）

- commit: 0c64fca（WIP）→ 收尾提交 0ce88bc
- 已落地：`src/host/tools.ts` 会话映射（exec.agent.id → match players → username，公平边界）+
  8 个工具（world_status/report/wait/submit_code/console/read_memory/write_memory/match），
  `ctx.inject(['tools'])` 注册、ctx.effect 注销；service 层补 submitCode/writeMemory/
  readMemoryPath/consoleOutput；screeps_match 的 start/settle 限 creator。
- 测试：`src/host/tools.test.ts` 10 条全绿（映射/公平边界/工具行为）；单测全量 91 绿；
  `tests/tools.it.test.ts` 真实私服全链 24.4s 绿（report→submit_code→console 捕获→read_memory）。
- **Console 捕获破案（open P1 解决）**：
  - **根因（用户先指认，源码级实锤，探针证据链闭环）**：`RpcClient.subscribe`
    （`common/lib/rpc.js` L143-145）把回调包装成 `(channel, ...args) => callback.apply({channel}, args)`
    ——用户回调只收到**一个实参=payload**（channel 借 `this.channel`）。
    mod 的 `subscribeConsole` 签名却是 `function (channel, data)` → payload 被当 channel 存进
    `entry.message`，`data`=undefined → buffer 里全是 `message:null`。
    **环一直是通的**（pubsubTicks 精确递增），"publish 到不了"是字段错位的假象。
  - 证据（`scripts/pubsub-probe.ts` v3-v6，x4 轮跑）：
    - `pubsubTicks` 23→38→48→53 每 tick +1 精确 @300ms——engine→storage daemon→backend 全链路通；
    - 自环 SELFTEST 帧实际也回来了（`selfLoop:false` 是假阴性，字段错位导致识别失败）；
    - 修复后 lines 出现真实帧 `{"messages":{"log":["PROBE_TICK_11790",…],"results":[]},"userId":"…"}`，
      vm 每 tick 一条、Memory 同步写入；
    - `bufferHasSelfTest` 兼容两种 payload 形状（engine 帧 `{log,results}` 对象 vs mod 自环帧数组）。
  - 修复：`screeps-mod/arena-mod.cjs` 回调改单参 payload + consoleOutput 前置 ensure 订阅 +
    `bufferHasSelfTest` 兼容形状；`src/host/tools.ts` console 渲染适配 `{log,results}`；`arena-mod.test.ts`
    观察点对齐真实单参协议（旧测试断言双参，是测试没反映实现）。
- 复盘（为什么这个 open item 曾以为"publish 到不了"）：
  1. **假阴性误导**：自环实验失败表象是 `selfLoop:false` + 全 null，直接被解读为"环断了"，
     而其实是"回调签名错了、payload 进错字段"。**自环实验的断言设计有漏洞**——只看有没有
     收到，不看收到后字段对不对。
  2. **探针本身有两个 bug**（房间名 `P` 前缀不匹配 `[WE]\d+[NS]\d+`、SVG 输出读取时序），
     第一轮 C 阶段用户没建成，20 分钟被浪费。教训：探针第一版就要用真实协议形状断言。
  3. **测试与实现脱节**：`arena-mod.test.ts` 的 listener 观察点写 `(ch, data)` 两参，
     与真实单参协议相反，导致"单测绿、实测红"长期并存。教训：**契约测试的观察点必须
     来自源码而非理想**。
- 备注：ScreepsWorldSnapshot.rooms 补 progress 字段（mod 一直在发，类型没跟上）。

## 09-06 18:05 S11 host HTTP 桥（ea3c62c）

- `src/host/http.ts`：路由核心 `handleArenaRequest` 纯函数（单测打表），webServer 接线
  薄壳（结构化最小接口，`ctx.inject(['webServer'])` + `ctx.effect` 注销）。
- 路由面：GET world、GET/POST matches、GET match、join/start/pause/resume/observe/settle；
  MatchError→404/409/500；405；no-store；body 1MB 上限。
- 验证：`tests/http.it.test.ts`（ctx.provide 最小 fake webServer + 真实 node:http 承载）
  22.6s 全绿零孤儿；单测 +7。

## 09-06 17:56 S9b service 接线 + 真实结算 e2e（95d8299）

- `src/host/match/match-service.ts`：MatchService = MatchStore(S8) + MatchLifecycle(S9a)
  接 ScreepsService（结构化满足 ArenaBackend，无适配层）；生命周期归 screeps fiber；
  store 落盘 `<dataDir>/matches`；init 时 boot() 标记 interrupted 对局。
- 验证：`tests/match.it.test.ts` 真实私服全链（create/join/start/observe/settle/读盘）
  35s 全绿零孤儿。
- 教训：**接线很快，是因为前面把生命周期语义钉死了**（S8/S9a 假后端 28 条 + disposer 单测）。

## 09-06 15:22→17:48 M0 flake 破案 + 孤儿泄漏修复（4f94fd5, adf5333）

- 孤儿泄漏：disposer `void` 丢弃 promise（cordis runDisposable 只 await 返回的 thenable）。
  修复：返回 promise + shutdown 等待在途 ensure + exit 兜底 SIGKILL；语义由
  `src/host/service.test.ts` 钉死。验证：两轮 IT + 单文件 + pgrep 恒空。
- ~50% 间歇冻结：**破案靠给 pf.cc 打 fprintf 探针**（第 3 代仪器；前两代 JS 侧包装
  TERRAIN_INIT wrapper 因模块实例/时机问题不可见）。真身：resetArena 清空
  rooms.terrain 摧毁基础地形覆盖 → pf.cc A* 探测未生成邻接房间 → throw。
  伴随挖出：addAccessibleRoom 未定义（S7a 起）、backend crash-loop（Node≥15
  unhandledRejection throw × stock cronjobs 丢弃 promise）、ok:false 被静默吞。
- 修复：8 邻居墙桩 + generateRoom 去毒 + addAccessibleRoom 落地 + resume 刷新 +
  rejection guard + service.system ok:false 熔断。验证：连跑 8 全绿（修复前 ~50%）。
- 全程记录：`docs/spikes/m0-flake.md` 第二节（含为什么旧假设被证伪）。
- **为什么花了 ~2.5 小时**（复盘，防止重演）：
  1. 复合症状——至少 3 个独立 bug 共用 "Could not load terrain data / bProgress=0" 表象，
     每修一个 flake 还在，无法单因子归因；
  2. 交接文档的 persistence-gap 假设锚定了第一轮探针（证伪有价值但花了 ~40 分钟）；
  3. 观测面缺失——pf 层零日志，仪器迭代了三代才"看见"决定性信息；
  4. 静态分析绕远（LokiJS "fun"、pubsub 链路反复推倒）——应当在 JS 侧仪器连续两代
     无效时立即下沉到 C++ fprintf；
  5. 验证循环本身慢（单次 IT ~1.5 分钟 × 多轮）+ 执行摩擦（pgrep 自匹配×2、
     fake 依赖小 bug、tsx 探针跑法）。

## 09-06 14:31→15:22 新会话交接 + 契约复核（6095dc5, 3672e24, 3e963c3）

- 交接文档入 repo；spike 文档统一到 docs/spikes/；AGENTS.md 同步。
- 复核 cordis runDisposable（L963-966、L1178-1182）与 server-launcher 现状，
  确认文档第二节根因属实再动手。

## 09-05 22:23→09-06 00:30 S5-S10（46fa814, 9a099dd, 742df22, fd405fd, 8640807, 53ed678, f02a34b）

- S5+S6 host 插件骨架 + ScreepsService（ensure 链自死锁修复）。
- S7c+S7d schedule bridge / map fairness spikes；S7a M0 e2e（users.code timestamp 根因、
  generateRoom 后必须 restart）；S7b event-stream 采集点结论。
- S8 领域模型+持久化；S9a 生命周期编排（假后端 28 条）；S10 starter bot 注册表。

## 早期（46fa814 之前）

- S1-S4：runtime 供给、私服安装、起停、arena-mod 基础（细节见 docs/spikes/ 其余文件）。
