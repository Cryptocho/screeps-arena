# M6 计划 v3 — 产品补全：Agent 代码查看器 + 观战坐标地图（客户端三件事收口）

> 审查记录：
> - **一审（subagent，2026-09-09）：不 PASS → 1 阻塞 + 8 次要 + 11 提示（v2 全部吸收）**。
>   阻塞 B1：§4-F IT 未写明提交通道——记录点 1/2/3 全在 `tools.ts` execute 内（L343-349 / L370-376 /
>   L385），照抄姊妹先例 `tests/m5-rounds.it.test.ts` L77-80 的 `store.update` 直写会**绕过全部工具层
>   记录点**，「seq 递增且内容一致」必落空 → v2 §4-F 写死：IT 提交一律走 `buildTools(svc)` 的
>   `screeps_submit_code.execute`（`tests/tools.it.test.ts` L63-71 模式；`resolveBinding` 直读活跃局
>   座位 `tools.ts` L74-76）；`store.update` 直写仅允许 bot 座位注入前置态（记录点 4 在 lifecycle 内不受影响）。
>   次要 1：记录点 4 的 phase 取值实为 **placing**（`lifecycle.ts` L201 先 `transition('placing')` 再
>   L240-251 注入）→ v2 改。次要 2：`resumeNextRound`（L325）是**第五个代码上服点**（每轮 resume 对全部
>   ready 玩家真传）→ v2 写明「内容与记录点 1 同份、不另记」的决定。次要 3：projection.ts 措辞——
>   测试存活（`projection.test.ts` L6 import）、产品零引用；且另有独立模块 `src/client/m4/projection.ts`
>   （5 处 import）→ v2 精确化。次要 4：terrain 编码是**位域**（bit1=wall、bit2=swamp，**3=墙+沼泽同格
>   合法**，索引 y*50+x；`checkTerrain` 在 arena-mod L843）→ v2 修正 + `projectTerrain` 打表含 3。
>   次要 5：全套 IT 现为 14（tests/ 13 + node-runtime.it），新增后 **15/15** → v2 改。次要 6：client
>   terrain 缓存须「仅缓存非空成功响应」→ v2 写明。次要 7：AGENTS「观察分层」节「对手代码永不可见」
>   需补限定（指 Agent 工具面）→ v2 文案任务加入。次要 8：赛事局（codeMode='round'）creating 提交经
>   L315-328 roundToken 校验后落入 L366-380 暂存=被记录点 2 覆盖 → v2 补单测防回归。
>   提示 P1-P11 全部吸收进 §3/§4（sessionId 禁入断言、内容端点全文件过滤、DELETE/append 并发无害化
>   单测、live 分支原样记录、`__bot_` 座位公开性同 DTO、GET /matches 裸 state 事实校准、world spawns
>   合并定案（worldSnapshot L892 已查 spawn 全量，按 (user,room) join）、IT 承载写死、离屏 canvas 缓存、
>   store 原子写区间 L121-133、seq 从文件行数播种）。
> - **二审（subagent，2026-09-09）：PASS（阻塞 0，次要 2，提示 5）**。吸收核对：一审 20 条全部落位
>   可溯源；源码论断抽查 30+ 处仅 3 处行号漂移且内容全对；新设计（code-log/端点/缓存/IT 承载）论证成立。
>   次要 1：**记录点 3（live 直传）无测试载体**——IT 用 world-rounds 局覆盖不了（rounds running 拒 live
>   提交）→ v3 §4-A 增补 `tools.test.ts` 记录点单测（fake svc + fake code-log 覆盖点 1/2/3，点 3 用
>   arena-blitz running 相位直调 execute），并把「赛事局 creating 被记录」从 code-log 单测列表移入此处。
>   次要 2：§2「round 分支拒绝」与「赛事局 creating 落暂存」矛盾 → v3 改「round **非 creating 相位**拒」。
>   提示：行号校准（controller 预赋权实为 L866-869、spawn 全量查询实为 L891、m4/projection.ts 为 4 处
>   import）；jsdom 无 canvas 2D → getContext null-guard + 投影以纯函数为主测试载体；离屏画布定死
>   `document.createElement('canvas')`；内容端点 username 可选 USERNAME_RE 预校验（省一次全文件解析）；
>   mod spawn join 边角（spawn 房不在 controller rooms[]）直接丢弃 + 注释。
> - **三审**：（如需）

