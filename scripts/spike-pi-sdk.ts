/**
 * Pi SDK 最小闭环 spike（离线，零 LLM 成本，可重复跑）
 *
 * 验证目标：
 *   S1. @earendil-works/pi-coding-agent 在 Node 22 (fnm) 下可安装可运行
 *   S2. registerProvider 挂 OpenAI 兼容 mock server（openai-completions + SSE 流）
 *   S3. createAgentSession + defineTool 白名单（只留自定义工具，无内置 read/bash）
 *   S4. session.prompt() 触发工具调用：LLM 回 tool_calls → submit_code 执行 → 结果回传
 *   S5. 空闲后重复 prompt() 驱动多轮（= world-rounds 周期唤醒）；
 *       附带实测 followUp() 对空闲 agent 是 no-op（仅 streaming 期间入队有效）
 *   S6. 事件流订阅可见 turn / 工具生命周期
 *
 * 运行：fnm exec --using=22 -- npx tsx scripts/spike-pi-sdk.ts
 */
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------- mock server
// 第 1 次请求回 tool_calls(submit_code)；第 2 次回纯文本。SSE 流式，兼容 openai-completions 解析。
const mock = { llmCalls: 0 }; // 属性收口：局部 let 会被 TS 等值断言窄化成字面量，后续 !==3 误报 TS2367
/** 断言收进函数边界：参数是 number，调用点无控制流窄化（属性比较在直线代码里会被 TS
 *  窄化成字面量，后续 !==3 误报 TS2367）。 */
function expectCalls(expected: number, what: string): void {
  if (mock.llmCalls !== expected) throw new Error(`${what}: expected ${expected} LLM calls, got ${mock.llmCalls}`);
}
const submitted: Array<Record<string, string>> = [];

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  req.on("end", () => {
    mock.llmCalls += 1;
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-spike",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-1",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (mock.llmCalls === 1) {
      // 第 1 次：回 tool_calls
      const args = JSON.stringify({
        modules: { main: "module.exports.loop = function () {}" },
      });
      res.write(
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_spike_1",
                type: "function",
                function: { name: "submit_code", arguments: args },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: `standing by (llm call #${mock.llmCalls}).` }, null));
      res.write(chunk({}, "stop"));
    }
    // 第 2 次起：纯文本（第 2 次是 round1 的 tool 结果回传后的收尾，第 3 次是 followUp 驱动的 round2）
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;
console.log(`[spike] mock openai server at ${baseUrl}`);

try {
  // ---------------------------------------------------------------- session
  // cwd/agentDir 都指向隔离临时目录，避免 DefaultResourceLoader 发现项目里的 AGENTS.md/.pi
  // （实测：agentDir 必传，undefined 会崩 resolvePath —— SDK 文档声称有默认值，不属实）
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spike-"));
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });

  const submitCode = defineTool({
    name: "submit_code",
    label: "Submit Code",
    description: "Upload your Screeps bot code (modules keyed by filename)",
    parameters: Type.Object({
      modules: Type.Record(Type.String(), Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      submitted.push(params.modules);
      return { content: [{ type: "text", text: "code accepted" }], details: {} };
    },
  });

  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();

  // 自定义 provider 走 models.json（agentDir 下），而非 registerProvider：
  // 实测 extension 注册的 provider 不进入 createAgentSession 的 model 解析/auth 链，
  // fallback 会选到 unknown/unknown 再报 no api key；显式 getModel + 传 model 才是正路。
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          mock: {
            name: "Mock",
            baseUrl,
            apiKey: "test-key",
            api: "openai-completions",
            models: [
              {
                id: "mock-1",
                name: "Mock 1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("mock", "mock-1");
  if (!model) throw new Error("mock model not found in ModelRuntime (models.json not loaded?)");

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader: loader,
    tools: ["submit_code"],
    customTools: [submitCode],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({}),
  });
  if (modelFallbackMessage) console.log(`[spike] model fallback: ${modelFallbackMessage}`);

  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") events.push(`tool:${event.toolName}`);
    else if (event.type === "agent_end") events.push("agent_end");
  });

  console.log(`[spike] model = ${session.model ? `${session.model.provider}/${session.model.id}` : "NONE"}`);
  if (!session.model) throw new Error("no model resolved — provider registration or auth failed");

  // S3 硬断言（整表相等）：工具面 = 白名单全集，任何名单外泄漏也会被抓（公平边界证据链）
  const toolNames: string[] = session.agent.state.tools.map((t) => t.name);
  console.log(`[spike] session tools = [${toolNames.join(", ")}]`);
  if (toolNames.length !== 1 || toolNames[0] !== "submit_code") {
    throw new Error(`tool list must be exactly [submit_code], got: [${toolNames.join(",")}]`);
  }

  // ---------------------------------------------------------------- round 1
  await session.prompt("Write your Screeps script and submit it with submit_code.");
  console.log(`[spike] round 1 done: callCount=${mock.llmCalls} submitted=${submitted.length} events=${events.join(",")}`);
  if (submitted.length !== 1) throw new Error(`expected 1 submit_code call, got ${submitted.length}`);
  expectCalls(2, "round 1 (tool turn + wrap-up)");

  // ---------------------------------------------------------------- round 2 (周期唤醒)
  // 实测：followUp() 只在 streaming 期间入队、由停止后的消费周期投递；对已空闲的 agent
  // 调用是 no-op（不报错也不产生 LLM 调用）。world-rounds 的周期唤醒由后端时钟驱动，
  // 正确姿势 = 空闲后直接再 prompt()（语义等同 DSH 的 followup turn）。
  await session.prompt("Round over. Review the report and stand by.");
  console.log(`[spike] round 2 done: callCount=${mock.llmCalls} events=${events.join(",")}`);
  if (mock.llmCalls !== 3) throw new Error(`second prompt did not drive a new LLM round (expected 3 calls total, got ${mock.llmCalls})`);

  // S6 硬断言：事件流可见工具执行与两轮 agent_end
  if (!events.includes("tool:submit_code")) throw new Error(`tool_execution_start not observed: ${events.join(",")}`);
  const agentEnds = events.filter((e) => e === "agent_end").length;
  if (agentEnds < 2) throw new Error(`expected >=2 agent_end events, got ${agentEnds}`);

  // ---------------------------------------------------------------- verdict
  console.log("[spike] PASS — S1..S6 all verified (hard assertions):", "\n  S1 pi-coding-agent runs on node", process.version, "\n  S2 mock openai-completions provider accepted", "\n  S3 tool whitelist enforced, no builtins leaked", "\n  S4 tool call loop round-tripped", "\n  S5 repeat prompt() drove a second round (followUp on idle = no-op, documented)", "\n  S6 event stream observed:", events.join(","));
  process.exitCode = 0;
} finally {
  server.close();
}
