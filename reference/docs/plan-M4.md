# M4 计划 v6（五审 **PASS**，待用户确认开工）——赛事 bracket、公开回放与历史比分
> **2026-09-09 M5 superseded 注**：M4 赛事机制不变；计划 §4.2/§9 提及的「普通 world-live 热更」已随 M5 废弃（live 热更仅剩 arena-blitz；world 主线为 world-rounds 周期提交）。

> **状态：计划已过五审 PASS，尚未开工。** 必须遵守 `AGENTS.md`：计划书 → subagent 审查 → PASS 后**等待用户确认**；用户确认前不改实现。
>
> **审查记录**：
> - v1：一审 **NOT PASS**（subagent `737fa9e3-a55b-4793-b587-dde28cb1949a`），6 个阻塞、12 个次要、15 个提示。
> - v2：二审 **NOT PASS**，4 个阻塞及若干次要/提示。
> - v3：三审 **NOT PASS**，4 个阻塞及若干次要/提示。
> - v4：四审 **NOT PASS**（subagent `60fb46f8-6be7-49c8-ae8c-527efc74952e`），3 个阻塞 + 3 个次要 + 5 条提示。
> - v5：吸收四审意见 → 五审（subagent `0c70b3e6-f3e8-475b-8a45-33c0861a943d`）**PASS（无阻塞）**。
> - v6：折叠五审的 2 处次要（replay hash 唯一字段集、孤儿 MatchResult diagnostics）+ 4 条提示（onSettled 转发链、gateway 转调签名、reconcile 两个调用方、级联故障注入 IT + meta.json 字段清单），定稿待确认。
>
> v6 对历轮审查的收口：**唯一结算顺序**（beginSettlement → pause → replay marker → HistoryStore.put + history marker → tournament match 经注入 TournamentGateway.applyResult + tournament marker → commitSettlement → 仅此后 onSettled hook / orchestrator 推进）；**receipt hash 只校验各自来源**（replay=replayMetaHash 唯一字段集，history/tournament=同一 canonical MatchResult 的同一 resultHash，与 candidateHash 分离）；**中断级联**（tournament 无 handle 时 owned attempt MatchState 全部终态化并释放单活跃席位）；普通 create/join 纳入 active 检查、普通局 journal 初值、observe 锁前 phase check、HTTP start/settle 幂等、roundToken 只存 hash（明文仅进参赛 Agent 自身 DSH 转录）、无 `__bot__` 验收断言均已补。当前实现仍是 M3 原状；以下是获用户确认后才执行的目标，不是已实现事实。

## 1. 目的与完成定义

M4 把 M3 的单场 `arena-blitz` 提升为可持续观看的赛事产品，完成一条可验证闭环：

1. 观战者创建并触发一场由 DSH Agent session 组成的 Arena 单淘汰赛事；观战者只触发编排/开始，不占座、不提交代码、不暂停/指挥比赛。
2. Host spawn 一组 Agent session；同一 DSH session 跨 bracket 轮次复用，但每个 bracket attempt 都创建新的 Screeps MatchState 和新的 Screeps user。
3. 赛事按确定性 bracket 串行运行：当前 1v1 完成结算 journal、公开回放和历史归档后才创建下一场；最终进入 `completed`、`draw`、`failed` 或 `interrupted`。
4. 每个 attempt 保存不含 token、源码、Memory、私有 console、内部对象原始字段、DSH sessionId 或 Screeps userId 的公开 canonical replay；回放按 generation/seq/tick 游标读取，缺口显式可见。
5. 赛事页展示 roster、当前槽位、bracket、终局结果；历史页展示不可变 MatchResult 和稳定排序的历史积分榜。
6. Host 重启、部署失败、Agent followup 超时、回放尾部损坏、跨 store 崩溃窗口都有可查询状态和可重复 reconcile；受控结束不遗留 Agent handle 或私服进程。

**M4 完成标准**：单测、双 program typecheck、build、真实私服 IT、真实 DSH web + stub provider lane、浏览器手测指导、`TEST.md` 自证、`docs/LOG.md`/`AGENTS.md`/`README.md` 回写全部有证据。M4 不宣传未经 A0 证明的 raw sockjs 无损录像。

## 2. 当前基线与硬设计决策

实现前若源码行号漂移，重新复核源码，不凭本计划行号猜契约。

### 2.1 已有事实

- `src/host/match/model.ts` 只有单场状态机 `creating → placing → running ⇄ paused → settled`；`arena-blitz` 单场 `seats=2`。
- `src/host/match/store.ts` 每场写 `<dataDir>/matches/<matchId>/state.json`，临时文件 + fsync + rename，写操作 promise 链串行；当前只保证单 host 单活跃 MatchState。
- `src/host/match/lifecycle.ts` 已有 Arena 镜像部署、公开 observe、事件游标、kills/losses 归因和 settle，但 settle 现在直接 `pause → store.settle`，没有跨 store journal。
- `src/host/match/match-service.ts` 的现有 settle hook 只拿 `matchId`，当前对所有 settled match 都可能触发单局 Agent 回收。
- `src/host/agents.ts` 的 `SpawnOrchestrator` 只按单局保存 handle；`src/host/service.ts` 只拥有该单局编排器。
- `arena-mod.cjs` 当前 `eventRing` 是进程内全局、按变化 tick 稀疏记录，`eventBusy` 会丢慢 tick，`resetArena` 清 ring；`ScreepsService` 目前只有 world/eventLog/console 客户端方法。
- `src/host/http.ts`/`src/client/` 已有 M3 单局大厅/看板；M3 `/spawn-agents` 是 fire-and-forget、无 tournamentId；HTTP 现有 MatchState 返回未定义 M4 redaction DTO。

### 2.2 硬规则

1. **赛事席位与单场席位分离**：`TournamentConfig.seats` 只能为 `4 | 8`；每个 bracket attempt 固定 `preset='arena-blitz'`、`MatchConfig.seats=2`。4/8 不是 4v4/8v8。
2. **复用 DSH session，不复用 Screeps user**：同一 participant 的 DSH `sessionId` 和当前进程 `AgentHandle` 跨轮次持续；每次 attempt 在 resetArena 后创建新的 Screeps user、username、userId 和 MatchState player binding。
3. **TournamentService 是唯一赛事 owner**：`ScreepsService` 持有一个 `TournamentService` 实例；该实例持有一个 `TournamentOrchestrator`、一个 `TournamentStore` 和 `tournamentId → AgentHandle[]` capability map。禁止通过第二个插件实例或第二个 orchestrator 竞争服务器。
4. **M3 settle hook 只在 commit 后调用**：hook 改为接收完整 `MatchState`，普通 M3 match 才调用 `disposeAgentMatch`; `tournamentId` 非空的 match 不走单局 dispose。赛事 handle 只由 TournamentService 终态/失败/中断或 service dispose 回收。
5. **赛事采用 round-submit**：每个 attempt 开赛前每位 participant 只能 staged submit 一次；placing/running/paused/settling 拒绝热更。Host 在下一 slot 显式 `followup` 唤醒同一 session；prompt 不要求 schedule。为防旧轮 scheduled followup 误写新轮，tournament 私有工具调用必须带持久化 `roundToken`，token 不匹配即拒绝。
6. **回放正式规范是 canonical public frame**：A0 仍取证 `room:`、`roomMap2:`、官方 `/map-stats`，但在未证明 host-side 权限、每 tick 对齐和可持续采集前，不把 raw sockjs/map-stats 当 M4 硬依赖。正式 API 是 arena-mod 在 `roomsDone` 边界产出的白名单 canonical frame；A0 PASS 后同步修订 `AGENTS.md` 中旧的 raw-source 表述。
7. **结算是显式 journal 协议**：新增 `settling` MatchPhase、固定 candidate、marker 和 revision CAS；不能以多个 JSON 文件的写入顺序冒充事务。
8. **draw 无人工裁决**：每个 slot 总 attempt 数最多 2（attempt 0 + 1 次重赛）；第二次仍 draw 则该 slot 和赛事直接 `draw`，不随机 tiebreak、不要求观战者介入。
9. **M4 建赛不调用普通 M3 create/join**：`POST /tournaments` 先持久化 recruiting，再由 host 预分配 participant/session 并内部原子创建 tournament-owned MatchState/player binding。Agent 只通过 tokenized round prompt 提交脚本。M3 `/spawn-agents` 保留旧语义，和 tournament owner 互斥。
10. **测试 bot 不是参赛者**：M4 bracket IT 使用 fake AgentRegistry/handles 驱动真实 host/私服链，或真实 DSH stub session；不注入 `tests/fixtures/bots/*`，不恢复 `addBot`。