> 依据（用户拍板，2026-09-09）：M6 范围 = **产品补全**——AGENTS「客户端面」三件事
> （对局生命周期 / 观战 / **Agent 代码查看**）中最后一件是明文「规划项：尚未实现」；
> 同批收口 S12/M2 遗留的「地形/spawn 坐标地图增强」（`board.tsx` L114-115 注释自证：「真正的坐标地图 +
> 地形留 M2（world 快照补 terrain 后）」）。公平前提 AGENTS 已拍板：**观战看代码不违反公平边界**
> ——「对手代码永不可见」指 Agent 侧工具；观战是人类公开视角，实现须与观察分层文案对齐。

## 1. 目的与范围

**目的**：观赛体验补全——人类观战者能看到每个 Agent **提交了什么代码（含跨周期迭代史）**，以及
**带地形与 spawn 坐标的真实世界地图**。Agent 工具面零新增，公平边界原样。

**范围（做）**：
- A. 提交记录层（host）：submit_code 三种分支 + start 注入统一落一份 per-match 追加日志（codes.jsonl）。
- B. HTTP 观战端点：提交版本列表 + 单条内容（公开观战面，无 sessionId/token）。
- C. client 代码查看区：玩家选择 + 版本列表 + 内容视图（行号 + 极简高亮，纯函数）。
- D. 地形/spawn 数据面：arena-mod 新增 `GET /api/arena/terrain` + world 快照补 `spawns`；host 透传端点。
- E. client 坐标地图（canvas）：地形 + 归属色 + spawn 标记 + 房间名；**与现有卡片地图并存，切换视图**。
- F. 验证：单测 + 真实私服 IT + 浏览器 MCP 自动化验收 + 公平边界回归。

**明确不做（范围外）**：
- **server 回读当前生效代码**（GET /api/user/code 回读）——提交流水已覆盖观战语义「Agent 提交了什么」；
  「服务器当前字节」核对留遗留。
- diff 视图、代码下载导出、monaco 级编辑器、回放帧内嵌代码、官方 sprite 房间细节渲染、
  world-frozen 建赛开放、2v2/击杀分到 T（玩法深化另立里程碑）、Agent 侧任何新工具/字段。

## 2. 现状事实（一审逐条核实，动手前复核行号）

- **submit_code 三分支**（`src/host/tools.ts` execute 内）：
  - rounds roundBreak commit：L338-359（`store.update` 写 `mine.code` + `mine.ready=true`）；
  - creating 暂存：L366-380（`mine.code` + `submitted=true`）；**赛事局（codeMode='round'）提交经
    L315-328 roundToken 校验后同样落入此暂存分支**——记录点 2 天然覆盖；
  - live 直传（arena-blitz running 等）：L385-386 `svc.submitCode(...)` —— **host 状态不留副本**；
    该分支对 modules 只有「main 是 string」校验（L330-332，无 `module.exports.loop` 检查）——流水
    **原样记录**，观战语义无需补校验（一审 P4）。
  - frozen / round（**非 creating 相位**）/ placing 分支均为拒绝，无代码产生（round 分支在 creating
    相位放行进暂存，见上一条）。
- **start 注入点**（`src/host/match/lifecycle.ts`）：L201 `transition('placing')` **先于** L240-251 注入
  循环 → 记录点 4 的 phase 取值 = **placing**（一审次要 1）；`const code = player.botCode ?? player.code
  ?? EMPTY_CODE`（L245；EMPTY_CODE L95）。
- **第五个代码上服点（写明决定，一审次要 2）**：`resumeNextRound`（lifecycle.ts L325）每轮 resume 对全部
  ready 玩家 `backend.submitCode?.(username, player.code, '$activeWorld')`——上服内容与记录点 1
  （roundBreak commit）**同份**，观战语义无增量 → **不另记流水**；实现时在 code-log 模块注释里写明此决定，
  防后人当漏记修。
