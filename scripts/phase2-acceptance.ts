import { EnterpriseAiRuntime } from "../src/runtime.js";
import { getCustomer } from "../src/tools/get-customer.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

/**
 * Phase 2 Acceptance Test — Enterprise Tool Runtime（最小验收，无 mock）。
 *
 * 真实链路：EnterpriseAiRuntime → ToolRegistry → AgentTool[] → pi-agent-core → Ollama → qwen2.5:14b
 *
 * 运行：npx tsx scripts/phase2-acceptance.ts
 */

interface ToolStartObs {
  toolName: string;
  args: any;
}
interface ToolEndObs {
  toolName: string;
  result: any;
  isError: boolean;
}

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

function attachCollector(runtime: EnterpriseAiRuntime) {
  const toolStarts: ToolStartObs[] = [];
  const toolEnds: ToolEndObs[] = [];
  const turnEndToolResults: unknown[] = [];
  const eventTypes: string[] = [];
  runtime.subscribe((e: AgentEvent) => {
    eventTypes.push(e.type);
    if (e.type === "tool_execution_start") {
      toolStarts.push({ toolName: e.toolName, args: e.args });
    }
    if (e.type === "tool_execution_end") {
      toolEnds.push({ toolName: e.toolName, result: e.result, isError: e.isError });
    }
    if (e.type === "turn_end") {
      turnEndToolResults.push(...e.toolResults);
    }
  });
  return { toolStarts, toolEnds, turnEndToolResults, eventTypes };
}

function messageText(m: { content?: unknown }): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b: { type?: string; text?: string }) => b?.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text)
      .join("");
  }
  return "";
}

const SYSTEM_PROMPT =
  "You are an enterprise assistant. When the user asks about a customer, call the get_customer tool with the customer name.";

// —— Test 1: Tool registration ——
function testRegistration(): void {
  const rt = new EnterpriseAiRuntime();
  if (rt.listTools().length !== 0) {
    fail("Tool registration", `expected 0 tools before register, got ${rt.listTools().join(",")}`);
  }
  rt.registerTool(getCustomer);
  if (!rt.listTools().includes("get_customer")) {
    fail("Tool registration", `listTools=${JSON.stringify(rt.listTools())}`);
  }
  pass("Tool registration");
}

// —— Test 2-5 + 7: 成功路径（真实 Ollama 端到端）——
async function testSuccessPath(): Promise<void> {
  const runtime = new EnterpriseAiRuntime({ systemPrompt: SYSTEM_PROMPT });
  runtime.registerTool(getCustomer);

  const { toolStarts, toolEnds, turnEndToolResults, eventTypes } = attachCollector(runtime);

  const prompt = "查询 Alice 的客户信息";
  log(`\nPrompt: ${prompt}`);
  await runtime.run(prompt);
  await runtime.waitForIdle();

  const transcript = runtime.transcript();
  const assistantText = transcript
    .filter((m) => m.role === "assistant")
    .map((m) => messageText(m as { content?: unknown }))
    .join(" ");
  log(`Final answer: ${assistantText}`);

  // Test 2: Agent 真正调用 get_customer
  const invoked = toolStarts.find((t) => t.toolName === "get_customer");
  if (!invoked) {
    fail("Agent invokes tool", `no tool_execution_start for get_customer. events=${eventTypes.join(",")}`);
  }
  pass("Agent invokes tool");

  // Test 3: Tool 参数真实来自 LLM Tool Call
  if (!invoked || !invoked.args || invoked.args.name !== "Alice") {
    fail("Tool receives correct arguments", `args=${JSON.stringify(invoked?.args)}`);
  }
  pass("Tool receives correct arguments");

  // Test 4: Tool Result 重新进入 Agent Loop
  const ended = toolEnds.find((t) => t.toolName === "get_customer");
  if (!ended) {
    fail("Tool result returns to Agent", "no tool_execution_end for get_customer");
  }
  const details = ended?.result?.details;
  if (!details || details.id !== "C001" || details.company !== "Acme" || details.plan !== "Enterprise") {
    fail("Tool result returns to Agent", `details=${JSON.stringify(details)}`);
  }
  if (ended?.isError) {
    fail("Tool result returns to Agent", "success-path tool result reported isError=true");
  }
  if (turnEndToolResults.length === 0) {
    fail("Tool result returns to Agent", "turn_end carried no toolResults");
  }
  pass("Tool result returns to Agent");

  // Test 5: Agent 根据 Tool Result 生成最终回答
  if (!/Acme|Enterprise/.test(assistantText)) {
    fail("Agent produces final answer", `answer did not reference tool data: ${assistantText}`);
  }
  pass("Agent produces final answer");

  // Test 7: 真实 Ollama 端到端
  log(`Model: ${runtime.model.id} @ ${runtime.model.baseUrl} (${runtime.model.provider})`);
  if (runtime.model.id !== "qwen2.5:14b") {
    fail("Real Ollama end-to-end", `unexpected model ${runtime.model.id}`);
  }
  pass("Real Ollama end-to-end");
}

// —— Test 6: Tool Error 不导致 Agent 崩溃 ——
async function testToolError(): Promise<void> {
  const runtime = new EnterpriseAiRuntime({ systemPrompt: SYSTEM_PROMPT });
  runtime.registerTool(getCustomer);

  const { toolEnds, eventTypes } = attachCollector(runtime);

  const prompt = "查询 Bob 的客户信息";
  log(`\nPrompt (error path): ${prompt}`);
  await runtime.run(prompt);
  await runtime.waitForIdle();

  const ended = toolEnds.find((t) => t.toolName === "get_customer");
  if (!ended) {
    fail("Tool error", `no tool_execution_end for get_customer. events=${eventTypes.join(",")}`);
  }
  if (!ended.isError) {
    fail("Tool error", "expected isError=true for unknown customer Bob");
  }
  // Agent 未崩溃：应到达 agent_end
  if (!eventTypes.includes("agent_end")) {
    fail("Tool error", "agent did not reach agent_end (likely crashed)");
  }
  pass("Tool error");
}

async function main(): Promise<void> {
  testRegistration();
  await testSuccessPath();
  await testToolError();
  log("\nPHASE 2 ACCEPTANCE: PASS");
}

main().catch((err) => {
  console.error("\nPHASE 2 ACCEPTANCE: FAILED");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
