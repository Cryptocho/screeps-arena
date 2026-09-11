/**
 * seatId → 文件名/用户名安全 slug（M2/S7，席位目录名碰撞加固）。
 *
 * 旧实现 `seatId.replace(/[^A-Za-z0-9_-]/g,'_')` 纯 sanitize：`a:b` 与 `a_b` 同映射
 * → AgentRunner 工作目录与 agent username 双双碰撞。这里追加 seatId 的 sha1 前 8 位
 * （hash 输入是原始 seatId，不是 sanitize 结果），仅特殊字符不同的 seatId 必然不同 slug。
 * sanitize 段截断 ≤16、hash 8 位、无分隔符 → 总长 ≤24；`agent_` 前缀后 = 30，
 * 贴合 30 字符用户名惯例上限（mod realCreateUser 无硬校验，此为自约束）。
 * 同串必同 slug（幂等）。
 */
import { createHash } from 'node:crypto'

export function seatSlug(seatId: string): string {
  const sanitized = seatId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16)
  const hash = createHash('sha1').update(seatId).digest('hex').slice(0, 8)
  return `${sanitized}${hash}`
}