- **持久化布局**（`src/host/match/store.ts`）：每场对局一个目录 `<dir>/<matchId>/`（L2、L112），
  state.json 原子写 = tmp 写 + **rename 原子发布（完整区间 L121-133）**（一审 P10）；**DELETE
  /matches/:id 已整目录删除**（L395 `rm(matchDir, {recursive, force})`）——同目录新增 codes.jsonl 的清理
  **自动成立**。
- **追加日志先例**：M4 ReplayStore frames.jsonl（append-only + finalize）——codes.jsonl 同构但更简单
  （无 checkpoint/torn-tail 问题：单行 JSON，坏行跳过）。
- **HTTP 路由形态**（`src/host/http.ts`）：路径解析 `rest` 数组；GET 分流须在「非 POST 即 405」检查**之前**
  （L428-449 console/observe 先例）；DELETE 已并入 rest.length===2 块（L414-427）；错误映射 L98-107；
  username 字符集校验 `/^[A-Za-z0-9_-]{1,30}$/`（L72，URL 段免转义）。
- **公开观战面先例**：`GET /dsh-screeps/matches/:id/observe`（L443-450）、`GET /matches/:id/console`
  （L428）——代码端点同级别，均无鉴权。
- **事实校准（一审 P6，非本计划缺陷但须知情）**：`GET /matches`、`/matches/:id`（http.ts L383/L412）
  当前**直接返回原始 MatchState**——players[].code/botCode/sessionId 本就随公开 DTO 出去（start 需
  creator sessionId 的既有信任边界）。M6 新端点 DTO 比它们干净；「暂存代码人类可见」在现状已成立，
  M6 增量只是 live 提交与注入空壳入流水。
- **world 快照**（`src/host/service.ts` L66-87 `ScreepsWorldSnapshot`）：users[].rooms = {room, level,
  progress}；**无 spawns 坐标、无地形**。数据面 = `arenaFetch`（L607-610）+ `getWorld`（L612-614）。
  optional 字段兼容先例：`creeps?/spawnEnergy?`（L81-84，外部旧版 server 缺）。
- **arena-mod 路由面**（`screeps-mod/arena-mod.cjs`，挂载 L1581）：`GET /world`（L1528）、
  `POST /rooms`（L1546）、`POST /system`（L1537）、`GET/POST /users`、`POST /token`。
- **world spawns 合并定案（一审 P7，悬问已解；行号二审校准）**：`worldSnapshot` 实现 **L891 已查询**
  `type:'spawn'` 全量对象（含 room/x/y/user，`$ne:null` 过滤；spawns 即 results[2]）——按 (user, room)
  join 进 rooms[] 条目即可，零新增查询。出生房 controller 由 placeSpawn 预赋权（arena-mod **L866-869**
  `$set {user, level:1, safeMode}`）→ 两形态 rooms[] 从 tick0 非空，坐标地图不会空场（镜像房 controller
  的中立副本 user:null 是 createUser 前中间态）。**边角处理**：spawn 所在房不在该用户 controller rooms[]
  的情形（当前流程不可达）直接丢弃 + mod 注释一句（二审提示 5）。
- **地形存储格式（一审次要 4 修正）**：`db['rooms.terrain']` 行 = `{room, terrain}`，terrain 为 **2500
  字符位域字符串**（50×50，索引 = y*50+x；`reference/screeps/common/index.js` L25-41 `encodeTerrain`：
  **bit1=wall、bit2=swamp，3=墙+沼泽同格合法**；`checkTerrain` 在 arena-mod L843）。渲染 wall 优先。
  `'1'.repeat(2500)` 全墙桩（L1085）、镜像 `reverseTerrain`（L1289）。
- **client 看板**（`src/client/match/board.tsx`）：MatchBoard = 头部 + 横幅 + WorldMap（L116-167，
  **玩家卡片地图**，S12 已验收）+ 比分 + console（L325-330）；轮询 `usePollJson`（L81-110）。
  L114-115 注释明示坐标地图是遗留增强项。
