# M3 计划 v5.5（七审 **PASS**）— Arena blitz + spawn-Agent 玩家闭环（产品核心改造）
> **2026-09-09 M5 superseded 注**：A0 spawn-Agent 编排沿用；world-frozen/arena-blitz 保留；本计划提及的 `world-live` 产品建赛已废弃（M5 改 world-rounds）。

> 审查记录：v1-v4（镜像歼灭四审 PASS）→ v5-v5.4（spawn-Agent 重审五轮）→ v5.5（七审 **PASS**，1 次要+4
> 提示已折叠进本版，定稿）。
>
> **v5.5 七审（subagent 62b4dbeb）结论：PASS（无阻塞）**。一/二/三/四/五/六审意见全部收敛：
> - 核心验收通过：门槛仅 spawn 局（普通局/工具面/HTTP 面/9 IT 零回归，防绕过闭环成立）；
>   model 新字段 optional 不破坏旧 state；`lifecycle.start` L130 扩字段行号零漂移；门槛插入序与现有代码
>   零冲突；暂存 submit 拦截点 = tools.ts resolveBinding+store.get 后、svc.submitCode（getToken）前；
>   DSH 驱动契约（create resolve 后逐 handle followup() 唯一驱动口）证据复核一致；spawn 仅 live 预设。
> - 次要 1/2 + 提示 3-6（本版已折叠进正文）：HTTP create 钉死「文档化信任边界」；placing submit 显式拒
>   （防御性）；IT 名单补 tools.it；spawnedBy 打标写点（host 观察 A1 create 后 store.update）；Agent 起名
>   冲突（prompt 互异约束 + start 前查重）；HTTP spawnAgents 202+recruiting 异步响应；stub provider 注入
>   途径（svc.spawnAgentMatch 显式 provider 参数）。
>
> **v5.4 六审（subagent 5afdaeea）不 PASS → B1 复诊 + 5 次要 + 6 提示（v5.5 已修）**：
>
> **v5.4 六审（subagent 5afdaeea）不 PASS → 1 阻塞（B1 复诊）+ 5 次要 + 6 提示（本版已修）**：
> - **阻塞 B1 复诊（v5.4 只豁免 botCode 座位，漏普通 session 玩家）**：match.it L45-50 / http.it L85-113 /
>   m2-battle L105-116 / m2-closed-loop L96-107 的普通玩家在 start 时 `submitted=false && botCode=undefined`
>   → 按字面全卡 → 9/9 IT 回归必破。**v5.5 改「门槛仅对 spawn-Agent 局生效」**：MatchState 加来源标记
>   `spawnedBy: 'agents'`（A0 spawn 建赛时打），判定 = 仅 spawn 局要求 `所有玩家 submitted===true`；
>   普通 create/join 局（工具/HTTP 直连，IT 用）**无门槛**——旧流程零回归；补单测（spawn 未就绪拦 /
>   普通局不拦 / bot 局不拦）。顺手在 model.ts 落地 `MatchPlayer.{code,submitted}` + `MatchState.spawnedBy`。
> - 次要 ①（HTTP join 移除后 http.it 2 玩家链断 + create 收紧反噬：普通局无门槛 → http.it 不受门槛影响，
>   join 断言随移除删除，create 收紧选「文档化信任边界」防反噬）、②（门槛插入序：players>=2 → spawnedBy
>   校验 → phase）、③（暂存分支无绑定先拒，tools.ts 声明顺序）、④（spawnAgents 真实 LLM 额度：client 二次
>   确认 + 文档；测试用 stub 零额度）、⑤（超时 Config 字段 `agentRecruitTimeoutMs` 默认 180s）已吸收。
> - 提示（已记）：m2-battle 行号现值（rooms L120 / clearSafeMode L129-141 / kills L149）、writeMemory
>   L368-377、IT1 双 bot 硬性、client 按钮加 submitted 指示、受影响 IT 名单显式列（回归基线段）、
>   code/botCode 来源隔离声明（spawn 局无 botCode、bot 局无 code，model 注释已标）。
>
> **v5.3 五审（subagent 6bad1979）不 PASS → 1 阻塞 + 4 次要 + 4 提示（v5.4 已修，机制保留）**：
>
> **v5.3 五审（subagent 6bad1979）不 PASS → 1 阻塞 + 4 次要 + 4 提示（本版已修）**：
> - **阻塞 B1（全就绪门槛卡死 botCode 测试链）**：plan「全 players submitted 才放行，旧 state 无 submitted
>   视为未就绪」按字面执行，m2-battle/closed-loop IT 的 botCode 座位 + C 节 world-frozen（frozen 拒 submit）
>   + IT1/IT2 双 bot 全部无法 start → 9/9 IT 回归必破。**v5.4 钉死：就绪判定 =
>   `submitted===true || player.botCode!==undefined`（bot 座位天然就绪）**，C/E 节同步。
> - 次要 S1（集成验收装置：devDeps 无 dsh-agent/loop/llm/base，裸 Context 无 ctx.agents/llm → 钉死 (a)
>   devDeps+Loader boot / (b) 全局 CLI+stub hook 二选一 + stub turn-script 契约，实现时先 spike 最小 boot）、
>   S2（风险节「已在 AGENTS 文档化」失实 → 改「随 F 节回写」）、S3（join 无名单限制注明进正文）、
>   S4（HTTP join 关闭语义=移除 + http.it.test.ts 连带改 + HTTP create 去留收紧）已吸收。
> - 提示 N1（行号漂移四处：eliminated L190 / observe L166 / settle L253 / frozen 拒 L289 / 热更 L296
>   已按现值修正）、N2（「空脚本就绪」→「结构非法脚本」措辞，注明空 loop 通过是设计）、N3（拦截层钉死
>   tools.ts submit_code 按 phase 分支且先于 getToken）、N4（暂存注入与开赛后热更同分支闭环确认）已记。
>
> **v5.2 四审（subagent abf7342b）不 PASS → 2 阻塞 + 4 次要（v5.3 已修，机制保留）**：
>
> **v5.2 四审（subagent abf7342b）不 PASS → 2 阻塞 + 4 次要（本版已修）**：
> - **阻塞 1（准备期 submit 不可行）**：Screeps 用户 placing 阶段才建号（lifecycle.ts L128-136），creating
>   阶段 submit_code 走 getToken → `/api/arena/token` **未建号 404**（arena-mod.cjs L885-892）→「写脚本→
>   就绪」链断裂。**v5.3 采用暂存式 submit**：creating 阶段 submit_code 由 host 拦截存 `MatchPlayer.code`
>   （复用 botCode 形状）+ 最小合法校验（非空/有 main/含 loop）后置 submitted；`lifecycle.start` L130 扩为
>   `botCode ?? code ?? EMPTY_CODE` 建号注入（同构先例：bot 座位）；开赛后 live 走正常热更。
> - **阻塞 2（分阶段 followup 无失败/超时语义）**：followup 是 void 异步唤醒（runtime-types.d.ts L115），
>   编排靠轮询。**v5.3 钉死**：阶段超时窗口 120-300s（默认 180 可配）、失败检测（轮询「players==count 但
>   某 player 无 submitted」）、一次重试 → dispose 全部 + 409、轮询间隔 2-5s。
> - 次要 1（start 门槛放 lifecycle.start 共享，防工具面绕过）、次要 2（frozen 标注目标区/明确不做/验证节
>   三处一致）、次要 3（submitted 最小合法校验 + 旧 state 无字段视为未就绪）、次要 4（e2e 可编程触发 =
>   测试工具/函数直调 + spawn provider 指 stub route）已吸收。
> - 提示（已记）：风险节补「观战者触发」条、activeExists 预检入 A0、lifecycle.start 行号现值 L104-148、
>   验证节补 spawn stub-lane、join 无名单限制可接受注明。
>
> **v5.1 三审（subagent 135a7bce）不 PASS → 1 阻塞级待拍板 + 4 次要 + 5 提示（v5.2 已收敛）**：
>
> **v5.1 三审（subagent 135a7bce）不 PASS → 1 阻塞级待拍板 + 4 次要 + 5 提示（本版已收敛）**：
> - **待拍板「Agent 自主起名」→ 用户指正定案**：起名本来就是 `screeps_match create/join` 的 `username`
>   参数——Agent 自填即自起名，入座同时写进 MatchPlayer；前端准备室直接渲染。**不存在「起名上报通道」
>   问题**（v5.1 因曾选 host 预入座方案才产生伪问题）。v5.2 编排链改 **方案 B 具体化（分阶段 followup）**：
>   spawn（不入座）→ followup A1「起名+create」→ host 观察新 match → followup A2..N「起名+join」→
>   前端显示完整名单 → followup「写脚本」→ submit_code（host 回填 submitted）→ 全就绪 → 人类点开始。
> - 次要 1（frozen×spawn）**钉死方案 b**：世界-frozen 产品建赛排期外（走 C 节 botCode 测试链路），人类建赛
>   仅 live（world-live/arena-blitz）。
> - 次要 2（HTTP join 关闭）、次要 3（全就绪 = submit 回填 submitted，不引入 ready action）、次要 4
>   （prompt 文案改「host 已入座/直接写脚本」随新流程重写）已吸收。
> - 提示 1-5 已吸收：stub lane 落点（headless patch 注入）、spawn 前 activeExists 预检、
>   「人类点开始 = 观战者触发规则」补 AGENTS、start/settle 授权形状随 http.ts 注释收尾、
>   工具面 create/join 保留（回归 IT 用）。
>
> **v5 二审（subagent 135a7bce）不 PASS → 2 阻塞 + 6 次要（v5.1 已修，机制仍保留）**：
> - **阻塞 1（A0 驱动机制）**：DSH `create()` 后 Agent **不自动开首 turn**（`dsh-agent-loop` publish 只
>   enter/announce/emit `agent/session-start`，不开 driver；`setup` 明令 "composes, it never drives"；
>   seed 只是历史）——唯一驱动口 `handle.agent.followup()`（runtime-types.d.ts L115 "wake the driver"）。
>   **v5.1 钉死：create resolve 后逐 handle `followup(playerPrompt)`**（含玩家编号/preset），seed/setup 不再
>   承担驱动（配套单测：followup 恰一次、失败原子 dispose）。
> - **阻塞 2（编排链未定义）**：「host 入座」vs「Agent 自主 create+join」矛盾、matchId 无法预分发、浏览器
>   代持 Agent 身份语义未钉。**v5.1 选方案 A（host 预建赛+预入座）**：host 用首个 spawn sessionId 建赛 +
>   `addPlayer` 预入座，Agent 只做起名+submit_code（prompt 预带 matchId）；失败 dispose 全部 + 409。
> - 次要 1-6（已吸收）：arena count 强制=2（B 节只支持两房）；world count [2,seats] 校验防半截 `'full'`；
>   **「全就绪」判定** = `MatchPlayer.ready` + `screeps_match ready` action + HTTP start ready 门槛；
>   **model 不进 MatchConfig**（spawn 时 per-session 定死，放 spawnAgents + Config 全局默认 + PRESETS 映射）；
>   **e2e LLM 供给** = `ctx.llm.registerAdapter` stub lane（零 token 确定性）；**frozen×spawn** = 方案 A 下
>   frozen 走 botCode 注入通道、live 走 Agent 自主 submit（frozen 拒 submit 不看 phase 的坑避开）；
>   **初始 prompt 含运行期协议**（report→submit→自调度 followup，AGENTS 再激活通道 2）。
>
> **P0 设计审查（subagent b2c6f8ab，01119a5 后）结论：不 PASS → 阻塞 1 + 次要 8 已全部修复**（见 LOG）：
> - **阻塞 1（已修，本版核心）**：client「一键开赛」伪造 `client-uuid` 会话 + 空壳代码占座 → 制造 0 Agent
>   空壳局，且 Agent 无入座通道。**用户拍板修法：人类点击创建对局 → host `AgentRegistry.create()`
>   spawn N 个 Agent 会话作为玩家（Arena=2、World=可配置数量、**模型型号可配置**）→ 各自起名并进入
>   准备（写脚本）→ 全就绪开赛**。替代伪造 sessionId 占座（HTTP 面 sessionId 信任边界已文档化）。
> - 次要 2-5 + 提示 6-8（本轮已修）：并发事件双计单飞锁 / IT fixture 锚定 / schedule 文案回写 spike /
>   README/AGENTS 陈旧文档 / screeps_wait 补单测 / 代码查看器标规划 / HTTP sessionId 文档化。
> - 提示：「IT 多 session 模拟 ≠ 真实多 Agent 决策循环」——回合制并发/超时/就绪竞态 IT 测不到，
>   **spawn-Agent 的真实多会话并发由专门的集成面验收（本版 E 节新增）**。
>
> v4 四审记录（保留历史，镜像歼灭方案已 PASS）：
> 结论（subagent 22ba9252）：10 条阻塞（一审5+二审2+三审3）全部修复吸收，未发现新方向性缺陷。
> PASS 依据（已验证关键假设）：镜像方位推导（W15N15→东邻 W14N15，utils.js L28-44）、镜像链顺序、
> addWalledNeighbors 不覆盖 base（L624-627 skip）、镜像 controller→placeSpawn 赋权链
> （realCreateUser L333 不拒 / L418-422 赋权）、world 判据对 m2-battle 零回归（该 IT 只断言 kills>0 +
> manual settle）、clearSafeMode 免 restart 可复用、固定房名复用安全、raider 210≤300、frozen 拒
> submit / `__bot__` 双拒无需新机制。
> 四审次要 2 条（本版已并入）：
> 1. **A 节「读 base terrain 对象数组」失实**：base terrain 在 db 是编码字符串（map.js L512
>    encodeTerrain → L558 insert）——**直接读字符串做每 50 字符一行反转，勿按对象数组读**；
> 2. **IT1「spawnEnergy=300」断言过强**：start 的 resume 已放行首 tick，raider spawnCreep 次 tick 结算，
>    快照可能已扣 210 → **改「双侧 spawnEnergy 严格相等」**，绝对值=300 挪到 mod 契约测试。
> 四审提示 2 条（本版已记）：标题已改 v4；base right 出口反转=镜像 left、其余边界全墙天然对称，可加注释。
>
> 三审要点（subagent 22ba9252）：
> - **B3（镜像方位写反）**：`roomNameToXY('W50N50')`=(-51,-51)（utils.js L28-44，东邻=roomNameFromXY(x+1,y)
>   ='W49N50'，西邻才='W51N50'）→ v3 把西邻当右邻，base exits.right 开向未生成的东邻、镜像在西侧靠随机
>   left 出口 → 互不可达（一审阻塞 3 复活）→ **v4：镜像=东邻（roomNameFromXY(x+1,y)），示例改
>   W15N15/W14N15，base 显式 exits.right 开向东**。
> - **B4（镜像链顺序反）**：v3 把 updateTerrainData 放 addWalledNeighbors(镜像) 之前，与官方链相反
>   （arena-mod L718-721 addWalledNeighbors→updateTerrainData）——新插斜角墙桩不进 blob，restart 后
>   runner 缺斜角房 → "Could not load terrain data" flake 必现 → **v4：addWalledNeighbors(镜像) 在
>   updateTerrainData 之前**。
> - **B5（IT1/IT2 缺 clearSafeMode）**：placeSpawn L420 设 safeMode=gameTime+20000 免疫攻击，m2-battle
>   L126-133 实证必须先清 → v4 IT1/IT2 每房 clearSafeMode + roomObjects 前置断言（safeMode<gameTime）。
> - 次要（v4 已吸收）：① 镜像 controller 的 room 字段须改镜像房名；② mineral 复制保留
>   mineralType/density/mineralAmount；③ spawnEnergy 断言 start 后立即取；④ attackController 落正文；
>   ⑤ Memory.arena 注入钉死 writeMemory（service.ts L372-381 已有）。
> - 提示（v4 已记）：exits 登记钉死不写 db.rooms 字段；固定房名安全性（IT 串行+resetArena 清场）；
>   IT1 玩家侧建议双 bot。
>
> 二审要点（subagent 22ba9252）：
> - **B1（镜像链漏 addWalledNeighbors）**：updateTerrainData 只补 4 方向 H/V 邻桩（map.js L681-688），
>   镜像房东侧斜角（W52N49/N50/N51）无 terrain → pf.cc A* "Could not load terrain data" flake
>   （m0-flake 50% 冻结同族）→ **v3：镜像链补 `addWalledNeighbors(镜像)`（8 方向）**。
> - **B2（IT2 双 raider 随机房互不可达）**：world 随机房（pickRoomName L46-49）相距数十房、中间无 terrain
>   → 战斗不发生 → eliminated 不达 → IT2 验收落空 → **v3：IT2 start 显式相邻房 + exits（m2-battle
>   L111-114 先例）**。
> - 次要（v3 已吸收）：① controller 钉死 = 镜像复制 base controller（level 0、user 置空），与 source
>   同路径，删「级联方案 B」绕路；② arena 拒收 rooms 的实现层语义（http.ts L294-302 只查格式不知 form
>   → start 校验 form==='arena' 且 rooms 非空则拒）；③ external 旧 mod 缺 arenaGen 命令降级；④ raider
>   寻敌策略钉死 `Game.map.describeExits`；⑤ 时长 20k×300ms≈1.7h（非 2.2h）；⑥ arenaGen 参数透传照
>   /rooms 路由 L918-924（勿抄 system generateRoom L710-713 只透传 exits）。
> - 提示（v3 已记）：双 bot winner 已有 E3 先例；spawnEnergy 累加现有 spawn find；attackController 不
>   影响判据；spawns/rooms 对称断言。
> - 已确认零回归：m2-battle 只断言 kills>0 + manual settle（L166/L169），不依赖 eliminated → world 判据
>   改 spawns+creeps 是增强非破坏；[ATTACK,ATTACK,MOVE]=210≤300 已实战；client start 不传 rooms
>   （panel.tsx L165）、9 IT 全 world → arena 拒 rooms 影响面小。
>
> 一审核心结论（subagent 22ba9252，源码行号证据）：
> - **阻塞 1（推翻技术核心）**：arena「controller:false 干净方案」伪命题——引擎 spawnCreep 强依赖
>   controller（`engine/src/processor/intents/spawns/create-creep.js` L17 → `engine/src/utils.js` L463：
>   无 controller/level<1/user 不匹配 → intent 被丢弃）→ 无 controller 房造不出任何 creep，歼灭无从谈起。
>   **替代（v2 采纳）**：保留 controller + placeSpawn 标准预赋权（arena-mod.cjs L418-422 现成语义：
>   controller.user=己方、level 1、safeMode=gameTime+20000）；两房各属一方 → 无中立 controller 可 claim →
>   禁 claim/禁扩张天然达成；safeMode 用现成 `clearSafeMode`（M2 已实现）清除免疫。
> - **阻塞 2（镜像克隆链三缺）**：plan v1 只写 addWalledNeighbors+addAccessibleRoom，漏：
>   ① 镜像房位置可能已有 addWalledNeighbors 插的墙桩 → 必须 removeWhere 先清（本仓库 generateRoom
>   链 L715-717 正是如此）；② 必须 `db.rooms.insert({_id, status:'normal', sourceKeepers:false})` 登记
>   （事件采集 arena-mod.cjs L205 `db.rooms.find` 与 cronjobs 按枚举基准；updateTerrainData 只处理
>   db.rooms 里有的房）；③ 必须 `updateTerrainData()` 重建 TERRAIN_DATA blob（map.js L661-695，
>   generateRoom 链 L721 先例）。
> - **阻塞 3（双房连通性未设计）**：镜像房不走 stock generateRoom（exits 匹配逻辑 map.js L81-113 不执行），
>   其余方向被墙桩封死 → 可能互不可达。**v2 方案**：基准房 generateRoom 显式传 exits（开向镜像房方向），
>   镜像房手动写对称 exits（`right↔left`，水平翻转下出口格 y 坐标不变 → 零计算对称）。
> - **阻塞 4（world-frozen IT2 不可达）**：placeSpawn 预赋权 → ownedRooms 恒≥1 且 controller 不可毁，
>   CONTROLLER_DOWNGRADE[1]=20000 与 maxTicks 同量级 → 原判据 `ownedRooms==0 && spawns==0` 永不满足。
>   **v2 修法**：world eliminated 判据改 `spawns==0 && creeps==0`（战斗意义上失去生产力+战力即出局；
>   controller 不可毁是引擎事实，判据不含它——同时回写 AGENTS）；IT2 改用战斗 bot 互殴造出真实 eliminated。
> - **阻塞 5（raider 依赖悬空）**：IT1/IT2 依赖 addBot(raider)，D 节却把 raider 降为可选 → **v2：raider 必做**。
> - 次要（v2 已吸收）：「generateRoom 返回坐标」事实错误（map.js L14-22 是 help 文本，L564 返回 'OK'）→
>   坐标靠 rooms.objects 查询；IT1 能量断言无数据源（worldSnapshot 无 energy 字段）→ worldSnapshot 补
>   spawn 能量；Invader 三重保险免骚扰（cronjobs L377-394）→ 已确认不处理；external 模式新命令兼容未提
>   → arenaGen 走 CLI 命令面（system），external 只读 arena API 不受影响。
> - 已验证成立：terrain 2500 字符按 `y*50+x` 每格 1 字符（common/index.js L25-58 encodeTerrain/decodeTerrain），
>   「每 50 字符一行反转」正确；arenaCreateUser 需覆盖 realCreateUser 全字段（L314-381）——v2 已简化
>   为复用 realCreateUser（保留 controller 后无需独立路径）；plan-M2 明确不做清单承接正确；frozen 拒
>   submit 已实现（tools.ts L289）；SPAWN_ENERGY_START=300 / SPAWN_HITS=5000（constants.js L139-140）；
>   package.json files 已含 bots。
>
> 流程：按 AGENTS「里程碑标准流程」——计划书 → subagent 审查 → 停等结果 → PASS 才开工；
> 不 PASS 则修改后重新送审，循环至 PASS。审查轮次只计数，不设终审。

