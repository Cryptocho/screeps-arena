# plan-M0 — 从 DSH 插件切割为独立程序「Screeps Arena」

状态：**送审中**（审查历史见文末）
前置：Pi SDK spike 已通过（`docs/spikes/pi-sdk.md`，S1–S6 全绿）
纪律：本文档不 PASS 不得开工；PASS 后等待用户确认再动工。

## 1. 目的

DSH 迭代激进，插件 API（client slots / cordis patch / dsh-tools / Config schema / 会话 spawn 语义）
频繁变动，维护成本失控。将项目切割为**独立程序**：自带 Web 服务与前端、自带 Agent 运行时（Pi SDK），
与 DSH 完全解耦；保留 Screeps 私服 + arena mod 及对局领域层的全部已验证资产。

## 2. 决策记录（用户拍板，2026-09-11）

| 决策 | 内容 |
|---|---|
| 仓库形态 | 新仓库 `screeps-arena`；旧仓库 `dsh-screeps` 冻结存档，重要文件已拷入 `reference/` |
| Agent 运行时 | 用 Pi SDK（`@earendil-works/pi-coding-agent` 0.85.x），spike 已验证可行 |
| Node | 22 LTS，fnm 供给（`.nvmrc`=22，engines `>=22.19 <23`）；系统 v26 不可用（native ABI） |
| 技术栈 | 授权 Agent 选型：Fastify 5 + zod + React 18 + Vite + vitest + tsdown |

> 归档说明：本文档为 M0 历史计划；前端实际落地为 **React 19**（见 package.json 与 plan-M1），此处的 18 为当时预估。
| 容器化 | 官方 compose 双服务（app + screeps）作为**推荐部署形态**（M2+）；开发/CI bare-metal；managed 模式保留给本地开发 |

## 3. 范围

M0 = **骨架 + Agent 运行时最小落地**。HTTP 全量平移、前端 SPA、锦标赛/回放/历史、真实私服接线
均不在 M0（后续里程碑推进）。

### 已完成（本计划提交时）

- S0a 仓库骨架：目录（`src/{server,agent,shared,client}`、`scripts`、`docs`）、package.json、
  tsconfig、.nvmrc、.gitignore、AGENTS.md、README、`reference/` 存档（1.9M）。
- S0b Pi spike：离线 mock OpenAI SSE server + models.json provider + defineTool 白名单 +
  工具调用闭环 + 重复 prompt 唤醒 + 事件流。复现 `npm run spike:pi`，全绿。
  踩坑结论 5 条（agentDir 必传 / registerProvider 不进解析链 / followUp 空闲 no-op /
  1 turn=2 次 LLM 请求 / npm arborist bug），见 spike 文档。

### 待实施

- S1 **AgentRunner**（`src/agent/runner.ts`）：Pi SDK 封装——会话创建（每席位隔离 cwd/agentDir）、
  工具注册（typebox）、`prompt()` 唤醒、事件归集（订阅转内部事件）、disposal。
  单测用 spike 的 mock server 装置。
- S2 **工具面最小集**（`src/agent/tools.ts`）：`submit_code` / `report` / `console` 三工具，
  逻辑参考 `reference/src/host/tools.ts` 去 DSH 化；两类依赖均以接口注入（M0 用内存假实现，
  M1 换真实 arena API）：① 席位→Screeps 用户映射；② 数据/执行面（提交落位 / console 执行 /
  世界投影，对应旧 `ScreepsService` 的最小子集）。公平边界单测：跨席位操作必须被拒。
- S3 **内存版对局状态机**（`src/server/match/`）：creating→running→roundBreak→settled 最小闭环，
  模型与转换语义对照 `reference/src/host/match/model.ts`（不整段照搬，裁剪到 M0 所需）；
  周期时钟 → AgentRunner.prompt()；超时兜底（沿用上轮提交自动 ready）。
- S4 **stub 对局 IT**：两个 mock LLM 席位完成「提交→唤醒→再提交→settle」一轮；
  `fnm exec --using=22 -- npm test` 全绿（不碰真实私服）。
- S5 收尾：LOG 首条、README 更新、（若有需手测项）TEST.md。

## 4. 验证

- 单测（AgentRunner）：会话生命周期 / 事件 / 多轮唤醒；**工具面断言：会话可用工具 = 白名单全集
  （screeps 三工具），无任何 Pi 内置工具**（与 spike S3 硬断言双保险：spike 锁 0.85.x 行为，
  单测锁封装层行为）。
- 单测（工具公平边界，负向）：席位 A 的工具触席位 B 映射 → 拒。
- 单测（状态机边界路径）：① roundBreak 超时到点、席位未提交 → 沿用上轮代码自动 ready 并续跑；
  ② running 期 `submit_code` → 拒绝（语义对照旧 `tools.ts` frozen 分支）。
- stub IT（S4）：mock provider 驱动 2 席位 1 轮闭环（全员提交 → 唤醒 → 再提交 → settle），
  断言状态机迁移与提交内容落位。
- 全部命令以 `fnm exec --using=22 -- …` 执行并真实跑通；结果与证据记入 `docs/LOG.md` 首条。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| Pi 0.85.x API 漂移 | 锁 0.85.x；`src/agent/` 作为唯一 Pi 触面（薄封装），升级只动这一层 |
| Pi 文档与实现不符（spike 已见 3 例） | 结论一律以实测为准，逐条记入 spikes；封装层单测钉死行为 |
| mock server 与真实 provider 行为差异（SSE 细节/工具调用格式） | M1 接真实 LLM 时先跑一次真链路冒烟（复用 S4 IT，换 baseUrl） |
| 状态机裁剪引入语义漂移 | 迁移时逐条对照 reference `match/model.ts` + `model.test.ts` + `lifecycle-rounds.test.ts` 的用例语义（rounds 语义钉在后两者；store 持久化语义 M0 内存版不涉及）；有出入在 LOG 记录取舍 |

## 6. 遗留（后续里程碑）

- M1：HTTP/WS 桥（Fastify）、React/Vite 前端 SPA（大厅/地图/console 流）、arena mod + 真实私服接线、
  真实 LLM provider 冒烟。
- M2：官方 compose 双服务（app + screeps，node:22 镜像）、数据卷、文档。
- 持续：`reference/docs/LOG.md` 旧遗留逐条复核是否仍适用（interrupted 恢复、房间可见性精确化等）。

## 7. 审查历史

- 一审（subagent，2026-09-11）：**FAIL**，4 项：① spike S3/S6 无硬断言（事实依据失实，
  白名单机制不能纸面验证）→ 已补 `state.tools` 枚举断言 + 事件流断言并重跑全绿；
  ② §4 缺「工具面 = 白名单全集」判据 → 已补；③ §5 风险表引用错位（store.test →
  model/lifecycle-rounds 测试）→ 已改；④ S3 边界路径（超时兜底 / running 期拒提交）
  无 done 判据 + S2 漏数据/执行面接缝 → 均已补。
- 二审（同 subagent，2026-09-11）：**PASS**。4 项修改全部确认到位；两条非阻塞观察
  （S2/S3 断言方式措辞、名单制排除盲区）已顺手采纳：S3 升级为整表相等断言
  （`state.tools` === `[submit_code]`），零成本消除盲区。
- 状态：**PASS，等待用户确认开工**。