- **client 投影纯函数（一审次要 3 精确化）**：`src/client/match/projection.ts` 四函数
  （`parseRoomName` L30 / `ownerColor` L39 / `projectRooms` L57 / `worldBounds` L77）**仅测试引用**
  （`projection.test.ts` L6），**board.tsx 产品路径零引用**（内联同款 hash L136-139 属实）——M6 复活
  该模块而非新写。注意另有独立模块 `src/client/m4/projection.ts`（赛事投影，**4 处** import：m4.test.ts
  L23、bracket-view.tsx L9、leaderboard.tsx L9、replay-player.tsx L10），两者勿混。
- **DTO guard 先例**：`src/client/m4/api.ts` `guardMatch`（strict 白名单）——代码端点 DTO 同样 client 侧
  guard。
- **公平边界红线**（AGENTS）：Agent 工具不新增（工具面 8 工具枚举无 HTTP/fetch 能力；「浏览器与 Agent
  都拿不到裸 Screeps token」）；M2 对手代码负向测试不动。

## 3. 设计定案

### 3.1 提交记录层（`src/host/match/code-log.ts` 新模块）
- 文件：`<dir>/<matchId>/codes.jsonl`，一行一条 JSON：
  `{seq, ts, username, phase, roundIndex?, source, size, modules}`。`seq` 单局从 1 递增；
  `source`: `'agent-submit' | 'start-injected'`；`size` = modules 序列化字节数（列表端点只给 size 不给
  内容）。**严禁携带 sessionId**（tools.ts 手边就有 `exec.agent.id`，schema 不含 + IT 全文断言兜底，
  一审 P1）。
- **记录点（四处，覆盖全部代码产生路径；第五上服点不另记，见 §2）**：
  1. tools.ts rounds commit 成功后（store.update 返回后追加，phase=`roundBreak`，带 roundIndex）；
  2. tools.ts creating 暂存成功后（phase=`creating`；普通局与赛事局 codeMode='round' 的 creating 提交
     都经此处——补一条赛事局记录单测防回归，一审次要 8）；
  3. tools.ts live `svc.submitCode` 成功后（phase 取当时 match.phase 或 `running`）；
  4. lifecycle.start 注入成功后（source=`start-injected`，**phase=placing**；botCode/空壳都记——观战
     完整性，空壳一眼可辨；`__bot_` 座位进列表与公开 DTO 已含 username 一致，无新增泄漏，一审 P5）。
- **写入纪律**：模块级 promise 链串行追加（单写者语义；tools 与 lifecycle 两个调用方并发不交错）；
  appendFile 单行；**记录失败只 log 不抛**——绝不阻塞对局主流程（单测钉死：写失败时 submit 仍成功）。
  DELETE 与 in-flight append 并发 → ENOENT 自然落入失败只 log 路径，无害（补一条单测，一审 P3）。
- **seq 播种（一审 P11）**：读取时若文件已存在，seq = 既有行数 + 1（防同目录重启续写撞号；当前恢复语义
  = interrupted 终态不续写，此为防御性一行）。
- 读取：列表（解析全部行，坏行跳过并计数）与单条（**解析全文件后按 (username, seq) 过滤**，勿用 URL
  username 拼路径，一审 P2）两个纯函数 + 文件不存在返回空。
- 体积防御：不做截断/上限（真实链路实测单条 ≤ 10KB、一局 < 50 条），体积告警留遗留。

### 3.2 HTTP 观战端点（http.ts）
- `GET /dsh-screeps/matches/:id/code` → `{ok, matchId, players: [{username, versions:
  [{seq, ts, phase, roundIndex?, source, size}]}]}`——**不含内容**（列表轮询轻量）。
- `GET /dsh-screeps/matches/:id/code/:username/:seq` → `{ok, username, seq, ts, phase, size, modules}`。
  可选优化：URL username 先过 `USERNAME_RE`（http.ts L72）预校验快速 404（读取本就是全文件过滤，无路径
  拼接风险，仅省一次解析，二审提示 4）。
- 两个 GET 都按 console/observe 先例在 POST-only 405 检查之前分流；对局不存在 → notFound(404)。
- DTO 纪律：无 sessionId、无 token、无 Memory/console 内容（只有 Agent 主动提交的代码本身）。
- client 侧 guard 纯函数（对齐 m4/api.ts 模式）白名单收口。