## 现状事实（已取证，动手前复核行号）

- **三预设数据已就位**（`src/host/match/model.ts` L43-47）：`arena-blitz` = `{form:'arena', frozenCode:false,
  tickDuration:150, maxTicks:2000, seats:2, scoring:{territory:0, rcl:0, kills:1, losses:1, energy:0}}`；
  `world-frozen` = `{form:'world', frozenCode:true, tickDuration:300, maxTicks:20000, seats:4}`——
  **form 字段目前无人消费**，start 是 world 专用流水线。
- **start 是 world 专用流水线**（`src/host/match/lifecycle.ts` L104-148，原 L89-133）：resetArena → 逐玩家 generateRoom +
  createUser → restart({resume:false}) → setAccessibleRooms → setTickDuration → resume。无 form 分支。
- **placeSpawn 已是标准预赋权套路**（arena-mod.cjs L383-427）：插 spawn 对象（type:'spawn', user, x, y,
  store:{energy: SPAWN_ENERGY_START=300}, hits: SPAWN_HITS=5000, spawning:null…）+ `controller.user=user,
  level 1, safeMode=gameTime+20000` + `db.rooms invaderGoal=1000000` + `activateRoom`。**arena 双侧各调一次
  即得己方 controller**，无需新路径。
- **generateRoom 全链 = 镜像克隆的模板**（arena-mod.cjs L704-727）：removeWhere(房 terrain) → stock
  generateRoom → addWalledNeighbors → updateTerrainData → addAccessibleRoom。镜像房克隆照抄此链。
