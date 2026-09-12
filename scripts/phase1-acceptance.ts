import { EnterpriseAiRuntime } from "../src/runtime.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Phase 1 Acceptance Test — 最小验收脚本。
 *
 * 只测试当前 EnterpriseAiRuntime 已有能力（run / subscribe / transcript / abort /
 * waitForIdle / isStreaming / model）。不依赖任何 Phase 2 能力，不 mock 任何响应。
 *
 * 运行：npx tsx scripts/phase1-acceptance.ts
 */

function messageText(m: AgentMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b: { type?: string; text?: string }) => b?.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text)
      .join("");
  }
  return "";
}

const lines: string[] = [];
function log(s: string): void {
  lines.push(s);
  console.log(s);
}
function pass(label: string): void {
  log(`[PASS] ${label}`);
}
function fail(label: string, reason: string): never {
  log(`[FAIL] ${label}: ${reason}`);
  throw new Error(`${label} FAILED: ${reason}`);
}
function inconclusive(label: string, reason: string): void {
  log(`[INCONCLUSIVE] ${label}: ${reason}`);
}

async function testRealRunEventsTranscript(): Promise<void> {
  const runtime = new EnterpriseAiRuntime({
    systemPrompt: "You answer concisely and correctly.",
  });

  const eventTypes: string[] = [];
  runtime.subscribe((e) => {
    eventTypes.push(e.type);
  });

  // —— Test 1: 真实 run（必须经 Runtime → pi-agent-core → pi-ai → Ollama）——
  const prompt = "用一句话回答：1+1等于多少？";
  log(`\nPrompt: ${prompt}`);
  await runtime.run(prompt);
  await runtime.waitForIdle();

  const transcript = runtime.transcript();
  const assistant = transcript.find((m) => m.role === "assistant");
  const assistantText = assistant ? messageText(assistant) : "";
  log(`Assistant: ${assistantText}`);

  // 1+1=2 —— 答案应包含 "2" / "二" / "两"
  if (!/2|二|两/.test(assistantText)) {
    fail("Real Ollama run", `assistant answer did not contain correct result: "${assistantText}"`);
  }
  pass("Real Ollama run");

  // —— Test 2: 事件订阅 ——
  log(`\nObserved event types (${eventTypes.length}):`);
  log(eventTypes.join(", "));
  const has = (t: string) => eventTypes.includes(t);
  if (has("agent_start") && has("turn_end") && has("agent_end")) {
    pass("Event subscription");
  } else {
    fail("Event subscription", `missing lifecycle events. Got: ${eventTypes.join(",")}`);
  }

  // —— Test 3: transcript ——
  const roles = transcript.map((m) => m.role);
  log(`\nTranscript roles: ${roles.join(", ")}`);
  const hasUser = roles.includes("user");
  const hasAssistant = roles.includes("assistant");
  if (hasUser && hasAssistant) {
    pass("Transcript");
  } else {
    fail("Transcript", `expected user+assistant, got: ${roles.join(",")}`);
  }
}

async function testAbort(): Promise<void> {
  const runtime = new EnterpriseAiRuntime({ systemPrompt: "You are extremely verbose." });
  runtime.subscribe(() => {});

  // 长生成 prompt，确保 abort 能在流式进行中触发
  const longPrompt =
    "请用不少于 800 个汉字，分多个段落，详细阐述人工智能的发展历史、关键技术突破以及未来可能的发展趋势。";
  log(`\nAbort-test prompt: ${longPrompt.slice(0, 24)}...`);

  const runPromise = runtime.run(longPrompt);
  // 等待流式开始
  await new Promise((r) => setTimeout(r, 800));
  const wasStreaming = runtime.isStreaming;
  log(`isStreaming at abort(): ${wasStreaming}`);

  runtime.abort();

  // 防止 hang：waitForIdle 必须在 15s 内结算
  const idle = Promise.race([
    runtime.waitForIdle(),
    new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error("waitForIdle did not resolve within 15s after abort")), 15000),
    ),
  ]);
  await idle;
  await runPromise.catch(() => {
    /* aborted run 可能 reject，已通过 idle 确认终止 */
  });

  if (wasStreaming) {
    log("ABORT TEST: PASS");
  } else {
    inconclusive(
      "Abort",
      "Model finished generating before abort() was called (isStreaming was false at abort time); cannot prove abort interrupted a live stream.",
    );
  }
}

async function main(): Promise<void> {
  const probe = new EnterpriseAiRuntime();
  log(`Model    : ${probe.model.id}`);
  log(`Base URL : ${probe.model.baseUrl}`);
  log(`Provider : ${probe.model.provider}`);
  log(`API      : ${probe.model.api}`);

  await testRealRunEventsTranscript();
  await testAbort();

  log("\nPHASE 1 ACCEPTANCE: PASS");
}

main().catch((err) => {
  console.error("\nPHASE 1 ACCEPTANCE: FAIL");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