### 3.3 client 代码查看区（新组件 `src/client/match/code-view.tsx`）
- 挂载：MatchBoard 比分与 console 之间；标题「代码 · 提交记录」。
- 交互：玩家 tab（默认 players[0]）→ 版本列表（seq、时间、phase/周期、size，最新在前，默认选中最新）
  → 选中才 fetch 内容一次（不轮询；列表 5s 轮询 no-store，复用 usePollJson）。
- 渲染：`<pre>` 等宽 + 行号 + **极简 JS 高亮纯函数**（`highlightJs(src): {text, color?}[]`，单遍 regex
  tokenize：注释/字符串/关键字三色，~40 行，打表单测；不做嵌套语法树）。版本多时列表滚动。
- 空态：无记录 → 「该对局暂无代码提交记录」。

### 3.4 地形/spawn 数据面
- **mod**（arena-mod.cjs）：
  - 新增 `GET /api/arena/terrain?rooms=E1N1,E2N1`（≤64 房，房名 regex 校验同 POST /rooms L1548）→
    `{ok, terrain: {<room>: <2500 字符位域串>}}`，数据源 `db['rooms.terrain']`。
  - `GET /world`（L1528）扩展：users[].rooms[] 每房补 `spawns: [{x, y}]`——**实现定案（一审 P7）**：
    L892 已查询 type:'spawn' 全量对象（含 room/x/y/user），按 (user, room) join 进 rooms[] 条目，零新增
    查询。字段 optional 语义（外部旧 server 缺 → client 降级不画标记，同 creeps? 先例）。
- **host**（service.ts + http.ts）：
  - `svc.getTerrain(rooms: string[])` 新方法（arenaFetch 透传）；
  - `ScreepsWorldSnapshot.rooms[]` 加 `spawns?: {x,y}[]`（optional）；
  - `GET /dsh-screeps/world` 投影透传 spawns；新 `GET /dsh-screeps/terrain?rooms=...`（校验 + ≤64 房）
    透传。**host 不缓存**。
- **client 缓存（一审次要 6 精确化）**：按 matchId 缓存，**仅缓存非空成功响应**——空/失败响应不缓存，
  随 world 轮询（3s）重试，避免开局前空拉把整局钉死在降级态。地形单局内不可变（generateRoom 全在
  start 内，resetArena 只发生在 start 前）+ matchId 唯一性（`model.ts` L251-253 时间前缀+随机尾、
  `store.ts` L171 活跃局互斥）→ 缓存失效论证成立。

### 3.5 client 坐标地图（board.tsx WorldMap 视图切换）
- WorldMap 头部加切换（`卡片 | 坐标图`），**默认卡片**（保护 S12 已验收的可读性体验）。
- 坐标图（canvas，新纯函数进 `src/client/match/projection.ts` 复活）：
  - 视口 = `worldBounds(cells)` 包围盒（含 8 邻缓冲），房间格固定 cellSize（如 96px），横向滚动兜底
    （S12 教训：不缩字）；
  - 房间格：归属色底/边框（`ownerColor`）+ RCL；房内 50×50 地形微渲染（**位域着色：bit1 wall 深色、
    bit2 swamp 蓝灰、3=wall 优先、0 透明**，terrain 串逐字符 y*50+x 索引）+ spawn 标记（▲）；
    房间名 + 坐标轴标签仅在格子 ≥22px 时绘制文字；
  - 纯函数：`projectTerrain(room, terrainStr, spawns) → 像素指令/色阵`，**打表必须含 3（墙+沼泽同格）**
    （一审次要 4）；`projectRooms` 扩展携带 spawns（原字段不变，旧调用零破坏）。
  - **离屏缓存（一审 P9；画布载体定死，二审提示 3）**：地形按房离屏 canvas 缓存（50×50 逐字符 =
    2500 rect/房，≤64 房 16 万矩形静帧可承受，但 3s world 轮询重绘会抖动）——重绘只叠归属色/标记层，
    不重画地形层。离屏画布用 `document.createElement('canvas')`（兼容面最稳，不用 OffscreenCanvas）。
