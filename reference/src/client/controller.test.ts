/**
 * MatchPanelController 单测（S12 体验轮）：面板开/关/选中状态机。
 * 钉死「观战不绑 session」语义——controller 只持有 matchId，无任何会话依赖。
 */
import { describe, expect, it } from 'vitest'
import { MatchPanelController } from './controller.ts'

describe('MatchPanelController', () => {
  it('starts closed with no selection', () => {
    const c = new MatchPanelController()
    expect(c.getSnapshot()).toEqual({ panelOpen: false, selectedMatchId: undefined })
  })

  it('openMatch selects and opens in one step', () => {
    const c = new MatchPanelController()
    c.openMatch('m1')
    expect(c.getSnapshot()).toEqual({ panelOpen: true, selectedMatchId: 'm1' })
  })

  it('select updates without forcing open', () => {
    const c = new MatchPanelController()
    c.select('m1')
    expect(c.getSnapshot().selectedMatchId).toBe('m1')
    expect(c.getSnapshot().panelOpen).toBe(false)
  })

  it('open/close/toggle keep selection', () => {
    const c = new MatchPanelController()
    c.openMatch('m2')
    c.close()
    expect(c.getSnapshot()).toEqual({ panelOpen: false, selectedMatchId: 'm2' })
    c.open()
    expect(c.getSnapshot().panelOpen).toBe(true)
    c.toggle()
    expect(c.getSnapshot().panelOpen).toBe(false)
  })

  it('subscribe fires on changes and unsubscribe works', () => {
    const c = new MatchPanelController()
    let fired = 0
    const un = c.subscribe(() => { fired++ })
    c.open()
    c.close()
    expect(fired).toBe(2)
    un()
    c.open()
    expect(fired).toBe(2)
  })
})