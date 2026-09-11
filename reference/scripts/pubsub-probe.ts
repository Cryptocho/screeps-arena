/**
 * pubsub 连通性探针 v2（CLI 回环实验，逐阶段打印，跑：npx tsx scripts/pubsub-probe.ts）
 *
 * 要回答的问题（S13 open P1：screeps_console 捕获不通，pubsubTicks=0）：
 *   A. 回调实参形状：官方 RpcClient 回调到底收到 (channel, data) 还是只有 data？
 *      → CLI 订阅 'probec' 打印 typeof 每个实参。
 *   B. roomsDone 每 tick 发布是否到达后端进程 socket？
 *      → 订阅 'roomsDone'/'tickStarted'，**先 resume（世界默认暂停，不 resume 永不发布）**，数 X 秒。
 *   C. mod 自身的订阅是否生效（pubsubTicks）？
 *      → REST 触发 mod 订阅后，CLI resume，REST consoleOutput 读回 pubsubTicks。
 */
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import ScreepsService from '../src/index.ts'

const serverDir = process.env.DSH_SCREEPS_SERVER_DIR ?? '/tmp/dsh-screeps-server-smoke/server'
const dataRoot = serverDir.replace(/[/\\]server$/, '')
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-screeps-pubsubprobe-'))
mkdirSync(dataDir, { recursive: true })
symlinkSync(dataRoot + '/server', join(dataDir, 'server'), 'dir')
symlinkSync(dataRoot + '/runtime', join(dataDir, 'runtime'), 'dir')

const ctx = new Context()
const fiber = await ctx.plugin(ScreepsService, ScreepsService.Config({
  serverMode: 'managed', dataDir, externalUrl: 'http://127.0.0.1:21025', port: 0,
  nodeVersion: '22', nodeDistMirror: 'https://nodejs.org/dist', tickDuration: 300, readyTimeoutMs: 180_000, agentRecruitTimeoutMs: 180_000,
}))
const svc = ctx.screeps
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

try {
  await svc.ensureRunning()
  const { port } = await svc.ensureRunning()
  const cliPort = port + 1
  // secret 私有属性不走（类型检查），从共享文件读
  const secret = readFileSync(join(dataDir, 'server', '.dsh-arena-secret'), 'utf8').trim()
  console.log('PROBE server ready, cli port', cliPort, 'secret=', secret ? 'yes' : 'NO')

  // ---------- CLI 会话 ----------
  const socket = net.createConnection(cliPort, '127.0.0.1')
  socket.on('error', e => console.error('PROBE cli socket error:', e.message))
  let buffer = ''
  const prints: string[] = []
  socket.on('data', (d: Buffer) => {
    buffer += d.toString()
    for (let line of buffer.split('\n')) {
      const idx = buffer.lastIndexOf('\n')
      if (idx === -1) break
      line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const trimmed = line.replace(/\r$/, '')
      if (trimmed.startsWith('<') || trimmed.startsWith('Screeps') || trimmed.includes('This CLI')) continue
      if (trimmed.trim().length) prints.push(trimmed)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  await sleep(600)
  const send = (expr: string) => new Promise<void>(r => { socket.write(expr + '\n'), r() })
  const drain = () => prints.splice(0).forEach(l => console.log('CLI>', l.slice(0, 300)))

  // ---------- 阶段 A：同进程回环 + 回调实参形状 ----------
  await send(`storage.pubsub.subscribe('probec', function(){ globalThis.PROBE_N=(globalThis.PROBE_N||0)+1; globalThis.PROBE_GOT=[].slice.call(arguments).map(function(a){return [typeof a, String(a).slice(0,80)]}) })`)
  await send(`storage.pubsub.publish('probec', 'hello-same-process')`)
  await send(`storage.pubsub.publish('probec', 'second')`)
  await sleep(2500)
  await send(`JSON.stringify({n: globalThis.PROBE_N, got: globalThis.PROBE_GOT})`)
  await sleep(1200)
  console.log('PROBE-A loopback args:', (prints.splice(0).join(' | ') || '(no values could be read)').slice(0, 500))

  // ---------- 阶段 B：roomsDone / tickStarted，先 resume ----------
  await send(`storage.pubsub.subscribe('tickStarted', function(){ globalThis.PROBE_TICKS=(globalThis.PROBE_TICKS||0)+1 })`)
  await send(`storage.pubsub.subscribe('roomsDone', function(){ globalThis.PROBE_ROOMS=(globalThis.PROBE_ROOMS||0)+1 })`)
  await send(`env.get('mainLoopPaused')`)
  await sleep(800)
  drain()
  await send(`system.resumeSimulation()`)
  await send(`storage.pubsub.publish('probec', 'post-resume')`)
  await sleep(5000)
  await send(`JSON.stringify({ticks: globalThis.PROBE_TICKS, rooms: globalThis.PROBE_ROOMS})`)
  await sleep(800)
  console.log('PROBE-B counts (after 5s resumed):', (prints.length ? prints.splice(0).join(' | ') : '(no values)').slice(0, 400))

  // ---------- 阶段 C：mod 视角 ----------
  // 1) 触发 mod 订阅（首个 arena 路由）→ 2) 生成一个用户 → 3) CLI resume 后读 mod 的 pubsubTicks
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/arena/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-arena-secret': secret } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return res.json()
  }
  await api('world') // trigger ensureRoomStatusOnce → mod 订阅 roomsDone
  const stamp = Date.now() % 100000
  const room = `W${stamp % 6}N${Math.floor(stamp / 6) % 6}`
  await api('rooms', { room, terrainType: 1, sources: 2, mineral: false })
  const user = `probe${stamp}`
  await api('users', { username: user, room, code: { main: 'module.exports.loop = function () {}' } })
  await sleep(800)
  const before = await api('system', { cmd: 'consoleOutput', value: { user } })
  console.log('PROBE-C mod before resume:', JSON.stringify(before))
  await send(`system.resumeSimulation()`)
  await sleep(4500)
  const after = await api('system', { cmd: 'consoleOutput', value: { user } })
  console.log('PROBE-C mod after resume:', JSON.stringify(after))

  // ---------- 阶段 D：用户跑 console.log 代码 → mod ring buffer 线上捕获 ----------
  await svc.submitCode(user, {
    main: 'module.exports.loop = function () { console.log("PROBE_TICK_" + Game.time); Memory.ticks = Game.time }',
  })
  await sleep(6_000) // ~20 ticks @300ms
  const d1 = await svc.consoleOutput(user)
  console.log('PROBE-D console capture after submit:', JSON.stringify(d1).slice(0, 2000))
  // 官方通道执行一个表达式（结果进 console.results，同一 publish 通道）
  const fired = await svc.runConsole(user, '5 + 7')
  console.log('PROBE-D runConsole fired:', fired)
  await sleep(1_500)
  const d2 = await svc.consoleOutput(user)
  console.log('PROBE-D console capture after expression:', JSON.stringify(d2).slice(0, 2000))
  const mem = await svc.readMemoryPath(user)
  console.log('PROBE-D memory probe (ticks written by vm?):', JSON.stringify(mem))
} finally {
  await fiber.dispose()
}
console.log('PROBE done')