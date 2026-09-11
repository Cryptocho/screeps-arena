/**
 * M1 开发服务器：HTTP 桥 + 对局驱动器 + （可选）真实私服接线。
 * 最小启动：内存 ArenaBackend（mock 世界）——前端可观察基础功能；
 * 真实私服接线由 test:live / 后续 CLI 子命令提供。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MatchMachine } from '../src/server/match/machine.js'
import type { MatchEvent } from '../src/server/match/machine.js'
import { MatchDriver } from '../src/server/http/driver.js'
import { startHttpServer } from '../src/server/http/server.js'
import type { ArenaHttpServices } from '../src/server/http/routes.js'
import { MemoryArena } from '../src/agent/memory-backend.js'

const machines = new Map<string, MatchMachine>()
const arena = new MemoryArena()
const driver = new MatchDriver({ intervalMs: 500, log: (m) => console.log('[driver]', m) })

const services: ArenaHttpServices = {
  matches: () => [...machines.values()],
  match: (id) => machines.get(id),
  createMatch: (input) => {
    const m = new MatchMachine({
      players: input.players,
      ...(input.config ? { config: input.config } : {}),
      onEvent: (e) => {
        void driver.onEvent(m, e)
        handle.broadcast({ type: 'match_state', match: m.id, phase: m.phase, roundIndex: m.state.roundIndex, event: e.type })
      },
    })
    machines.set(m.id, m)
    return m
  },
  getWorld: async () => ({ ok: true, gameTime: 0, users: [] }),
  getTerrain: async (rooms) => ({ terrain: Object.fromEntries(rooms.map((r) => [r, '0'.repeat(2500)])) }),
  consoleSince: async () => ({ lines: [], cursor: 0, bound: true }),
}

const handle = await startHttpServer({ services, port: Number(process.env.PORT ?? 8787) })
driver.start()
console.log(`[dev] http://127.0.0.1:${handle.port} (mock world; frontend dev server proxies here)`)

process.on('SIGINT', async () => {
  driver.stop()
  await handle.close()
  process.exit(0)
})
void fs
void path
void arena