## 3. 领域模型与精确状态契约

### 3.1 TournamentState、participant 与 bracket

新增纯数据/纯函数模型，具体 schema 由单测锁定：

```ts
interface TournamentConfig {
  preset: 'arena-blitz'
  seats: 4 | 8
  maxAttempts: 2
  tickDuration?: number
  model?: string
  provider?: string
}

type TournamentPhase = 'recruiting' | 'ready' | 'running' | 'completed' | 'draw' | 'failed' | 'interrupted'
type SlotPhase = 'pending' | 'running' | 'won' | 'draw' | 'interrupted'

interface TournamentParticipant {
  participantId: string       // 稳定公开 id；永不使用 sessionId 作公开 key
  sessionId: string           // host 私有，HTTP/client/history projection 必须剥离
  displayName: string         // 本赛事公开 alias，例如 Agent 1；允许跨赛事重复
  seed: number
}

interface BracketAttempt {
  attempt: 0 | 1
  matchId: string
  replayId: string
  phase: 'pending' | 'running' | 'settling' | 'settled' | 'draw' | 'interrupted'
  resultId?: string
  winnerParticipantId?: string
}

interface TournamentSlot {
  slotId: string
  round: number
  index: number
  participantIds: [string, string]
  attempts: BracketAttempt[]
  phase: SlotPhase
  revision: number
  winnerParticipantId?: string
}
```

- `TournamentState` 另存 `requestId`, `config`, `participants`, `slots`, `currentSlotId`, `phase`, `revision`, `error`, `cleanupUnknown`, `createdAt`, `updatedAt`；不保存 AgentHandle。`sessionId` 可在 host 持久化，但任何公开 DTO、历史、replay、client 都剥离。
- `participantId` 创建时随机生成并持久化；`displayName` 是赛事内 alias（例如 `Agent 1`），跨赛事可以重复；跨赛事 leaderboard 以 participantId 聚合，因此 alias 不是全局身份。
- 首轮确定为 seed 0 vs 1、2 vs 3…；上一槽 winner 填下一轮；纯函数输入相同且 revision 正确时输出唯一 bracket。
- 4/8 Tournament seats 始终映射到 2 席 Match seats。每个 attempt 的 Screeps username 由 host 生成，≤30 字符、包含 tournament/participant/attempt 的可追溯短码，reset 后重新创建；username 不是公开 participantId。
- `TournamentStore.applyResult(resultId, matchId, expectedSlotRevision, result)` 必须同时校验当前 slot、attempt、phase 和 revision：
  - expected revision/attempt 不匹配 → `409 conflict`，不写任何状态；
  - 相同 `resultId` 且内容 hash 相同 → 幂等返回当前状态；
  - 相同 `resultId` 但内容不同 → `corrupt/conflict`，赛事进入 `failed`，禁止继续推进；
  - attempt 0 draw 只有在 apply 成功后才可创建 attempt 1；attempt 1 draw 只有在 apply 成功后才写 slot/tournament `draw`。

### 3.2 MatchState settlement 状态机与 CAS API

`MatchState` 增加可选兼容字段 `revision:number`（旧 state 缺省按 0）、`tournamentId?`、`tournamentSlotId?`、`attempt?`、`participantId?`（在 MatchPlayer）、`codeMode:'live'|'frozen'|'round'`、`settlement?: SettlementJournal`。

精确状态图：

```text
creating ──placing──> running ⇄ paused ──beginSettlement──> settling ──commitSettlement──> settled
   │          │           │       │                         │
   └──────────┴───────────┴───────┴──> interrupted          └──explicit abort only──> interrupted
```

- `settling` 属于 active phase；`MatchStore.markInterrupted()` 不得把 settling 直接覆盖为 interrupted，必须先交给 recovery coordinator。
- `settling` 只有 `commitSettlement` 或显式 `abortSettlement` 可离开；正常 reconcile 失败只更新 journal.error/retry metadata，保持 settling。
- 新 journal 结构：

```ts
interface SettlementReceiptRef {
  resultId: string                 // matchId；所有外部 receipt 的幂等主键
  payloadHash: string              // hashVersion=1 的 canonical payload hash
  storeRevision?: number           // TournamentStore apply 后的 revision
}

interface SettlementJournal {
  settlementId: string                 // 固定等于 matchId
  candidateHash: string                 // hashVersion=1；candidate 不可改写
  hashVersion: 1
  reason: SettleReason
  winner: WinnerRef                    // 内部仍可用 session ref
  scores: Record<string, number>       // 内部 key 是本次 MatchState session；归档同时写 participant mapping
  endTick: number
  replay: { status: 'pending'|'committed'|'not-applicable'; completeness?: 'complete'|'partial'; gapReasons?: string[]; receipt?: SettlementReceiptRef; replayId?: string }
  history: { status: 'pending'|'committed'|'not-applicable'; receipt?: SettlementReceiptRef }
  tournament: { status: 'pending'|'committed'|'not-applicable'; receipt?: SettlementReceiptRef }
  cleanup: { status: 'pending'|'committed'|'not-applicable'|'unknown'; error?: string }
  error?: string
}
```

- **journal 初值语义**：tournament attempt 的 `replay/history/tournament` 均从 `pending` 开始并逐步提交；普通 create/join（HTTP 或工具面，无 replay bridge 的旧流程）在 beginSettlement 时把 `replay` 和 `tournament` 预置为 `not-applicable`、`history` 若未启用 M4 HistoryStore 也置 `not-applicable`，使 M3 普通局 commit 不受 replay/history 阻塞且语义可诊断；若 HistoryStore 全局启用，则普通局也写 history，但 result 不含 participantId、不进入 leaderboard。

`candidateHash`/receipt `payloadHash` 的 canonical 算法固定为 `hashVersion=1`：递归对象键按 UTF-16 字典序排序，数组保持顺序，字符串按 UTF-8 原样编码，数字必须是有限整数或有限 IEEE-754 数值的 JSON 表示，拒绝 `NaN/Infinity/-0`，不省略 `null`/空数组/空对象；根值以 canonical JSON 序列化后取 SHA-256 hex。candidate 还包含不可变的 participant mapping snapshot、matchId、attempt、reason、winner、scores、endTick，故 session 复用不会改变历史 hash。

### Marker 转移矩阵（唯一允许的外部提交顺序）

| marker | 初态 | 允许提交前置 | 外部 receipt 必须满足 | 成功转移 | 失败/重试 |
|---|---|---|---|---|---|
| replay | `pending` | `settling` | `resultId=matchId`、generation/replayId 与 meta 一致、`payloadHash = replayMetaHash`（唯一权威定义见下 §receipt hash，字段集含 replayId/sourceGeneration/schemaVersion/matchId/participantSnapshot/status/recordCount/firstSeq/lastSeq/gapReasons，**不接受 Matrix 行内另一份字段集**） | `committed` + `complete/partial` | 保持 pending，写 error；receipt 存在则校验后补 marker |
| history | `pending` | replay=`committed` 或 ordinary legacy replay=`not-applicable` | HistoryStore 中存在不可变 `matchId` result，`payloadHash = resultHash`（该 MatchResult 的 canonical hash，见下） | `committed` | 外部写成功而 marker 失败时按 matchId 读取 receipt；hash 不同 → corrupt/conflict |
| tournament | `pending` | history=`committed` | TournamentStore 中存在同一 `resultId=matchId` 的 result receipt，`payloadHash = resultHash`（与该 HistoryStore MatchResult 同一份 canonical result 的同一哈希），且记录 `fromRevision/toRevision` | `committed` | apply 已成功而 marker 失败时按 resultId 重放/读取 receipt；hash/revision 冲突 → tournament failed |
| cleanup | `pending` | 仅在 MatchState 已 `settled` 后 | 普通局 disposer 返回成功，或 tournament 局明确 not-applicable | `committed`/`not-applicable` | disposer 失败 → `unknown` + cleanupError；不回滚 settled，recovery 重试 |