- **createUser 强依赖 controller**（realCreateUser L330-343：查 controller，缺 → throw 'room controller
  not found'；有主 → throw 'already owned'）——v2 保留 controller 后**无需 arenaCreateUser 独立路径**，
  直接复用 realCreateUser。
- **terrain 双格式互通**（common/index.js L25-58）：db.terrain 存对象数组 `[{x,y,type}]` 或编码字符串
  （`y*50+x` 每格 1 字符 0/1/2/3；encodeTerrain 从数组编码、decodeTerrain 解码）。**镜像反转 = 字符串
  每 50 字符一行反转（x'=49-x，y 不变）**；addWalledNeighbors 桩用 `'1'.repeat(2500)` 字符串（L626）
  证明字符串格式合法。
- **updateTerrainData 是 blob 权威**（map.js L661-695）：以 `db.rooms.find()` + `db['rooms.terrain'].find()`
  为准 deflate 进 env TERRAIN_DATA；**未登记 db.rooms 的房不参与**；'out of borders' 房全墙化；每房自动
  补 H/V 邻墙桩。generateRoom 会 `db.rooms.insert({_id, status:'normal', sourceKeepers})`（L557）。
- **exits 结构**（map.js L16, L275-294）：`{top:[x], right:[y], bottom:[x], left:[y]}`（top/bottom 是 x 列，
  left/right 是 y 行）；exit 格在 terrain 里编码为非墙。**水平翻转下 right↔left、y 坐标不变 → 对称 exits
  零计算**（基准 right:[y] → 镜像 left:[y]）。
