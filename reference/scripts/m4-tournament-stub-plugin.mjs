/**
 * m4-tournament-stub-plugin（纯 JS ESM, M4-F.2 集成验收装置，临时，验收后清理）.
 *
 * 用途（plan-M4 §9 验收矩阵 "composition" 的 web 面）：真实 DSH web（3200）+
 * stub provider 驱动 tournament 全链——
 * - 注册 provider 'stub' 的 LlmAdapter：对 tournament round prompt（含「screeps_submit_code」
 *   和 roundToken）确定性应答 submit_code(roundToken, MINIMAL_LOOP)；
 * - 注册触发工具 `screeps_tournament_demo`：宿主 turn 里调用 → ctx.screeps 建 4 席赛事 →
 *   recruit（stub 秒答 handle）→ start → 驱动循环推进（stub 提交代码 → lifecycle.start →
 *   raider/harvester 无从注入…… 本 lane 只验收「HTTP 建赛 + 状态推进 + bracket 可见」——
 *   完整对局由 IT 承担，这里 stub 提交最小脚本后驱动到 running 即可）。
 *
 * 临时装置说明：headless/profile 的 node_modules 无 dsh-llm/dsh-tools（从全局 dsh 解析），
 * 本插件从全局 dsh 安装目录直接 import ESM。仅验收用。
 */
const LLM_URL = 'file:///usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const TOOLS_URL = 'file:///usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const llmMod = await import(LLM_URL)
const toolsMod = await import(TOOLS_URL)
const { LlmAdapter } = llmMod
const { defineTool } = toolsMod

const MINIMAL_LOOP = 'module.exports.loop = function () { Memory.stub = Game.time }'

class StubTournamentAdapter extends LlmAdapter {
  constructor() {
    super()
    this.submits = new Map() // sessionId → 已提交码数
  }
  providerInfo(provider) {
    return { id: provider, name: 'stub-tournament', models: ['stub-model'] }
  }
  providerRetryPolicy() { return undefined }
  async listModels() { return [{ id: 'stub-model', name: 'stub-model' }] }
  async resolveModel(provider, model) {
    return { provider, id: model ?? 'stub-model' }
  }
  async *stream(options) {
    const sid = String(options.sessionId ?? 'anon')
    const allText = [
      options.system ?? '',
      ...(Array.isArray(options.messages) ? options.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))) : []),
    ].join('\n')
    // round prompt 特征：含 screeps_submit_code + roundToken=；应答一次提交即可
    const isRoundSubmit = /screeps_submit_code.*roundToken/.test(allText) || /roundToken="?[A-Za-z0-9]+"?.*submit_code/.test(allText)
    console.log('[m4-stub] stream called sid=' + sid)
    const token = /roundToken="?([A-Za-z0-9]+)"?/.exec(allText)?.[1]
    console.log(`[stub-tournament] stream sid=${sid} isRoundSubmit=${isRoundSubmit}`)
    if (isRoundSubmit) {
      const id = `stub_tc_${sid}_submit`
      const args = JSON.stringify({ modules: { main: MINIMAL_LOOP }, ...(token ? { roundToken: token } : {}) })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'screeps_submit_code', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'screeps_submit_code', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = 'tournament participant ready (stub deterministic reply)'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  }
}

export const name = 'dsh-screeps-m4-stub'
export const inject = ['llm', 'tools', 'screeps']

export function apply(ctx) {
  const llm = ctx.llm
  console.log('[m4-stub] registering stub adapter')
  llm.registerAdapter(['stub'], new StubTournamentAdapter())
  const tools = ctx.tools
  tools.register(
    defineTool({
      name: 'screeps_tournament_demo',
      description:
        '集成验收（M4-F.2）：创建 4 席赛事（stub provider）→ 等待 ready → 促发 start → 返回 tournamentId/phase/roster。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => [{ type: 'text', text: String(v.text ?? '') }],
      },
      async execute() {
        const seats = 4
        const requestId = 'm4f2-' + Date.now().toString(36)
        const createRes = await ctx.screeps.tournaments.create(
          requestId,
          { preset: 'arena-blitz', seats, maxAttempts: 2, tickDuration: 100, provider: 'stub', model: 'stub-model' },
          'op-m4f2-' + Date.now().toString(36),
          { awaitRecruit: true },
        )
        const tid = createRes.tournamentId
        let phase = createRes.state.phase
        for (let i = 0; i < 20 && phase === 'recruiting'; i++) {
          await new Promise(r => setTimeout(r, 500))
          const st = await ctx.screeps.tournaments.storeRef.get(tid)
          phase = st?.phase ?? phase
        }
        if (phase === 'ready') {
          await ctx.screeps.tournaments.start(tid, 'op-start-' + Date.now().toString(36))
          const st = await ctx.screeps.tournaments.storeRef.get(tid)
          phase = st?.phase ?? phase
        }
        // 宿主 turn 内轮询：等首场 attempt 被 stub 提交（roundToken 路径）
        let firstMatch = null
        let allSubmitted = false
        for (let i = 0; i < 40; i++) {
          const st = await ctx.screeps.tournaments.storeRef.get(tid)
          const slot = st?.slots.find(sl => sl.phase === 'running')
          const attempt = slot?.attempts.find(a => a.matchId)
          if (attempt?.matchId) {
            const m = await ctx.screeps.match.store.get(attempt.matchId)
            firstMatch = { id: m.id, phase: m.phase, players: m.players.length, submitted: m.players.every(p => p.submitted === true) }
            if (m.players.length === 2 && m.players.every(p => p.submitted === true)) { allSubmitted = true; break }
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        console.log('M4F2-OK ' + JSON.stringify({ tournamentId: tid, phase, allSubmitted, firstMatch }))
        return { text: 'M4F2-OK ' + JSON.stringify({ tournamentId: tid, phase, allSubmitted, firstMatch }), tournamentId: tid, phase, allSubmitted, firstMatch }
      },
    }),
  )
}