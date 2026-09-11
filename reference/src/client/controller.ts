/**
 * 对局面板控制器（S12 体验轮）：全局开/关 + 当前选中对局。
 *
 * 学 dsh-dice-game 的 PanelController：框架无关的状态机，让侧边栏入口、
 * 中心列面板、列表切换共享一个订阅面。**不绑定 session**——地图/统计/console
 * 全是 host 公开数据，观战不需要会话上下文（S12 实测修正）。
 */

export interface MatchPanelSnapshot {
  panelOpen: boolean
  /** 当前选中的对局 id（undefined = 未选）。 */
  selectedMatchId: string | undefined
  /** 当前选中的赛事 id（undefined = 未选；选中时面板显示赛事详情而非对局看板）。 */
  selectedTournamentId: string | undefined
}

/** 面板状态 owner：侧边栏入口 toggle，列表项 select+open。 */
export class MatchPanelController {
  private panelOpen = false
  private selectedMatchId: string | undefined
  private selectedTournamentId: string | undefined
  private listeners = new Set<() => void>()

  getSnapshot(): MatchPanelSnapshot {
    return { panelOpen: this.panelOpen, selectedMatchId: this.selectedMatchId, selectedTournamentId: this.selectedTournamentId }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  select(matchId: string): void {
    if (this.selectedMatchId === matchId) return
    this.selectedMatchId = matchId
    this.selectedTournamentId = undefined
    this.notify()
  }

  /** 选中赛事（清对局选中，打开面板）。 */
  openTournament(tournamentId: string): void {
    this.selectedTournamentId = tournamentId
    this.selectedMatchId = undefined
    this.panelOpen = true
    this.notify()
  }

  /** 关闭赛事详情，回列表（保持面板开）。 */
  closeTournament(): void {
    this.selectedTournamentId = undefined
    this.notify()
  }

  open(): void {
    if (this.panelOpen) return
    this.panelOpen = true
    this.notify()
  }

  close(): void {
    if (!this.panelOpen) return
    this.panelOpen = false
    this.notify()
  }

  toggle(): void {
    if (this.panelOpen) this.close()
    else this.open()
  }

  /** 选中并打开面板（列表项点击的完整动作）。 */
  openMatch(matchId: string): void {
    this.selectedMatchId = matchId
    this.selectedTournamentId = undefined
    this.panelOpen = true
    this.notify()
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}