- **worldSnapshot 已有 spawns 计数**（service.ts L46-63；arena-mod.cjs L436-473：spawns.forEach 累加）——
  「拆光对方 spawn」判定 = 该用户 spawns==0。**缺 creeps 计数与 spawn 能量**（v2 补）。
- **eliminated 现判据（lifecycle.ts L190）**：`ownedRooms==0 && spawns==0`——**预赋权下永不满足**（阻塞 4）。
- **BotRegistry 已支持目录加载**（`tests/helpers/bot-registry.ts` L26-66：`tests/fixtures/bots/<name>/main.js`，
  已有 `harvester`）；与玩家同走 createUser 公平通道（2026-09-09 迁出产品路径）。
- **world-frozen 现状**：`frozenCode:true` 下 submit_code 已被拒（tools.ts L289）；lastStanding autoSettle
  判定在 observe（lifecycle.ts L166/199）+ settle 裁决已实现（L253）——缺完整玩法闭环验收。
- **DSH 原生支撑（P0 取证）**：`AgentRegistry.create`/`resume`（`dsh-agent/lib/types/index.d.ts` L65-140）
  可程序化创建 Agent 会话（sessionId 自定、agentOptions.model 可配、AgentHandle 带 dispose）——人类建赛
  spawn N 玩家的技术基础。

## M3 目标（AGENTS 里程碑对齐）

0. **【核心】spawn-Agent 玩家闭环**（用户拍板）：人类点「新建对局」→ host spawn N 个 Agent 会话为玩家
   （Arena=2 / World=可配置数量 / **模型可配**）→ 各自起名、准备、写脚本 → 全就绪开赛。替代伪造 sessionId
   占座（P0 阻塞 1 修法；client「一键开赛」红线修复）。
1. **arena mod 预置对称兵力**：镜像克隆（terrain 逐行反转 + objects 镜像复制 + 对称 exits + 完整登记链）、
   双方对称 spawn + 对等初始能量、两侧各保留己方 controller（无中立 controller → 禁 claim/禁扩张）、禁 NPC。
2. **单房歼灭结算**：拆光对方 spawn（spawns==0）+ 无 creep → eliminated → lastStanding 语义；maxTicks 到时
   按 kills 主导比分判 winner（scoring 已定义）。
3. **`arena-blitz` / `world-frozen` 预设完整可用**：form 分支接线（lifecycle.start）+ world eliminated 判据
   修正（spawns+creeps）+ frozen 完整玩法闭环验收。**注：world-frozen 预设数据可用，但其产品建赛
   （人类 spawn-Agent）排期外**（A0 钉死：人类建赛仅 live；frozen 由 C 节 botCode 测试链路验收）。
4. **测试专用 bot**：`bots/raider`（或测试 fixture 位置）用于 IT 驱动战斗；**不做预置对手、
   不打包第三方策略 bot**（对局参与者只能是 Agent，2026-09-09 用户对齐）。

## 任务清单

### A0. 核心改造：人类建赛 → spawn N Agent 玩家（P0 阻塞 1 修法，用户拍板）

> 用户期望：「人类点击创建对局 → 开启两个 Agent Session，它们为自己起名并开始准备（写脚本）」。
> Agent 就是玩家；Arena 生成 2 个、World 生成可配置数量；**模型型号可配置**。
> 已取证可行：`AgentRegistry.create(CreateAgentOptions)`（`dsh-agent/lib/types/index.d.ts` L65-140）
> 程序化创建 Agent 会话，`agentOptions.model` 可配型号；`AgentHandle` 带 dispose（对局结束收会话）。

- [ ] **host spawn 能力（新模块 `src/host/agents.ts`）**：
  - 依赖 DSH `AgentRegistry` create（service 注入 `ctx.agents`）；spawn N 个会话
    `{sessionId: 生成, agentOptions: {model: 可配}, setup: 合成作用域}`。
  - **驱动机制（审查阻塞 1，钉死）**：DSH `create()` 后 Agent **不会自动开首 turn**（publish 只 enter/
    announce/emit session-start，不开 driver；seed 只是历史、setup 明令 "composes, it never drives"）。
    **必须于 create resolve 后逐 handle 调 `handle.agent.followup(playerPrompt)`**——与 "Drive the agent
    only after creation resolves" 契约一致。
  - 数量/模型从对局配置读：`spawnAgents: {count, model?}`（Arena **强制 =2**（B 节只支持 base+mirror 两房）、
    World `[2, seats]` 校验（审查次要 1：count>seats 会在 store.addPlayer 半截 `'full'`）；**model 超时
    spawn 时 per-session 定死，不进 MatchConfig**（per-match 概念错位，审查次要 3）——放 `spawnAgents`
    请求体 + Config schema 全局默认 `agentModel?`（`service.ts` Config）+ PRESETS 只作缺省映射；
    `isMatchConfig` 忽略多余键已核不破坏旧 state（store.ts L64）。
  - 对局结束/删除/中途 dispose → `AgentHandle.dispose()`（停 loop→await exit→unregister→removes session→
    unwind scope，index.d.ts L142-158）。
- [ ] **编排链（用户指正定案 = 方案 B 具体化：起名即 create/join 的 username 参数，零新机制）**：
  - **起名 = 工具参数**：`screeps_match create/join` 的 `username` 就是 Agent 自己起的名——Agent 调
    create/join 时自填，入座同时名字写进 MatchPlayer（`store.create/addPlayer` 的 `{sessionId, username}`），
    **前端 creating 准备室直接渲染**（client 既有 players 卡牌）。**不需要任何「起名上报通道/改名动作」**。
  - 流程（分阶段 followup，天然解决 matchId 分发）：
    1. 人类点「⚔️ 新建对局」→ host spawn N 个 Agent 会话（**不入座，无对局**）→ 前端「招募 N 个 Agent…」过渡态；
    2. followup **A1**（玩家 1）：prompt「你是本局玩家 1，preset=X，**为自己取一个 ≤30 非 `__bot__` 的用户名**，
       用 `screeps_match(action=create, username=<你起的名字>, preset=X)` 建局入座」；A1 执行 → `store.create`
       生成 matchId → 前端出现对局 + 名单 [A1 的名]；
    3. host 观察到新 active match（`store.list` 轮询，spawn 模块 await）→ followup **A2..N**：
       prompt「matchId=X，**为自己起名**，用 `screeps_match(action=join, matchId, username=<你起的名字>)`
       入座」→ 各自 join → 前端准备室显示完整名单（每个 Agent 自起的名）；
    4. 全部入座 → followup「各位可以写脚本了」→ 各 `screeps_submit_code` → host 在 submitCode 成功后回填
       `MatchPlayer.submitted = true`（**暂存式 submit，见下「写脚本机制」**）→ 前端「✓ 已就绪」；
    5. 全部 submitted → 人类点「开始」→ `lifecycle.start`（HTTP start 传 creator sessionId，观战者触发规则，
      见风险节）。
  - **写脚本机制（四审阻塞 1 + 五审 N3/N4，钉死暂存式 submit）**：Screeps 用户在 creating/placing 阶段**未建号**
    （`lifecycle.start` L128-136 才 createUser；`submit_code` 经 getToken → `/api/arena/token` 对未建号
    **404**，arena-mod.cjs L885-892），「准备期直接写脚本到私服」走不通。**采用暂存式 submit**：
    `screeps_submit_code` 在 creating 阶段由 host 拦截——**拦截层钉死：tools.ts submit_code execute 内
    （resolveBinding + store.get 后）按 `match.phase==='creating'` 分支暂存，且必须在 `svc.submitCode`
    （service.ts L380 getToken 链）之前拦**，否则 404 照旧；把 modules 存进 `MatchPlayer.code`（新字段，复用
    botCode 形状），`submitted = true`（**最小结构合法校验后**：modules 非空 + main 存在 + 含
    `module.exports.loop`，防「结构非法脚本就绪」——空 loop 通过是设计，N2）；`lifecycle.start` L130 扩为
    `player.botCode ?? player.code ?? EMPTY_CODE` 建号时注入（**同构先例**：bot 座位 botCode 就是这么注入的；
    N4 确认闭环：arena-mod realCreateUser 把 code 写进 `users.code` 的 branch:'default'+activeWorld:true，
    热更 submitCode 默认 `$activeWorld` 替换同一激活分支 → 暂存注入与开赛后热更**同分支不冲突**，world-live
    准备期暂存+开赛后热更闭环成立）。开赛后 live 预设的 submit_code 走正常热更路径（build 分支激活）。
    这兼作「准备期暂存到 ready 生效」（rounds 已知坑①的 live 侧实例）。
    **placing 阶段 submit 分支（七审次要 2 钉死）**：placing 是 start 触发的同步部署瞬态（无在驱 turn），
    submit_code 在 placing 阶段**显式拒**（「进行中,请等待开始」）——实际不可达（start 需全 submitted 才可点），
    防御性兜底即可，单测补一条。
  - **失败/超时语义（四审阻塞 2，钉死）**：followup 是 void 异步唤醒（runtime-types.d.ts L115），host 不能
    await 完成 → 编排推进靠**轮询 store 状态 + 阶段超时**：
    - 阶段超时窗口 **120-300s**（默认 180s）——**Config schema 加 `agentRecruitTimeoutMs`（service.ts
      Config，默认 180_000）**（次要 ⑤ 钉死字段名）：A1 建赛、A2..N 入座、写脚本三个阶段各设 deadline；
    - 失败检测 = 轮询发现「players.length == count 但某 player 无 submitted」到点未变 → 判该阶段失败；
    - 策略：**一次重试（followup 同阶段再驱一次）→ 仍失败 dispose 全部已 spawn 会话 + 409**；
    - 轮询间隔 2-5s（低频，不刷屏）。
  - **任一 spawn/建赛/阶段失败 → dispose 全部已 spawn 会话 + 409 返回**（原子性，配测试）。
  - **HTTP join 关闭（三审次要 2）**：方案下所有玩家由 Agent 工具面 join（exec.agent.id 真实），HTTP join
    端点废弃（避免任意 sessionId 占座复活）。
