/**
 * M2/S5 interrupted 恢复单测——journal 落盘/扫描 + MatchMachine.restore 闭环。
 * 装置纪律（m0-flake §四）：per-test mkdtemp 独立目录。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MatchJournal } from '../src/server/match/journal.js'
import type { MatchJournalRecord } from '../src/server/match/journal.js'
import { MatchMachine } from '../src/server/match/machine.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

function newJournal(): MatchJournal {
  const dir = mkdtempSync(join(tmpdir(), 'screeps-arena-journal-'))
  dirs.push(dir)
  return new MatchJournal(join(dir, 'journal', 'matches'))
}

function record(overrides: Partial<MatchJournalRecord> = {}): MatchJournalRecord {
  return {
    id: 'mtest1',
    config: { seats: 2, roundMs: 60_000, roundBreakTimeoutMs: 300_000, maxRounds: 8 },
    players: [
      { seatId: 'a', username: 'ua', ready: false, code: { main: 'module.exports.loop=function(){}' } },
      { seatId: 'b', username: 'ub', ready: false },
    ],
    seatUsers: { a: 'agent_x1', b: 'agent_y2' },
    rooms: { a: 'E5N5', b: 'E7N5' },
    state: { createdAt: 1, phase: 'running', roundIndex: 0, roundStartedAt: 100, errors: [] },
    ...overrides,
  }
}

describe('MatchJournal（M2/S5）', () => {
  it('save/list roundtrip：players 全量（含 code）+ seatUsers + rooms', () => {
    const j = newJournal()
    j.save(record())
    const list = j.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.players[0]!.code).toEqual({ main: 'module.exports.loop=function(){}' })
    expect(list[0]!.seatUsers).toEqual({ a: 'agent_x1', b: 'agent_y2' })
    expect(list[0]!.rooms).toEqual({ a: 'E5N5', b: 'E7N5' })
  })

  it('原子写：save 后无 .tmp 残留', () => {
    const j = newJournal()
    j.save(record())
    expect(existsSync(join(j.path('mtest1'), '../mtest1.json.tmp'))).toBe(false)
  })

  it('损坏条目跳过（部分写不拖垮扫描）', () => {
    const j = newJournal()
    j.save(record())
    writeFileSync(join(j.path('mbroken')), '{broken json')
    j.save(record({ id: 'mtest2' }))
    const list = j.list()
    expect(list.map((r) => r.id).sort()).toEqual(['mtest1', 'mtest2'])
  })

  it('remove：settled 清理', () => {
    const j = newJournal()
    j.save(record())
    expect(j.list()).toHaveLength(1)
    j.remove('mtest1')
    expect(j.list()).toHaveLength(0)
  })
})

describe('MatchMachine.restore（M2/S5）', () => {
  it('灌回 code/ready/state 元数据；roundBreakSinceResetTo 生效 → 兜底续跑正常', () => {
    const m = MatchMachine.restore({
      id: 'mtest1',
      config: record().config,
      players: record().players,
      state: { ...record().state, phase: 'roundBreak', roundIndex: 0, roundBreakSince: 1 },
      roundBreakSinceResetTo: 999,
      onEvent: () => {},
    })
    expect(m.id).toBe('mtest1')
    expect(m.phase).toBe('roundBreak')
    expect(m.players[0]!.code).toEqual({ main: 'module.exports.loop=function(){}' })
    expect(m.state.roundBreakSince).toBe(999)
    // 恢复后周期边界语义完整：回拨超时窗口（timeoutMs=300s）→ advance 兑底续跑（沿用 code）
    m.state.roundBreakSince = Date.now() - 301_000
    m.advance()
    expect(m.phase).toBe('running')
    expect(m.state.roundIndex).toBe(1)
  })

  it('恢复局提交续跑：roundBreak 期 submit → resume 进入下一轮', () => {
    const m = MatchMachine.restore({
      id: 'm2',
      config: record().config,
      players: record().players,
      state: { ...record().state, phase: 'roundBreak', roundIndex: 0, roundBreakSince: Date.now() },
      onEvent: () => {},
    })
    m.submitCode('a', { main: 'module.exports.loop=function(){/*r1*/}' })
    m.submitCode('b', { main: 'module.exports.loop=function(){/*r1*/}' })
    m.advance()
    expect(m.phase).toBe('running')
    expect(m.players[0]!.code!.main).toContain('r1')
  })

  it('不触发事件（恢复路径静默）', () => {
    const events: string[] = []
    MatchMachine.restore({
      id: 'm3',
      config: record().config,
      players: record().players,
      state: record().state,
      onEvent: (e) => events.push(e.type),
    })
    expect(events).toEqual([])
  })
})