**receipt hash 只做自己来源校验，不做跨 marker 相等**：三种 marker 的 `payloadHash` 各自描述其外部记录的可复现内容，唯一共享点是 **history 与 tournament 都从同一个不可变 `MatchResult` canonical 记录派生 `resultHash`**。具体 canonical 边界固定为 hashVersion=1：
- `replayMetaHash = SHA256(canonical({replayId, sourceGeneration, schemaVersion, matchId, participantSnapshot, status: complete|partial, recordCount, firstSeq, lastSeq, gapReasons}))`；
- `resultHash = SHA256(canonical({resultId: matchId, tournamentId?, slotId?, attempt?, preset, phase, winner: {kind, participantId?}, scores, participantSnapshot, kills, losses, endTick, replayCompleteness}))`，字段固定为这组，不允许把 MatchState 私有字段塞进 MatchResult；
- HistoryStore receipt 存 `{resultId, resultHash, content: MatchResult}`；TournamentStore 的 `applyResult` 接收同一 `MatchResult` 对象，先在自己的 `receipts/<resultId>.json` 以 no-clobber 写 `{resultId, resultHash, slotId, fromRevision, toRevision}`，再发布 TournamentState；同一 resultHash 幂等，不同 resultHash 或 revision 不一致返回 conflict。
- `candidateHash` 只代表 `beginSettlement` 时固定的 settle candidate（reason/winner/scores/endTick/participantSnapshot 的 hash），与任何外部 receipt hash 不同，**commit 校验的是三个 marker 都处于 committed 以及各自 marker.payloadHash 与对应 receipt 的 resultHash/manifestHash 一致**，不要求等于 candidateHash。

精确 API（全部在 MatchStore 的同一串行链内执行，所有新写 API 使用 revision CAS）：

1. `beginSettlement(matchId, candidate, expectedRevision?)`：只允许 running/paused；若无 journal，按 canonical hash 固定 candidate、写 journal pending、`cleanup=pending`（tournament 局为 not-applicable）、phase=settling、revision+1；若已 settling 且 candidateHash 相同，幂等返回；若 candidate 不同返回 conflict，不重新计算/覆盖。
2. `markSettlement(matchId, expectedRevision, marker, receipt)`：只允许 settling；按上表校验 settlementId、前置 marker、receipt resultId/hash/version 和 revision，写对应 marker，revision+1；marker 只能从 pending→committed/not-applicable 一次转移，不能回退。
3. `commitSettlement(matchId, expectedRevision)`：只允许 settling；要求 replay/history/tournament 均为 committed 或 not-applicable，且每个 committed marker 的 `payloadHash` 与其对应外部 receipt 的 manifestHash/resultHash 一致（见 Marker 矩阵；不要求等于 candidateHash）；CAS 成功后复制 journal candidate 到 `winner/scores/endTick`，phase=settled、revision+1。replay `committed + completeness=partial` 合法，最终 MatchState 明确为 partial replay，不是假装完整；ordinary match 保持 cleanup=pending，tournament match 为 not-applicable。
4. `markCleanup(matchId, expectedRevision, status, error?)`：只允许 settled；普通 hook 成功写 cleanup=committed，失败写 cleanup=unknown+cleanupError，revision+1；tournament hook 不执行，cleanup=not-applicable。cleanup 状态不影响已提交的 winner/history/tournament。
5. `reconcileSettlement(matchId)`：只读取已固定 journal，按 replay→history→tournament→commit 顺序重试；先查 receipt 再决定是否重新调用外部 put/apply，绝不重新 observe/重算 winner。外部重复 `settle` 对 settling/settled 仍返回 M3 兼容的 409；只有内部 recovery 调此幂等 API。
6. `abortSettlement(matchId, expectedRevision, error)`：仅供恢复器在确认 receipt 冲突、不可修复 host 错误或清理策略明确放弃时使用，写 `interrupted` + error；普通网络错误不允许直接 abort，避免丢 candidate。

对 settling 的读写语义固定：公开 `GET observe` 先做 phase check（在 `withMatchLock` 之前先读一次 store；phase=settling 立即返回 409 `settlement in progress`，不重新读世界），因为锁内才检查会让并发轮询全部串行等待后拿到同一 409；M3 client 3s 轮询会看到 409 后在下一轮自然恢复，普通 M3 局的 settling 窗口短，视为可接受。内部 recovery/replay/history 可读 journal；pause/resume/submit/console/memory 对 settling 一律拒绝；replay reader 仍可读已持久化的 partial/live 页。`isActivePhase` 包含 settling，`get()` 不能把 settling 当 terminal。

`MatchLifecycle.settle()` 的精确顺序（唯一顺序；applyResult 的唯一归属见下）：
1. 在 per-match lock 内 observe 一次并固定 candidate；调用 `beginSettlement`（candidate 已 durable）；
2. 调 backend `pause`（若已暂停则视为幂等）；暂停失败只记 journal.error，保持 settling；
3. final replay drain/stop；写 replay receipt/marker（canonical bridge 不可用时 tournament match 不得 commit；普通旧 M3 match 可 `not-applicable`）；
4. 写 HistoryStore MatchResult/receipt，校验 history marker（history 在 tournament applyResult 之前，确保 tournament result 与已归档 result 同一份 canonical 记录）；
5. 若是 tournament match（`tournamentId` 非空），通过注入的 `TournamentGateway.applyResult(matchId, MatchResult)` 推进 slot，并在成功后写 tournament marker（receipt 校验同一 resultHash）；普通 match 写 tournament=not-applicable；
6. `commitSettlement` CAS；只有 commit 返回后才调用 `MatchService` settled hook；hook success/failure 通过 `markCleanup` durable 记录；commit 后清 lifecycle 内存 cursor。

**applyResult 唯一归属与调用方（实现前必须钉死的接缝）**：applyResult 只经注入的 `TournamentGateway` 调用，gateway 由 MatchLifecycle/MatchService 构造时注入（结构化最小接口，允许经 ScreepsService 接 TournamentService）。调用方固定为两个：① settle 流程第 5 步；② recovery/reconcileSettlement 仅在对应外部 receipt 缺失时按 resultId 幂等重放（不携带新结果、不重复推进 slot、no-clobber）——两者都不会产生第二次 apply。Orchestrator 不在 commit 后二次调 applyResult，只在收到 settled 通知后读取 slot 状态决定下一 attempt/决赛推进。**settled hook 转发链**：commit 完成后由 MatchService 的 `onSettled` hook 把 committed state 转发给 TournamentService（tournament 局该 hook 只做转发通知、不做 dispose、markCleanup=not-applicable）；orchestrator 不轮询 MatchStore，只在收到该通知后读取 slot 状态推进下一 slot/attempt；普通局 hook 保持 disposeAgentMatch + markCleanup 语义。gateway 是唯一外部入口，内部转调 `TournamentStore.applyResult(resultId, matchId, expectedSlotRevision=<当前 slot revision>, result)`，expectedSlotRevision 由 gateway 调用时读取当前 slot revision 取得，slot/attempt/phase 校验与幂等语义以 §3.1 为准。

```ts
/** MatchLifecycle/MatchService 构造时注入的赛事推进网关（唯一 applyResult 入口）。 */
interface TournamentGateway {
  /** 校验 matchId 属当前 slot，写 TournamentStore receipt，CAS slot=won/draw；
   * 返回 outcome 供 settle 继续。普通 match 不调用。 */
  applyResult(matchId: string, result: MatchResult): Promise<{
    resultId: string
    resultHash: string
    outcome: 'won' | 'draw' | 'conflict'
    slotRevision: number
  }>
}
```

`MatchService` 改为 `hooks.onSettled?: (state: MatchState) => Promise<void>|void`，传完整 committed state，hook 只在 commit 后调用；普通 match 执行幂等 `disposeAgentMatch(state.id)`，`state.tournamentId` 非空时 no-op。hook 失败不回滚已 committed state，必须 catch 后调用 `markCleanup(...,'unknown',error)`，再由 service dispose/recovery 重试；`MatchService.settle()` await hook 的 catch/marker，不使用未 await 的裸 promise 造成 unhandled rejection。

### 3.3 Boot recovery 与唯一 owner

`ScreepsService` 构造并持有唯一 `TournamentService`：

```text
ScreepsService (Cordis Service, one instance)
├─ MatchService / MatchStore
├─ TournamentService
│  ├─ TournamentStore
│  └─ TournamentOrchestrator (one instance, handlesByTournament)
└─ shared AdmissionGate (legacy spawn + tournament create/start)
```

