# S12 计划 v9 — client 观战面板（对局大厅 + 地图投影 + console 流）
> **2026-09-09 M5 superseded 注**：client 观战面板沿用；预设列表中的 world-live 已删，World 入口改为 world-rounds（回合制）。

> 审查记录：v1(一审 3阻塞+6次要) → v2(二审 5新问题) → v3(三审 5新问题) → v4(四审 3问题，含 1阻塞)
> → v5(五审 3问题，含 1阻塞) → v6(六审 3问题，含 1阻塞) → v7(七审 1否决+3提示) → v8(八审 4提示级)
> → v9(本版，九审送审)

M1 待做项的收尾：插件从「纯 host」升级为「host + client」，实现 DSH 内的观战与对局 UI。
本计划基于 S14 后主分支（commit f3fd300）+ S11 已就绪的 HTTP 桥 + S13 工具面 + S13 console 采集。

> 审查 v1 结论：**需修订**（3 阻塞 + 6 次要，审查 agent 在 rc.2 类型面 + 官方克隆 d347e703 上逐条取证）。
> 本版全部吸收：数据源决策、依赖固化、视图切换语义、测试 lane、构建细节、版本标注。

## 现状事实（已取证；**以已安装 dsh 0.1.1-rc.2 为准**，官方克隆 d347e703 仅作源码形态参考，其版本实为滚动 master）

- **插件当前纯 host**：package.json 无 `./client` export、无 `dsh.client`；src/ 无 client。
  `tsconfig.host.json` 已 exclude `src/client/**`（client 目录预留）；`tsconfig.base.json` 存在。
- **S11 HTTP 桥已就绪**（`src/host/http.ts`，`/dsh-screeps/*` 前缀，全部 no-store）：
  `GET world`（L90）、`GET/POST matches`（L97-113）、`GET /matches/:id`（L120）、
  `join/start/pause/resume`（L131-156）、**`POST /matches/:id/observe`**（L158-161，POST 不是 GET）、
  `settle`（L162-170）。路由核心 `handleArenaRequest` 是纯函数（method+pathname+body → status+json）。
- **S13 console 采集已就绪**：`service.consoleOutput(username, since)`（service.ts L394-404）经 arena-mod
  ring buffer 返回 `{lines, cursor, ...}`——console 流的原料已可复用。
- **对局观察面缺口（阻塞 1 根源）**：`MatchObservation`（match/lifecycle.ts L27-35）只有
  scoreboard 相关字段，**无 console**；observe 实现（L119-148）只聚合分数；L130 注释明言
  击杀/损失分要等 M2 事件流——**计划 v1 的「console 流 = observe 增量」无实现基础**。
- **地图数据面缺口（阻塞 2 根源）**：`ScreepsWorldSnapshot`（service.ts L45-60）只有
  `users[].rooms{room,level,progress}`，**无地形、无 spawn 坐标**——v1 的「terrain + spawn」不可达。
- **视图切换无公开 API（阻塞 3 根源）**：rc.2 的 IConversation 面只有
  send/updateQueue/cancel/loadOlder/input/blocks（无 setView）；active view 从骨架私有 store 读
  （ConversationSession.tsx L64 selectedId=useStore(s=>s.view)）；setView 是 chat 条目私有 store 动作。
  **官方代码里跨会话导航用 `ctx.sessions.open(sessionId)`**（ui-chat apply.ts L144）——这是公开通道。
