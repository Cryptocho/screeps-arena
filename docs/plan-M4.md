# plan-M4 — 锦标赛编排（round-robin 单循环 + 积分榜 + 自动串联）v3

> **v3（二审 FAIL 1 阻塞 RB1 + 4 非阻塞→修订）**：D5 初始 prompt 改为「starter 轮询
> 兼任有界补发」（RB1：单次 prompt 与 llm-smoke maxAttempts=3 先例矛盾，会产生静默
> 永久卡死——starter 对 code 缺席席位有界重发，超界落 `[tournament]` 错误面）；
> D3-③ 启动恢复对 scheduled 状态先按 pair 扫 journal/history 采纳已有对局再重排
> （RN1：fs 写失败致 matchId 回填丢失的双故障窗口）；D5 prompt 发送 fire-and-forget
> 不占 pump 互斥（非阻塞）；D3-② settle 回填 applyResult 在 settled 分支同步执行
> （非阻塞：不依赖 pump 收敛）；S1 测试清单补「scheduled/created 条目不计分」（非阻塞）。
>
> **v2（一审 FAIL 3 阻塞 + 5 非阻塞→修订）**：D5 新增「开局驱动」（一审 B1：start() 有
> 全席位 code 门槛、首唤醒依赖 started 事件，scheduler 只建局则对局永停 creating——
> 事实链已核对：创建相位零事件、初始提交靠外部 prompt，llm-smoke.it.test.ts:96-110 先例）
> ；D4 榜级 tiebreak 写死单序（一审 B2：两句矛盾）；D3 改「scheduled 先持久化再建局」
> + 恢复判定优先级重排 + pump 单飞互斥（一审 B3/N4）；D3-② 挂点精确到
> `void teardownMatch(m, snap)` 语句之后（一审 N1）；D6 禁改 seats + 无 provider 拒建
> （一审 N2/N3）；D8 措辞收敛（一审 N5）；验收判据 4 改可执行负向断言（非阻塞）。
>
> 范围拍板（2026-09-13，用户授权自主推进）：M3 已交付多局地基（多活跃对局 + 定点 teardown +
> 历史记账），M4 在其上做第一个产品级编排——**锦标赛**。同时收编 M3 复审遗留的两项：
> 真实 kill-9 三真合一端到端测试（M3 复审非阻塞项）与 prepare 期免 restart 评估（只出结论）。
> 单淘汰/双败赛制、回放/战报详情、arena-blitz 镜像克隆、单世界跨容器拆分、表现层统一收尾
> （用户决策：全部功能完成后单独做）不进本计划。
>
> **赛制选型（先行说明）**：round-robin（单循环）优先于单淘汰——① 每对选手恰好一局，
> 积分榜是最小可信记分面；② 无「输一局即出局」的调度分支（淘汰树要做轮空/种子位，
> 复杂度集中且对 Agent 对战价值低）；③ 与 BotArena 先例（社区锦标赛常年跑循环/积分制）
> 一致。淘汰制留给 M5+（store 预留 format 字段即可）。

## 1. 背景与动机

- M3 后系统能力：多活跃对局（池可容纳即建）、settle 自动定点 teardown、换席位再建局可行
  （seatSlug 工作区保留 = 同一 Agent 连续打多局是 M3/D8 特性）、`GET /api/history` 记账。
  缺的只有「谁跟谁打、打几局、谁赢了整届」——即编排与积分。
- 现状必须复用的两条既有事实（不重新发明）：
  ① 建局唯一正道 = `services.createMatch`（main.ts 内部函数，含 assertSeatsFree /
  allocateRooms / driver.watch / prepareRooms 预热，HTTP 只是它的一个入口）；
  ② 对局结果唯一可信源 = settle 时 machine.state 的 winner/scores（history 只记账，
  且记的是同一份快照）。
- 公平红线不变：锦标赛全部逻辑在 host 侧编排层，Agent 工具面（submit_code/report/console）
  零改动；对手战绩对 Agent 不构成新透视面（wake 文案仍只含己方视角战报）。

## 2. 设计决策（D 系列）

