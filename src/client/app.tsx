/**
 * SPA 主组件（M1/S5）——大厅 + 对局详情（状态/玩家榜/console 流）+ 地图 canvas。
 * 状态管理最小化：fetch + WS 订阅，不引状态库。
 */
import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import type { MatchView, WorldSnapshot } from '../shared/types.js'
import { createMatch, fetchHistory, fetchMatch, fetchMatches, fetchTerrain, fetchTournaments, fetchWorld, settleMatch, startMatch, subscribeConsole, subscribeMatch } from './api.js'
import type { HistoryView, TournamentView } from './api.js'
import { TerrainCanvas } from './terrain-canvas.js'

type Tab = 'lobby' | 'match'

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('lobby')
  const [matches, setMatches] = useState<MatchView[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setMatches(await fetchMatches())
      setError(null)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [refresh])

  return (
    <div style={{ fontFamily: 'monospace', color: '#c8d0e0', background: '#11131a', minHeight: '100vh', padding: 16 }}>
      <h1 style={{ fontSize: 18 }}>Screeps Arena</h1>
      <nav style={{ marginBottom: 12 }}>
        <button onClick={() => setTab('lobby')} disabled={tab === 'lobby'}>大厅</button>{' '}
        {currentId && <button onClick={() => setTab('match')} disabled={tab === 'match'}>对局 {currentId}</button>}
      </nav>
      {error && <p style={{ color: '#e07070' }}>{error}</p>}
      {tab === 'lobby' ? (
        <Lobby matches={matches} onOpen={(id) => { setCurrentId(id); setTab('match') }} onChanged={refresh} />
      ) : (
        <MatchDetail id={currentId!} />
      )}
    </div>
  )
}

