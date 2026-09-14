/**
 * M1 开发服务器：HTTP 桥 + 对局驱动器（真实接线）+ mock world。
 *
 * 最小形态：内存 mock ArenaBackend + 无 LLM 唤醒（waker 缺席）——前端可观察
 * 基础功能（创建/start/settle/roundBreak 时钟推进/console/terrain）。
 * 传入 OPENROUTER_API_KEY 时挂真实 AgentRunner 唤醒。
 *
 * 真实私服接线由 test:live / M2 CLI 子命令提供。
 */
import { MatchDriver } from '../src/server/http/driver.js'
import type { SeatWaker } from '../src/server/http/driver.js'
import { startHttpServer } from '../src/server/http/server.js'
import { createArenaDevServices } from '../src/server/http/dev-services.js'
import { AgentRunner } from '../src/agent/runner.js'
import type { AgentProviderConfig } from '../src/agent/runner.js'
import { MemoryArena } from '../src/agent/memory-backend.js'
import { buildSeatTools } from '../src/agent/tools.js'

const PORT = Number(process.env.PORT ?? 8787)
const KEY = process.env.OPENROUTER_API_KEY
const MODEL = process.env.SMOKE_MODEL ?? 'qwen/qwen3.7-flash'
const MODEL_BASE = process.env.SMOKE_BASE_URL ?? 'https://openrouter.ai/api/v1'

const driver = new MatchDriver({ intervalMs: 500, log: (m) => console.log('[driver]', m) })

const arena = new MemoryArena()
const runners = new Map<string, AgentRunner>()
const provider: AgentProviderConfig | undefined = KEY
  ? {
      name: 'openrouter',
      model: MODEL,
      baseUrl: MODEL_BASE,
      apiKey: KEY,
      contextWindow: 128_000,
      maxTokens: 4_096,
    }
  : undefined

/** 广播通道占位（服务器起来后回填；createMatch 在 listen 之后才会被调用）。 */
let broadcast: (e: { type: string; [k: string]: unknown }) => void = () => {}

async function wakerFor(seatId: string): Promise<SeatWaker> {
  let runner = runners.get(seatId)
  if (!runner) {
    arena.bindUser(seatId, seatId)
    runner = await AgentRunner.create({
      seatId,
      tools: buildSeatTools({ registry: arena, backend: arena }, seatId),
      provider: provider!,
      baseDir: process.env.DEV_AGENT_DIR ?? `${process.cwd()}/.dev-agents`,
      onEvent: (e) => {
        if (e.type === 'tool_end') console.log(`[${seatId}] tool_end ${e.toolName ?? ''} ${e.isError ? 'ERR' : 'OK'}`)
      },
    })
    runners.set(seatId, runner)
  }
  const r = runner
  return { prompt: (_sid, text) => r.prompt(text) }
}

const created = createArenaDevServices({
  driver,
  onBroadcast: (e) => broadcast(e),
  // 无 key 时不给 waker → 只推进时钟（前端可观 roundBreak 周期）
  ...(provider ? { makeWaker: (seatId: string) => ({ prompt: async (sid, text) => (await wakerFor(seatId)).prompt(sid, text) }) } : {}),
})

const handle = await startHttpServer({ services: created.services, port: PORT })
broadcast = (e) => handle.broadcast(e)
driver.start()
console.log(`[dev] http://127.0.0.1:${handle.port} (mock world; wake=${provider ? `real ${MODEL}` : 'disabled'})`)

process.on('SIGINT', async () => {
  driver.stop()
  for (const r of runners.values()) r.dispose()
  await handle.close()
  process.exit(0)
})
