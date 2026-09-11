# M0 Spike Findings（定稿）

M0 spike 全部验证完成（2026-09-05，开发机）。本文件是 M1/M2 开工的输入，所有结论均实测复核。
配套可复现脚本：`scripts/m0-spike.sh`；arena mod：~~`screeps-mod/arena.js`~~（v0 历史产物，已删除 2026-09-07；**现役 mod 是 `screeps-mod/arena-mod.cjs`**）。

## 1. 环境与原生编译（Step 0.1）✅

| 项 | 结论 | 证据 |
|---|---|---|
| isolated-vm（pinned github commit → 6.1.2）在 node 26.3 | **编译失败**（`v8-object.h:558` V8 API 不兼容） | npm install 输出 |
| 同版本在 node 24.20 LTS | **编译+运行成功**（`new ivm.Isolate()` 可用），native rebuild 1m53s | 本机实测 |
| npm 12 的 git 依赖门禁 | 默认拒绝（`EALLOWGIT`），需 `--allow-git=all` | npm help install |
| npm 11.19+ 的构建脚本门禁 | 需 `npm install-scripts approve screeps @screeps/driver isolated-vm uglifyjs-webpack-plugin es5-ext` + `npm rebuild` | 实测 |
| `screeps` 全量安装耗时 | ≈6 分钟（下载）+ ≈2 分钟（native 编译） | time |
| driver/dist（webpack 产物） | **非运行时必需**；`driver/build/runtime.snapshot.bin`（VM 快照）随 npm 包自带 | 实测快照加载正常 |

**产品策略落点**：
- 私服需要 node 22/24 LTS 工具链；DSH 若跑在 node 26 上，managed 模式必须用独立 node 运行时
  （便携 tarball 方案已在另一工作线实现：`src/runtime/node-runtime.ts` 的 provisioning），
  或者用户走容器/external 模式（`startCommand`/`stopCommand` 模板天然支持 docker/podman）。
- README 安装前置：git、python3、C++ 工具链、`--allow-git`、`install-scripts approve` 五包。

## 2. 全新世界的隐藏坑（重要！）✅

**全新安装（空 db.json）会让 storage 进程启动即崩**：`upgradeDb` 里 `db.getCollection('env')` 为
null → `env.get(1)` TypeError → "Could not launch the storage process"（`storage/lib/db.js` L42）。
全库唯一的播种路径是 CLI `system.resetAllData()` → `db.loadJSON(db.original.json)`。

**落点**：插件的 managed 流程必须在首次启动前播种 `db.json`
（lokijs `new loki(path) + loadJSON(db.original) + save()`，3 行，见 m0-spike.sh 第 4 步）。
这也解释了为什么 `npx screeps init` 流程对部分用户是坏的。
**【2026-09-06 勘误】**原文"对局生命周期用 resetAllData 是官方正路"已被推翻：`resetAllData`（loadJSON）
会把 env 的 `databaseVersion` 重置为 undefined → 下次 storage 启动重跑 v4→v5 转换器，
毁掉 reset 后新建的 v5 格式对象（spawn 的 store 被掏空）。对局重置一律走 arena-mod 的
`resetArena`（清集合并**保留 env 元数据**）。实证见 `docs/spikes/m0-flake.md` 与 `screeps-mod/arena-mod.cjs`。

## 3. STEAM_KEY 消除 ✅（arena mod v0 实测）

- 时序确认：backend `index.js` 顶部 require（捕获 `steamApi.key`）→ `start()` 内 `configManager.load()`（mods）→ `startServer()`（读 STEAM_KEY 分支 + connectToSteam）。**mod 内自设占位 env + stub `steam-webapi.ready` 的窗口有效**，实测私服零 Steam 依赖、零重试噪音。
- **mods.json 会被 storage 与 backend 两个进程各自加载**（都走 `configManager.load()`）；mod 必须 guard：CLI/HTTP 注册只在 backend 进程（`config.backend`/`config.cli` 存在时）。
- npm 包名勘误：仓库目录叫 `backend-local`，npm 包名是 **`@screeps/backend`**（mod 内 require 用后者）。

