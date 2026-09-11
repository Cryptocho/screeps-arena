/**
 * M4-E.2 — tournament 面板：创建（4/8 seats、额度警告、纯 Agent 文案）、
 * recruiting/ready/failed/active/terminal 状态、开始（观战者触发）、bracket、replay、leaderboard。
 *
 * 数据源：POST/GET /dsh-screeps/tournaments、/start、/:id/bracket、/history/leaderboard。
 * 纯 Agent 文案：赛事参与者是 Agent 会话，人类只观战/触发编排（plan §7.2）。
 */
import { useEffect, useRef, useState } from 'react'
import { fetchJson, guardTournament, guardTournamentDetail, guardTournamentList, type PublicTournamentView } from './api.ts'
import { BracketView } from './bracket-view.tsx'
import { Leaderboard } from './leaderboard.tsx'
import { ReplayPlayer } from './replay-player.tsx'

export interface TournamentPanelProps {
  /** 当前选中的 tournamentId（undefined = 列表视图）。 */
  tournamentId?: string
  onSelect: (tournamentId: string | undefined) => void
  onOpenMatch: (matchId: string) => void
}

const PHASE_COLOR: Record<string, string> = {
  recruiting: '#4a9eff',
  ready: '#3ddc84',
  running: '#3ddc84',
  completed: '#ffd76e',
  draw: '#ffb347',
  failed: '#e05',
  interrupted: '#889',
}

function requestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 赛事列表 + 创建表单（sidebar 空间有限，列表紧凑）。 */
export function TournamentList({
  tournaments,
  onSelect,
  onCreate,
  busy,
  msg,
}: {
  tournaments: PublicTournamentView[]
  onSelect: (id: string) => void
  onCreate: (seats: 4 | 8) => void
  busy: boolean
  msg?: string
}): React.JSX.Element {
  const [seats, setSeats] = useState<4 | 8>(4)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden>🏆</span>
        <span>Screeps 赛事</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>Agent 参赛 · 人类只观战/触发编排</span>
      </div>

      {/* 创建表单：seats 4/8 + 一键建赛 */}
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={seats}
          onChange={e => setSeats(Number(e.target.value) === 8 ? 8 : 4)}
          style={{ flex: 1, background: 'rgba(128,128,128,0.12)', color: 'inherit', border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
          title="赛事席位（4 或 8；单淘汰 bracket）"
        >
          <option value={4}>4 席 · 单淘汰</option>
          <option value={8}>8 席 · 单淘汰</option>
        </select>
        <button
          disabled={busy}
          onClick={() => onCreate(seats)}
          style={{
            padding: '6px 12px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: busy ? 'default' : 'pointer',
            border: '1px solid rgba(61,220,132,0.6)', background: 'rgba(61,220,132,0.15)', color: 'inherit',
          }}
          title="创建赛事：host 招募 N 个 Agent 会话参赛（真实 LLM 额度将被消耗）"
        >
          {busy ? '创建中…' : '🏆 新建赛事'}
        </button>
      </div>
      {msg && <div style={{ fontSize: 11, color: msg.startsWith('✓') ? '#3ddc84' : '#ffb347' }}>{msg}</div>}

      {/* 赛事列表 */}
      {tournaments.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>点「新建赛事」开赛</div>
      ) : (
        <div style={{ maxHeight: 180, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tournaments.map(t => {
            const color = PHASE_COLOR[t.phase] ?? '#aaa'
            return (
              <div
                key={t.tournamentId}
                role="button"
                tabIndex={0}
                aria-label={`赛事 ${t.tournamentId.slice(-6)} ${t.phase} ${t.participants.length} 名选手`}
                onClick={() => onSelect(t.tournamentId)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(t.tournamentId)
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', fontSize: 12,
                  borderRadius: 4, cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(128,128,128,0.14)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                title={t.error ? `⚠ ${t.error}` : `${t.participants.length}/${t.config?.seats ?? 4} 名选手`}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>
                    {t.tournamentId.slice(-6)} <span style={{ opacity: 0.6, fontWeight: 400 }}>{t.phase}</span>
                  </span>
                  <span style={{ fontSize: 10, opacity: 0.6 }}>
                    {t.participants.map(p => p.displayName).join(' · ') || `招募中 ${t.participants.length}/${t.config?.seats ?? 4}`}
                  </span>
                </div>
                {t.error && <span style={{ fontSize: 11, color: '#e05' }} title={t.error}>⚠</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 单个赛事的详情：状态 + 开始 + bracket + replay + leaderboard。 */
export function TournamentDetail({
  tournamentId,
  onBack,
  onOpenMatch,
}: {
  tournamentId: string
  onBack: () => void
  onOpenMatch: (matchId: string) => void
}): React.JSX.Element {
  const [tournament, setTournament] = useState<PublicTournamentView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | undefined>(undefined)
  const [activeReplay, setActiveReplay] = useState<{ matchId: string; replayId?: string } | undefined>(undefined)
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const raw = await fetchJson<unknown>(`/dsh-screeps/tournaments/${tournamentId}`)
        if (alive && raw) {
          const guarded = guardTournamentDetail(raw)
          if (guarded) setTournament(guarded)
        }
      } catch {
        // 失败保留快照
      } finally {
        inFlight.current = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tournamentId])

  const start = async (): Promise<void> => {
    setBusy(true)
    setMsg(undefined)
    try {
      const res = await fetch(`/dsh-screeps/tournaments/${tournamentId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`)
      setMsg('✓ 已触发开赛 —— 编排层开始逐场激活')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    setMsg(undefined)
    try {
      const res = await fetch(`/dsh-screeps/tournaments/${tournamentId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`)
      setMsg('✓ 已重试招募')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const phase = tournament?.phase ?? 'recruiting'
  const color = PHASE_COLOR[phase] ?? '#aaa'
  const isTerminal = ['completed', 'draw', 'failed', 'interrupted'].includes(phase)
  const canStart = phase === 'ready'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.12)', color: 'inherit' }}
        >
          ← 返回
        </button>
        <span style={{ fontWeight: 600, fontSize: 13 }}>🏆 赛事 {tournamentId.slice(-6)}</span>
        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: color, color: '#111' }}>
          {phase}
        </span>
        {tournament?.config?.seats && <span style={{ fontSize: 12, opacity: 0.7 }}>{tournament.config.seats} 席</span>}
        {tournament?.championParticipantId && (
          <span style={{ color: '#ffd76e', fontWeight: 600, fontSize: 12 }}>
            🏆 {tournament.participants.find(p => p.participantId === tournament.championParticipantId)?.displayName ?? '—'}
          </span>
        )}
      </div>

      {/* roster */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 12, opacity: 0.7 }}>选手（{tournament?.participants.length ?? 0}/{tournament?.config?.seats ?? 4}）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(tournament?.participants ?? []).map(p => (
            <span key={p.participantId} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, background: 'rgba(128,128,128,0.12)' }}>
              {p.displayName}
            </span>
          ))}
          {(tournament?.participants.length ?? 0) < (tournament?.config?.seats ?? 4) && (
            <span style={{ fontSize: 12, opacity: 0.6 }}>招募中…</span>
          )}
        </div>
      </div>

      {/* 操作：start / retry */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={busy || !canStart}
          onClick={() => void start()}
          style={{
            padding: '8px 20px', fontSize: 14, fontWeight: 700, borderRadius: 8,
            cursor: busy || !canStart ? 'default' : 'pointer',
            border: canStart ? '1px solid rgba(61,220,132,0.7)' : '1px solid rgba(128,128,128,0.3)',
            background: canStart ? 'rgba(61,220,132,0.18)' : 'rgba(128,128,128,0.08)',
            color: 'inherit', opacity: canStart ? 1 : 0.6,
          }}
          title={canStart ? '观战者触发开赛（Agent 已就绪）' : '等待全部 Agent 就绪'}
        >
          {busy ? '开赛中…' : canStart ? '▶ 开始赛事' : '等待就绪…'}
        </button>
        {tournament?.retryable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void retry()}
            style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: busy ? 'default' : 'pointer', border: '1px solid rgba(255,179,71,0.6)', background: 'rgba(255,179,71,0.12)', color: 'inherit' }}
          >
            ↻ 重试
          </button>
        )}
        {tournament?.error && <span style={{ fontSize: 12, color: '#e05' }}>⚠ {tournament.error}</span>}
        {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? '#3ddc84' : '#ffb347' }}>{msg}</span>}
      </div>

      {/* bracket */}
      <BracketView
        tournamentId={tournamentId}
        onOpenReplay={(matchId, replayId) => setActiveReplay({ matchId, replayId })}
        onOpenMatch={onOpenMatch}
      />

      {/* replay player（选中槽位时） */}
      {activeReplay && (
        <div style={{ borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 12 }}>▶ 回放 {activeReplay.matchId.slice(-6)}</span>
            <button
              type="button"
              onClick={() => setActiveReplay(undefined)}
              style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.1)', color: 'inherit' }}
            >
              ✕
            </button>
          </div>
          <ReplayPlayer matchId={activeReplay.matchId} />
        </div>
      )}

      {/* leaderboard */}
      <div style={{ borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: 10 }}>
        <Leaderboard tournamentId={tournamentId} limit={20} />
      </div>

      {isTerminal && (
        <div style={{ fontSize: 12, opacity: 0.7 }}>
          {phase === 'completed' && '🏁 赛事结束，冠军已产生'}
          {phase === 'draw' && '🤝 赛事以平局结束'}
          {phase === 'failed' && '⚠ 赛事失败，可重试'}
          {phase === 'interrupted' && '⚠ 赛事中断（服务器重启打断）'}
        </div>
      )}
    </div>
  )
}