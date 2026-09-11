# Spike S7d：地图生成公平性

日期：2026-09-05 · 结论：**World 用同参数房间（数量公平）；Arena 1v1 用 mod 镜像克隆（完全对称）**

## 事实（源码 + 实机实验，screeps 4.3.0）

1. `map.generateRoom(roomName, opts)` 可控参数（`backend-local/lib/cli/map.js` L14-22）：
   `terrainType`(1-28 地形原型)、`swampType`(0-14)、`sources`(1-2 精确数量)、`mineral`(类型或 false)、
   `controller`(默认 true)、`keeperLairs`(默认 false)、`exits`。
2. **同参数 ≠ 同地形**（实测 4 组，W21N14 vs W21S14 等，terrain 字符串全部不同）：
   terrainType 只是平滑/原型风格参数，内部初始噪声用 `Math.random()`，不可复现。
3. **source 数量精确可控**：sources=2 两房都正好 2 个；sources=1 都 1 个。位置随机（L317-336，
   `Math.random()*44+3`），controller 位置亦随机。
4. **工程坑**：generateRoom 会写 `assets/map/[zoom2|zoom4|zoom8/]<room>.png` 预览，
   目录不存在 → WriteStream ENOENT → **backend 直接崩溃**（未处理 'error' 事件）。
   安装器已补建这些目录（server-installer.ts）。
5. mod 新增 `POST /api/arena/rooms {room, terrainType, sources, mineral, ...}` 返回生成的
   source/controller 坐标，供对局控制器做公平性校验。

## 决策

**World 模式（同参数 + 校验）**：
- 对局创建时为每个玩家生成 `terrainType 相同、sources 相同、mineral 相同、无 keeperLairs` 的房间。
- 公平性度量：mod 返回 source/controller 坐标 → 计算 Σ(source→controller 距离)；偏离全体中位数
  超过阈值的房间重新生成（重掷预算 ≤3 次）。
- 认知：资源"数量与风格"公平，位置有天然差异——与 Screeps 正式开局抽房的体验一致。

**Arena 模式（镜像克隆，M3）**：
- 单房 1v1 要完全对称：mod 生成基准房后，在 db 层把 terrain 字符串逐行反转（镜像 x）、
  source/mineral/controller 对象按镜像坐标复制到对手房。纯 db 操作，无需 fork engine。
- 这同时保证视野外一切对称（能量、矿、地形）。

## 对 AGENTS.md 的回写

- 「地图公平性」定案：World=同参数+距离校验重掷；Arena=mod 镜像克隆。
- 安装器必须创建 assets/map/zoom{2,4,8}（已实现）。