- `TournamentService` 通过结构化 backend 依赖调用 `ScreepsService`，不再在 `getOrchestrator()` 中临时创建第二个 owner。所有 handle 在 `registry.create()` 成功后立即登记到 `handlesByTournament`，阶段失败、首场尚未创建、轮间、终态和 service dispose 都从同一 map 回收。
- `TournamentService.dispose()` 先停止新建/推进，取消可取消的轮询，等待在途编排 promise 到达可收敛点，再逐 handle `dispose()`；单个失败记录 `cleanupUnknown`，继续清理其余，不阻塞私服 stop。`ScreepsService.shutdown()` 顺序固定为 tournament dispose → ordinary orchestrator dispose → Screeps server stop/exit guard；实现上由一个 service-owned disposer 统一 `await` 两个编排器，Cordis effect 只返回该 disposer promise，任何 handle dispose rejection 都先记录再继续。
- 共享 admission 不是只有内存锁，而是持久 reservation + 进程内互斥：

```ts
interface AdmissionReservation {
  reservationId: string
  operationId: string
  kind: 'tournament-create'|'legacy-spawn'|'tournament-advance'
  ownerId: string              // tournamentId 或 legacy operation id
  state: 'held'|'released'|'recovery'
  createdAt: number
  releasedAt?: number
  error?: string
}
```

  `AdmissionStore` 单独写 `<dataDir>/admission/state.json`，用与 MatchStore 相同的串行 promise 链 + temp/fsync/rename；`acquire(kind,operationId,ownerId)` 在同一写操作中检查没有 `held` reservation、没有 active Tournament/Match/Recovery lock，然后 no-clobber 写 reservation；同一 operationId+kind+ownerId 幂等返回原 reservation，不同 operation 返回 conflict。`release(reservationId,status,error?)` 只由 owner 在 finally 或 recovery 调用，且 revision/CAS 校验；成功释放后才允许下一 operation。
- 崩溃恢复：Service init 第一阶段独占 `recovery` reservation；扫描 admission state、Tournament/Match diagnostics。`held` 且无可恢复 owner 的 reservation 改为 `recovery` 并写 `error='owner lost during process restart'`，关联 Tournament 标 `interrupted/cleanupUnknown` 或 legacy operation 标诊断；只有清理检查完成后 `release`，不会永久占用，也不会静默重用一个半成品 operation。Recovery 期间所有 create/start/spawn 返回 503/409 `recovery in progress`，不进入 spawn。
- `AdmissionGate.runExclusive` 只包进程内互斥；所有入口必须 `acquire → 持久化 owner state → 异步编排 → finally release`。tournament-advance 只在前一 slot commit/reconcile 后 acquire，首场/下一槽创建失败由 finally release；legacy `/spawn-agents` 即使 A1 尚未生成 MatchState，也已通过 `legacy-spawn` reservation 被 Tournament active gate 看见。**普通 create/join（HTTP `POST /matches` 与工具面 `screeps_match create/join`）也必须先过 active 检查**：任一 `held` reservation、`recruiting/ready/running` tournament 或 recovery lock 存在时返回 409，避免普通对局与 recruiting/ready 窗口并发（现有 http.ts 只查 MatchState active、看不见 recruiting tournament 的缺口在此闭合）。
- `ScreepsService.init()` 不再先无条件 `match.boot()`。RecoveryCoordinator 顺序固定：
  1. `MatchStore.scanActive()` 返回普通 active、tournament active、settling，不改状态；同时取得单 host `recoveryLock`（持久 AdmissionReservation kind=`recovery`），未完成前所有 admission 返回 503/409；
  2. 对 settling match 调 `reconcileSettlement`，成功才 commit；失败保持 settling/reconcilePending，按 operationId/attemptedAt 做有界 retry/backoff，不能并发第二个 reconcile；
  3. 对已 settled 但 journal/archive marker 缺失的 match 做幂等补档；receipt/hash 冲突进入 diagnostics，不覆盖原结果；
  4. 对 tournament state 按 revision/resultId reconcile；slot 与 MatchState 的双写顺序固定为：先持久化 attempt record=`pending/creating`，再创建 MatchState，成功后 CAS slot=`running` 并写 match link；部署失败则 slot=`interrupted`/error，不让 UI 假设 running；结算统一走 `MatchLifecycle.settle`（§3.2 唯一顺序）：replay/history marker → TournamentGateway.applyResult → tournament marker → commit；slot 结果（won/draw）由该统一流程写，`currentSlotId`/下一 attempt 由 orchestrator 在 settled hook 后创建。每次双写携带 `tournamentRevision`+`matchId`，读 projection 发现 link 不一致显示 `reconcilePending`，不推进。若当前进程没有对应 handle（进程重启或 recruit 期间 owner 丢失）：recruiting/ready 直接标 `interrupted + cleanupUnknown`；running 赛事必须**级联终态化其 owned attempt MatchState**——把该赛事名下 phase 为 creating/placing/running/paused 的 match 依次安全终止：settling 的按 journal 完成或 abort，其余 transition 到 `interrupted`（与 markInterrupted 同语义但不覆盖 settling），slot 标 interrupted，最后赛事标 interrupted+cleanupUnknown，确保不留任何占用单活跃不变量 的 match，也不自动 resume；
  5. 仅对未被 tournament recovery 接管的普通 creating/placing/running/paused 调旧 `markInterrupted`；settling 不能被覆盖；
  6. recovery diagnostics 可查询后释放 recovery reservation，恢复结果可查询后才启动新 admission。Recovery lock 的获取/释放也写 finally；释放失败保留 recovery diagnostics，不能放开并发。
- `MatchStore.list()` 仍可为公开列表跳过坏目录，但 recovery 必须有 `scanDiagnostics()` 返回 missing/corrupt/torn；`TournamentStore`/`HistoryStore`/`ReplayStore` 也有相同 diagnostics，不让 corrupt state 静默消失。

## 4. Tournament 建立、Agent 生命周期与 bracket 编排

### 4.1 原子建赛与异步失败流程

新端点不依赖 M3 A0 的 A1 `screeps_match create`：

1. HTTP body 必须含 `requestId`（1–64 个可打印字符）和 `seats:4|8`；client 生成 requestId，重试复用同一值。`requestId` 规范化后计算 `requestConfigHash`（canonical hash v1，包含 seats/preset/model/provider/tickDuration），是幂等键的一部分。
2. `TournamentStore` 维护同一目录内的 `requests.json` 索引：`requestId -> {requestConfigHash,tournamentId,stateRevision}`。`createRecruiting(requestId,config)` 在自己的串行链中先读索引：相同 requestId+相同 hash 返回原 tournament snapshot（包括 failed/interrupted/ready，不创建新 id）；相同 requestId+不同 hash 返回 409；无索引时用 no-clobber temp/fsync/rename 同时写 state 和 request index（index 更新失败则不发布 tournament state）。两个 HTTP 请求不会先查后写，唯一约束由该 store 写链持有。
3. `ScreepsService.createTournament(request)` 进入 shared `AdmissionGate`，先 `AdmissionStore.acquire('tournament-create',operationId,ownerId)`，再调用上述 `createRecruiting`，reservation 与 recruiting state 都持久化后才 fire-and-forget `recruit(operationId,tournamentId)`；HTTP 立即返回 `202 {ok:true,tournamentId,recruiting:true,quotaWarning:true,operationId}`。quotaWarning 明确真实 Agent 会消耗模型额度，state/operation 已经可由 GET 查询。
4. 后台 `TournamentService.recruit(tournamentId,operationId)` 每一阶段带 `expectedRevision + operationId`：按 roster 调 `registry.create({sessionId, agentOptions, meta:{cwd,origin:'subagent',agentPreset:'screeps-tournament'}})`；每次 create 成功立即登记 handle。全部成功后 CAS `recruiting→ready`；任意失败 CAS `recruiting→failed` 写 error/operation/revision，然后 dispose 已登记 handles，最后 finally release reservation。release 失败写 admission recovery diagnostics，不把 state 改回 recruiting。
5. failed/interrupted 的 request 语义固定：同 requestId+同 config 默认返回原 failed/interrupted state；仅显式 `retry:true` 且提供新 `operationId` 时，在 AdmissionGate 内 CAS `failed/interrupted→recruiting`，复用原 participantId/displayName/seed/sessionId（不重复创建身份），清空旧 error/cleanupUnknown，旧 handles 必须已经无 owner；retry 次数/operationId 写入 `operations[]`，并重新登记新 handles。不同 active tournament 仍 409。`ready/running/completed/draw` 不允许 retry。
6. `GET /tournaments`/`:id` 暴露 `operationId`, `phase`, `revision`, `error`, `cleanupUnknown`, `retryable`，不暴露 session/handle；异步失败不能只依赖日志。
7. 异步阶段每次 state 更新都带 `expectedRevision`；`followup` 是 void，完成只能由 MatchStore 的 submitted/phase/roundToken CAS 轮询判定，不以调用返回值判定。所有后台路径以 `operationId` 做 single-flight，重复 recruiter 只能观察当前 operation，不能重复 spawn。
8. 旧 `POST /spawn-agents` 保持 M3 202/无 tournamentId 兼容，但 HTTP preflight 和 `SpawnOrchestrator.spawn` 都必须通过 shared AdmissionGate：先 acquire `legacy-spawn` reservation，再查/占用 active；A1 尚未生成 MatchState 时 reservation 已挡住 tournament create；成功 MatchState 出现后 ownerId 绑定 legacy operation，失败/timeout/dispose 在 finally release。旧端点失败日志语义不扩张为 Tournament state；legacy reservation 仍可被 recovery 扫描。