- [ ] **client「⚔️ 新建对局」改造**（替代伪造 `client-uuid` 会话 + test_a/test_b 空壳占座）：
  - 点按钮 → host spawn N Agent → 「招募中」过渡态 → A1 create 后对局出现在列表 → 准备室渲染 Agent 自起名
    （仿 S12 赛前准备室，卡牌=真实 Agent 会话 id + 自起名）→ 各自写脚本（submitted 打勾）→ 全就绪 → 开始可点。
- [ ] **全就绪判定（六审 B1 复诊钉死：仅 spawn-Agent 局启用门槛）**：`MatchPlayer.submitted?: boolean`（暂存式
  submit 回填 + 最小**结构**合法校验：modules 非空 + main 存在 + 含 `module.exports.loop`——只能挡结构非法，
  空 loop 与 EMPTY_CODE 结构不可分**必然通过是设计**（开局后 live 热更可自救），措辞为「防结构非法脚本就绪」；
  N2 注明不做空壳启发式拒判）；**start 门槛放 `lifecycle.start` 共享**（工具面 `screeps_match start` 走同一
  lifecycle，防绕过）——**但门槛只对 spawn-Agent 局生效**（六审 B1 复诊：五审只豁免 botCode 座位，漏了
  match.it/http.it/m2-battle/m2-closed-loop 四个 IT 的普通 session 玩家（非 bot 无 submitted），按字面判定
  全卡 → 9/9 IT 回归必破）：
  - **判定 = 仅当该局由 A0 spawn-Agent 创建（MatchState 打来源标记 `spawnedBy: 'agents'`）时，
    `所有玩家 submitted===true`（spawn 局全是 Agent，无 botCode 混合）才放行**；
  - **spawnedBy 打标写点（七审提示 4 钉死）**：host 观察 A1 create 生成 matchId 后立即
    `store.update(matchId, s => s.spawnedBy = 'agents')`（A1 create 到打标间仅 1 名玩家、players>=2 兜底，
    无实际绕过窗口）；createMatch 不内置该字段（普通 create 不触发）。
  - **Agent 起名冲突（七审提示 5 钉死）**：同名 → start 建号 realCreateUser throw 'user already exists'
    （arena-mod.cjs L347）→ start 中途炸（resetArena 已执行、部分用户已建）——**followup prompt 加
    「与现有玩家昵称互不相同」约束 + start 前查重（重名 → 清场+409，不烧到建号）**，单测补。
  - **普通 create/join 局（工具面/HTTP 面直连，IT 用）无门槛**——保持旧流程零回归（9/9 IT 不受影响）；
  - 防绕过：spawn 局由 host 管理（HTTP start 是唯一入口），工具面 `screeps_match start` 对 spawn 局
    creator=A1（真实 Agent 会话）——同走 lifecycle，来源标记一致门槛生效。
  - 补单测：spawn 局未全就绪 start 被拦；普通局无 submitted 玩家 start 不被拦（旧 IT 零回归）；
    botCode 座位局（bot 局）不被拦。
  - **门槛插入序（六审次要 ② 钉死）**：`lifecycle.start` 内顺序 = `players.length>=2` 校验 →
    **spawnedBy==='agents' 时全 submitted 校验** → phase 校验（creating/placing）→ placing 流转。
    creating/placing 都查（spawn 局 submitting 窗口只在 creating）；普通局跳过门槛。
  - **暂存分支的绑定前提（六审次要 ③）**：tools.ts submit_code 拦截先做 resolveBinding——spawn 期（A1
    create 前）会话未入任何局时无绑定，**先拒（未绑定）**；已绑定 creating 局的会话才进暂存分支；开赛后
    走原热更。计划正文声明此顺序。
- [ ] **spawnAgents 真实额度资源（六审次要 ④）**：spawn 出的是**真实 Agent 会话（真 LLM，烧模型额度）**——
  建赛端点/测试触发前**明确提示用户将被消耗模型额度**（client 按钮二次确认文案 + HTTP 响应提示 + 文档）；
  测试用 stub provider 零额度（见集成验收）；避免无感知烧钱。
- [ ] **world-frozen × spawn（三审次要 1，钉死方案 b）**：**M3 明确「人类建赛仅 live（world-live/
  arena-blitz）；world-frozen 产品局排期外**」——frozen 拒 submit 不看 phase（tools.ts L288-291）与
  Agent 准备写脚本天然冲突，产品上 frozen 局（纯 AI 对撞）由 C 节 botCode 注入通道验收（测试链路），
  不纳入 spawn-Agent 人类建赛范围。**目标 3 相应标注「world-frozen 预设数据可用；产品建赛排期外」**
  （次要 2：目标区/明确不做/验证节三处一致标注）。
- [ ] **HTTP 面**：新增建赛端点（spawnAgents，body: {preset, count?, model?}）+「开始」沿用 start（观战者
  触发）；**响应语义（七审提示 6 钉死）**：spawnAgents 返回 **202 + {matchId?, recruiting: true}**（异步编排，
  A1 create 前 matchId 未知 → 前端轮询对局列表「招募中」进展，不做同步全链等待）；「开始」沿用 start（同
  lifecycle，全就绪门槛在 server 侧拦）；**spawn 前 `activeExists` 预检**（store.ts L72-74 单活跃局约束——
  先查再 spawn，避免 spawn 完才 409）；
  sessionId 真实性校验文档化；`__bot__` 保留命名仅测试链路；http.ts L271 注释随收尾对齐。
  - **HTTP join 关闭语义（五审 S4）**：join 端点**移除**（方案下所有玩家由 Agent 工具面 join，exec.agent.id
    真实）；**连带改 tests/http.it.test.ts 的 join 断言**（现 L96-103 有 join 用例，删除/改谓词），回归基线
    同步；**HTTP create（POST /matches, http.ts L199-215）去留**：spawnAgents 取代产品建赛，但 create 保留
    给工具面/测试用——风险：任意 sessionId 可 create 占座局（activeExists 会挡掉后续 spawn，submitted 门槛
    挡假局开赛，但占座本身要 409 才拦）——**HTTP create 的 sessionId 校验钉死为「文档化信任边界」**
     （七审次要 1 定案：不做前缀收紧——收紧会连带拒 http.it L89 的 'http-a' 等测试 session，反噬回归；
      保留现状非空+保留名校验 + 信任边界文档化，占座风险由 activeExists/sessionId 文档兜底）。
  - **join 无名单限制注记（五审 S3）**：HTTP join 移除、工具面 join 只校验是玩家？——现状工具面 join 任意
    会话可加任意 match（匹配名单不限）；spawn-Agent 局靠 host 代管 + 门槛兜底，外部会话 join 会被
    activeExists/submitted 挡（不阻断但可占座）；**注明为已知边界**（本地无认证场景可接受，记 LOG）。