- **D1 锦标赛实体与持久化**：`TournamentStore`（dataDir/tournaments/，每届一个
  `<id>.json`，tmp+rename 原子写——与 history flush 同款纪律）。记录字段：
  `id`（t+时间36进制+随机后缀，对齐 matchId 惯例）、`name`、`createdAt`、
  `format: 'round-robin'`、`participants: Array<{seatId, username}>`、
  `matchConfig`（透传 MatchConfig 可选覆盖，缺省 DEFAULT_MATCH_CONFIG）、
  `matches: Array<{pair: [seatId, seatId], status: 'scheduled'|'created'|'settled',
  matchId?: string, result?: {winner: seatId|null(draw), scores, settledAt}}>`、
  `createdAt/finishedAt?`、`errors: string[]`（届级错误可查面：初始 prompt 超界等，
  二审措辞补项）。**matchId 缺席的 `scheduled` 是先于 createMatch 落盘的状态**
  （D3，一审 B3：先建局后持久化的崩溃窗口会让 pair 静默消失）。**积分榜（standings）
  不持久化**——纯函数从 matches 派生（D4），单一事实源，避免「榜与赛果双写漂移」。
- **D2 赛程纯函数（round-robin 轮转）**：`roundRobinPairs(participants: string[])` →
  C(n,2) 个 pair 的确定性序列。算法取标准 circle method（固定首元素轮转其余），
  输出按「轮次内顺序」排列——好处：前几轮两两错开、天然均匀；n<2 或 n 为奇数（轮空：
  奇数时补 bye 位，bye 不产生 match）在纯函数内处理并单测钉死。**纯函数进
  `src/server/tournament/bracket.ts`（零 IO），与 pool.ts 同款纪律**。
- **D3 调度器（scheduler，host 侧状态机）**：不变式 = 「每位选手同时至多在 1 局活跃
  对局中」+「锦标赛同时至多 maxConcurrent（默认 1，M4 不开放配置）局在打」。触发点
  三个，全部收敛到同一个幂等 `pump(tournament)`：
  ① 届创建后；② **wireMachine settled 分支**——挂点精确为 `void teardownMatch(m, snap)`
  **语句之后**（main.ts 既有分支末尾；一审 N1：runner dispose 同步段在该语句前已完成，
  同 seatId 旧 runner 复用路径已被房间守卫间接挡住，但挂点必须显式钉在 teardown 派发后
  才不依赖该隐式顺序）；**结果回填（applyResult）在 settled 分支同步执行**（二审
  非阻塞：与 history.upsert 同款「同步落账」纪律，不依赖 pump 收敛——pump 被单飞跳过
  时回填最多延迟 30s，无必要）；teardown 异步进行中 pump 建局会被 roomsSnapshot 瞬时拒绝
  （M3/D3 已拍板语义），pump 对 `RoomPoolExhaustedError` 与 `SeatInUseError` 两类瞬时
  拒绝 catch 后**不重试、留待下个触发点**：teardown done 无独立事件，但下一场 settle /
  新一届创建 / （兜底）pump 定时器（30s 间隔，仅在存在未完成锦标赛时启用）都会再次
  触发，收敛性由触发点密度保证（S0-② 复核量级），不引入 teardown-done 回调复杂度；
  ③ **启动恢复**（重启后从 store 读 unfinished 届，按序判定——优先级写死，一审 B3）：
  `status=settled` 但 result 缺失 → 从 history.jsonl 按 matchId 回填（settle→pump 崩溃窗）；
  `status=created` 且 matchId 不在 machines/journal → 重排该 pair（建局成功但进程内
  状态全失）；`status=scheduled`（matchId 缺席）→ **先按 pair 扫 journal/history**
  （players 恰为该 pair 的记录 → 直接采纳其 matchId/result 回填——二审 RN1：回填写盘
  失败的 fs 双故障窗下防重打一局），扫不到才重排（createMatch 前崩溃，一审 B3 窗口）。
  **建局时序（一审 B3）**：pump 先写 `status:scheduled` 持久化 → 再 createMatch →
  回填 matchId（status→created）持久化；任何一步失败，scheduled 记录保证恢复可重排。
  **pump 单飞互斥（一审 N4）**：模块级 in-flight 标志（同 preparePromise 纪律），
  重入直接 return——settle 触发与 30s 定时器同拍时只跑一份。**初始 prompt 不占互斥段**
  （二审非阻塞：LLM 往返秒~分钟级，pump 内 await 会长时间占住单飞标志、settle 触发的
  pump 全被跳过；prompt 发送 fire-and-forget，重入防护由 starter 的 per-match 状态机
  承担）。