- **jsdom 空值防御（二审提示 2）**：jsdom 无 canvas 2D，`getContext('2d')` 返回 null——坐标地图组件与
  离屏缓存 mount 路径必须 null-guard（null 时跳过绘制只留 DOM 图例/标签），jsdom 单测才不会假红；
  投影逻辑以 `projectTerrain` 纯函数返回色阵为主测试载体。
- 无 terrain 数据（拉取失败/未加载）时房间格降级为纯归属色块——地图永不白屏。

### 3.6 公平边界与文案对齐
- **Agent 工具面零新增**：tools.ts 仅在既有 execute 内加记录调用，工具 schema/description/负向测试全不动。
- 文案更新（文档任务 F 内）：
  - AGENTS「客户端面」段——「Agent 代码查看（尚未实现，规划项）」改为已实现 + 语义边界（「观战看提交
    流水 = 人类公开视角；Agent 工具面对手代码仍不可见」）；
  - AGENTS「观察分层」节原句「对手代码/memory/console 永不可见」**补一处限定（指 Agent 工具面）**——
    M6 后观战查看器与该句字面并存，防两章节表面打架（一审次要 7）；
  - board.tsx L114-115 注释同步。
- HTTP DTO 断言进 IT：全文无 `sessionId`、无 token 字段。

## 4. 任务清单

### A. 提交记录层
- [ ] `src/host/match/code-log.ts`：追加（串行链 + 失败不抛）、列表（坏行跳过）、单条读取（全文件过滤）、
  seq 播种；模块注释写明「resumeNextRound 第五上服点不另记」决定；单测（并发顺序、写失败不阻塞、坏行
  容错、seq 递增与播种、DELETE 并发 ENOENT 无害）。
- [ ] **记录点测试载体在 `tools.test.ts`（二审次要 1）**：该文件已有 buildTools+execute 直调模式（L80 附近）
  → 加记录点单测：fake svc + fake code-log，覆盖点 1/2/3——点 1（rounds roundBreak commit）、点 2
  （creating 暂存，**含赛事局 codeMode='round' 的 creating 提交被记录**——从 code-log 单测列表移入此处，
  它是 tools.execute 层行为）、点 3（**arena-blitz running 相位直调 execute 走 live 直传**，断言 append 的
  phase/source/modules；这是 IT 覆盖不到的路径——rounds running 拒 live 提交）。
- [ ] tools.ts 三分支接入（3.1 记录点 1-3）；lifecycle.start 注入后接入（记录点 4，phase=placing）。
- [ ] store.ts：codes.jsonl 随 matchDir 整删（L395 已 recursive，补单测断言删除后文件消失）。

### B. HTTP 端点
- [ ] 两个 GET 端点（3.2）+ http 单测（fake code-log；404；DTO 无敏感字段断言）。
- [ ] client guard 纯函数 + 单测。

### C. client 代码查看区
- [ ] `code-view.tsx` + highlight 纯函数 + jsdom 单测（tab 切换、版本选择、内容渲染、空态）。

### D. 地形/spawn 数据面
- [ ] mod：`GET /api/arena/terrain` + world spawns join（L892 已有 spawn 全量，(user,room) 合并）；
  terrain 字符语义以 `checkTerrain`（L843）+ `common/index.js` L25-41 位域为准。
- [ ] service.ts `getTerrain` + Snapshot 类型；http.ts world 透传 + terrain 端点；单测（fake svc）。
- [ ] mod 契约测试：terrain 端点房名校验/≤64 上限；world spawns 存在性（IT 覆盖真实数据）。

### E. client 坐标地图
- [ ] projection.ts 复活/扩展（projectRooms 带 spawns、projectTerrain 位域打表含 3、视口计算）+ 打表单测。
- [ ] board.tsx WorldMap 切换 + canvas 渲染（离屏地形缓存）+ 降级路径；jsdom 单测（切换按钮、图例文本、
  无数据降级）。