- [ ] 单测：spawn 调用形状（count/model 传递）；**followup 恰一次 + prompt 含玩家编号/preset（阻塞 1 配套）**；
  **create 失败 dispose 全部（原子性）**；count 校验（arena=2 / world [2,seats]）；**暂存式 submit**（creating
  阶段 submit_code → 存 MatchPlayer.code + submitted=true；结构校验拒非 modules 形状/无 main/无 loop；start 建号注入
  code 字段）→ 全就绪 start 门槛（lifecycle 共享，工具面/HTTP 面都拦）；**阶段超时**（deadline 到且未推进 →
  一次重试 → dispose 全部 + 409）；host 观察 match 出现（A1 create 后拿到 matchId）；dispose 清理。
- [ ] **集成验收（四审次要 4，钉死触发入口 + LLM 供给）**：spawn 由 HTTP 端点触发，而 headless（无 webServer）
  验收需**可编程触发入口**——提供测试专用 host 函数直调（如 `svc.spawnAgentMatch({preset, count, model})`，
  IT/集成测试直接调；HTTP 端点是它的薄封装）；**`ctx.llm.registerAdapter` stub provider**（dsh-llm
  `registerAdapter(providers, adapter)`，spawn 的 `agentOptions.provider` 指 stub route，零 token 确定性）：
  **provider 注入途径（七审提示 6 钉死）**：`svc.spawnAgentMatch` 接收可选 `provider`（缺省用
  config.agentModel 对应 provider 或全局；stub lane 显式传 stub provider 名）；`agentOptions = {provider,
  model}` 二者都来自该请求，不隐式 fallback。
  真实 DSH profile（headless + stub provider patch）→ 调 `svc.spawnAgentMatch` → 断言 registry/session 事件
  （`agent/created`+`agent/session-start`）→ 由 stub 驱动执行「A1 起名+create → A2 起名+join → 双方
  submit_code → submitted 全置」全链（覆盖「真实多会话并发/超时/就绪竞态」IT 测不到的面）；有真实 key 时
  同 lane 可跑真 LLM。
  - **初始 prompt 须含运行期协议（审查次要 6）**：起名/join 阶段后、写脚本阶段 prompt 要带开局后
    report→submit→自调度 followup（AGENTS 再激活通道 2）的节奏指令，热更循环才闭环。
  - **stub 插件落点（四审提示 1）**：stub provider 以临时插件/headless patch 注入（`cordis.patch.yml` 或
    `--patch` 注册 registerAdapter），不并入主插件分发；改 test/scripts 下固定目录，验收后清理。
  - **装置来源（五审 S1，钉死）**：本仓库 devDeps/node_modules 现**无 dsh-agent/dsh-agent-loop/dsh-llm/
    dsh-base**（只有 client 面 + dsh-tools），现有 IT 全裸 `new Context()` + `ctx.plugin(ScreepsService)`，
    `ctx.agents`/`ctx.llm` 在裸 Context 上不存在。集成验收需真实 DSH 运行时，二选一：
    (a) 加 devDeps（dsh-agent/dsh-agent-loop/dsh-llm/dsh-base，版本随全局 dsh 对齐）后 vitest 内真实
    Loader/patch boot（无先例，需先 spike 一个最小 boot）；(b) 走全局 dsh CLI（已有 headless profile +
    `--patch`）+ stub 插件挂测试工具/hook 触发 `svc.spawnAgentMatch`，断言经 stdout 捕获或进程内
    listener。**stub turn-script 契约**：stub adapter 按 session 维护多轮答复序列（A1: create 调用 →
    返回 matchId；A2: join → 确认；双方: submit → 确认；…），逐轮确定性应答——写进 stub 插件文档。
    实现时先 spike 最小 boot 定 (a)/(b)，不阻塞其他任务。

### A. arena-mod：镜像克隆 + 对称兵力（screeps-mod/arena-mod.cjs）