- **D4 结果入账与积分榜纯函数**：`applyResult(tournament, matchId, {winner, scores})`
  与 `standings(tournament)`。计分：胜 3 / 平 1 / 负 0（draw 双方各 +1）。
  **榜级 tiebreak 写死单序（一审 B2，只此一版）**：`积分 → 胜场数 → 净胜分
  （得分−失分）→ 抽签序（participants 下标）`；全同并列名次，不强行决出。
  winner 取 `m.state.winner`（seat / draw 原样映射）。
- **D5 建局复用、开局驱动与席位语义**：scheduler 直接调用 main.ts 内部 `createMatch`
  （与 HTTP 同一函数对象，非自调 HTTP——避免路由层校验双语义）。
  **开局驱动（一审 B1，必须存在，否则对局永停 creating）**：现状事实链 =
  `start()` 有「全席位已提交代码」门槛（machine.ts:92）、创建相位零事件（构造函数不
  emit）、Agent 首次提交初始代码靠**外部 prompt**（llm-smoke 先例：测试手动
  `runner.prompt('Commit your initial bot code NOW…')`）。锦标赛自动化把这条链补全为
  host 侧两步：① pump 建局后**逐席位发「提交初始代码」prompt**（走既有
  SeatWaker 通道，文案进 wakeText 侧新分支——注意这不改 Agent 工具面，只是唤醒文案，
  与 M2 roundBreak 唤醒同性质；**pump 发出的那次 prompt 计入 starter 的重发计数**
  （per-match 状态机唯一持有方是 starter，两处共享同一计数器，二审措辞补项）；② **starter 轮询兼任开局与补发（二审 RB1 修订）**：
  5s 定时器（仅存在「已建局未 started」的锦标赛对局时启用），每拍两件事——对
  `p.code` 缺席的席位**有界重发初始 prompt**（上限对齐 llm-smoke maxAttempts=3 语义：
  reasoning 模型偶发只回文本不调工具，单次 prompt 不可靠；超界该席位落
  `[tournament]` 错误日志 + 届 errors 可查面，不静默卡死）；全员 `p.code` 就位 →
  `m.start()`（与 POST /api/matches/:id/start 同一入口语义，host 侧
  编排动作，不新增 Agent 工具面，合规）→ started 事件 → driver 正常接管周期唤醒。
  per-match prompt 状态机（初始已发/已重发 N 次/超界）由 starter 持有，pump 不 await
  prompt（fire-and-forget，见 D3）。
  选手 seatId 即对局 seatId：同 seatId 跨场串行复用（M3/D8：工作区保留、Agent 沿用
  上轮代码是超时兜底语义的一部分，锦标赛天然想要「越打越强」）；并发 = 1 时不存在
  同 seatId 并发冲突，`assertSeatsFree` 作为既有守卫原样兜底（若未来放开
  maxConcurrent>1，调度器 D3 不变式已保证不撞）。建局 username = participants 里的
  username（show 名，host 侧映射到 agent_<slug> 不变）。
- **D6 API 面（routes.ts 与 server.ts 双处注册——M3 踩坑：纯函数打表 + Fastify 壳都要加）**：
  `POST /api/tournaments {name?, participants:[{seatId,username}], matchConfig?}`（校验：
  participants 2–8 人、seatId 去重、username 非空、**matchConfig 禁改 seats**——pair 固定
  2 席，覆盖 seats≠2 会在 MatchMachine 构造期才炸，一审 N2；**无 provider（观战形态）
  直接 400 拒建**——无唤醒的锦标赛永不完成且无提示，一审 N3）→ 返回届实体 + 立即 pump；
  `GET /api/tournaments`（列表摘要含 standings）；`GET /api/tournaments/:id`（全量含
  matches 明细）。前端大厅加「锦标赛」最小功能列表（HTTP 轮询 5s，与历史同款，
  样式仍不做）。**不提供删除/中止**（M4 边界：错建的届留着手动处理数据目录文件；
  abort 语义牵扯活跃对局处置，留 M5）。