function Lobby(props: {
  matches: MatchView[]
  onOpen: (id: string) => void
  onChanged: () => void
}): React.ReactElement {
  const [seatA, setSeatA] = useState('seat-a')
  const [seatB, setSeatB] = useState('seat-b')
  const [roundMs, setRoundMs] = useState(60_000)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // start/settle 失败必须显式反馈（否则静默 unhandled rejection，用户点了没反应）
  const runAction = async (fn: () => Promise<void>) => {
    try {
      setActionError(null)
      await fn()
    } catch (err) {
      setActionError(String(err instanceof Error ? err.message : err))
    } finally {
      props.onChanged()
    }
  }
  return (
    <div>
      <fieldset style={{ marginBottom: 16 }}>
        <legend>创建对局（2 席位 world-rounds）</legend>
        <label>席位A <input value={seatA} onChange={(e) => setSeatA(e.target.value)} /></label>{' '}
        <label>席位B <input value={seatB} onChange={(e) => setSeatB(e.target.value)} /></label>{' '}
        <label>周期ms <input type="number" value={roundMs} onChange={(e) => setRoundMs(Number(e.target.value))} /></label>{' '}
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await createMatch({ players: [{ seatId: seatA, username: seatA }, { seatId: seatB, username: seatB }], config: { roundMs } })
              props.onChanged()
            } finally {
              setBusy(false)
            }
          }}
        >
          创建
        </button>
      </fieldset>
      {actionError && <p style={{ color: '#e07070' }}>{actionError}</p>}
      <table cellPadding={4}>
        <thead>
          <tr><th>id</th><th>phase</th><th>form</th><th>round</th><th>players</th><th>winner</th><th></th></tr>
        </thead>
        <tbody>
          {props.matches.map((m) => (
            <tr key={m.id}>
              <td>{m.id}</td>
              <td>{m.phase}</td>
              <td>{m.config.form}</td>
              <td>{m.roundIndex}</td>
              <td>{m.players.map((p) => `${p.username}${p.ready ? '✓' : '…'}`).join(' vs ')}</td>
              <td>{m.winner?.kind === 'draw' ? 'draw' : m.winner?.kind === 'seat' ? m.winner.seatId : ''}</td>
              <td>
                <button onClick={() => props.onOpen(m.id)}>查看</button>{' '}
                {m.phase === 'creating' && <button onClick={() => void runAction(() => startMatch(m.id))}>start</button>}
                {m.phase !== 'settled' && <button onClick={() => void runAction(() => settleMatch(m.id))}>settle</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <MatchHistoryList />
      <TournamentList />
    </div>
  )
}

/** 锦标赛（M4/D6）：编排列表 + 积分榜（HTTP 轮询 5s，与历史同款；样式收尾延后）。 */
function TournamentList(): React.ReactElement {
  const [tournaments, setTournaments] = useState<TournamentView[]>([])
  useEffect(() => {
    const load = async () => {
      try {
        setTournaments(await fetchTournaments())
      } catch {
        /* 锦标赛是冷数据，拉取失败不打扰大厅 */
      }
    }
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [])
  if (tournaments.length === 0) return <></>
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 13 }}>锦标赛</h3>
      {tournaments.map((t) => (
        <div key={t.id} style={{ marginBottom: 12 }}>
          <div>
            <b>{t.name}</b> <small>{t.id} · {t.format} · {t.matches.filter((m) => m.status === 'settled').length}/{t.matches.length} 场{t.finishedAt ? ' · 已结束' : ''}</small>
          </div>
          <table cellPadding={4}>
            <thead>
              <tr><th>选手</th><th>赛</th><th>胜</th><th>平</th><th>负</th><th>积分</th><th>净胜</th></tr>
            </thead>
            <tbody>
              {t.standings.map((r) => (
                <tr key={r.seatId}>
                  <td>{r.username}</td>
                  <td>{r.played}</td>
                  <td>{r.wins}</td>
                  <td>{r.draws}</td>
                  <td>{r.losses}</td>
                  <td><b>{r.points}</b></td>
                  <td>{r.scoreDiff > 0 ? `+${r.scoreDiff}` : r.scoreDiff}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {t.errors.length > 0 && <small style={{ color: '#b00' }}>errors: {t.errors.join('; ')}</small>}
        </div>
      ))}
    </div>
  )
}

/** 对局历史（M3/S4）：settle 后的记账列表（journal 语义不含已完结局，此表全量）。 */
function MatchHistoryList(): React.ReactElement {
  const [history, setHistory] = useState<HistoryView[]>([])
  useEffect(() => {
    const load = async () => {
      try {
        setHistory(await fetchHistory())
      } catch {
        /* 历史是冷数据，拉取失败不打扰大厅 */
      }
    }
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [])
  if (history.length === 0) return <></>
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 13 }}>历史对局</h3>
      <table cellPadding={4}>
        <thead>
          <tr><th>id</th><th>round</th><th>winner</th><th>reason</th><th>scores</th><th>ended</th><th>teardown</th></tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{h.id}</td>
              <td>{h.roundIndex}</td>
              <td>{h.winner?.kind === 'draw' ? 'draw' : h.winner?.kind === 'seat' ? h.winner.seatId : ''}</td>
              <td>{h.settleReason ?? ''}</td>
              <td>{h.scores ? Object.entries(h.scores).map(([k, v]) => `${k}:${v}`).join(' ') : '—'}</td>
              <td>{h.settledAt ? new Date(h.settledAt).toLocaleString() : ''}</td>
              <td>{h.teardown}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MatchDetail(props: { id: string }): React.ReactElement {
  const [match, setMatch] = useState<MatchView | null>(null)
  const [world, setWorld] = useState<WorldSnapshot | null>(null)
  const [terrain, setTerrain] = useState<Record<string, string>>({})
  const [consoleTab, setConsoleTab] = useState<string | null>(null)
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const m = await fetchMatch(props.id)
        if (!alive) return
        setMatch(m)
        const w = await fetchWorld()
        if (!alive) return
        setWorld(w)
        const rooms = [...new Set(w.users.flatMap((u) => u.rooms.map((r) => r.room)))]
        if (rooms.length > 0) setTerrain(await fetchTerrain(rooms))
        setError(null)
      } catch (err) {
        if (alive) setError(String(err instanceof Error ? err.message : err))
      }
    }
    void load()
    const t = setInterval(() => void load(), 3000)
    const unsub = subscribeMatch(props.id, (msg) => {
      if (msg.type === 'match_state') void load()
    })
    return () => {
      alive = false
      clearInterval(t)
      unsub()
    }
  }, [props.id])

  // console 流：WS 订阅增量（M2/S2 替换 2s 轮询），累积展示（上限 500 行）
  useEffect(() => {
    if (!consoleTab) return
    setConsoleLines([])
    const unsub = subscribeConsole(props.id, consoleTab, (msg) => {
      if (msg.bound) setConsoleLines((prev) => [...prev, ...msg.lines].slice(-500))
    })
    return unsub
  }, [consoleTab, props.id])

  if (error) return <p style={{ color: '#e07070' }}>{error}</p>
  if (!match) return <p>loading…</p>
  const rooms = [...new Set(world?.users.flatMap((u) => u.rooms.map((r) => r.room)) ?? [])]
  return (
    <div>
      <h2 style={{ fontSize: 15 }}>
        {match.id} · {match.phase} · round {match.roundIndex}
        {match.winner?.kind === 'draw' && ' · draw'}
        {match.winner?.kind === 'seat' && ` · winner ${match.winner.seatId}`}
      </h2>
      <table cellPadding={4} style={{ marginBottom: 12 }}>
        <thead>
          <tr><th>seat</th><th>username</th><th>ready</th><th>code</th><th>score</th><th>rooms</th><th>rcl</th><th>spawns</th><th>creeps</th></tr>
        </thead>
        <tbody>
          {match.players.map((p) => {
            const u = world?.users.find((x) => x.username === p.username)
            return (
              <tr key={p.seatId}>
                <td>{p.seatId}</td>
                <td>{p.username}</td>
                <td>{p.ready ? '✓' : '…'}</td>
                <td>{p.hasCode ? '✓' : '—'}</td>
                <td>{match.scores?.[p.seatId] ?? '—'}</td>
                <td>{u?.ownedRooms ?? 0}</td>
                <td>{u?.rclTotal ?? 0}</td>
                <td>{u?.spawns ?? 0}</td>
                <td>{u?.creeps ?? 0}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {rooms.length > 0 && <TerrainCanvas terrain={terrain} rooms={rooms} world={world} />}
      <div style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 13 }}>console</h3>
        <nav>
          {match.players.map((p) => (
            <button key={p.seatId} onClick={() => setConsoleTab(p.seatId)} disabled={consoleTab === p.seatId}>
              {p.username}
            </button>
          ))}
        </nav>
        {consoleTab && (
          <pre style={{ background: '#0a0c12', padding: 8, maxHeight: 240, overflow: 'auto' }}>
            {consoleLines.length > 0 ? consoleLines.join('\n') : '(no output)'}
          </pre>
        )}
      </div>
      {match.errors.length > 0 && (
        <div style={{ marginTop: 8, color: '#e0a070' }}>
          <h3 style={{ fontSize: 13 }}>errors</h3>
          <pre>{match.errors.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
