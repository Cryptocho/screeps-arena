# S14 计划 v3 — README/AGENTS 写回 + 真实组合验证（修订版，合并审查 v1+v2 意见）

审查 v1/v2 结论：需修订。v1 的 3 个高问题已在 v2 解决（git 分发空壳 / headless 任务可判定 / 配置注入 + LICENSE 初稿）；
v2 复审遗留 1 个阻塞项（README License 节矛盾）→ S14 执行前审查实测该矛盾已不存在（L106-108 已是正确
MIT 表述，与 L8/LICENSE/package.json 四方一致），本版保留 D 步复核项，并顺手修 3 处次要瑕疵（行号引用、
C2 patch 语义、AGENTS 验收句恢复策略），供最终复审。S14 审查另发现 2 处次要缺陷，已合并入本版：
D 步 README License 项改为「复核」（见 D）；A 步 external 标注实际未写入 README → D 步补写（见 D）。

## 现状事实（commit 240b4e5，已核实）
- README.md 缺失 → **已补初稿**（正文完成，安装命令待 C 步实测后定稿）
- LICENSE 缺失 → **已补**（MIT 文本，与 `package.json.license` 一致）
- `lib/` 陈旧 → **已重建**（80.28 kB），typecheck + 91 单测全绿（B 步已过）
- 纯 host 插件（无 client）；私有仓库、不 push 不发布、只本地验证
- `.gitignore` 排除 `lib/` → git 分发时 `exports["."]` 指向不存在的 `lib/index.js`（审核问题 1）

## 任务清单

### A. README + LICENSE（✅ 已完成初稿）
- README：玩法/三层架构/配置 schema/工具面/公平边界/信任模型（vm 非安全边界，明示）/验证命令
- 安装命令只写**本地路径 add**（私有不发布场景的唯一诚实命令）+ 注明 build 前置；
  **不写 git+file:// 命令**（审核 4c：未实测的命令不写进 README）
- external 模式标注「配置以 schema 为准，真机验证待后续」（审核 4c）

### B. 基线（✅ 已完成）
`npm run build` / `typecheck` / `npm test`（91 绿）/ `git diff --check`

### C. 真实组合验证（重排四步，审核问题 2）
- **C0** 本地路径 add scratch → `--dump-config` **精确断言**：
  `id: dsh-screeps` / `name: dsh-screeps` / `config: {}`（与 `cordis.patch.yml` L5-7 逐字对照）
  [已手动验证一次，C 步重跑固化]
- **C1** 产物存在性断言：`<profile>/node_modules/dsh-screeps/lib/index.js` + `cordis.patch.yml`
  存在（审核 4d——这是抓 lib/ 空壳的断言，dump-config 盖不住）
- **C2** headless **加载层任务**（审核问题 3 重构）：
  插件 add 到 headless profile + 启动时 `--patch` 注入 screeps 层 config
  （`--patch` 是 dsh CLI 的真实 repeatable 选项，layer 顺序在 profile 层之后、config 为整段替换、
  未写键走 schema 默认：`service.ts` L63-72；注入 `dataDir` 指向复用 smoke 的目录：
  含 `server/`、`runtime/` symlink，同 IT 模式；
  `port: 0`、`tickDuration: 200`）→
  `dsh --profile headless "调用 screeps_world_status 并报告 gameTime 与玩家数"`
  - 小而可判定：验证插件加载 + 工具注册 + 服务连上私服（复用 smoke dataDir，避免现场下载）
  - **不写**「创建双用户对局」任务——S13 无 CLI 通道、headless 单会话、双用户提码不可行
    （审核问题 3；AGENTS.md 原句是 M0 愿景，D 步同步修订 AGENTS.md）
- **C3** §8.4 git+file:// 分支（放最后）：
  临时 git repo **显式纳入 lib/**（`git add -f lib/` 到临时 repo，主仓库 ignore 不动）
  → git+file:// 安装 → `--dump-config` + 产物存在性断言 + 加载层任务 → **用完删临时目录**
  （审核 4e）目的：预验证未来 GitHub 分发形态；现阶段不发布，若 C0-C2 全绿且时间紧张，
  将 C3 标注「分发前必做」留存

### D. 收尾
- **README License 节复核**（v2 复审阻塞项的收尾，S14 审查实测已无需修改）：L106-108 现文为
  「本插件 MIT（见 LICENSE）/ Screeps 引擎与素材 ISC（声明在上游）」——与 L8 自述、LICENSE 全文、
  package.json license 四方一致。复核通过，如与最终 diff 不符再修。
- **README external 标注补写**（S14 审查问题 2）：A 步声称的「external 模式：配置以 schema 为准、
  真机验证待后续」标注实际未写入 README → 在配置节 external 相关位置（L61-63 附近）补标注。
- README 安装命令按 C 实测定稿
- **AGENTS.md 同步修订**（审核 4h + 问题 3）：
  - 验证节验收句：把「创建一场两个用户各提交最简代码的对局并报告胜负」换成可判定的
    「headless 加载层任务」（screeps_world_status 报告 gameTime/玩家数），
    **标注「M2 完成后恢复对局闭环验收」**（防止对局闭环验收永久丢失）
  - 工具面 `screeps_match` 一行：删除「或 CLI」表述（实现无 CLI 通道），录入遗留
- `docs/LOG.md` 追加 S14 条目（含验证证据）
- 版本号写死：0.1.0 **不 bump**（纯文档+验证，无 API 变化，审核 4f）
- 一个 commit（用户授权范围）

## 风险与缓解（重写，审核 §5）
- **git 分发空壳**：取舍明确——主仓库 lib/ 保持 ignore；C3 临时 repo 显式纳 lib/；
  README 只写本地路径 add + build 前置；不再误引 §7.1 备选路径
- **headless 用时/网络**：C2 patch 注入复用 smoke dataDir（避免现场下载 Node+私服）；
  单命令加 timeout
- **smoke 单写者**：C2 复用 smoke dataDir 时遵守单写者（验证期间不并行跑其他 IT）
- **清理纪律**：C3 临时目录用完即删；scratch/headless 的插件 add 记录可保留（本地开发）