- [ ] **新命令 `arenaGen`（镜像克隆，generateRoom 链 L704-727 为模板；参数透传照 `/rooms` 路由
  L918-924：terrainType/sources/mineral/exits 全透传，勿抄 system generateRoom L710-713 只透传 exits）**：
  1. **基准房**：`generateRoom(base, {terrainType:'<同参数>', sources:2, mineral, controller:true,
     keeperLairs:false, exits:{right:[<y 列表>]}})`（**exits.right 开向东邻镜像房**；controller:true 供
     后续预赋权）→ 走既有 generateRoom 命令链（removeWhere→gen→addWalledNeighbors→updateTerrainData→
     addAccessibleRoom）；
  2. **镜像房**（**B3 修法：镜像=东邻，`roomNameFromXY(x+1,y)` 计算**；示例 base=W15N15，镜像=W14N15
     ——`roomNameToXY('W15N15')`=(-16,-16)（utils.js L28-44），东邻=roomNameFromXY(-15,-16)='W14N15')：
     - `db['rooms.terrain'].removeWhere({room: 镜像})`（清 addWalledNeighbors 可能插的墙桩，先例 L715）；
     - 读 base terrain（**db 存的是编码字符串，map.js L512 encodeTerrain → L558 insert——直接读字符串做
       反转，勿按对象数组读**，四审次要 1）→ 字符串**每 50 字符一行反转**（x'=49-x，y 不变）→ 写镜像房
       terrain（字符串格式合法，addWalledNeighbors L626 先例；**base right 出口反转=镜像 left、其余边界
       全墙天然对称，可加注释**，四审提示 2）；
     - `db.rooms.insert({_id: 镜像, status:'normal', sourceKeepers:false})`（登记，先例 map.js L557）；
     - objects 镜像复制：base 内 source/mineral（带 x/y）按 `x'=49-x, y 不变` 复制进镜像房（`_id` 重新
       生成、不拷 user 等状态字段；**mineral 保留 mineralType/density/mineralAmount，room 字段改镜像
       名**）；**controller 同步镜像复制一份（x'=49-x，构造 `{type:'controller', x, y, room:镜像,
       user:null, level:0, ...}` 中立副本，room 字段=镜像房名）——与 source 同路径，钉死此方案；删
       「二选一/级联方案 B」绕路**；
     - **对称 exits**：镜像房 terrain 边界格非墙已随反转自动保持（exit 格在 base 非墙 → 反转后镜像对应
       格非墙；水平翻转下 base 的 right 出口 ↔ 镜像的 left 出口，y 坐标不变 → 零计算对称；**exits 登记
       钉死不写 db.rooms 字段**，引擎 interRoom 只读边界格 terrain，待 IT1 战斗真实跨房验证）；
     - **`addWalledNeighbors(镜像)`（B1 阻塞，8 方向；B4：必须在 updateTerrainData 之前）**：
       updateTerrainData 只自动补 4 方向 H/V 邻桩（map.js L681-688），镜像房东侧斜角房无 terrain →
       pf.cc A* flake（m0-flake 同族）；官方链顺序 addWalledNeighbors→updateTerrainData（L718-721）——
       新插斜角桩必须先进 blob（L691-693 deflate），否则 restart 后 runner 缺斜角房；
     - `updateTerrainData()`（重建 blob，先例 L721）；
     - `addAccessibleRoom(镜像)`；
  3. **双侧 spawn 预置**（照抄 placeSpawn L383-427 对象插入语义）：`generateRoom`（基准）+ 镜像克隆后，
     host start 对每玩家调 `createUser(room=各自房)` → realCreateUser 内部 placeSpawn 自动赋权己方
     controller + 插 spawn + safeMode（level 1 无 tower，纯近战公平）；
  4. **对等初始能量**：placeSpawn store SPAWN_ENERGY_START=300 两侧严格相等（同一函数同一常量，天然对称；
     不作额外直灌——减少路径差异）。
- [ ] 禁 NPC：基准房 `keeperLairs:false`；Invader 骚扰已由 cronjobs 三重保险免骚扰（L377-394，无
  controller 房不发 invader + arena 短局），**确认不处理**（记风险节）。
- [ ] **worldSnapshot 补两字段**（mod L436-473；service.ts L46-63 同步）：
  - `creeps: number`（`rooms.objects` 内 type:'creep' 按 user 计数）——「无 creep」判据数据源；
  - `spawnEnergy: number`（该用户所有 spawn 的 store.energy 总和）——IT1 能量对称断言数据源。
- [ ] mod 契约测试：镜像 terrain 字符串 = 基准逐行反转；镜像 objects 坐标 = 基准镜像坐标（x'=49-x）；
  双侧 spawn/能量严格相等（worldSnapshot.spawnEnergy 相等）；controller 各属一方 + 无中立；镜像房在
  db.rooms/terrain/accessibleRooms/TERRAIN_DATA 中齐全；createUser 照旧可建号；creeps/spawnEnergy 计数。

### B. host：arena 形态接线（src/host/match/lifecycle.ts + model.ts + service.ts）

- [ ] `lifecycle.start` 加 form 分支（L104-148 重构，world 路径零改动）：
  - `form==='arena'`：resolve rooms = base + 东邻镜像（`W15N15`/`W14N15`，镜像关系由 mod 侧保证）→
    `arenaGen` 一次 → 逐玩家 `createUser(room=base/mirror)` → `restart({resume:false})` →
    `setAccessibleRooms([base,mirror])` → `setTickDuration` → `resume` —— 与 world 流水线同框架，仅
    generateRoom 换成 arenaGen；
  - `form==='world'`：原流水线不动（回归保护）。
- [ ] **eliminated 双分支**（lifecycle.ts L190 + scoreboard 展示）：
  - arena：`spawns==0`（拆光对方 spawn 即出局；ownedRooms 各 1 恒成立无意义；**对方无 spawn 无 creep 即
    无法再生产**）；配合 worldSnapshot.spawns 现有字段；
  - world：`spawns==0 && creeps==0`（战斗意义上失去生产力+战力即出局；**controller 不可毁，判据不含
    ownedRooms**——同步回写 AGENTS.md 玩法节出局定义）；
  - worldSnapshot 缺 creeps 字段（外部 server 旧版）→ 降级为 spawns==0（不炸）。
- [ ] settle 裁决复用（lifecycle.ts L253）：arena 下 `eliminatedCount >= players.length-1` → lastStanding；
  maxTicks 到时 → 比分判 winner（kills 主导已由 scoring 定义）；scoreWarning 照旧。
- [ ] 工具面：`screeps_match create` 的 preset=arena-blitz / world-frozen 已通（数据已就位）；start 对
  arena **拒收 rooms 参数**（arena 不随机选房，镜像自动）——实现层语义（次要②）：`lifecycle.start` 校验
  form==='arena' 且 opts.rooms 非空则抛 Err（http.ts L294-302 只查格式不知 form，故校验必须在 lifecycle
  层）；client start 不传 rooms（panel.tsx L165）、9 IT 全 world → 影响面小。
- [ ] 单测：arena 状态迁移；eliminated 双分支打表（arena spawns==0 / world spawns+creeps）；arena settle
  裁决；start form 分支走假后端打表（arena 调 arenaGen 不调 generateRoom；world 回归不变）。

### C. world-frozen 完整玩法闭环

- [ ] 全链确认：create(preset=world-frozen) → join → start（frozen 正常部署，bot 代码经 botCode 注入）→
  submit_code 被拒断言（frozen 语义已实现，补 IT 打表）→ 双方 raider 互殴 → 一方 spawns==0 && creeps==0 →
  autoSettle lastStanding → settle winner 落盘。
- [ ] **eliminated 判据修正后 lastStanding 可达**（阻塞 4 修法）：world 判据 spawns==0 && creeps==0；
  raider 拆光对方 spawn + 杀光 creep → 对方 eliminated。
- [ ] 边界：若双方都龟缩不出兵（无 elim 无战斗）→ maxTicks 兜底（world 20k tick，控时约 20k×300ms≈1.7h
  太长，且 world-frozen 预设 tickDuration=300）→ **模板显式观察后手动 settle 兜底**（与 E3 同款），IT 内
  用战斗 bot 保证战斗发生。

### D. 测试专用 bot（仅驱动 IT，非产品功能）

> 产品定位修正（2026-09-09，用户对齐）：对局参与者只能是 Agent；`bots/` 仅测试/IT 验收用，
> **不打包第三方策略 bot、不做预置对手**（原「license 调研 + TooAngel/hivemind 打包」方向废弃）。

- [ ] **`bots/raider`（测试驱动，IT1/IT2 依赖）**：`bots/raider/main.js` 铁律：
  - **寻敌策略钉死**：`Game.map.describeExits(room)` 拿到出口方向 → 沿出口跨房找敌房 → 敌房内
    `FIND_HOSTILE_CREEPS`/`FIND_HOSTILE_STRUCTURES`（battle IT 已证：`Game.roomObjects` 是服务器内部
    隔离环境，必须玩家 API）；host 可注入 `Memory.arena={targetRoom}` 兜底目标——**注入机制钉死
    `writeMemory`（service.ts L372-381 已有），createUser 后、start 前写入**；
  - 找己方 spawn → spawn 攻击 creep（`[ATTACK,ATTACK,MOVE]` 成本 210 ≤ SPAWN_ENERGY_START=300
    （已实战），或 `[TOUGH×2,ATTACK,MOVE]` 低成本冲锋）→ harvest/能量直灌（arena RCL1 无 tower，纯近战）；
  - **目录/命名迁到测试专属位置**（与用户确认：`bots/` → 测试 fixture 目录，`package.json files` 移除
    `bots`；BotRegistry 随迁或改测试工具）；`__bot__` 前缀仅测试链路使用（不变）。

### E. 验收（tests/ + headless）

- [ ] **IT1 arena-blitz 歼灭闭环**：
  1. create(preset=arena-blitz, tickDuration:100) → **测试内部链路注入 bot 座位**（2026-09-09：addBot 已从
     工具面摘除，`botRegistry.load('raider')` + `store.addPlayer` 直注入，详见 m2-battle.it.test.ts 先例）→
     join 玩家（**建议双 bot，省 session
     建号摩擦**，提示级）→ start（arena 镜像自动，不传 rooms）；
  2. **开局镜像对称断言**（失败即 fail dump）：
     - mod 探针/新命令返回 base/mirror terrain 编码串 → 断言 mirror == base 逐行反转；
     - worldSnapshot：两侧 spawns==1、**spawnEnergy 双侧严格相等**（四审次要 2：start 的 resume 已放行
       首 tick，raider spawnCreep 次 tick 结算，快照可能已扣 210 → 只断言双侧相等；绝对值=300 挪到 mod
       契约测试）；controller 各属一方；rooms 字段两侧房间名对称；
     - **前置：clearSafeMode（每房）**（B5）：placeSpawn L420 设 safeMode=gameTime+20000 免疫攻击，
       m2-battle L129-141 实证必须先清 → 每房 clearSafeMode → roomObjects 断言 controller.safeMode <
       gameTime → 失败即 IT 前置失败直接 fail；
  3. 战斗：raider（frozen 或 live 皆可，IT 内用 botCode 注入 raider）沿 exits 跨房攻击对方 spawn → 拆光
     （SPAWN_HITS=5000 / damage 60/tick ≈ 84 tick，tick 预算 2000 富余）→ 对方 spawns==0 → eliminated →
     autoSettle lastStanding（**attackController 不影响判据**：arena 无中立 controller 可 attack，且判据
     只看 spawns+creeps，attackController 加速 downgrade 与本判据无关）；
  4. 断言 winner=raider 侧、kills≥1、scoreWarning 无；双方无复活 spawn（无 controller 升级，RCL1 上限 1
     个 spawn，拆光即无）。
- [ ] **IT2 world-frozen 完整玩法**（B2 修改：须显式相邻房 + exits，防随机房互不可达）：
  create(world-frozen) → 双 bot（raider 互搏，或 raider vs 采集龟缩）→ **start 显式传相邻房 + 匹配 exits**
  （m2-battle L120-127 先例：`[{room:'W15N15', exits:{top:[22,23,24]}}, {room:'W15N16',
  exits:{bottom:[22,23,24]}}]`）→ **clearSafeMode 前置（同上 B5，roomObjects 断言）** → submit_code 被拒
  断言 → 战斗发生 → 一方 spawns==0 && creeps==0 → lastStanding settle → winner 落盘。
- [ ] **headless 验收 = 仅加载冒烟**（2026-09-09 决策：完整对局 headless 不再做）：
  - **验收面收敛**：对局逻辑闭环 → IT（跨进程多 session 模拟已在 tools.test `makeExec` 打底）；
    UI/用户触发/观战 → browser-mcp；headless 只做「plugin 加载 + 工具响应」冒烟。
  - 冒烟模板：`dsh --profile headless --patch <dataDir 指向 smoke、port:0> "<调用 screeps_world_status 并
    报告 gameTime 与玩家数>"` 可判定即可（S14 已验证过）；**不需要完整对局、不需要 bot 座位**。
  - **headless bot 注入通道遗留关闭**（原「配置开关/预注入/测试工具」候选不再做；IT 已覆盖完整战斗闭环）。
