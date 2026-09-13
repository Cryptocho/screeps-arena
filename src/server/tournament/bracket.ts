/**
 * 锦标赛赛程与积分纯函数（plan-M4/S1，D2/D4）——零 IO / 零时钟，与 pool.ts 同款纪律。
 * 公平边界：本模块只服务 host 侧编排与人类观战面，import 面不含 src/agent/*
 * （验收判据 4 的可执行负向断言）。
 */
import type { Tournament, TournamentMatchResult } from './types.js'

/**
 * round-robin 赛程（circle method，D2）：固定首元素、其余轮转配对。
 * 偶数 n = (n-1) 轮 × n/2 场；奇数补 bye 位（与 bye 配对 = 轮空，不产生场）。
 * 输出为按轮次顺序展开的 pair 平铺序列（确定性：跟随输入顺序）。
 */
export function roundRobinPairs(participants: string[]): Array<[string, string]> {
  if (participants.length < 2) return []
  const ids = [...participants]
  const hasBye = ids.length % 2 === 1
  if (hasBye) ids.push('\0bye')
  const rounds = ids.length - 1
  const half = ids.length / 2
  const fixed = ids[0]
  const rest = ids.slice(1)
  const pairs: Array<[string, string]> = []
  for (let r = 0; r < rounds; r++) {
    const ring = [fixed, ...rest]
    for (let i = 0; i < half; i++) {
      const a = ring[i]
      const b = ring[ring.length - 1 - i]
      if (a === '\0bye' || b === '\0bye') continue
      // 主客交替：偶数轮 a 在前，奇数轮对调，避免固定席位长期坐庄
      pairs.push(r % 2 === 0 ? [a as string, b as string] : [b as string, a as string])
    }
    // 轮转：fixed 不动，rest 左移一位
    rest.push(rest.shift() as string)
  }
  return pairs
}

/** 榜级 tiebreak（D4 写死单序）：积分 → 胜场数 → 净胜分 → 抽签序（participants 下标）。 */
export interface StandingRow {
  seatId: string
  username: string
  played: number
  wins: number
  draws: number
  losses: number
  /** 胜 3 / 平 1 / 负 0。 */
  points: number
  /** 净胜分 = 得分 − 失分（对局内 score 差值累计；draw 记 0）。 */
  scoreDiff: number
}

/** 结果回填（D4）：按 matchId 幂等，非 settled 条目（scheduled/created）不计分。
 *  winner 合法性写入时校验（fail fast），不留给派生层。 */
export function applyResult(
  t: Tournament,
  matchId: string,
  result: TournamentMatchResult,
): void {
  const m = t.matches.find((x) => x.matchId === matchId && x.status !== 'scheduled')
  if (!m) throw new Error(`tournament ${t.id}: unknown match ${matchId}`)
  if (m.status === 'settled') return
  if (result.winner !== null && !m.pair.includes(result.winner)) {
    throw new Error(`tournament ${t.id}: match winner ${result.winner} not in pair`)
  }
  m.status = 'settled'
  m.result = result
}

/** 积分榜（D4）：纯派生，跳过未 settle 条目；排序 = 积分 → 胜场数 → 净胜分 → 抽签序。 */
export function standings(t: Tournament): StandingRow[] {
  const rows = new Map<string, StandingRow>()
  t.participants.forEach((p, i) => {
    rows.set(p.seatId, { seatId: p.seatId, username: p.username, played: 0, wins: 0, draws: 0, losses: 0, points: 0, scoreDiff: 0 })
  })
  for (const m of t.matches) {
    if (m.status !== 'settled' || !m.result) continue
    const [a, b] = m.pair
    const ra = rows.get(a)
    const rb = rows.get(b)
    if (!ra || !rb) throw new Error(`tournament ${t.id}: match pair references unknown participant`)
    const { winner, scores } = m.result
    const sa = scores[a] ?? 0
    const sb = scores[b] ?? 0
    ra.played++
    rb.played++
    ra.scoreDiff += sa - sb
    rb.scoreDiff += sb - sa
    if (winner === null) {
      ra.draws++
      rb.draws++
      ra.points += 1
      rb.points += 1
    } else if (winner === a) {
      ra.wins++
      rb.losses++
      ra.points += 3
    } else if (winner === b) {
      rb.wins++
      ra.losses++
      rb.points += 3
    } else {
      // 写入时已校验（applyResult）；防御性保留
      throw new Error(`tournament ${t.id}: match winner ${winner} not in pair`)
    }
  }
  return [...rows.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.wins - x.wins ||
      y.scoreDiff - x.scoreDiff ||
      t.participants.findIndex((p) => p.seatId === x.seatId) - t.participants.findIndex((p) => p.seatId === y.seatId),
  )
}
