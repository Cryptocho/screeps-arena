/**
 * 对局大厅（S12 体验轮 + A0 改造）：左下角 = 「新建对局」按钮 + 对局列表。
 *
 * 交互（2026-09-09 用户拍板：斗蛐蛐 = 纯 Agent 对战，人类只观战/撮合）：
 * - 点「⚔️ 新建对局」→ POST /dsh-screeps/spawn-agents → host spawn N 个真实 Agent 会话为玩家
 *   （Arena=2 / World=可配数量）→ 202 recruiting 异步编排（各 Agent 自己起名、写脚本）→
 *   轮询对局列表出现 creating 局 → 点条目开中间面板准备室观战/发「开始对局」；
 * - 对局列表：状态色点/悬停/选中，点条目开面板；终局条目 🗑 删除；
 * - 人类建赛仅 live/rounds 预设（world-rounds / arena-blitz；world-frozen 产品建赛排期外）。
 * 全部 de-session（不再伪造 client-uuid 占座——A0 替代伪造 sessionId 占座，P0 阻塞 1 修法）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useRef, useState } from 'react'
import type { MatchPanelController } from '../controller.ts'
import { fetchJson, guardTournamentList, type PublicTournamentView } from '../m4/api.ts'
import { TournamentList } from '../m4/tournament-panel.tsx'

export interface LobbyMatch {
  id: string
  phase: string
  preset: string
  players: { sessionId: SessionId; username: string; ready?: boolean }[]
  createdAt: number
}

const PHASE_COLOR: Record<string, string> = {
  creating: '#4a9eff',
  placing: '#4a9eff',
  running: '#3ddc84',
  paused: '#ffb347',
  roundBreak: '#ffb347',
  settled: '#9aa',
  interrupted: '#889',
}

/** 人类建赛仅 live/rounds 预设（A0 钉死：world-frozen 产品局排期外）。 */
const LIVE_PRESETS = [
  { id: 'arena-blitz', label: 'Arena 1v1 快速歼灭', seats: 2 },
  { id: 'world-rounds', label: 'World 回合制', seats: 4 },
] as const

/** 轮询 JSON（no-store、in-flight guard、失败保留快照）。 */
function usePoll<T>(path: string, intervalMs: number): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined)
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        if (!res.ok) return
        const json = (await res.json()) as { ok: boolean; matches?: T }
        if (alive) setData(json.matches)
      } catch {
        // 失败保留最后快照
      } finally {
        inFlight.current = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [path, intervalMs])

  return data
}

interface LobbyInjected {
  /** 打开中心列面板并选中对局。 */
  openMatch: (matchId: string) => void
  /** 打开中心列面板并选中赛事。 */
  openTournament: (tournamentId: string) => void
}

/** 注册对局大厅入口（sidebar.footer.action，root scope list）。返回 disposer。 */
export function registerLobby(ctx: ClientContext, controller: MatchPanelController): () => void {
  const dispose = ctx.slots.inject('sidebar.footer.action', () => {
    const dispose = ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'screeps-lobby',
        order: 10,
        inject: (): LobbyInjected => ({
          openMatch: (matchId: string) => controller.openMatch(matchId),
          openTournament: (tournamentId: string) => controller.openTournament(tournamentId),
        }),
      },
      LobbyEntry,
    )
    return () => {
      dispose()
    }
  })
  return () => {
    dispose()
  }
}