- **官方 client 契约**（rc.2 已装类型 + 官方源码）：
  - apply 形态：`export const inject=[...]` + `export function apply(ctx)`（ui-message-feedback index.ts）；
  - slot 注册：`ctx.slots.inject(key, () => ctx.slots.register({...}, Component))`，经调用方 ctx.effect
    自动清理（dsh-client-runtime/lib/types/client/slots.d.ts SlotRegistry）；
  - `sidebar.footer.action`：list/root，owner=`{wide}`（已装 ui-sidebar contract/slots.d.ts L58-63）；**声明即占有**；
  - `conversation.view`：list/session；ui-chat 以 `id:'chat', order:0` 注册实例 tab
    （ui-chat/src/client/apply.ts L94-153）。**view registry 是全局注册一次，不是 per-session 条件注册**
    （v1 的「仅在对局时注册」是语义误解——修正：常驻 tab + 组件内按会话判空渲染占位）；
  - **新增 tab 永不自动激活**：active view 回落 DEFAULT_VIEW_ID（官方 view-selection.ts），
    tablist 仅 tabs.length>1 时渲染（ConversationSession.tsx L137-139）→ 常驻对局 tab 是安全增量；
  - bundle 包装三段原文（官方 tsdown.client.ts L566-568）：banner=ModuleLoader.load + intro/footer；
  - 官方 manifest：exports["./client"] + `dsh.client.platform:"web"`；client 运行时包放 peerDependencies，
    react/react-dom/@testing-library/react 等 devDependencies（rc.2 官方形态）。
- **依赖可拉取（审查已验证）**：npm 可拉到 0.1.1-rc.2 的 client 包（dsh-client-runtime 等）与 react 18.2.0。
- **client 测试 lane**：vitest.config.ts 无 jsdom → 用 per-file `// @vitest-environment jsdom` pragma；
  官方 **`@deepseek-ai/dsh-client-test-runtime@0.1.1-rc.2` 已发布**（jsdom slot test runtime，自带
  real Cordis Context + SlotRegistry + UI renderer，官方 ui-sidebar/ui-conversation 的 devDeps 即引
  `^0.1.1-rc.2`）→ **优先用官方 test-runtime**，自造 fake services 仅作 canvas 自绘断言的兜底 stub；
  typecheck 需双 program 脚本。

## 任务清单（按审查建议的顺序）

### A. 数据源决策（先定，阻塞 1/2 的收口）
- [ ] **console 流：扩 host 契约（含 query 接线落实，七审否决项收口）**——新增
  `GET /dsh-screeps/matches/:id/console?since=<cursor>`：
  - **接线**：`http.ts` 的 `ArenaRequest` 扩 **`query?: URLSearchParams`**（**可选**，缺省=空游标全量——
    现 http.test.ts 10+ 调用点不带 query，必选会先撞 typecheck 红线；缺省语义与「since 缺失→全量」一致）；
    `registerHttp` 的 handler 里 `new URL(req.url).searchParams` 传入
    （现 L209 只取 pathname，query 被剥离——不扩契约则 since 永远拿不到，前端被迫全量重放）；
    路由核心 method/pathname/query 分支打表钉死；
  - **collectConsole 签名（带服务句柄，防 creating 500）**：`collectConsole(services, match, query?)`
    纯函数——内部对每个对局玩家调 `services.consoleOutput(username, since)`；**单用户失败（未建号/
    getToken 抛错，service.ts L406-413）降级为 `{lines: [], cursor: 保持, bound: false}`，不整端 500**，
    与「creating 空增量不闪挂」自洽；
  - **游标语义钉死为逐用户**：`since` 是 URL-encoded JSON `{"userA":n,"userB":n}`（每用户 ring buffer
    下标，arena-mod 的 since 即逐用户下标；单全局游标在 N 用户间会错位/整段重放）。**编码写死走 query
    参数**（如 `?since=%7B...%7D`），不塞 body（GET 语义）；
  - **边界用例打表**：since 缺失→当空游标全量返回；since 非法 JSON→400；
    creating 阶段（用户未建号，`lifecycle.ts` L134 置 eliminated=true）→ 单玩家失败降级空 lines、
    整端返回空增量不闪挂；
  - 响应 `{lines: [{user, text}], cursor: {user→n}, bound}`，无新消息返回空增量（轮询友好）。
  **方法定死 GET**（纯读取，与 observe 的 POST 区分）。S13 采集已就绪；这是**在 S12 内补数据源**，不剪流。
