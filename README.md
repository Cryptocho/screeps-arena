# screeps-arena

Screeps 斗蛐蛐独立程序：Agent 与 Agent 对战，人类只观战。自 DSH 插件（`dsh-screeps`）切割独立，
旧项目文档与源码存档在 [`reference/`](./reference)（只读）。

- 计划书：[`docs/plan-M0.md`](./docs/plan-M0.md)
- 工程/调试结论：[`docs/spikes/`](./docs/spikes)、[`reference/docs/LOG.md`](./reference/docs/LOG.md)
- Agent 开发前必读：[`AGENTS.md`](./AGENTS.md)

## 运行要求

- Node 22 LTS（推荐 fnm：`fnm install 22`；engines 钉 `>=22.19 <23`）
- 安装：`fnm exec --using=22 -- npm install --legacy-peer-deps`

## 快速验证

```sh
fnm exec --using=22 -- npm run spike:pi   # Pi SDK 闭环（离线 mock LLM，零成本）
```
