import { EnterpriseAiRuntime } from "../src/runtime.js";
import { getCustomer } from "../src/tools/get-customer.js";
import { formatTrace } from "../src/trace/format.js";
import type { ExecutionTrace, LlmCallTrace } from "../src/trace/types.js";

/**
 * Phase 3 Acceptance Test — Agent + Tool + LLM Interaction Trace（最小验收，无 mock）。
 *
 * 真实链路：EnterpriseAiRuntime → pi-agent-core → pi-ai → Ollama → qwen2.5:14b
 * LLM Trace 经 Pi 官方 onPayload / onResponse 钩子（包装 streamFn）实际捕获，observe-only。
 *
 * 运行：npx tsx scripts/phase3-acceptance.ts
 */

const SYSTEM_PROMPT =
  "You are an enterprise assistant. When the user asks about a customer, call the get_customer tool with the customer name.";

function log(s: string): void {
  console.log(s);
}
function pass(label: string): void {
  log(`[PASS] ${label}`);
}
function fail(label: string, reason: string): never {
  log(`[FAIL] ${label}: ${reason}`);
  throw new Error(`${label}: ${reason}`);
}

/* ----- helpers ----- */
function findEvent(trace: ExecutionTrace, type: string) {
  return trace.events.find((e) => e.type === type);
}
function has(trace: ExecutionTrace, type: string): boolean {
  return trace.events.some((e) => e.type === type);
}
function reqOf(call: LlmCallTrace): Record<string, unknown> {
  return call.request;
}
function userText(req: Record<string, unknown>): string {
  const msgs = req.messages;
  if (!Array.isArray(msgs)) return "";
  const u = msgs.find((m) => (m as { role?: string }).role === "user") as { content?: unknown } | undefined;
  if (!u) return "";
  const c = u.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("");
  }
  return String(c);
}
function reqToolNames(req: Record<string, unknown>): string[] {
  const tools = req.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t as { function?: { name?: string }; name?: string })?.function?.name ?? (t as { name?: string })?.name)
    .filter((x): x is string => typeof x === "string");
}
function msgRoles(req: Record<string, unknown>): string[] {
  const msgs = req.messages;
  if (!Array.isArray(msgs)) return [];
  return msgs.map((m) => (m as { role?: string }).role ?? "?");
}

async function run(prompt: string): Promise<{ runtime: EnterpriseAiRuntime; trace: ExecutionTrace }> {
  const runtime = new EnterpriseAiRuntime({ systemPrompt: SYSTEM_PROMPT });
  runtime.registerTool(getCustomer);
  await runtime.run(prompt);
  await runtime.waitForIdle();
  const trace = runtime.lastTrace();
  if (!trace) fail("Trace created", "lastTrace() 返回 undefined（run 未完成或无事件）");
  log("\n" + formatTrace(trace));
  return { runtime, trace };
}

