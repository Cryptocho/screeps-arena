/**
 * dsh-screeps client 半身（S12 体验轮）：左下角对局大厅 + 中心列对局面板。
 *
 * 交互模型（S12 实测修正，学 dsh-dice-game，最终形态）：
 * - **左下角**（sidebar.footer.action）—— 对局列表 + **新建/删除** 全生命周期入口；
 * - **中心列面板**（panel.tsx）—— 点列表项打开，观战 + join/start，全局不绑 session；
 * - **不注册会话 tab**——主交互完整体现在左下角，无 session 绑定残留。
 *
 * 失败安全（学 dice）：apply 内任何挂载失败只 warn 不 throw，不拖垮 web shell。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：拉入 client-runtime 的 Context merge。
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only：拉入 ui-sidebar 的 SlotMap merge（sidebar.footer.action）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MatchPanelController } from './controller.ts'
import { registerLobby } from './lobby/index.tsx'
import { mountPanel } from './panel.tsx'

export const name = 'dsh-screeps-client'

/** 必需服务：SlotRegistry（面板是纯 DOM + 侧边栏入口，全部 de-session，不需要 sessions）。 */
export const inject = ['slots'] as const

/**
 * Client plugin body：侧边栏对局大厅（列表 + 创建 + 删除）+ 中心列对局面板。
 */
export function apply(ctx: ClientContext): void {
  const controller = new MatchPanelController()
  const disposers: Array<() => void> = []
  try {
    disposers.push(registerLobby(ctx, controller))
    disposers.push(mountPanel(ctx, controller))
  } catch (error) {
    console.warn('[dsh-screeps] client mount failed (degraded, shell kept alive):', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-screeps: client mounts')
}