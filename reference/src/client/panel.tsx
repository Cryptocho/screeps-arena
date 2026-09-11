/**
 * 中心列对局面板（S12 体验轮）：DOM 级挂载 + 属性切换显隐（学 dsh-dice-game）。
 *
 * - 入口：侧边栏「Screeps 对局」列表项点击 → controller.openMatch(id) → 开面板；
 * - 中心列识别：`[data-pane='conversation']` / `[class*='centerCol']`（dice 同款，兼容 rc.2）；
 * - 显隐：html[data-dsh-screeps-active] 属性 + CSS（下方注入），面板 absolute 覆盖中心列，
 *   对话内容 stay mounted（隐藏不卸载 → 状态保留）；关闭恢复；
 * - **不绑定 session**：面板内容 = 选中对局（controller.selectedMatchId）的公开数据。
 *
 * 清理：React root.unmount + 属性剥除 + observer 断连，全走 disposer。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MatchBoard, ui, usePollJson, type LobbyMatch } from './match/board.tsx'
import { TournamentDetail } from './m4/tournament-panel.tsx'
import type { MatchPanelController } from './controller.ts'

/** 面板容器 data 属性 + 中心列选择器 + active 属性（与 CSS 一致）。 */
export const PANEL_SELECTOR = '[data-dsh-screeps-panel]'
const COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-screeps-active'
const STYLE_ID = 'dsh-screeps/panel.css'

const CSS = `
[data-pane='conversation'],
[class*='centerCol'] {
  position: relative;
}

[data-dsh-screeps-panel] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base, #101018);
  flex-direction: column;
  overflow: hidden;
}

html[data-dsh-screeps-active] [data-dsh-screeps-panel] {
  display: flex;
}

html[data-dsh-screeps-active] [data-pane='conversation'] > :not([data-dsh-screeps-panel]),
html[data-dsh-screeps-active] [class*='centerCol'] > :not([data-dsh-screeps-panel]) {
  display: none !important;
}

.dsh-screeps-panel-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  flex: 0 0 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,137,.2));
  background: var(--dsw-alias-bg-elevated, #1a1a24);
  box-sizing: border-box;
}

.dsh-screeps-panel-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
`

/** 注入面板样式（幂等）。 */
function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-screeps'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

interface MatchList {
  ok: boolean
  matches?: LobbyMatch[]
}