- **D7 wake 文案与公平**：既有事件（round_break/round_resume/started）的 wakeText 零
  改动（战报内报 = 既有 per-match 视角）。**唯一新增分支 = D5 的「提交初始代码」prompt**
  （发生在创建相位，机器无事件可借，必须由 scheduler 直发；文案只含本局语义——席位、
  对局、提交要求——**不含**锦标赛进度/积分/对手战绩等任何跨局信息，单测钉死）。
  跨局上下文是给 Agent 的新信息面，M4 一律不给（积分榜属于人类观战面；若未来要给，
  须单独评审公平性）。
- **D8 kill-9 三真合一端到端（M3 遗留收编）**：live IT 增补段——真实私服 + 真实
  teardown pending 窗口（history.upsert 是同步 tmp+rename，pending 行先于一切异步落盘，
  窗口宽 = teardown 的秒级 HTTP 链，一审 N5 确认锚定方式成立）真实 `kill -9` 杀进程 →
  重新拉起 → 断言：journal/历史一致、teardown-recovered>0、残留用户/房间被清。
  实现注意：杀的是**子进程形态的 main**（spawn main.mjs 再 kill -9，IT 进程自身不陪葬）；
  kill 时机锚定 = 轮询 `GET /api/history` 出现 `teardown:pending` 行后立即。
  锦标赛侧的崩溃恢复由 stub IT 覆盖（S5-②），live 段不重复测（一审 N5 措辞收敛）。
- **D9 prepare 期免 restart 评估（只调研，不改行为）**：输出一页结论进本计划附录
  （评估 svc.restart({resume:true}) 换成增量 updateTerrainData 通知 runner 重载地形的
  可行面：runner 地形缓存在哪层、能否按房失效、爆炸半径）。结论若为「低成本可行」
  也不在 M4 实施——只立遗留条目，避免本里程碑范围膨胀。

## 3. 里程碑（S 系列）

- **S0 调研钉子（先行，低成本）**：① round-robin 轮转算法核对（circle method 生成
  序列的均匀性 + 奇数 bye 处理，纸面推演 + 单测即闭合，不写 spike 脚本）；
  ② **核对「pump 触发点密度」论证**——实测 teardown 耗时量级（M3 m2-smoke 已有数据，
  复核即可），确认 30s 兜底定时器 + settle 触发足够收敛；③ D9 免 restart 评估调研
  （读 runner/terrain 缓存代码路径，写附录）。结论回填附录 A。
- **S1 赛程/积分纯函数**：`src/server/tournament/bracket.ts`（roundRobinPairs /
  applyResult / standings）+ 单测（奇偶人数、bye、去重、tiebreak 排序、draw 记分、
  **scheduled/created 条目不计分**——二审非阻塞补项）。
- **S2 TournamentStore**：持久化（tmp+rename）+ 崩溃恢复读回 + 单测（同 id 幂等回填、
  损坏行容忍对齐 history 纪律）。
- **S3 调度器接线 main.ts**：D3 三触发点 + scheduled/created 两段持久化 + settle 结果
  回填 + 启动恢复三态判定（优先级按 D3）+ **D5 开局驱动**（初始提交 prompt + starter
  轮询 start）+ 日志（`[tournament]` 前缀统一）。
- **S4 API + 前端**：D6 三端点（routes.ts + server.ts 双注册）+ 客户端 api.ts +
  大厅锦标赛列表（最小功能）。
- **S5 验证**：① stub lane IT：4 选手单循环 6 局全自动串完（mock 世界，断言：场次全、
  无同选手并发、**建局→初始 prompt→全员提交→自动 start→settle→下一场全链无人干预**、
  积分榜与赛果一致、standings 纯派生）；② stub lane IT：锦标赛中断恢复三态
  （scheduled 无 matchId 重排 / created 丢失重排 / settled 未回填从 history 回填）；
  ③ live IT 增补：真实私服 2 选手 1 局自动建局→settle→回填（**复用 test:live 现有装置
  纪律**，预算 +10 分钟内）；④ live IT：D8 kill-9 三真合一；⑤ `npm test` 全绿 +
  typecheck/build/build:client 零错。
- **S6 文档**：TEST.md 手测段（锦标赛建届→自动串场→积分榜，compose 形态实测）、
  README/AGENTS 状态、LOG.md 条目、附录 A 回填。