### 4.2 首场与轮间 MatchState：host 内部创建

- `TournamentService.start(tournamentId)` 只允许 ready，必须经 AdmissionGate + TournamentStore CAS；重复 start 同 request/当前 revision 返回 409 或当前 in-flight 状态，不能创建第二首轮。
- `MatchService.createTournamentAttempt(input)` 是新内部 API，不暴露 HTTP/tool：一次 MatchStore serialized operation 创建完整 `MatchState` 和两名 players，包含 `tournamentId`, `tournamentSlotId`, `attempt`, `spawnedBy='tournament'`, `codeMode='round'`, `participantId`, 新 username、新 roundToken、submitted=false；不调用普通 create/join，不会出现半个 roster。
- 创建成功后 `TournamentStore` CAS 写当前 slot attempt/matchId/phase=running；然后只向该 slot 两个 Agent handle 发 prompt。其他 roster Agent 保持空闲，等轮次到达。
- prompt 必须含 tournamentId/round/slot/attempt/matchId/displayName/对手 displayName/roundToken，并明确唯一动作是 `screeps_submit_code(..., roundToken=...)`；提交后停止当前 turn，不调用 schedule_create。
- `SessionBinding` 扩展返回 `matchId`, `username`, `matchPhase`, `codeMode`, `roundToken`, `participantId`。`resolveBinding` 优先当前 tournament active match；旧 settled match 不抢绑定。
- `screeps_report`, `screeps_wait`, `screeps_submit_code`, `screeps_console`, `screeps_read_memory`, `screeps_write_memory` 对 tournament match 要求 roundToken；旧 token/旧 scheduled turn 被拒绝。`submit_code` 在 creating 只接受一次结构合法 staged code，在 placing/running/paused/settling 明确拒绝；普通 live/frozen 工具语义保持 M3。
- **roundToken 只存 hash、明文只在内存提示中出现**：`MatchState/MatchPlayer` 只持久化 `roundTokenHash`（SHA-256，hashVersion=1），明文只在构造 prompt/工具校验的瞬间位于 host 内存；工具校验用传入明文做 hash 比较，永不把明文或 hash 写进 replay frame、HistoryStore、PublicMatchDTO、TournamentDTO、client 或 LOG。prompt 中的明文 token 不进入任何公开投影；旧 attempt 的 token 在新 attempt 后即失效。**注明**：roundToken 明文会进入发给该 Agent 的 prompt（DSH 会话转录对参赛 Agent 自身可见属可接受，因为该 Agent 本就持有自己的身份），它不出现在任何非该 Agent 可见或公开侧。
- 两位 player `submitted=true` 后由 orchestrator CAS slot ready，再调用既有 `lifecycle.start()`；lifecycle start 的“全 submitted”门槛扩展到 `spawnedBy='tournament'`，部署仍复用 M3 Arena mirror/reset/restart 代码。

### 4.3 bracket、结算和 rematch

- bracket 的匹配结算统一走 `MatchLifecycle.settle`：内部 replay/history marker → `TournamentGateway.applyResult`（唯一归属）→ tournament marker → commit。Orchestrator 不调用 applyResult，只在 settled hook 后读 slot 结果；同一 `matchId/resultId` 只推进一次（receipt no-clobber + marker 幂等）。
- lastStanding winner 转换为 participantId；ticksExhausted 等分转换为 draw。attempt 0 draw → 在同一 slot CAS 成功后创建 attempt 1：新 MatchState、new Screeps users、new username/roundToken/replay/history，participant/session/displayName 不变。attempt 1 draw → slot/tournament draw；不创建后续 slot。
- slot CAS 条件为 `(slotId, expectedSlotRevision, expectedAttempt, expectedPhase)`；并发 settle/reconcile 或重复 result 冲突返回 409；相同 resultId+相同 payloadHash 幂等。
- winner 成功后推进下一 slot；决赛 winner → tournament completed/championParticipantId；任何 recruit/deploy/replay/archive 失败 → failed 或 interrupted，不伪造 completed。
- 赛事被中断（无 handle/失败）时执行 §3.3 step4 的级联：owned attempt MatchState 全部终态化，slot+赛事标 interrupted，单活跃不变量立刻释放；不留下可阻塞后续建赛的活局。
- round-submit 的“普通 live 热更”差异写入 tournament prompt、tool descriptions、AGENTS；M4 不改变普通 `world-live` 的热更语义。

## 5. Replay：canonical public frame 与 A0 硬门槛

### 5.1 正式 frame 与公开字段

M4 replay 不透传 `room:` 默认对象 diff（其中包含内部字段），也不直接持久化当前 eventRing。arena-mod 新增 bridge，host 只收到 canonical payload：

```ts
interface PublicReplayFrame {
  sourceGeneration: string
  replayId: string
  seq: number
  gameTime: number
  rooms: Array<{
    room: string
    status: string
    novice?: boolean
    respawnArea?: boolean
    openTime?: number
    safeMode?: boolean
    own?: { username: string; level: number } | null
    publicObjects: Array<{
      kind: 'controller'|'spawn'|'creep'|'tower'|'constructionSite'
      x: number
      y: number
      username?: string
      level?: number
      hitsBucket?: number
    }>
  }>
  events: Array<{ kind: 'attack'|'destroyed'|'heal'|'upgrade'|'other'; room: string; actorUsername?: string; targetUsername?: string }>
  gap?: { fromTick: number; toTick: number; reason: 'busy'|'backpressure'|'ring-overflow'|'restart'|'reset' }
}
```

- `username` 是公开游戏昵称，host sanitizer 立即映射为本赛事 `participantId/displayName`；对外 frame 不保留 username、sessionId、userId。`publicObjects` 不含 `_id/name/store/intents/memory/code/token`；hits 只能按固定 bucket，不能暴露内部原始 object。
- `rooms` 的 `status/novice/respawnArea/openTime/own/safeMode` 是 map-stats-equivalent projection；M4 不声称是官方 `/map-stats` 原始响应。A0 把字段差异写入 spike。

### 5.2 Bridge 精确 API与背压

通过 `ScreepsService` 的结构化方法和 arena-mod system command 暴露正式 bridge（不是临时 probe）；所有响应带 `schemaVersion:1`，bridge 的生产实现和契约测试在 A0 后保留并随插件发布：

