/**
 * Mock OpenAI `/v1/chat/completions`（SSE）—— spike 装置抽出的测试夹具（stub lane 共用：
 * S1 单测、S4 对局 IT 都指向它，零 LLM 成本、可重复）。
 *
 * 脚本化：第 i 次 LLM 调用按 replies[i] 回复；越界回纯文本 standing by。
 * 断言口径（spike 结论 4）：1 个工具 turn = 2 次 LLM 请求（tool turn + 收尾文本）。
 */
import * as http from 'node:http'
import * as net from 'node:net'

export interface MockToolCall {
  name: string
  args: unknown
}

export type MockReply =
  | { kind: 'tool_calls'; calls: MockToolCall[]; delayMs?: number }
  | { kind: 'text'; text: string; delayMs?: number }

export interface MockOpenAI {
  url: string
  /** 已收到的 LLM 请求数。 */
  readonly llmCalls: number
  /** 按序记录的 LLM 侧工具调用（名 + 参数），供落位/一致性断言。 */
  readonly toolRequests: MockToolCall[]
  close(): Promise<void>
}

/** 默认脚本：第 1 次回 submit_code tool_calls（与 spike 相同载荷），其余回纯文本。 */
export async function startMockOpenAI(
  replies: MockReply[] = [
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'submit_code',
          args: { modules: { main: 'module.exports.loop = function () {}' } },
        },
      ],
    },
  ],
): Promise<MockOpenAI> {
  let callCount = 0
  const toolRequests: MockToolCall[] = []

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    req.resume()
    req.on('end', () => {
      callCount += 1
      const reply: MockReply = replies[callCount - 1] ?? { kind: 'text', text: `standing by (call #${callCount})` }
      const respond = () => {
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-mock',
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
        if (reply.kind === 'tool_calls') {
          for (const [i, call] of reply.calls.entries()) {
            toolRequests.push(call)
            res.write(
              chunk(
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: i,
                      id: `call_${callCount}_${i}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.args) },
                    },
                  ],
                },
                null,
              ),
            )
          }
          res.write(chunk({}, 'tool_calls'))
        } else {
          res.write(chunk({ role: 'assistant', content: reply.text }, null))
          res.write(chunk({}, 'stop'))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      }
      if (reply.delayMs) setTimeout(respond, reply.delayMs)
      else respond()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    get llmCalls() {
      return callCount
    },
    toolRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
