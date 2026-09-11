/**
 * M4-E.4 — bracket 视图：HTML/SVG 纯投影（plan §7.2）。
 *
 * 数据源：GET /dsh-screeps/tournaments/:id/bracket（host 已剥离 session/userId）。
 * 纯投影：只渲染公开 alias（displayName）+ slot/attempt 摘要 + winner/draw。
 */
import { useEffect, useState } from 'react'
import { fetchJson, guardTournamentDetail, type PublicTournamentView } from './api.ts'
import { projectBracketColumns, slotLabel, slotReplayId } from './projection.ts'

export interface BracketViewProps {
  tournamentId: string
  /** 点击某槽位的回放入口。 */
  onOpenReplay?: (matchId: string, replayId?: string) => void
  /** 点击某槽位打开对局看板。 */
  onOpenMatch?: (matchId: string) => void
}

const SLOT_PHASE_COLOR: Record<string, string> = {
  pending: '#889',
  running: '#3ddc84',
  won: '#ffd76e',
  draw: '#ffb347',
  interrupted: '#e05',
}

export function BracketView({ tournamentId, onOpenReplay, onOpenMatch }: BracketViewProps): React.JSX.Element {
  const [tournament, setTournament] = useState<PublicTournamentView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const raw = await fetchJson<unknown>(`/dsh-screeps/tournaments/${tournamentId}`)
        if (alive && raw) {
          const guarded = guardTournamentDetail(raw)
          if (guarded) {
            setTournament(guarded)
            setError(undefined)
          }
        }
      } catch {
        // 失败保留快照
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tournamentId])

  // 从公开视图构造 bracket 投影（slots 已含全部轮次）
  const rounds = projectBracketColumns({
    tournamentId,
    phase: tournament?.phase ?? 'recruiting',
    seats: tournament?.config?.seats ?? 4,
    participants: tournament?.participants ?? [],
    rounds: (tournament?.slots ?? []).reduce<Array<{ round: number; slots: Array<{
      slotId: string; round: number; index: number;
      participants: Array<{ participantId: string; displayName: string }>;
      phase: string; winner?: { participantId: string; displayName: string };
      attempts: Array<{ attempt: number; matchId?: string; replayId?: string; phase: string; winnerParticipantId?: string }>;
      replayId?: string; matchId?: string;
    }> }>>((acc, s) => {
      const round = acc.find(r => r.round === s.round)
      const slotView = {
        slotId: s.slotId,
        round: s.round,
        index: s.index,
        participants: s.participantIds.map(pid => ({
          participantId: pid,
          displayName: tournament?.participants.find(p => p.participantId === pid)?.displayName ?? pid,
        })),
        phase: s.phase,
        winner: s.winnerParticipantId ? {
          participantId: s.winnerParticipantId,
          displayName: tournament?.participants.find(p => p.participantId === s.winnerParticipantId)?.displayName ?? s.winnerParticipantId,
        } : undefined,
        attempts: s.attempts,
        replayId: s.attempts.find(a => a.replayId)?.replayId,
        matchId: s.attempts.find(a => a.matchId)?.matchId,
      }
      if (round) round.slots.push(slotView)
      else acc.push({ round: s.round, slots: [slotView] })
      return acc
    }, []),
    champion: tournament?.championParticipantId ? {
      participantId: tournament.championParticipantId,
      displayName: tournament.participants.find(p => p.participantId === tournament.championParticipantId)?.displayName ?? tournament.championParticipantId,
    } : undefined,
    currentSlotId: tournament?.currentSlotId,
    error: tournament?.error,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 头部：赛事状态 + 冠军 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
        <span style={{ opacity: 0.8 }}>赛事 {tournamentId.slice(-6)}</span>
        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: 'rgba(128,128,128,0.2)' }}>
          {tournament?.phase ?? 'recruiting'}
        </span>
        <span style={{ opacity: 0.7 }}>{tournament?.config?.seats ?? 4} 席</span>
        {tournament?.championParticipantId && (
          <span style={{ color: '#ffd76e', fontWeight: 600 }}>
            🏆 {tournament.participants.find(p => p.participantId === tournament.championParticipantId)?.displayName ?? '—'}
          </span>
        )}
        {tournament?.error && <span style={{ color: '#e05' }}>⚠ {tournament.error}</span>}
      </div>

      {/* 轮次列（HTML 投影，无 SVG 依赖） */}
      {rounds.length === 0 ? (
        <div style={{ fontSize: 12, opacity: 0.7 }}>（赛事尚未配对）</div>
      ) : (
        <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8 }}>
          {rounds.map(col => (
            <div key={col.round} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 220 }}>
              <div style={{ fontWeight: 600, fontSize: 12, opacity: 0.8, textAlign: 'center' }}>
                {col.round === 1 ? '首轮' : `第 ${col.round} 轮`}
              </div>
              {col.slots.map(slot => {
                const replayId = slotReplayId(slot)
                const color = SLOT_PHASE_COLOR[slot.phase] ?? '#889'
                return (
                  <div
                    key={slot.slotId}
                    style={{
                      border: `1px solid ${color}55`,
                      borderRadius: 6,
                      padding: '6px 8px',
                      fontSize: 12,
                      background: 'rgba(128,128,128,0.05)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
                      <span style={{ opacity: 0.7 }}>{slot.slotId}</span>
                      <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 11 }}>{slot.phase}</span>
                    </div>
                    <div style={{ fontWeight: 500 }}>{slotLabel(slot)}</div>
                    {slot.attempts.length > 0 && (
                      <div style={{ fontSize: 11, opacity: 0.6 }}>
                        {slot.attempts.map(a => `${a.attempt === 0 ? '首战' : '重赛'}${a.phase === 'settled' ? ' ✓' : ''}`).join(' · ')}
                      </div>
                    )}
                    {(replayId || slot.matchId) && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        {replayId && onOpenReplay && (
                          <button
                            type="button"
                            onClick={() => onOpenReplay(slot.matchId ?? '', replayId)}
                            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.1)', color: 'inherit' }}
                          >
                            ▶ 回放
                          </button>
                        )}
                        {slot.matchId && onOpenMatch && (
                          <button
                            type="button"
                            onClick={() => onOpenMatch(slot.matchId!)}
                            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.1)', color: 'inherit' }}
                          >
                            看板
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}