## 4. 全链路（Step 0.3/0.4）✅

实测通过（`scripts/m0-spike.sh` + `scripts/cli-run.cjs`）：
1. 启动参数：README 过时——`--runners_cnt` 已改 **`--runner_threads`**；`--assetdir` 必填（指向 `node_modules/@screeps/launcher/init_dist/assets`）；**`--host`/`--cli_host` 不传会把 undefined 传进 backend env 导致崩**（`CLI_HOST is not set`），必须显式传 `127.0.0.1`。
2. `arena.createUser(name, room)`（复刻 bots.spawn 去bot化）建用户+spawn+claim controller+20000 tick safeMode ✅
3. `arena.grantToken(name)` 发 token → HTTP `X-Token` header 认证 ✅
4. `POST /api/user/code` 上传代码 ✅；`system.setTickDuration(200)` 加速 ✅（gameTime 冲到 1000+）
5. **`/api/game/map-stats` 返回完整观战投影**：房间归属 user+level、safeMode、minerals、用户 badge/rooms/cpu ✅
6. 用户代码确实逐 tick 执行：agentA 的 `Memory.stats={tick:1002}` 通过 `/api/user/memory` 读回（**`gz:` 前缀 gzip+base64**，host 解压即可）✅

## 5. 关键协议事实（M1/M2 直接引用）

- **token TTL 60s 滑动**（`authlib.genToken` → `setex 60s`，使用即续期）。host 必须「用时即铸」，
  或由 arena mod 全程持 secret 代行（推荐后者：token 永不出 host 侧）。
- **sockjs 挂载在 `/socket`**（`socketServer.installHandlers(server, {prefix:'/socket'})`）；
  协议：连上收 `time/protocol` 行 → 发 `auth <token>` → 发 `subscribe <channel>`。
  **`user:<id>/*` 通道只允许订阅自己的 id**（服务端强制）——观战他人 console 需 mod 增加观战通道或 host 逐用户连接。
- **pubsub 是进程内 EventEmitter + RPC 桥**：backend 的 `pubsub.subscribe` 走 rpc 到 storage 进程。
  **时序陷阱：mods 加载早于 `storage._connect()`**，mod 里订阅必须轮询 `storage._connected` 后再挂，
  否则静默失效。sockjs 模块无此问题（注册发生在 startServer 内）。
- **`roomsDone` 事件实测可用**：driver 每 tick publish（payload = gameTime 数字）；mod 内 tap 实测
  `roomsDone: 47, lastGameTime: 649`（≈1.6 tick/s @ 200ms 设定）。**M1 事件流采集方案候选 A（mod 内
  pubsub roomsDone + db diff）验证通过**；候选 B（浏览器 sockjs `room:<r>` 增量流）协议已确认，
  M1 按视图需要二选一或并用。
- 默认世界：**121 房（W0N0~W10N10），其中 81 个内圈房（W1N1~W9N9）有 controller**，四角（W1N1/W1N9/W9N1/W9N9）自带 4 个 simplebot NPC；十字/边缘房无 controller。World 模式选房只在内圈 81 房中做资源对称匹配。
- 默认 world 里 `generateRoom` 的地形种子不可控——对称地图靠「多候选房 + map-stats 资源比对挑选」，不靠引擎。

## 6. 遗留到 M1 的输入清单

1. 事件流：候选 A/B 并用方案（mod 聚合战报原料 + sockjs 房间增量给地图动画）。
2. 观战 console 通道：arena mod 增加受 secret 保护的 `arena:spectate` pubsub 通道，或 host 逐用户 sockjs 连接。
3. `arena.summary()` 已是 `/api/arena/summary` HTTP 面（mod v1），M1 的对局大厅直接用。
4. W2N2/W8N8 已被 spike 占用；正式对局重置用 arena-mod 的 `resetArena`（勿用 `resetAllData`，见第 2 节勘误）。
5. 另一工作线已交付 S0+S1（脚手架 + node-runtime provisioning，commit 8e3a52f）；本 spike 的
   arena mod 修正（进程 guard / 包名 / eventTap）与 provisioning 是互补产物，合流即可。