- [ ] **地图：v1 明确降级为归属色网格投影**——地图画「世界房间网格 + controller 归属色 + RCL 数字」，
  **不画地形贴图、不画 spawn 坐标**（数据源缺 terrain/spawn 坐标，扩快照属 M2 地图增强）。
  投影函数为纯函数：`input: rooms[{room, level, progress, owner?}] → gridCell: {x,y,color,label}`。

### B. 依赖固化 + 安装
- [ ] 加入 package.json（**分组以已装 rc.2 官方 manifest 逐包镜像为准；官方惯例是 peer+dev 双列，
  不存在「peer 仅 cordis」**）：
  - `exports["./client"]`：types 路径**不硬编码**——采用官方路线（见下），构建后 `ls lib/` 核对实际
    `.d.ts` 路径/扩展名再回填；default→`./lib/client.js`（钉死）；
  - `dsh.client: {platform: "web"}`；
  - **peerDependencies**（镜像官方 ui-sidebar/ui-conversation 的 peer 清单，逐一核对）：
    `@deepseek-ai/cordis ^4.0.2` + `@deepseek-ai/dsh-client-runtime@^0.1.1-rc.2` +
    `@deepseek-ai/dsh-client-locale`/`invariants`/`dsh-client-ui-layout` 等官方 peer 所列（以 manifest 为准）；
  - **devDependencies**：`react@^18.2.0`、`react-dom@^18.2.0`、`@types/react@~18`、`@types/react-dom@~18`、
    `@testing-library/react`、`jsdom`、`@deepseek-ai/dsh-client-test-runtime@0.1.1-rc.2`（官方 jsdom slot
    test runtime，npm 已发布）、`@deepseek-ai/dsh-client-ui-sidebar@0.1.1-rc.2`、`@deepseek-ai/dsh-client-ui-conversation@0.1.1-rc.2`
    （slots merge 类型）；
  - 安装：`pnpm add -D <devDeps>` + peer 按清单（npm 可达已验证：rc.2 client 包 + react 18.2.0 可拉取）。