```ts
type ReplayRecord =
  | { schemaVersion: 1; sourceGeneration: string; replayId: string; seq: number; kind: 'frame'; gameTime: number; frame: PublicReplayFrame }
  | { schemaVersion: 1; sourceGeneration: string; replayId: string; seq: number; kind: 'gap'; fromTick: number; toTick: number; reason: 'busy'|'backpressure'|'ring-overflow'|'restart'|'reset' }

interface ReplayPage {
  schemaVersion: 1
  sourceGeneration: string
  replayId: string
  cursor: number          // 下一个要读取的 record seq；不是数组 offset
  nextCursor: number
  records: ReplayRecord[] // 每条 record 占一个 seq，按 seq/gameTime 单调
  status: 'live'|'complete'|'partial'
  complete: boolean       // stop 后无 gap 才 true；live 永远 false
  finalCursor?: number
  gapReasons: string[]
}

replayStart({ replayId, matchId, rooms }): Promise<{
  schemaVersion: 1; sourceGeneration: string; cursor: number; acceptedGameTime: number; queueCapacity: number
}>
replayPage({ replayId, sourceGeneration, cursor, limit }): Promise<ReplayPage>
replayStop({ replayId, sourceGeneration }): Promise<{
  schemaVersion: 1; sourceGeneration: string; finalCursor: number; finalGameTime: number;
  status: 'complete'|'partial'; complete: boolean; gapReasons: string[]
}>
```

- `cursor`/`nextCursor`/`finalCursor` 是 record seq 水位：`replayStart` 返回 `cursor=0`；第一条 record seq=0；page 返回的 `nextCursor`=最后返回 seq+1；空页 nextCursor 不变。cursor 只属于当前 sourceGeneration/replayId，limit 固定 1–200。generation 不匹配返回结构化 `staleGeneration`（host 映射 409），未知 replay 返回 404；同 generation 的 stop 幂等。
- 一个 `gap` record 覆盖闭区间 `[fromTick,toTick]`，且 `fromTick<=toTick`；该区间内每个 accepted tick 均由 gap 覆盖，不为每个 tick 虚增 seq。gap 后下一 frame 的 gameTime 必须大于 `toTick`；record seq 仍严格递增。连续 overflow 合并时只允许扩展最后一个未发布 gap 的 `toTick`，不得修改已可见 record；若 gap 尚未发布，其最终闭区间由 gap slot manifest 固定。
- `accepted roomsDone` 定义为 bridge 收到并通过 `(sourceGeneration,gameTime)` 去重、登记到 ingress queue 的 tick；重复 gameTime 不再 accepted。每个 accepted tick 必须最终落成 frame 或覆盖它的 gap record。队列上限固定为配置 `replayQueueCapacity`（默认 256），额外保留一个 gap slot；满时先以连续 gameTime 创建/扩展待发布 gap，之后才继续接收；若 gap slot 也无法写入则 bridge 标 `fatalBackpressure`、停止接受新 tick，`replayStop` 返回 partial/error，绝不静默丢 tick。
- frame/gap record 按 accepted gameTime 排序；frame 可以没有 events，但不得用“没有 record”暗示没有 tick。`eventBusy` 旧 eventLog ring 可以继续为 M3 kills/report 服务，但 canonical bridge 不复用该静默丢 tick 路径；bridge 自己串行消费并记录 busy/backpressure gap。
- `replayStop` 将 ingress 标为 closed，拒绝其后 roomsDone，等待已 ingress 的 queue/gap drain，发布最后 gap/frames 和 final manifest。无 gap 且 drain 完成 → `status='complete', complete=true`；出现任何 gap、fatalBackpressure、restart/reset → `status='partial', complete=false`。stop 期间最后一个 accepted roomsDone 必须在某条 record/gap 闭区间中；stop 重复返回同一 final manifest。
- `resetArena/restart` 先关闭当前 bridge、发布 reason=`reset`/`restart` gap（若能取得最后 tick），再使旧 generation stale；新 match 必须 replayStart 新 generation，禁止读取旧 cursor。

### 5.3 ReplayStore 可见水位与 A0 PASS gate

`ReplayStore` 布局建议为 `<dataDir>/replays/<matchId>/{meta.json,frames.jsonl,checkpoint.json}`，单 host 单 writer。`meta.json` 字段固定为 replayMetaHash 所需集合：`{schemaVersion, replayId, sourceGeneration, matchId, participantSnapshot, status: 'complete'|'partial', recordCount, firstSeq, lastSeq, gapReasons}`，保证 §5.2 `replayMetaHash` 可独立复算。

- 每次 append batch 有 `batchId`, generation, `firstSeq`, `lastSeq`, `recordCount`, `payloadHash` 和独立 `batch-manifest.json`/同目录 commit marker；frames append + fsync 后原子发布 manifest，最后才推进 checkpoint。`checkpoint.lastPersistedSeq` 是唯一可见水位，reader 只返回 `seq <= lastPersistedSeq`。
- crash 在 frames fsync 后、manifest/checkpoint 前：启动只把带完整 commit marker、行数、first/lastSeq/hash 全匹配的 batch 视为可见候选；无 marker 的完整行只能按 batchId 重放或截断，不能直接对 reader 可见；torn 最后一行截断。checkpoint 先写而 frames/manifest 失败的路径通过同目录 temp+原子发布禁止。重复 drain 以 `(sourceGeneration,seq)`/batchId 幂等。
- `lastSourceSeq` 与 `lastPersistedSeq` 分离。读取支持 `cursor/limit/afterTick`、`nextCursor`、`complete`、`status:'live'|'complete'|'partial'`、`gapReasons`；active replay 返回 200+`complete:false`，不存在 404。ordinary legacy match 没有 replay 时返回明确 `unavailable`，不伪造空完成回放。
- A0 的产物是**正式最小 bridge**（schemaVersion=1，保留在最终 arena-mod/service API 中），不是临时 probe；A0 允许修改 `arena-mod.cjs`、其契约测试和 host 结构化 bridge 类型，但禁止实现 Tournament/ReplayStore/Client 业务。A0 完成时必须同时提交并验证：bridge 代码+contract tests、`docs/spikes/m4-replay-source.md`、`AGENTS.md` 回放/客户端段同步、plan/README 的 canonical-only 表述；这四类产物作为同一 gate，任何一项未同步都不算 PASS，不能把 probe 删除后宣称 PASS。
- A0 的 PASS 仅是 **canonical-only contract PASS**，必须同时满足：
  1. 真实私服在目标 tick（至少 100/150/200ms 各一项）下 `replayStart/page/stop` 返回 schemaVersion/generation + 单调 record seq；
  2. 每个 accepted roomsDone 有 frame 或覆盖闭区间的 gap，队列满、处理失败和重启都有明确 reason/status；
  3. page limit/cursor/generation stale/stop idempotence/record gap closed-interval 可测；
  4. reset/restart 后旧 generation 不能读新场 frame；
  5. map-stats-equivalent 字段（明确是 canonical projection，不是官方每 tick HTTP 原始响应）、object/event 白名单和 username→participant redaction 契约测试通过；
  6. raw token/code/Memory/private console/userId/internal object fields 的负向测试通过；
  7. 真实队列/backpressure benchmark 无无限增长和无声丢 tick，fatalBackpressure 可观察；
  8. 四类 gate 产物（正式 bridge、contract tests、spike、AGENTS/plan/README 同步）一致且 `schemaVersion=1`。

如果 raw sockjs 或官方 map-stats 的“每 tick 原始采集”不可行，不算 canonical A0 失败；但必须在 A0 PASS 前同步修改 `AGENTS.md` 与本计划旧措辞，明确 canonical-only 等价投影边界。A0 未满足上述 canonical gate，不得进入 M4-B/C/D；M4-E 只能在 bridge schema 固定后开始。

## 6. Settlement、HistoryStore 与恢复协议

### 6.1 固定结算顺序

每个 M4 tournament attempt 和所有新建普通 match 都走 journal；旧 M0-M3 state 缺 journal 时只兼容读取，不伪造历史 replay。

1. per-match lock 内 observe 一次，得到 candidate；`beginSettlement` durable 写 phase=settling/journal。
2. backend pause；失败保留 settling/error。
3. final replay drain/stop；ReplayStore 写完 replay marker。canonical frame 有 gap 仍可 commit，标 `completeness=partial`；bridge 不可用的 tournament match 不得 commit。
4. `HistoryStore.put(resultId=matchId)`；成功写 history marker（tournament 在 applyResult 之前先归档 result）。
5. tournament match 经注入的 `TournamentGateway.applyResult(matchId, MatchResult)` 推进 slot；成功后写 tournament marker；普通 match 写 not-applicable。
6. `commitSettlement` revision CAS；成功后才调用 hook、清理内存 cursor；orchestrator 只在 settled hook 后创建下一 slot/attempt。

### 6.2 HistoryStore 与 leaderboard 边界