function LobbyEntry(props: { wide: boolean } & LobbyInjected): React.JSX.Element {
  const matches = usePoll<LobbyMatch[]>('/dsh-screeps/matches', 3000) ?? []
  const [lastOpened, setLastOpened] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | undefined>(undefined)
  const [preset, setPreset] = useState<string>('arena-blitz')
  const [count, setCount] = useState<number>(2)
  // M4：赛事列表 + 创建
  const [tournaments, setTournaments] = useState<PublicTournamentView[]>([])
  const [tournamentBusy, setTournamentBusy] = useState(false)
  const [tournamentMsg, setTournamentMsg] = useState<string | undefined>(undefined)

  // M4：轮询赛事列表（no-store + in-flight guard + 失败保留快照）
  useEffect(() => {
    let alive = true
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const raw = await fetchJson<unknown>('/dsh-screeps/tournaments')
        if (alive && raw) setTournaments(guardTournamentList(raw))
      } catch {
        // 失败保留快照
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const creatTournament = async (seats: 4 | 8): Promise<void> => {
    setTournamentBusy(true)
    setTournamentMsg(undefined)
    try {
      const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const res = await fetch('/dsh-screeps/tournaments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, seats }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string; tournamentId?: string; quotaWarning?: boolean }
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setTournamentMsg(
        `✓ 赛事已创建（${seats} 席）—— host 招募 ${seats} 个 Agent 会话参赛；` +
        (json.quotaWarning ? '真实 LLM 额度将被消耗。' : ''),
      )
      if (json.tournamentId) props.openTournament(json.tournamentId)
    } catch (err) {
      setTournamentMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setTournamentBusy(false)
    }
  }

  const isTerminal = (m: LobbyMatch): boolean => m.phase === 'settled' || m.phase === 'interrupted'

  /** A0 建赛：POST /spawn-agents → host spawn N 真实 Agent 会话（202 recruiting 异步编排）。
   *  各 Agent 自己起名/写脚本（准备室可见），全就绪后由用户在中间面板点「开始对局」（观战者触发）。 */
  const spawnMatch = async (): Promise<void> => {
    setBusy(true)
    setMsg(undefined)
    try {
      const spawnRes = await fetch('/dsh-screeps/spawn-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset, ...(count > 0 ? { count } : {}) }),
      })
      const spawnJson = (await spawnRes.json()) as { ok: boolean; error?: string; recruiting?: boolean }
      if (!spawnRes.ok || !spawnJson.ok) throw new Error(spawnJson.error ?? `HTTP ${spawnRes.status}`)
      setMsg(`✓ 已招募 ${count} 个 Agent（${preset}）—— 等它们起名/写脚本后，点对局条目开准备室`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 预设切换时同步 count 默认值（arena 固定 2；world 默认满员 seats）。 */
  const onPresetChange = (value: string): void => {
    setPreset(value)
    const p = LIVE_PRESETS.find(x => x.id === value)
    setCount(p?.seats ?? 2)
  }

  const remove = async (m: LobbyMatch): Promise<void> => {
    setBusy(true)
    setMsg(undefined)
    try {
      const res = await fetch(`/dsh-screeps/matches/${m.id}`, { method: 'DELETE' })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !json.ok) setMsg(json.error ?? `HTTP ${res.status}`)
      else setMsg(`✓ 已删除 ${m.id.slice(-6)}`)
    } catch (err) {
      setMsg(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 8, borderTop: '1px solid rgba(128,128,128,0.3)' }}>
      {!props.wide ? (
        <button
          title="Screeps 对局"
          style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'inherit' }}
          onClick={() => void spawnMatch()}
        >⚔️</button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden>⚔️</span>
            <span>Screeps 对局</span>
            {matches.some(m => m.phase === 'running') && (
              <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: 4, background: '#3ddc84', boxShadow: '0 0 6px #3ddc84' }} title="有对局运行中" />
            )}
          </div>

          {/* 建赛（唯一主操作）：预设 + Agent 数量 + 一键 spawn */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                value={preset}
                onChange={e => onPresetChange(e.target.value)}
                style={{ flex: 1, background: 'rgba(128,128,128,0.12)', color: 'inherit', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
                title="对局形态：Arena 1v1 快速歼灭 / World 回合制（周期提交；人类建赛仅此两预设）"
              >
                {LIVE_PRESETS.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <input
                type="number"
                min={2}
                max={12}
                value={count}
                onChange={e => setCount(Number(e.target.value))}
                style={{ width: 52, background: 'rgba(128,128,128,0.12)', color: 'inherit', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
                title="Agent 玩家数量（Arena 固定 2；World 2-4）"
              />
            </div>
            <button
              disabled={busy}
              onClick={() => void spawnMatch()}
              style={{
                padding: '6px 10px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
                border: '1px solid rgba(61,220,132,0.6)', background: 'rgba(61,220,132,0.15)', color: 'inherit',
              }}
              title={`spawn ${count} 个 Agent 会话为玩家（${preset}）；真实 LLM 额度将被消耗`}
            >
              {busy ? '招募中…' : '⚔️ 新建对局'}
            </button>
          </div>

          {/* 对局列表 + 删除 */}
          {matches.length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 12 }}>点「新建对局」开赛</div>
          ) : (
            <div style={{ maxHeight: 160, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {matches.map(m => {
                const color = PHASE_COLOR[m.phase] ?? '#aaa'
                const isActive = lastOpened === m.id
                return (
                  <div
                    key={m.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${m.id.slice(-6)} ${m.phase} ${m.players.map(p => p.username).join(' vs ')}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', fontSize: 12,
                      borderRadius: 4, cursor: 'pointer',
                      outline: isActive ? '1px solid rgba(140,160,255,0.5)' : 'none',
                      background: isActive ? 'rgba(128,128,128,0.08)' : 'none',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(128,128,128,0.14)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = isActive ? 'rgba(128,128,128,0.08)' : 'none' }}
                    onClick={() => {
                      props.openMatch(m.id)
                      setLastOpened(m.id)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        props.openMatch(m.id)
                        setLastOpened(m.id)
                      }
                    }}
                    title={isTerminal(m) ? '点击观看 · 可删除' : '点击观看'}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 600 }}>{m.id.slice(-6)} <span style={{ opacity: 0.6, fontWeight: 400 }}>{m.phase === 'roundBreak' ? '周期边界' : m.phase}</span></span>
                      <span style={{ fontSize: 10, opacity: 0.6 }}>
                        {m.players.map(p => p.username + (p.ready === true ? ' ✅' : '')).join(' vs ') || '—'}
                      </span>
                    </div>
                    {isTerminal(m) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void remove(m)
                        }}
                        disabled={busy}
                        title="删除该对局"
                        style={{ border: 'none', background: 'transparent', color: 'rgba(224,80,90,0.8)', cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}
                      >🗑</button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {msg && <div style={{ fontSize: 11, color: msg.startsWith('✓') ? '#3ddc84' : '#ffb347' }}>{msg}</div>}

          {/* M4：赛事（创建 + 列表） */}
          <div style={{ borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 10 }}>
            <TournamentList
              tournaments={tournaments}
              onSelect={id => props.openTournament(id)}
              onCreate={seats => void creatTournament(seats)}
              busy={tournamentBusy}
              msg={tournamentMsg}
            />
          </div>
        </div>
      )}
    </div>
  )
}