- [ ] **回归基线**：npm test（140+新增）绿、typecheck/build 过、9/9 IT 绿零孤儿（arena 房同样 generateRoom
  后 restart，孤儿纪律照旧 pgrep 断言）。**受影响 IT 显式名单（六审提示，门槛只对 spawn 局生效后，
  以下普通局无门槛应全绿不受影响，回归时逐文件确认）**：`match.it`（L45-50），`http.it`（L85-113,
  join 断言 L96-103 随移除删除），`m2-battle`（L105-116），`m2-closed-loop`（L96-107）——即「普通
  create/join 局零回归」的直接证据集，**另加 `tools.it`（L46-48：create→join→start，普通局 0 submitted，
   与 match.it 同型，是第 5 个见证者）**；其余（m0/launch/service/runtime）不涉门槛。

### F. 收尾
- [x] LOG 追加 M3 条目（证据链 + 遗留：2v2 双房对拼、击杀分到 T 提前终止、interrupted 恢复等）；
  AGENTS 里程碑/验证同步 + **world 出局定义回写（判据改 spawns+creeps）**；TEST.md 增 arena/frozen 验收项
  （命令全部自证实测——§5 已在 3200 实测通过）。
- [ ] commit 待用户确认后执行（不擅自提交）。

## 验证
- 单测全绿（140 基线 + 新增 arena 状态机/eliminated 分支/镜像坐标纯函数）；typecheck + build；
- IT1/IT2 全绿零孤儿（串行）；headless 加载冒烟可判定（world_status，不需要完整对局）；
- 公平边界回归：arena 镜像对称是核心断言；`__bot__` 双拒、frozen 拒 submit 回归不破；
- world 原路径 start 零改动回归（既有 9 IT + battle/closed-loop 全绿）。

## 风险与缓解
- **「人类点开始 = 观战者触发规则」（四审提示，语义定位）**：start/settle 是规则触发点不是对局内操作
  （AGENTS「不进对局、不指挥、不参与」禁的是指挥/发令/插旗）；合法触发者（观战者）≠ creator（=A1），
  HTTP start 传 players[0].sessionId（浏览器代持）是唯一无认证授权形状——**「start/settle 只认 players[0]
  且该值 GET /matches 公开可读」的表述需随 F 节回写进 AGENTS 信任边界段**（现状 AGENTS 只写了 create/join
  的 sessionId 校验，五审 S2 核实缺 players[0]/观战者触发表述）；实现者不困惑于 isCreator 语义。
- **spawn-Agent 驱动不生效（四审阻塞 1 复发风险）**：必须 create resolve 后 `followup()`（seed/setup 不驱动）；
  缓解：单测钉死「每 spawn 恰一次 followup + prompt 含玩家编号/preset」；e2e stub lane 断言 session 事件 +
  首个 turn 发生。
- **spawn 失败/掉线原子性（阻塞 2 增补）**：任一 spawn/建赛失败 → dispose 全部已 spawn 会话 + 409；
  Agent 对局中掉线 → 报告 + 由人类观察者决定 continue/settle（首版不自动踢人，记遗留）；对局结束/删除
  → dispose 收会话（防泄漏，Level 收尾核对）。
- **count 与 seats 一致性（次要 1）**：arena 强制 =2（B 节只支持 base+mirror 两房）；world count [2,seats]
  校验（>seats 会在 store.addPlayer 半截 `'full'`；<seats 语义 = 少人局，lastStanding 数学仍成立但记
  scoreWarning 提示「非满员局」）。
- **frozen×spawn（次要 5）**：frozen 拒 submit 不看 phase——spawn-Agent 仅用于 live 预设；world-frozen 的
  机器玩家走既有 botCode 注入（C 节），不混用。
- **镜像坐标/terrain 反转正确性**：50 字符/行反转 + x'=49-x 是核心纯逻辑——缓解：mod 契约测试直接断言
  反转后字符串与对象坐标；host 侧 IT1 再断言 worldSnapshot 双侧对称（spawn/能量/rooms）。
- **镜像房 controller 对象**：**钉死方案：镜像复制 base controller（x'=49-x，level 0、user 置空中立副本）**，
  与 source 同路径（A 节）；IT1 断言「controller 各属一方 + 无中立」兜底——若实现发现 engine 对中立
  controller 有隐含依赖，回到「先 stock generateRoom 再覆盖 terrain/objects」，两者都写清，实现时选通。
- **external 模式降级（次要③）**：arenaGen 是 CLI 命令面（system 透传）新增；external 只读 arena API 的
  用户若连旧 mod（无 arenaGen 命令）→ start arena 时报「unsupported command」，降级为明确错误提示
  （不静默），文档注明「Arena 模式需升级 mod 版本」。
- **「拆光 spawn」判定边界**：RCL1 上限 1 个 spawn、无升级路径（controller 各属一方，claim 无中立目标）→
  拆光即无法再生产；IT 断言无复活。
- **safeMode 免疫**：placeSpawn 预置 safeMode=gameTime+20000（L420）——IT1/IT2 前置 clearSafeMode +
  roomObjects 断言（B5，m2-battle L129-141 实证）。
- **Invader 骚扰**：cronjobs 三重保险（L377-394）已确认免骚扰，不处理（记入 LOG 免重复排查）。
- **exits 登记**：镜像房 exits 是否需写 db.rooms 字段待实现取证（exit 格非墙已在 terrain 里，引擎 interRoom
  读取边界格）——IT1 战斗真实跨房即验证。
- **frozen 局无人出局**：IT2 用 raider 保证战斗；边界走 maxTicks 兜底或手动 settle（IT 内断言战斗发生）。
- **镜像房也要 restart**：runner 进程级地形缓存——arena start 照旧走 restart({resume:false}) 全链，无特例。
- **回归破坏**：start 加 form 分支必须 world 原路径零改动（只加 arena 分支），单测 + 既有 9 IT 回归保护。
- **world 判据回写连锁**：eliminated 判据改 spawns+creeps 影响 world-live 既有语义（M2 battle IT 断言
  elim）——既有 IT 回归验证，必要时同步更新断言口径（kills/losses 不变）。

## 明确不做（M3 边界）
- **2v2 双房对拼**（AGENTS 提到，M3 先单房 1v1 镜像）；**击杀分到 T 的提前终止**（只做拆 spawn + maxTicks
  +比分两路）；**Arena 双 spawn 各自再扩展**（RCL1 上限天然限死，无需额外规则）；
- **world-rounds 回合制预设**（2026-09-09 用户对齐方向：周期 commit/准备/全就绪自动续跑；规则细节待后续
  细化，不在 M3 排期——AGENTS 层面记录为玩法方向+已知设计坑，**M3 只做 spawn-Agent 的准备→全就绪开赛，
  rounds 的「周期边界暂停/续跑」另行排期**）；
- **world-frozen 人类建赛（spawn-Agent）排期外**（四审钉死：frozen 拒 submit 与准备期写脚本冲突；frozen
  局由 C 节 botCode 测试链路验收；人类建赛仅 world-live / arena-blitz）；
- **headless 完整对局验收**（2026-09-09 决策：对局逻辑走 IT、UI 走 browser-mcp，headless 只留加载冒烟；
  bot 注入通道遗留关闭）；
- interrupted 死局恢复、房间可见性精确化、World 扩张成本（继续遗留，不并线）；
- client 新 UI（spawn-Agent 的准备阶段 UI 除外——新建对局按钮改造属 A0；完整观战增强留给 M4）；
- schedule 桥插件侧、energy 分（scoring 已含可配，默认 0 不展开）。