- `MatchResult` 主键固定 `matchId`；每个 rematch attempt 单独一条 result，字段保存 tournamentId/slotId/attempt、participantId/displayName 快照、winner/draw、scores、kills/losses、scoreWarning、replayId/completeness。
- 只有 **commit 成功** 的 settled attempt 的 MatchResult 进入公开历史/榜单；§6.1 step4 的 put 发生在 commit 之前，因此 apply 冲突→abort→interrupted 路径可能留下**已落盘但未 commit 的孤儿 MatchResult**：该 result 不可变、不删除，但必须标 `diagnostics: 'settlement-aborted'`，不计入 leaderboard、不出现在公开 history DTO；failed/interrupted 且没有 committed settlement 的 attempt 同样不计入 leaderboard，TournamentState 保留失败诊断。已经 committed 后 host 崩溃的结果仍保留并由 reconcile 补 tournament marker。
- 两次 draw 都是 settled attempt：`matches++/draws++`，不增加 wins/losses；scores/kills/losses 按各 attempt 聚合。Tournament draw 终态没有 champion。
- leaderboard 纯函数聚合 `wins/losses/draws/matches/scoreTotal/kills/lossesTaken`，排序固定 `scoreTotal desc, wins desc, participantId asc`；返回 `rank` 和 `hasMore`，limit 截断按稳定排序，不随机、不按 alias 聚合。`tournamentId` 过滤时只聚合该赛事 participantId 的 result；不传 tournamentId 时只聚合带 `participantId` 的结果（赛事参与者的历史），**普通 M3 match result 没有 participantId，只出现在对局历史/详情，不进入 leaderboard 聚合**，避免把 session 或 username 当成跨赛事身份。
- participantId 是公开历史身份；displayName 是赛事内快照，重名不合并。坏 JSON/重复主键/缺主键进入 diagnostics，不静默为空。同 rank 并列共享同一 rank 值，`limit` 按稳定排序截断并返回 `hasMore`，不把并列组拦腰切成无说明的子集。
- `DELETE /matches/:id` 只能删除非 tournament-owned 的 terminal live state；删除前必须确认 HistoryStore/replay meta 已 committed，否则 409。tournament-owned 直接 409。删除普通 live state 不删 history/replay；删除不触发新的比赛推进。

### 6.3 Boot 与跨 store 故障表

| 崩溃点 | 启动动作 | 允许的最终状态 |
|---|---|---|
| begin 前 | 普通 active 按旧规则 interrupted；无 candidate 不猜结果 | interrupted |
| begin 已写、pause 前 | 保留 settling，重试 pause/reconcile | settled 或 settling/reconcilePending |
| replay frames 写后 checkpoint 前 | 扫描完整 batch、推进可见水位；torn tail 截断 | settling 后继续 |
| replay marker 后、history 前 | 不重算 candidate，重试 history | settling 或 settled |
| history 已写、marker 前 | 通过 matchId 幂等读取/补 marker | settling 后继续 |
| tournament apply 已写、tournament marker 前 | 按 resultId/resultHash 幂等补 marker；不重复 apply，不重复推进 slot | settling 后继续（commit 完成才推进） |
| tournament apply 因 receipt/revision 冲突失败 | TournamentStore 置 failed/conflict；不 commit，不创建下一 slot | settling → abort → interrupted/failed |
| MatchState settled 后 | scan marker/archive，缺失时补档；无 journal 的旧局只报 unavailable | settled + archive status |
| tournament active 无 handle（recruiting/ready） | 不伪造 resume，标 interrupted + cleanupUnknown | interrupted |
| tournament running 无 handle（owned attempt match 处于 creating/placing/running/paused） | **级联终态化**：owned attempt MatchState 逐场安全 transition 到 interrupted（settling 的先按 journal 完成或 abort），slot 标 interrupted，赛事标 interrupted + cleanupUnknown；单活跃席位立即释放 | attempt match interrupted + tournament interrupted |
| tournament settling 无 handle | 按 journal 完成 reconcile/commit；bridge 不可恢复则 abort，然后级联终态化 | settled（replay partial 合法）或 interrupted |

Recovery 永远不重新 observe/重算 candidate；`settling` 不被普通 `markInterrupted` 覆盖，只能由 reconcileSettlement 完成或 abortSettlement 显式放弃。所有 Store 假设单 host 单 writer；不宣称多 host 并发安全。

## 7. HTTP、Client 与公平边界

### 7.1 HTTP

保留 M3 `/matches`、`/spawn-agents` 的兼容响应和测试；新增：

- `POST /dsh-screeps/tournaments`：body `{requestId,seats:4|8,model?,provider?,tickDuration?}`；先持久化 recruiting，再异步 recruit，返回 `202 {ok:true,tournamentId,recruiting:true,quotaWarning:true}`。相同 requestId 幂等，另一个 active tournament/match 409。
- `GET /dsh-screeps/tournaments`、`GET /dsh-screeps/tournaments/:id`：只返回 redacted public DTO；异步 failed/interrupted/error/revision 可查询。
- `POST /dsh-screeps/tournaments/:id/start`：只允许 ready，观战者触发，返回 202/当前 operation；不接收 participant sessionId，不代表人类入座；重复 start 409/幂等当前 operation。
- `GET /dsh-screeps/tournaments/:id/bracket`：公开 alias、slot/attempt/replay 摘要、winner/draw/gap，不含 stack/session/userId。
- `GET /dsh-screeps/matches/:id/replay?cursor=&limit=&afterTick=`：只读 redacted frames；公开 no-store。
- `GET /dsh-screeps/history/leaderboard?tournamentId=&limit=`：稳定排名，不含 sessionId。

HTTP 幂等语义固定：`POST /tournaments/:id/start` 对 completed/draw/failed/interrupted 返回 409 + 终态；对已 in-flight 的 operation 返回 202 + 当前 operationId（幂等），不重复创建。`POST /matches/:id/settle` 对已 settled/committed 的 match 保持 M3 409（外部不重放）；对 settling 返回 409 `settlement in progress`；GET history 是读取已提交结果的唯一公开路径。

现有 HTTP `GET /matches`/`GET /matches/:id` 改为显式 `PublicMatchDTO`：保留 M3 客户端启动所需 `id/phase/preset/players[{sessionId,username,submitted?}]`、公开房间/比分/时间；剥离 `userId/code/botCode/settlement journal/tournament session internals`。Tournament endpoints 使用更严格 DTO，绝不返回 sessionId。内部 host 直接读完整 MatchState。`DELETE /matches/:id` 按 6.2 规则。

**sessionId 兼容例外（明示信任边界，不伪装成无例外）**：`PublicMatchDTO.players[].sessionId` 仅对**普通 M3 match** 保留，因为现有 M3 client（`src/client/panel.tsx`）需要它向 `/matches/:id/start|pause|resume|settle` 传 creator/player session；这延续 AGENTS 已文档化的 M3 信任边界（start/settle 只认 players[0]、GET /matches 公开可读，属既有可接受风险）。Tournament endpoints 的 DTO、replay、history 一律不含 sessionId。client 迁移期先做 strict DTO guard（丢弃未知字段），避免 settlement/journal/session 内部字段进入 browser state（当前 `src/client/panel.tsx:88-113` 直轮询 `/matches` 原始形状，扩展前必须先接 guard）；未来把 M3 client 换成 host 签发观战者操作 token 取代 sessionId 不在 M4 排期，记入遗留。

### 7.2 Client

- lobby 显示 4/8、额度警告、recruiting/ready/failed/active/terminal；文案为“Agent 参赛，人类只观战/触发编排”。
- bracket 纯 projection 用 HTML/SVG；attempt 可进入 replay。
- replay player 只消费 canonical JSON：分页、播放/暂停、seek、live/complete/partial/gap banner；不声称 raw sockjs。
- leaderboard 用 participantId/name 的公开 DTO，稳定 rank/tie；不得把 HTTP 内部 DTO 放进 browser state。
- 所有轮询 no-store + in-flight guard + 最后快照 + unmount；slot/controller/React root/timer/style 都可 dispose；jsdom/HMR/browser-mcp 只用 accessibility snapshot + click/type，不截图。

## 8. 实施步骤（获 PASS 且用户确认后执行）

### M4-A0：正式 canonical bridge（第一道开工门）