### C. tsdown 双产物（独立仓库，不搬官方 monorepo 预设）
- [ ] **构建顺序（必须两步，防 entry 不存在）**：`tsc -p tsconfig.client.json`（emit JS+d.ts 到 lib/types）
  **先于** `tsdown`；package.json `build` 脚本改为 **`rm -rf lib && tsc -p tsconfig.client.json && tsdown`**
  ——旧产物清理交给脚本前置 `rm -rf lib`（原子清场一次），**tsdown 两个 config 均 `clean:false`**
  （官方多 config 同 outDir 一律 clean:false，tsdown.client.ts L232/L444；`clean:true` 会对所有 configs
  在首次构建前 glob(outDir) 删掉整个 lib/，含 tsc 刚产出的 lib/types/** 与 client 产物，双产物必败）。
- [ ] `tsconfig.client.json`（client 程序）：
  - `include: ["src/client/**"]`，**`rootDir: "src"`**（否则推导 root=src/client → emit 到 lib/types/index.js，
    与 L 步的 lib/types/client/index.js 路径不符），`outDir: "lib/types"`；
  - `declaration: true, sourceMap: true, declarationMap: true`（照官方 tsconfig.base.json，
    **不要 `emitDeclarationOnly`**——tsc 必须 JS+d.ts 同出，否则 tsdown entry 输入不存在）；
  - `jsx: "react-jsx"`、`lib: ["ES2022","DOM"]`（client 走浏览器）
  - **`rewriteRelativeImportExtensions: true`**（仓库 tsconfig.base.json 有 allowImportingTsExtensions，
    无 rewrite → emit 时 TS5095；或 `moduleResolution: "bundler"` + extensionless import 二选一）；
  - types 引用 rc.2 包（不 emit 类型只引用）。
- [ ] **typecheck 双 program（落实步骤，非仅承诺）**：package.json `typecheck` 脚本改为
  `tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json --noEmit`
  （当前仅 host program 且 host exclude src/client/**，不改则 client 面根本不被类型检查）。
- [ ] **watch 同步（提示级）**：`watch` 改为 `tsc -p tsconfig.client.json --watch` 与 `tsdown --watch`
  并行（**先启 tsc --watch 再启 tsdown --watch**，README I 步写明首启顺序；tsdown --watch 只重打包
  既有输入，不 watch tsc 产出）。
- [ ] `tsdown.config.ts`：single entry 改为 **数组**，client entry **钉死为**：
  `{ entry: { client: 'lib/types/client/index.js' }, outDir: 'lib', clean: false,
  format: 'cjs', platform: 'browser', sourcemap: true,
  outputOptions: { entryFileNames: 'client.js' } }`
  ——**产物名必须 entryFileNames 钉死为 client.js**（DSH host 硬编码 `/plugins/<id>/client.js` 端点；
  outExtensions 只改扩展名不改 basename，单 entry 会出 index.js 与 host 的 lib/index.js **路径对撞**，
  故 entry 用 `{client: ...}` 命名 + entryFileNames 双保险）。**host entry 改 `clean: false`**
  （同 outDir，clean 由 build 脚本前置 rm 统一处理；见上「构建顺序」条）。
- [ ] **banner 手写三段**：banner/footer 走 `outputOptions`（tsdown 0.22 的 outputOptions 透传 rolldown
  OutputOptions，**含 intro**——官方正是 banner+intro+footer 三段，tsdown.client.ts L566-568）：
  banner = `window.__ModuleLoader__.load({ id: <pkg>, factory: (require) => {`、
  intro = `var module={exports:{}}; var exports=module.exports;`、
  footer = `return module.exports; } });`；若个别 tsdown 版本不认 intro，可把 intro 文本并入 banner
  末尾（产物等价，顺序不变）。
- [ ] **自维护 external 模块表（白名单语义，不是全外部化）**：只外部化加载器模块表内**实际行**
  （本插件用到：`@deepseek-ai/dsh-client-runtime/client`，以及 react/react-dom/cordis）；
  **其余 `@deepseek-ai/dsh-client-*` 一律 type-only import**（类型擦除不进 bundle）——表外包 require
  即运行时 throw（官方 clientConfig L445-453 白名单语义，非「一律外部化」）。
- [ ] CSS 策略：**S12 不用 CSS module**（避免 lightingcss 管线），组件用内联 style / 普通 CSS
  经 `?inline` 或直接在组件内 template 字符串；保持构建自包含；
- [ ] **define 三键（照官方 clientConfig defines，防 boot ReferenceError）**：client entry 加
  `define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env.MODE': '"production"',
  'import.meta.env': JSON.stringify({MODE:'production'}) }`（官方 tsdown.client.ts L476-481 逐键一致）。
- [ ] **产物名与 exports 对齐**：`exports["./client"].default` 钉死为 `./lib/client.js`（与 entryFileNames
  一致）；`exports["./client"].types` 以构建后 `ls lib/` 核对的 `.d.ts` 实际路径回填（官方形态
  `./lib/types/client/index.d.ts`）。build 后先 `ls lib/` 核对产物名再进真实组合（防 404 排查绕圈）。

### D. client 骨架
- [ ] `src/client/index.ts`：`name`/`inject=['slots']`/`apply(ctx)`；type-only import 拉入
  `@deepseek-ai/dsh-client-runtime/client`（ClientContext/SessionId）与 ui-sidebar/ui-conversation 的
  SlotMap merge；注册大厅入口与对局视图（见 E/F）。

### E. 对局大厅（sidebar.footer.action 入口）
- [ ] `src/client/lobby/`：`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({...}, LobbyEntry))`，
  owner `{wide}` → wide 渲染按钮文案、窄列渲染图标；
- [ ] 数据：轮询 `GET /dsh-screeps/matches`（no-store、in-flight guard、失败保留最后快照）→ 列表
  （id/状态/预设/玩家/创建时间）+ 创建按钮（world-live/world-frozen/arena-blitz 选择）；
- [ ] **大厅 join 入口：S12 明确不做**（http.ts 已有 `POST /matches/:id/join` 端点，但加入观战他人
  对局涉及「未绑定用户的观摩会话」语义，归 M2 对局闭环处理；S12 大厅只做「创建自己的对局」）。
  **A 步 console 端点实现顺序提醒**：http.ts L127-128 的 POST-only 405 检查在 rest.length===3 时先于
  action switch 执行——新增 `GET /matches/:id/console` 分支**必须在 405 检查之前分流**，否则被 405
  吞掉；`collectConsole` 打表测试会钉死该方法+路径组合。
- [ ] **创建→运行衔接（S12 UI 可达状态定义）**：S12 大厅只创建（1 玩家，creating 态）、面板只观战
  （无 start 按钮）；`lifecycle.start` 要求 players>=2 → **S12 UI 无法直接跑到 running**。验收/演示用的
  running 对局由 **S13 工具 `screeps_match`（第二会话 join + start）或 HTTP 端点预置**；
  同时 `collectConsole` 打表钉死 creating 阶段（用户未建号）返回空增量的行为，
  面板三块在 creating 态渲染为可用的空态（不闪挂）。
- [ ] **创建流数据来源（问题 5 收口）**：
  - **当前会话 id**：读 `ctx.sessions.list`（rc.2 `ISessions.list: ObservableSnapshot<SessionListState>`，
    含 current selection）→ 取当前活动会话 id；无活动会话时创建按钮禁用 + 提示「先打开一个会话」；
  - **Screeps 用户名**：S13 的 session→user 映射在 host 侧且新会话无 binding 可查 → **大厅 UI 提供用户名输入框**
    （`USERNAME_RE` 校验 `^[A-Za-z0-9_-]{1,30}$`，http.ts L110），创建/加入请求带
    `{preset, sessionId, username}` 双字段；重复用户名冲突由 host 返回 4xx 提示；
  - （不新增 whoami 端点：避免把 host 私有映射暴露成 API，用户名输入最符合 S13 现有接口形态。）
- [ ] **点击行为（阻塞 3 收口）**：`ctx.sessions.open(match.sessionId)` 打开对局所属会话；
  **不做编程切 view**（无公开 API；tab 切换交用户点击，对局 tab 常驻）。`ctx.sessions.open` 官方在用（ui-chat apply.ts L144）+ rc.2 `ISessions.open(id)`（contract/sessions.d.ts L35）双证实。

### F. 整页对局工作区（conversation.view）
- [ ] `src/client/match/`：`ctx.slots.inject('conversation.view', () => ctx.slots.register({name, id:'screeps',
  order:10(>chat 的 0), label, ...}, MatchView))`——**常驻 tab**，组件内按 `sessionId` 判空：
  该会话无活跃对局 → 渲染占位（「无对局，用大厅创建」）；有 → 渲染面板。register 是全局一次（v1 修正）；
- [ ] 面板三块：
  - **地图投影**：纯函数 `projectRooms(world)`（归属色网格 + RCL），canvas 自绘；
  - **统计**：`POST /matches/:id/observe` 的 scoreboard（RCL/领地/进度/比分）；**差分在前后快照前端计算**
    （http.ts observe 不收 since、lifecycle.observe 无 since 参数——现状即前端差分，不扩后端）；
  - **console 流**：轮询 A 的新端点 `GET /matches/:id/console?since=`，增量追加 + 游标；
- [ ] 数据面全部 no-store、in-flight guard、失败保留最后快照；
- [ ] `src/client/match/projection.ts` 纯函数 + 单测。

### G. 清理契约
- [ ] slot 注册、轮询 timer、DOM、listener 全部经 `ctx.effect`/disposer 随 fiber 清理（HMR 安全）；
- [ ] per-session 状态按 `SessionId` 分桶；连接 reset 只重同步已读对象。

### H. 验证
- [ ] 单测：投影纯函数打表（归属色/RCL 映射）；`collectConsole` 打表；service 快照→投影不抛；
- [ ] client lane：**优先用官方 `@deepseek-ai/dsh-client-test-runtime@0.1.1-rc.2`**（npm 已发布、官方
  devDependencies 即引 ^0.1.1-rc.2；自带 jsdom + SlotRegistry + UI renderer + @testing-library/react
  依赖链）；以官方 ui-message-feedback / ui-sidebar 的测试写法为模板挂 `// @vitest-environment jsdom`
  per-file pragma；自造 fake services 仅作 canvas 自绘断言的兜底 stub。断言大厅入口 slot 注册/渲染、
  match view 判空占位、dispose 后 registry/DOM/style 清理。
- [ ] 基线：`npm run build`（双产物 lib/index.js + lib/client.js）→ `npm run typecheck`（双 program）→
  `npm test` 全绿 → `git diff --check`；
- [ ] 真实组合（web profile）：`dsh plugin --profile s12web add base web-app dsh-screeps`
  （port:0 规避 21025 冲突）→ 浏览器验证**分两段**：
  1. **creating 空态**：sidebar 入口存在 → 大厅列表 → 创建对局（1 玩家，creating）→ 打开该会话 →
     对局 tab 渲染地图（空世界网格）/统计（空 scoreboard，**忽略未建号玩家的 eliminated=true 行**，
     lifecycle.ts L134）/console（空增量，不闪挂）；
  2. **running 真数据**：用 `screeps_match` 第二会话 join + start（或 HTTP 端点）预置一个 running
     对局 → 打开该会话 → 对局 tab 渲染**有数据**的地图/统计/console 增量流（S12 标题交付物）。
  headless 回归照 S14（C2 加载层任务零孤儿）。

### I. 收尾
- [ ] `docs/LOG.md` 追加 S12 条目（证据链 + 遗留：地形/spawn 坐标地图增强、编程切 view、击杀/损失分
  记分待 M2 事件流）；
- [ ] README（client 面落地、watch 用法）/AGENTS（client 面「已落地」行更新、M1 待做项划掉 client）；
- [ ] 与用户确认 commit 范围后单个 commit。

## 风险与缓解

- **client 构建**：独立仓库不搬官方 monorepo 预设→自维护 external 表 + 简化 CSS；NODE_ENV 缺失
  （官方 define 三段）→ client entry 加 define `process.env.NODE_ENV`（照官方 clientConfig defines）；
  clean:false 防清 host 产物（C 步写明）。
- **client 包 peer 依赖安装**：npm 上 rc.2 可拉取（已验证）；官方 peer+dev 双列，逐包镜像官方 manifest；
  若 install 遇 peer 冲突，加 `--config.peerDependencyRules.allowedVersions` 记录到计划注释。
- **client 测试**：优先官方 test-runtime；其依赖链自带 @testing-library/react（覆盖测试栈）；
  **安装时 `npm view @deepseek-ai/dsh-client-test-runtime@0.1.1-rc.2 peerDependencies` 核对 peer 面**
  （滚动 master 达 16 项、rc.2 以实查为准），据实补 devDeps；canvas 自绘断言的 stub 可能仍需自制（兜底）。
  peer 冲突走风险节 allowedVersions 记录。
- **视图抢占**：常驻 tab + order 10 > chat 0 + 新增 tab 永不自动激活（官方 view-selection 契约）→
  安全增量；无活跃对局显示占位，不干扰 chat。
- **console 轮询成本**：增量 + 游标 + no-store + in-flight guard；无消息时空增量短轮询。
- **真实组合网络**：复用 S14 模式（smoke 已 provision，无需现场下载）。

## 明确不做（防范围蔓延）
- 不做编程切 view（无公开 API，M2 spike）；不做地形贴图/spawn 坐标（M2 地图增强）；
- 不做击杀/损失分的完整记分（M2 事件流）；不做 Agent 代码查看器（独立里程碑）；
- 不搬 @screeps/renderer 引擎（AGENTS 决策：自绘 canvas）。