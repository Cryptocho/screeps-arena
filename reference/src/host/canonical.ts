/**
 * canonical hash v1（M4-B）—— 本插件所有外部 receipt / settle candidate / MatchResult /
 * replay meta / tournament request 哈希的唯一算法（plan-M4 §3.2/§4.1）。
 *
 * hashVersion=1 契约（不可偏离，测试钉死）：
 *   - 递归对象键按 UTF-16 字典序排序；
 *   - 数组保持元素顺序；
 *   - 字符串按 UTF-8 原样编码（输出经 JSON.stringify，含标准转义）；
 *   - 数字必须是有限整数或有限 IEEE-754 数值的 JSON 表示；拒绝 NaN / Infinity / -0；
 *   - 不省略 null / 空数组 / 空对象；
 *   - 只接受 plain object / array / string / finite number / boolean / null：
 *     undefined、function、symbol、bigint、Date、Map、循环引用、非 plain 对象一律拒绝
 *     （调用方必须显式省略可选键，而不是塞 undefined——错误信息会点明）；
 *   - 根值以 canonical JSON 文本序列化后取 SHA-256 hex。
 */
import { createHash } from 'node:crypto'

export const HASH_VERSION = 1

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalError'
  }
}

function write(value: unknown, out: string[], ancestors: Set<object>): void {
  if (value === null) {
    out.push('null')
    return
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value))
      return
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalError(`hashV1: non-finite number ${String(value)} is not canonical`)
      }
      if (Object.is(value, -0)) {
        throw new CanonicalError('hashV1: -0 is not canonical (use 0)')
      }
      // JSON.stringify(number) 是 IEEE-754 数值的标准 JSON 表示（1e21 → "1e+21"）
      out.push(JSON.stringify(value))
      return
    }
    case 'object': {
      if (Array.isArray(value)) {
        if (ancestors.has(value)) throw new CanonicalError('hashV1: circular reference is not canonical')
        ancestors.add(value)
        out.push('[')
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(',')
          const item = value[i]
          if (item === undefined) {
            throw new CanonicalError(`hashV1: array item ${i} is undefined; omit it instead`)
          }
          write(item, out, ancestors)
        }
        out.push(']')
        ancestors.delete(value)
        return
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalError(
          `hashV1: non-plain object (${Object.prototype.toString.call(value)}) is not canonical`,
        )
      }
      if (ancestors.has(value)) throw new CanonicalError('hashV1: circular reference is not canonical')
      ancestors.add(value)
      const keys = Object.keys(value as Record<string, unknown>).sort() // 默认 sort = UTF-16 code unit 字典序
      out.push('{')
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!
        const item = (value as Record<string, unknown>)[key]
        if (item === undefined) {
          throw new CanonicalError(`hashV1: property "${key}" is undefined; omit the key instead`)
        }
        if (i > 0) out.push(',')
        out.push(JSON.stringify(key))
        out.push(':')
        write(item, out, ancestors)
      }
      out.push('}')
      ancestors.delete(value)
      return
    }
    default:
      throw new CanonicalError(`hashV1: value of type ${typeof value} is not canonical`)
  }
}

/** 把任意 JSON-safe 值序列化为 canonical JSON 文本（供 hash 或 requestConfigHash 复算）。 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalError('hashV1: root value must not be undefined')
  }
  const out: string[] = []
  write(value, out, new Set())
  return out.join('')
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** hashVersion=1：canonical JSON → SHA-256 hex。 */
export function hashV1(value: unknown): string {
  return sha256Hex(canonicalize(value))
}