/** 面板主体：标题栏（对局名/状态/关闭）+ 对局切换下拉 + 看板。 */
function PanelBody(props: { controller: MatchPanelController }): React.JSX.Element {
  const { controller } = props
  const snap = controller.getSnapshot()
  const selected = snap.selectedMatchId
  const selectedTournament = snap.selectedTournamentId
  const listData = usePollJson<MatchList>('/dsh-screeps/matches', 3000)
  // M5：maxRounds 在原始 DTO 的 config 里嵌套——拍平到顶层供看板周期进度显示（0/缺省 = 不限）
  const matches = (listData?.matches ?? []).map(m => ({
    ...m,
    maxRounds:
      typeof (m as unknown as { config?: { maxRounds?: number } }).config?.maxRounds === 'number'
        ? (m as unknown as { config: { maxRounds: number } }).config.maxRounds
        : undefined,
  }))
  const current = matches.find(m => m.id === selected) ?? matches[0]

  const [busy, setBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | undefined>(undefined)

  return (
    <>
      <div className="dsh-screeps-panel-bar">
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {selectedTournament ? '🏆 Screeps 赛事' : '⚔️ Screeps 对局'}
        </span>
        {!selectedTournament && matches.length > 0 && (
          <select
            value={current?.id ?? ''}
            onChange={e => controller.openMatch(e.target.value)}
            style={{
              marginLeft: 8, padding: '4px 8px', fontSize: 12, borderRadius: 6,
              border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit',
            }}
          >
            {matches.map(m => (
              <option key={m.id} value={m.id}>
                {m.id.slice(-6)} · {m.phase} · {m.players.map(p => p.username).join('/') || '—'}
              </option>
            ))}
          </select>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={() => controller.close()}
            style={{
              border: '1px solid rgba(127,127,137,.3)', background: 'transparent', color: 'inherit',
              borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 13,
            }}
            title="关闭面板"
          >✕</button>
        </span>
      </div>
      <div className="dsh-screeps-panel-body">
        {selectedTournament ? (
          <div style={{ padding: 16 }}>
            <TournamentDetail
              tournamentId={selectedTournament}
              onBack={() => controller.closeTournament()}
              onOpenMatch={matchId => controller.openMatch(matchId)}
            />
          </div>
        ) : current ? (
          current.phase === 'creating' || current.phase === 'placing' ? (
            /* 赛前准备室：Agent 起名/写脚本 → 全就绪 → 用户发令开始（观战者触发） */
            <div style={{ padding: 24, ...ui.col }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>⚔️ 赛前准备室</div>
              <div style={{ ...ui.muted }}>
                {current.id.slice(-6)} · {current.preset} · Agent 各自起名/写脚本，全就绪后可开始
              </div>

              {/* 玩家卡牌：自起名的用户名 + 就绪状态（A0 submitted 打勾） */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {current.players.length > 0 && current.players.map((p, i) => (
                  <div key={p.username + i} style={{ ...ui.card, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 6, background: i === 0 ? '#3ddc84' : '#4a9eff', flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{p.username}</span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      {i === 0 ? '红方' : '蓝方'} · {p.submitted ? '✓ 已就绪（已提交脚本）' : '写脚本中…'}
                    </div>
                  </div>
                ))}
                {current.players.length < 2 && (
                  <div style={{ ...ui.card, ...ui.muted }}>等待第二位选手就座…</div>
                )}
              </div>

              {current.players.length < 2 ? (
                <div style={{ ...ui.muted }}>还差一位选手 —— 稍候招募完成</div>
              ) : (
                <button
                  onClick={async () => {
                    setBusy(true)
                    setActionMsg(undefined)
                    try {
                      // M2 C 步：start 需带 creator 的 sessionId（HTTP 侧 creator 校验；players[0] 是创建者）
                    const creatorSession = current.players[0]?.sessionId
                      const res = await fetch(`/dsh-screeps/matches/${current.id}/start`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: creatorSession ? JSON.stringify({ sessionId: creatorSession }) : undefined,
                      })
                      const json = (await res.json()) as { ok: boolean; error?: string }
                      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
                    } catch (err) {
                      setActionMsg(String(err instanceof Error ? err.message : err))
                    } finally {
                      setBusy(false)
                    }
                  }}
                  disabled={busy}
                  style={{
                    alignSelf: 'flex-start', padding: '10px 24px', fontSize: 15, fontWeight: 700, borderRadius: 8,
                    cursor: busy ? 'default' : 'pointer',
                    border: '1px solid rgba(61,220,132,0.7)', background: 'rgba(61,220,132,0.18)', color: 'inherit',
                  }}
                >
                  {busy ? '开赛中…' : '▶ 开始对局'}
                </button>
              )}
              {actionMsg && <div style={{ fontSize: 12, color: actionMsg.startsWith('✓') ? '#3ddc84' : '#ffb347' }}>{actionMsg}</div>}
            </div>
          ) : (
            <MatchBoard match={current} />
          )
        ) : (
          <div style={{ padding: 24, ...ui.col }}>
            <div style={{ opacity: 0.7 }}>暂无对局 —— 点左下角「⚔️ 新建对局」开赛</div>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * 挂载中心列对局面板，绑定 controller 显隐。
 * @returns disposer（unmount root + 剥属性 + 断 observer）。
 */
export function mountPanel(ctx: ClientContext, controller: MatchPanelController): () => void {
  injectStyles()
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const SIDEBAR_ROW = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"]'
  /** 点侧边栏行 → 关面板回对话（dice 同款：capture 阶段先于 shell 处理）。 */
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      container.remove()
      container = undefined
      root?.unmount()
      root = undefined
    }
    const column = document.querySelector<HTMLElement>(COLUMN_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.dataset.dshScreepsPanel = ''
    container.setAttribute('data-dsh-screeps-panel', '')
    column.appendChild(container)
    root = createRoot(container)
    const body = <PanelBody controller={controller} />
    root.render(body)
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().panelOpen) {
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    waitObserver.disconnect()
    unsubscribe()
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}