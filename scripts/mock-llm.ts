/**
 * 独立 mock OpenAI 兼容 server（compose 锦标赛全链用，spike-pi-sdk.ts 装置抽取）。
 * 判据（按请求体而非全局计数，多席位各自首轮都能拿到 submit_code）：
 *   会话历史中尚无 tool 结果 → 回 tool_calls(submit_code)（提交初始代码）；
 *   已有 tool 结果（本轮工具回传收尾）→ 回纯文本结束本轮。
 * 跑法：fnm exec --using=22 -- tsx scripts/mock-llm.ts   （MOCK_LLM_PORT 默认 8901）
 */
import * as http from 'node:http'

const port = Number(process.env.MOCK_LLM_PORT ?? 8901)
let llmCalls = 0

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (d: Buffer) => (body += d.toString()))
  req.on('end', () => {
    llmCalls += 1
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: `chatcmpl-mock-${llmCalls}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock-1',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let hasToolResult = false
    try {
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> }
      hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool')
    } catch {
      /* 解析失败按无 tool 结果处理 */
    }
    if (!hasToolResult) {
      const args = JSON.stringify({ modules: { main: 'module.exports.loop = function () {}' } })
      res.write(
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: `call_mock_${llmCalls}`, type: 'function', function: { name: 'submit_code', arguments: args } },
            ],
          },
          null,
        ),
      )
      res.write(chunk({}, 'tool_calls'))
    } else {
      res.write(chunk({ role: 'assistant', content: `standing by (call #${llmCalls})` }, null))
      res.write(chunk({}, 'stop'))
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '0.0.0.0', () => console.log(`[mock-llm] listening on 0.0.0.0:${port}`))