1. 只读复核并记录 reference `rooms.js`、`map.js`、`user.js`、`game.js /map-stats` 的权限、payload、USER_LIMIT、throttle 和每用户 diff 基线；明确它们为何不直接成为 normative source（写入 spike）。
2. 在 arena-mod 实现并保留正式最小 bridge（schemaVersion=1，见 §5.2/5.3 契约）+ 契约测试（不实现 Tournament/ReplayStore/Client 业务）：start/page/stop、generation/seq、frame/gap 闭区间、queue/backpressure/gap slot、reset/restart stale、sanitizer/redaction。
3. 用真实私服测试 100/150/200ms；每个 accepted roomsDone 有 frame 或 gap，队列满有合并 gap/backpressure 记录，无声丢 tick 判失败；benchmark 无无限增长。
4. 同时产出并验证 5.3 的四类 gate 产物：正式 bridge 代码+contract tests、`docs/spikes/m4-replay-source.md`、`AGENTS.md` 回放/客户端段同步、plan/README 的 canonical-only 表述。A0 未满足该 gate 不得进入 M4-B/C/D；M4-E 只能在 bridge schema 固定后开始。

### M4-B：model/store/journal/history

1. 先实现纯 bracket/participant/result/redaction functions；4/8 pairing、slot CAS、attempt conflict、draw、leaderboard 边界表驱动测试。
2. 新增 TournamentStore：requestId 幂等、active gate 配合、recruiting/ready/running/terminal、revision CAS、corrupt diagnostics。
3. 新增 ReplayStore/HistoryStore：visible checkpoint、batch recovery/torn tail、immutable result、partial/gap、redacted DTO。
4. 扩展 MatchStore/Model/Lifecycle/MatchService：settling 图、begin/mark/commit/reconcile/abort、hook(state) after commit、旧 state 兼容和 M3 409 回归。
5. 实现 RecoveryCoordinator 顺序和故障注入测试；普通/tournament settle dispose 分支、删除/归档 invariant 测试。

### M4-C：TournamentService/Orchestrator

1. `ScreepsService` 构造唯一 TournamentService/AdmissionGate；service init/shutdown await/dispose 顺序先写单测。
2. `POST` 持久 recruiting 后 recruit：preassigned session/participant roster，handle immediate registration，timeout/retry/failure CAS，cleanupUnknown。
3. host 内部 `createTournamentAttempt` 原子创建两席 MatchState；prompt + roundToken；轮 token 私有工具校验；submitted CAS 后 start。
4. 实现串行 settle→journal/archive/apply→next slot；same handles、new Screeps users；attempt CAS/draw/rematch/final champion/draw。
5. 实现 boot 不自动 resume、settling reconcile、service dispose 和所有 handle 泄漏/异常测试。**故障注入测试显式覆盖**：running tournament 无 handle（owned attempt 处于 creating/placing/running/paused）逐场级联 transition 到 interrupted、settling 的按 journal 完成或 abort、slot+赛事标 interrupted、单活跃席位释放断言。

### M4-D：ReplayRecorder/HTTP

1. 接 A0 bridge；单 writer、cursor/generation、final drain/stop、gap/partial。
2. sanitizer/reducer/reader 负向测试和终局一致性；score attribution 仍使用 M3 eventLog 的独立 cursor，event ring gap 进入 scoreWarning；canonical replay gap 不与 kills cursor 混用。
3. 接 tournament/replay/history routes、PublicMatchDTO 和 M3 compatibility tests。
4. 真实 server 做 reset→start generation→frames→pause/final drain→stop→新 attempt generation 隔离。

### M4-E：Client

1. pure projections/API guards；bracket/replay/leaderboard。
2. lobby 创建/ready/start/error；recruiting 失败可见；额度和纯 Agent 文案。
3. replay player 的 complete:false/gap/seek；HMR/dispose/jsdom。
4. browser-mcp web profile accessibility 验收；不启动替代 server，不用 3080 GUI 之外的替代实现。

### M4-F：验证、TEST 与交接

1. `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`；单测含所有状态/API/故障契约。
2. 真实私服 IT 使用 fake AgentRegistry/handles（不是 fixture bot、不注入 `tests/fixtures/bots/*`），临时 dataDir/随机端口/串行单写者/精确清理；参赛 Agent 的代码是 fake handle 按 round prompt 通过 `screeps_submit_code` 暂存的**真实代码模块 payload**（确定性进攻代码或 idle 代码，复用 `tests/fixtures/bots` 中 raider/harvester 的源码内容作为纯代码字符串是允许的，但绝不作为 bot 座位/registry 注入）。拆成两个场景：
   - 场景 A：4 席两轮（4 个 session，每次只唤醒当前 slot 两个、其余空闲），首轮确定性“进攻代码 vs idle”，winner 推进到冠军；二轮 winner 代码可直接复用或由 handle 重新提交；
   - 场景 B：独立 4 席赛事，双方在 attempt 0/1 使用确定性相同 idle round code，两次都 draw，赛事进入 draw；
   两场都断言 replay/history/reconcile/zero orphan，且没有 fixture bot 作为参赛者身份（**断言对局/历史/HTTP 响应中无 `__bot__` 用户与会话痕迹**，验收只存在 fake 或 stub DSH session）。
3. 真实 DSH web + stub provider 覆盖 4-session recruiting：`POST /tournaments` 202+id → recruiting（四个 stub session 的 registry.create 证据）→ ready → observer start → 当前 slot 两个 Agent tokenized submit（其余 session 无 followup、保持空闲）→ winner → 下一 slot followup 同 session/new user → completed；另一个 stub scenario 覆盖 draw/rematch。stub 按消息内容/持久状态判阶段，不按 stream 调用次数。
4. headless 只做纯 model/store/replay smoke；HTTP/historical API 使用真实 web profile/HTTP lane，不写不可运行的 headless webServer 命令。
5. 更新 `TEST.md`：启动/patch、stub 零额度与真实额度警告、建赛/开始/bracket/replay seek/partial/gap/leaderboard/failure；每条命令/curl/patch 先真实执行并记录证据。
6. 更新 `docs/LOG.md` 倒序追加 M4，`AGENTS.md` 写回 canonical frame、round-submit、session/user 分离、settling/reconcile、M4 状态，`README.md` 写回公开 API/信任边界；不擅自 commit/push。

## 9. 验收矩阵

| 面 | 必须证据 |
|---|---|
| domain | Tournament seats=4/8；每场 Match seats=2；pairing、slot/attempt/revision/resultId 可追溯 |
| Agent owner | DSH session 跨轮；每 attempt 新 Screeps user；M3 hook 不误回收；service dispose 零 handle 泄漏 |
| settlement | settling journal；begin/marker/commit CAS；**唯一顺序（history→applyResult→tournament marker→commit）**；partial replay 合法；故障表可 reconcile；级联中断释放单活跃席位；旧 M3 409 不倒退 |
| bracket | winner 推进；slot CAS 冲突；attempt 0/1 draw；completed/draw/failed/interrupted 明确；applyResult 唯一归属（gateway） |
| replay source | A0 canonical gate；generation/seq/frame-or-gap/queue policy/reset isolation；sanitizer negative |
| replay storage | visible checkpoint、batch recovery、torn tail、cursor/limit/afterTick、终局 projection一致 |
| history | matchId immutable；rematch 独立计数；participantId 非 session；delete 不删 archive；tie/limit 稳定；receipt hash 只校验自己来源 |
| HTTP | tournamentId/async failure/queryable；M3 DTO redacted/兼容；no-store/错误码/无 token；start/settle 幂等语义 |
| client | recruiting/ready/bracket/replay/history、partial/gap、seek、slot/HMR/dispose、无内部字段 |
| composition | 4-seat two-round real private server + fake handles；独立 draw/rematch；web stub；零孤儿且无 `__bot__` 痕迹；TEST/LOG 证据 |

## 10. 风险与遗留

- A0 canonical bridge 性能不足时允许显式 gap/partial，不允许静默丢 tick；不宣传“每 tick 无损录像”。
- 跨进程 Agent capability 不可从持久 state 恢复；crash 后只做 interrupted/cleanupUnknown，不承诺自动续跑。
- 单 host 单 writer/单 active tournament/match；多 host、多赛事并行、远端联机、认证另排期。
- 旧 state 缺 journal/replay 时兼容读取但返回 unavailable，不猜历史结果。
- 不做 World tournament、world-rounds、2v2、多房 Arena、完整 renderer、raw sockjs 浏览器录像、竞猜/聊天/认证、测试 bot 产品化。