### F. 验证
- [ ] 单测全绿 + typecheck 双 program + build。
- [ ] **IT `tests/m6-product.it.test.ts`（真实私服）——提交通道写死（一审 B1）**：提交一律走
  `buildTools(svc)` 的 `screeps_submit_code.execute`（`tests/tools.it.test.ts` L63-71 模式，
  `resolveBinding` 直读活跃局座位），**禁止照抄 m5-rounds.it 的 `store.update` 直写**（那会绕过工具层
  记录点 1-3）；`store.update` 直写仅允许 bot 座位注入前置态。承载 = 真实私服 + 工具 execute 驱动 +
  `handleArenaRequest` 直调端点断言（http.test.ts 模式；node:http 承载已有 http.it.test.ts 覆盖，不重复，
  一审 P8）。流程：world-rounds 局（roundTicks 小值）→ creating 经工具提交 → start（bot 座位注入记录）
  → roundBreak 经工具提交 round1 → 断言：代码列表 seq 递增且内容与提交一致；`GET terrain` 返回 wall
  边界 + 主房地形；world DTO spawns 有坐标；全文无 sessionId/token。与全套存量 14 IT 零回归
  （fileParallelism:false 照旧）。
- [ ] **浏览器 MCP 自动化验收**（零额度）：HTTP create + smoke state 注入第二玩家 → start →
  accessibility 快照断言：代码区标题/玩家 tab/版本列表文本/内容中包含提交片段；地图切换按钮/图例文本。
  canvas 像素观感属纯视觉（MCP 达不成）→ TEST.md 列人工项（唯一人工项，符合测试协作纪律）。
- [ ] TEST.md 增补 M6 节（启动方式 + 本节人工项 + 自动化已覆盖清单）；AGENTS（客户端面 + 观察分层两处）
  /README/LOG 文档收口。
- [ ] 真实 LLM 链路观战演练（TEST.md 注明需用户批准额度）：real-web-lane 建赛 → 代码查看器看到
  真实 Agent 跨周期代码差异。

## 5. 验收矩阵

| 面 | 必须证据 |
|---|---|
| 提交记录 | 四个记录点全覆盖：点 1/2/4 经 IT，点 3（live 直传）经 tools.test 单测（IT 不可达路径，二审次要 1）；记录失败不影响对局主流程；seq 单调含播种；DELETE 清理连带 codes.jsonl |
| HTTP | 列表/内容端点 IT 实测（工具 execute 驱动提交）；DTO 无 sessionId/token（全文断言）；404 语义 |
| client 代码区 | jsdom + 浏览器快照双验证；版本选择/空态/行号渲染 |
| 地形/spawn | mod terrain 端点真实私服 IT；world spawns DTO（(user,room) join 实现）；host 透传 ≤64 房校验 |
| 坐标地图 | 切换默认卡片（S12 体验零回归）；位域打表含 3；离屏缓存；无 terrain 降级不白屏 |
| 公平边界 | Agent 工具面 diff 零新增（schema/description/负向测试原样）；AGENTS 两处文案与观察分层对齐 |
| 回归 | 全部单测绿、**15/15 IT 全绿**（存量 14 + 新增 m6-product）、双 tsc 0 错、build 绿 |

## 6. 风险与遗留（范围外 → 持续遗留）

- server 回读「当前生效代码」与提交流水的差异核对（如 Agent 用 console 改行为）——观赛语义上提交流水
  足够，差异检测留遗留。
- diff 视图、代码导出、monaco 级高亮、回放帧内嵌代码、官方 sprite 房间细节渲染（AGENTS 渲染策略的
  第二阶段）。
- codes.jsonl 无体积上限（防御性截断）——真实单条 ≤10KB、数十条/局，风险可忽略，留观察。
- 外部旧版 server（external 模式）world 无 spawns 字段 → client 降级（optional 先例同构）。
- canvas 地形观感（配色/密度）属纯视觉，以 TEST.md 人工项收口；Agent 自动化止步于 DOM 文本断言。
- 既有 `GET /matches` 裸 state（players[].code/sessionId 直出，一审 P6）的收敛——M4 已记录
  「host 签发观战者 token 取代 sessionId」方向，继续留遗留，M6 不扩面。
