/**
 * S1 手动 CLI：准备便携 Node 运行时并打印结果。
 * 用法：
 *   npm run provision -- --data-dir /tmp/dsh-screeps-data [--node-version 22] [--mirror URL] [--external-node /path/node]
 */
import { mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ensureNodeRuntime } from '../src/runtime/node-runtime.ts'

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    'node-version': { type: 'string' },
    mirror: { type: 'string' },
    'external-node': { type: 'string' },
  },
})

const dataDir = values['data-dir']
if (!dataDir) {
  console.error('--data-dir is required')
  process.exit(2)
}
mkdirSync(dataDir, { recursive: true })

try {
  const runtime = await ensureNodeRuntime({
    runtimeDir: `${dataDir}/runtime`,
    versionSpec: values['node-version'],
    distMirror: values.mirror,
    externalNodeBin: values['external-node'],
  })
  console.log(JSON.stringify(runtime, null, 2))
} catch (err) {
  console.error('provision failed:', err)
  process.exit(1)
}
