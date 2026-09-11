/**
 * S2 真实安装冒烟脚本：便携 Node + npm install screeps + 原生编译 + 产物校验。
 * 用法：npm run provision:server -- --data-dir /tmp/xxx
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'
import { ensureScreepsServer } from '../src/runtime/server-installer.ts'

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: '/tmp/dsh-screeps-server-smoke' },
    'node-version': { type: 'string' },
  },
})

const dataDir = values['data-dir']!
mkdirSync(dataDir, { recursive: true })

const runtime = await ensureNodeRuntime({ runtimeDir: `${dataDir}/runtime`, versionSpec: values['node-version'] ?? '22' })
console.log('runtime ready:', runtime.version, runtime.nodeBin)

// 随包分发的真实 arena mod（每次重写进 server dir）
const arenaModContent = readFileSync(new URL('../screeps-mod/arena-mod.cjs', import.meta.url), 'utf8')

const result = await ensureScreepsServer({
  serverDir: `${dataDir}/server`,
  runtime,
  mods: [{ name: 'arena-mod.cjs', content: arenaModContent }],
  onLog: line => console.log(line),
})
console.log('install result:', JSON.stringify({ ...result, artifacts: result.artifacts.length + ' files' }, null, 2))