## 4. 验收判据

1. `npm test` 全绿（基线 124/124 + 新增），typecheck / build / build:client 零错。
2. `test:live` 绿（现 4/4 + 锦标赛段 + kill-9 段）。
3. stub IT：4 选手 6 局自动串完、结果/积分一致、中断恢复重排正确。
4. 公平红线：Agent 工具面与 wake 通道零改动（回归 suite 保证）；**可执行负向断言**
   （一审非阻塞）：单测断言 tournament 模块 import 面不含 `src/agent/*`（编排层不得
   接触工具构造面），且全仓 `buildSeatTools` 调用点数量不变（防编排层绕道注册工具）；
   D7 跨局信息不注入（初始提交 prompt 只含本局语义，单测断言其不含积分/对手战绩字样）。
5. compose 冒烟：建届 → 自动建局 → settle → 榜面更新（HTTP curl 验证，并入 TEST.md
   手测段；本机 Docker 在位，实测记录）。
6. D9 调研结论落附录（不实施、不阻塞验收，只要结论有据）。

## 5. 风险与边界

- **pump 触发点之间的收敛**：teardown 异步未完成时建局被瞬时拒绝（M3/D3 已拍板语义），
  靠触发点密度收敛（S0-② 复核）；极端形态（最后一局 settle、teardown 后无任何新触发）
  由 30s 兜底定时器覆盖——定时器仅在存在未完成锦标赛时启用，空闲零开销。
- **同一 seatId 跨局**：AgentRunner 每场新建（teardown 已 dispose），工作区延续；
  Agent 是否「记得」上局 = 工作区文件语义（既有 D8 特性），锦标赛不额外干预。
- **崩溃窗口（settle→pump 回填）**：D3-③ 启动恢复从 history 按 matchId 回填；
  history 与 machine 同源（M3/D7 已对齐），无双源冲突。
- **参赛者上限 8**：房间池默认 2 房（并发=1 也只占 2 房），人数只影响届时长
  （8 人 = 28 局 × 每局分钟级），不占额外池；上限纯为防误建巨榜，可后调。
- **淘汰制 / abort / maxConcurrent>1 / 回放详情 / arena-blitz**：明确不进 M4。
- **表现层**：仍不做（用户决策）。

## 6. 遗留去向（M5+）

- 单淘汰/双败赛制（format 字段已预留）、锦标赛 abort/编辑、maxConcurrent 配置化、
  跨局 Agent 上下文注入（需公平性评审）、回放/历史战报详情、arena-blitz 镜像克隆、
  prepare 免 restart 实施（依 D9 结论）、单世界 vs 多世界跨容器、表现层统一收尾。

## 附录 A — S0 调研结论（实施期回填，2026-09-13）

- **S0-① 轮转算法**：circle method（固定首元素，其余轮转配对）生成 n 偶数 = (n-1) 轮 ×
  n/2 场；奇数补 bye（bye 轮该选手轮空不产生 match）。均匀性由「每轮每人恰一场/恰 bye」
  判据单测钉死（bracket.test.ts），无需 spike 脚本。
- **S0-② teardown 耗时量级**：M3 实测（m2-smoke 13 步 + compose 全链）teardown =
  每席位 removeUser+removeRoom 各一次 HTTP system 调用，单局 2 席位共 4 次调用，秒级；
  settle 本身就是高密度触发点（每局终局必触发），30s 定时器仅覆盖「最后一局 settle 后
  再无新局」的极端形态——收敛充分，无需 teardown-done 回调。
- **S0-③ D9 免 restart 评估（结论：低成本不可行，维持 M3 restart+互斥语义）**：
  runner 地形缓存在引擎内部 `staticTerrainData`（进程级闭包，service.ts:307-312 注释
  与 S7a spike 结论），mod 侧可触达的只有 env/cliMap 层——`cliMap.updateTerrainData()`
  只重建 env blob、不清 runner 缓存（这正是 M3 removeRoom 收尾插桩后仍必须 restart 的
  原因）；免 restart 需 fork 引擎 runner 或向其暴露缓存失效口（侵入引擎，维护成本高、
  风险面大）。维持现状；若未来世界常驻多局导致 restart 窗口成为真痛点，再评估引擎
  fork 路线（记 M5+ 遗留）。
