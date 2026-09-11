/**
 * S3 启动冒烟：起服 → 健康 → 读 arena world → setTickDuration → 停服。
 * 前置：npm run provision:server 已完成。
 */
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'
import { readArenaSecret } from '../src/runtime/server-installer.ts'
import { launchScreepsServer } from '../src/runtime/server-launcher.ts'

const { values } = parseArgs({
  options: { 'data-dir': { type: 'string', default: '/tmp/dsh-screeps-server-smoke' } },
})
const dataDir = values['data-dir']!
const serverDir = `${dataDir}/server`

const runtime = await ensureNodeRuntime({ runtimeDir: `${dataDir}/runtime`, versionSpec: '22' })
console.log('runtime:', runtime.version)

const server = await launchScreepsServer({
  serverDir,
  runtime,
  onLog: line => console.log(line),
})
console.log('spawned, port =', server.port)

try {
  await server.waitReady()
  console.log('SERVER READY on port', server.port)
  const secret = await readArenaSecret(serverDir)
  const getJson = async (path: string, withSecret = true) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: withSecret && secret ? { 'x-arena-secret': secret } : {},
    })
    const text = await res.text()
    try {
      return { status: res.status, json: JSON.parse(text) as unknown }
    } catch {
      return { status: res.status, text: text.slice(0, 200) }
    }
  }

  // arena world 快照
  console.log('arena world:', JSON.stringify(await getJson('/api/arena/world')))

  // 系统：读 tick 间隔 → 设为 200ms → 读回
  const sys = async (cmd: string, value?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/arena/system`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-arena-secret': secret } : {}) },
      body: JSON.stringify({ cmd, value }),
    })
    const text = await res.text()
    try {
      return { status: res.status, json: JSON.parse(text) as unknown }
    } catch {
      return { status: res.status, text: text.slice(0, 200) }
    }
  }
  console.log('getTickDuration:', JSON.stringify(await sys('getTickDuration')))
  console.log('setTickDuration(200):', JSON.stringify(await sys('setTickDuration', 200)))
  console.log('getTickDuration:', JSON.stringify(await sys('getTickDuration')))

  // 无密钥应被拒（guard 生效证据）
  const noSecret = await fetch(`http://127.0.0.1:${server.port}/api/arena/world`).then(r => r.status)
  console.log('arena world without secret ->', noSecret, '(expect 403)')
} finally {
  await server.stop()
  console.log('stopped cleanly')
}
process.exit(0)
