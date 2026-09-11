/**
 * M4-E.4 — leaderboard 视图：稳定排序历史积分榜（plan §7.2）。
 *
 * 数据源：GET /dsh-screeps/history/leaderboard?tournamentId=&limit=（host 已剥离 sessionId）。
 * 纯投影：participantId/displayName 公开 DTO，稳定 rank/tie。
 */
import { useEffect, useState } from 'react'
import { fetchJson, guardLeaderboard, type PublicLeaderboardPage } from './api.ts'
import { projectLeaderboard } from './projection.ts'

export interface LeaderboardProps {
  /** 可选：只看某赛事的积分榜。 */
  tournamentId?: string
  limit?: number
}

export function Leaderboard({ tournamentId, limit = 50 }: LeaderboardProps): React.JSX.Element {
  const [page, setPage] = useState<PublicLeaderboardPage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const q = new URLSearchParams()
        if (tournamentId) q.set('tournamentId', tournamentId)
        q.set('limit', String(limit))
        const raw = await fetchJson<unknown>(`/dsh-screeps/history/leaderboard?${q.toString()}`)
        if (alive && raw) {
          const guarded = guardLeaderboard(raw)
          if (guarded) {
            setPage(guarded)
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
    const timer = setInterval(() => void tick(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tournamentId, limit])

  const view = page ? projectLeaderboard(page) : undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ fontWeight: 600 }}>🏆 历史积分榜</span>
        {tournamentId && <span style={{ opacity: 0.6 }}>赛事 {tournamentId.slice(-6)}</span>}
        {view?.hasMore && <span style={{ opacity: 0.6 }}>（仅显示前 {limit} 名）</span>}
        {error && <span style={{ color: '#e05' }}>⚠ {error}</span>}
      </div>
      {!view || view.rows.length === 0 ? (
        <div style={{ fontSize: 12, opacity: 0.7 }}>（暂无对局记录）</div>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'left' }}>#</th>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'left' }}>选手</th>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>胜</th>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>负</th>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>平</th>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>场次</th>
              <th style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px' }}>总分</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map(r => (
              <tr key={r.participantId}>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', opacity: 0.7 }}>{r.rank}</td>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', fontWeight: 500 }}>{r.displayName}</td>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'center' }}>{r.wins}</td>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'center' }}>{r.losses}</td>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'center' }}>{r.draws}</td>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'center' }}>{r.matches}</td>
                <td style={{ border: '1px solid rgba(128,128,128,0.2)', padding: '4px 8px', textAlign: 'center', fontWeight: 600 }}>{r.scoreTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}