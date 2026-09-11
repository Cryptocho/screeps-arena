/**
 * 持久化共享 IO（M4-B）—— 临时文件 + fsync + 原子发布（rename），tmp 名带随机后缀
 * （同一进程内并发写不共用 tmp，见 src/host/match/store.ts 文件头注释的 M3 实证）。
 * 单 host 单 writer 假设：跨进程并发不在承诺范围（AGENTS.md 持久化节）。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

/** 原子写 JSON 文件（自动建目录）。 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const json = JSON.stringify(value)
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(json, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, filePath)
}

/** 读 JSON；文件不存在返回 null；存在但不可解析抛错（corrupt 诊断面）。 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    throw new Error(`unreadable JSON at ${filePath}: ${(err as Error).message}`)
  }
}