async function main(): Promise<void> {
  /* ===== Alice: 正常 Tool 调用流程 ===== */
  const { runtime, trace } = await run("查询 Alice 的客户信息");

  // Real Ollama 证据
  log(`Model: ${runtime.model.id} @ ${runtime.model.baseUrl} (${runtime.model.provider})`);
  if (runtime.model.id !== "qwen2.5:14b") fail("Real Ollama", `unexpected model ${runtime.model.id}`);
  pass("Real Ollama");

  // Test 1：LLM Call 数量（必须来自 onPayload 实际捕获，非推测）
  if (trace.llmCalls.length !== 2) fail("LLM Call count", `期望 2，实际 ${trace.llmCalls.length}`);
  pass("LLM Call count (2)");

  // Test 2：LLM #1 Request
  const llm1 = trace.llmCalls[0];
  if (llm1.model !== "qwen2.5:14b") fail("LLM #1 request", `model=${llm1.model}`);
  if (!userText(reqOf(llm1)).includes("查询 Alice 的客户信息")) {
    fail("LLM #1 request", `user message 不含 prompt: ${userText(reqOf(llm1))}`);
  }
  if (!reqToolNames(reqOf(llm1)).includes("get_customer")) {
    fail("LLM #1 request", `tools 不含 get_customer: ${reqToolNames(reqOf(llm1))}`);
  }
  pass("LLM #1 request (model + user + get_customer)");

  // Test 3：LLM #1 → Tool Call 关联（来自 Agent Event，非伪造 HTTP body）
  const tcStart = findEvent(trace, "tool_execution_start");
  if (!tcStart) fail("LLM #1 tool call", "缺少 tool_execution_start");
  if (tcStart!.data.toolName !== "get_customer") fail("LLM #1 tool call", `toolName=${String(tcStart!.data.toolName)}`);
  if ((tcStart!.data.args as { name?: string })?.name !== "Alice") {
    fail("LLM #1 tool call", `args.name 不是 Alice: ${JSON.stringify(tcStart!.data.args)}`);
  }
  if (!(llm1.sequence < tcStart!.sequence)) fail("LLM #1 tool call", "LLM #1 应在 tool call 之前");
  pass("LLM #1 → tool call (get_customer / Alice)");

  // Test 4：Tool Result
  const tcEnd = findEvent(trace, "tool_execution_end");
  if (!tcEnd) fail("Tool result", "缺少 tool_execution_end");
  if (tcEnd!.data.isError !== false) fail("Tool result", "isError 不是 false");
  const details = (tcEnd!.data.result as { details?: { company?: string; plan?: string } })?.details;
  if (!details || details.company !== "Acme" || details.plan !== "Enterprise") {
    fail("Tool result", `details=${JSON.stringify(details)}`);
  }
  pass("Tool result (C001 / Alice / Acme / Enterprise)");

  // Test 5：LLM #2 Request（完整上下文：system + user + assistant tool_call + tool result）
  const llm2 = trace.llmCalls[1];
  if (llm2.model !== "qwen2.5:14b") fail("LLM #2 request", `model=${llm2.model}`);
  const roles = msgRoles(reqOf(llm2));
  const msgs = reqOf(llm2).messages as Array<{ role?: string; tool_calls?: unknown[] }>;
  const hasUser = msgs.some((m) => m.role === "user");
  const hasAssistantToolCall = msgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
  const hasTool = msgs.some((m) => m.role === "tool");
  if (!hasUser) fail("LLM #2 request", `messages 无 user，roles=${roles}`);
  if (!hasAssistantToolCall) fail("LLM #2 request", `messages 无 assistant tool_call，roles=${roles}`);
  if (!hasTool) fail("LLM #2 request", `messages 无 tool result，roles=${roles}`);
  if (!reqToolNames(reqOf(llm2)).includes("get_customer")) fail("LLM #2 request", "tools 仍应含 get_customer");
  pass("LLM #2 request (user + assistant tool_call + tool result + get_customer)");

  // Test 6：Final Answer（来自 Agent Event，非 onResponse）
  if (!trace.finalAnswer || !/Alice|Acme|Enterprise/.test(trace.finalAnswer)) {
    fail("Final answer", `finalAnswer=${trace.finalAnswer}`);
  }
  pass("Final answer (via Agent Event)");

  // Test 7：HTTP Response Metadata（来自 onResponse）
  if (trace.llmCalls[0].responseMetadata?.status === undefined) {
    fail("HTTP response metadata", "onResponse 未触发 / status 缺失");
  }
  pass(`HTTP response metadata (status=${trace.llmCalls[0].responseMetadata?.status})`);

  // Phase 3 回归：Agent lifecycle + event ordering 仍正常
  if (!has(trace, "agent_start") || !has(trace, "agent_end")) fail("Agent lifecycle", "缺少 agent_start/agent_end");
  const iStart = trace.events.findIndex((e) => e.type === "agent_start");
  const iEnd = trace.events.findIndex((e) => e.type === "agent_end");
  if (!(iStart < iEnd)) fail("Event ordering", "agent_start 应在 agent_end 之前");
  pass("Agent lifecycle + ordering (Phase 3 regression)");

  /* ===== Bob: Tool Error 流程 ===== */
  const { trace: errTrace } = await run("查询 Bob 的客户信息");
  if (errTrace.llmCalls.length < 1) fail("Tool error", "缺少 LLM Call");
  const errTc = findEvent(errTrace, "tool_execution_start");
  if (!errTc || errTc.data.toolName !== "get_customer") fail("Tool error", "缺少 get_customer tool call");
  const errEnd = findEvent(errTrace, "tool_execution_end");
  if (!errEnd) fail("Tool error", "缺少 tool_execution_end");
  if (errEnd!.data.isError !== true) fail("Tool error", "期望 isError=true（未知客户 Bob）");
  if (!has(errTrace, "agent_end")) fail("Tool error", "Agent 未到达 agent_end（疑似崩溃）");
  if (!errTrace.finalAnswer) fail("Tool error", "Tool Error 后无后续 Agent Response");
  pass("Tool error (LLM → tool call → error → continues → final answer)");

  log("\nPHASE 3 ACCEPTANCE: PASS");
}

main().catch((err) => {
  console.error("\nPHASE 3 ACCEPTANCE: FAILED");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
