/**
 * M4-E.3 — replay player：只消费 canonical JSON（host 公开桥），分页/播放暂停/seek/
 * live/complete/partial/gap banner。不声称 raw sockjs（plan §7.2）。
 *
 * 数据源：GET /dsh-screeps/matches/:id/replay?cursor=&limit=&afterTick=
 * 播放器状态：cursor 页游标 + 播放 tick 指针；seek 用 afterTick 参数。
 */
import { useEffect, useRef, useState } from 'react'
import { fetchJson, guardReplayPage, type PublicReplayPage } from './api.ts'
import { projectReplayTimeline, seekSeq, type ReplayTimeline } from './projection.ts'

const PAGE_SIZE = 200

export interface ReplayPlayerProps {
  matchId: string
  /** 初始播放速度（帧/秒）。 */
  fps?: number
}

export function ReplayPlayer({ matchId, fps = 2 }: ReplayPlayerProps): React.JSX.Element {
  const [page, setPage] = useState<PublicReplayPage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [playing, setPlaying] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [playIdx, setPlayIdx] = useState(0) // 当前播放帧下标（timeline.frames 内）
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const inFlight = useRef(false)
  const playTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const timeline: ReplayTimeline = page ? projectReplayTimeline(page) : { frames: [], gaps: [], complete: false }

  // 拉取一页（cursor 推进）
  const loadPage = async (fromCursor: number): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setLoadingMore(true)
    try {
      const q = new URLSearchParams({ cursor: String(fromCursor), limit: String(PAGE_SIZE) })
      const raw = await fetchJson<unknown>(`/dsh-screeps/matches/${matchId}/replay?${q.toString()}`)
      const guarded = guardReplayPage(raw)
      if (!guarded) {
        setError('回放数据不可用')
        return
      }
      if (guarded.unavailable) {
        setError(guarded.reason ?? '该对局没有回放')
        setLoaded(true)
        return
      }
      setPage(prev => {
        // 合并：同 cursor 幂等；新页追加（按 seq 去重）
        if (!prev) return guarded
        const seen = new Set(prev.records.map(r => r.seq))
        const merged = [...prev.records, ...guarded.records.filter(r => !seen.has(r.seq))]
        return { ...guarded, records: merged, nextCursor: guarded.nextCursor }
      })
      setCursor(guarded.nextCursor)
      setError(undefined)
      setLoaded(true)
    } catch {
      setError('回放加载失败')
    } finally {
      inFlight.current = false
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    setPage(undefined)
    setCursor(0)
    setPlayIdx(0)
    setLoaded(false)
    setError(undefined)
    void loadPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId])

  // 播放/暂停
  useEffect(() => {
    if (!playing) {
      if (playTimer.current) {
        clearInterval(playTimer.current)
        playTimer.current = undefined
      }
      return
    }
    playTimer.current = setInterval(() => {
      setPlayIdx(i => {
        const next = i + 1
        if (timeline.frames.length === 0) return i
        if (next >= timeline.frames.length) {
          // 播完：若还有更多页则加载；否则暂停
          if (cursor > 0 && !timeline.complete) {
            void loadPage(cursor)
            return i
          }
          setPlaying(false)
          return i
        }
        return next
      })
    }, Math.max(50, Math.round(1000 / fps)))
    return () => {
      if (playTimer.current) clearInterval(playTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, cursor, timeline.complete, fps])

  const currentFrame = timeline.frames[playIdx]
  const currentTick = currentFrame?.gameTime

  const seekTo = (afterTick: number): void => {
    const seq = seekSeq(timeline.frames, afterTick)
    if (seq === undefined) {
      // 目标 tick 超出已加载范围：尝试 afterTick 参数拉取
      void (async () => {
        const q = new URLSearchParams({ afterTick: String(afterTick), limit: String(PAGE_SIZE) })
        const raw = await fetchJson<unknown>(`/dsh-screeps/matches/${matchId}/replay?${q.toString()}`)
        const guarded = guardReplayPage(raw)
        if (!guarded || guarded.unavailable) return
        setPage(guarded)
        setCursor(guarded.nextCursor)
        setPlayIdx(0)
      })()
      return
    }
    setPlayIdx(Math.max(0, seq))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 状态 banner */}
      {page && !page.unavailable && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
          <span style={{ opacity: 0.7 }}>
            {page.status === 'complete' ? '✓ 完整回放' : page.status === 'partial' ? '⚠ 部分回放（有缺口）' : '● 实时回放'}
          </span>
          {page.gapReasons.length > 0 && (
            <span style={{ color: '#ffb347' }} title={page.gapReasons.join(', ')}>
              缺口: {page.gapReasons.join(', ')}
            </span>
          )}
          {timeline.tickRange && (
            <span style={{ opacity: 0.7 }}>
              tick {timeline.tickRange.from}–{timeline.tickRange.to}
            </span>
          )}
          <span style={{ opacity: 0.6 }}>帧 {timeline.frames.length}</span>
          {!timeline.complete && <span style={{ opacity: 0.6 }}>（未完）</span>}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: '#e05' }}>{error}</div>}

      {/* 播放控制 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={!loaded || timeline.frames.length === 0}
          onClick={() => setPlaying(p => !p)}
          style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.12)', color: 'inherit' }}
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button
          type="button"
          disabled={!loaded || timeline.frames.length === 0}
          onClick={() => { setPlayIdx(0); setPlaying(false) }}
          style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.12)', color: 'inherit' }}
        >
          ⏮ 开头
        </button>
        <input
          type="range"
          min={timeline.tickRange?.from ?? 0}
          max={timeline.tickRange?.to ?? 0}
          value={currentTick ?? 0}
          onChange={e => seekTo(Number(e.target.value))}
          disabled={!loaded || timeline.frames.length === 0}
          style={{ flex: 1, minWidth: 120 }}
          aria-label="回放进度"
        />
        <span style={{ fontSize: 12, opacity: 0.7 }}>tick {currentTick ?? '—'}</span>
        {loadingMore && <span style={{ fontSize: 11, opacity: 0.6 }}>加载中…</span>}
      </div>

      {/* gap 提示 */}
      {timeline.gaps.length > 0 && (
        <div style={{ fontSize: 11, color: '#ffb347', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {timeline.gaps.map((g, i) => (
            <span key={i}>⚠ tick {g.fromTick}–{g.toTick} 缺失{g.reason ? `（${g.reason}）` : ''}</span>
          ))}
        </div>
      )}

      {/* 当前帧内容（公开投影：房间归属 + 事件摘要） */}
      {currentFrame && (
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>tick {currentFrame.gameTime} · seq {currentFrame.seq}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflow: 'auto' }}>
            {currentFrame.frameSummary?.rooms.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <span style={{ opacity: 0.7 }}>{r.room}</span>
                <span>{r.owner ? `🏳 ${r.owner}` : '中立'}</span>
                <span style={{ opacity: 0.6 }}>objects {r.objectCount}</span>
              </div>
            ))}
            {currentFrame.frameSummary && currentFrame.frameSummary.eventCount > 0 && (
              <div style={{ opacity: 0.7 }}>事件 {currentFrame.frameSummary.eventCount} 条</div>
            )}
          </div>
        </div>
      )}
      {loaded && timeline.frames.length === 0 && !error && (
        <div style={{ fontSize: 12, opacity: 0.7 }}>（回放暂无帧）</div>
      )}
    </div>
  )
}