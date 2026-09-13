/**
 * Phase 27-B acceptance — 验证 Business Client 通过稳定 Public API 完成真实调用链，
 * 并获得结构化 RunResult。全部离线（ScriptedModel），可重复运行，无需 Ollama。
 *
 * 覆盖：
 *   Case A — Normal Run      : tool 执行 + Policy ALLOW + Tool Result + LLM final answer
 *   Case B — Policy DENY     : tool 不执行，Run 仍返回 contract 合规结果
 *   Case C — Tool Failure    : tool 返回 isError，Run 不泄漏内部异常，status=completed
 *   Case D — Abort           : 调用方 abort，RunResult.status=aborted
 */
import { getCustomer } from "../src/tools/get-customer.js";
import { BusinessClient } from "./phase27b-business-client.js";
import {
  ScriptedModelV2,
  makeFailingTool,
  denyGetCustomerPolicy,
} from "./phase27b-fixtures.js";
import type { ExecutionTrace } from "../src/index.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function toolEvents(trace: ExecutionTrace | undefined, toolName: string) {
  if (!trace) return [];
  return trace.events.filter(
    (e) => e.type === "tool_execution_end" && e.data.toolName === toolName,
  );
}

/** 该 tool 是否「按 isError 判定」执行过。isError=true 看 result.isError 或 event.isError；false 看两者都非 error。 */
function executedWith(trace: ExecutionTrace | undefined, toolName: string, isError: boolean): boolean {
  return toolEvents(trace, toolName).some((e) => {
    const ev = e.data.isError === true;
    const res = (e.data.result as { isError?: boolean } | undefined)?.isError === true;
    return isError ? ev || res : !ev && !res;
  });
}

function policyDenied(trace: ExecutionTrace | undefined, toolName: string): boolean {
  if (!trace) return false;
  return trace.events.some(
    (e) =>
      e.type === "policy_decision" &&
      e.data.toolName === toolName &&
      e.data.decision === "deny",
  );
}

async function caseA(): Promise<void> {
  const model = new ScriptedModelV2();
  model.enqueueTool("get_customer", { name: "Alice" });
  model.enqueueFinal("Alice (C001) is on the Enterprise plan at Acme.", "completed");

  const client = new BusinessClient({ tools: [getCustomer], model: model.model, streamFn: model.streamFn });
  const result = await client.execute("Find customer Alice");

  check("A.status", result.status === "completed", `status=${result.status}`);
  check("A.answer", typeof result.answer === "string" && result.answer.includes("Alice"), result.answer);
  check("A.sessionId", result.sessionId === client.sessionId, result.sessionId);
  check("A.runId", typeof result.runId === "string" && result.runId.length > 0, result.runId);
  check("A.trace", result.trace !== undefined, result.trace ? "present" : "missing");
  check("A.tool executed", executedWith(result.trace, "get_customer", false), "get_customer ran (isError=false)");
  check("A.no error", result.error === undefined, result.error ? JSON.stringify(result.error) : "clean");
}

async function caseB(): Promise<void> {
  const model = new ScriptedModelV2();
  model.enqueueTool("get_customer", { name: "Alice" });
  model.enqueueFinal("I'm not permitted to look that up.", "completed");

  const client = new BusinessClient({ tools: [getCustomer], policy: denyGetCustomerPolicy, model: model.model, streamFn: model.streamFn });
  const result = await client.execute("Find customer Alice");

  check("B.status", result.status === "completed", `status=${result.status}`);
  check("B.tool NOT executed", !executedWith(result.trace, "get_customer", false), "get_customer blocked (no successful execution)");
  check("B.policy denied", policyDenied(result.trace, "get_customer"), "policy_decision=deny observed");
  check("B.answer", typeof result.answer === "string" && result.answer.length > 0, result.answer);
}

async function caseC(): Promise<void> {
  const model = new ScriptedModelV2();
  model.enqueueTool("unreliable_lookup", { key: "x" });
  model.enqueueFinal("The lookup failed, but here is a fallback answer.", "completed");

  const client = new BusinessClient({ tools: [makeFailingTool()], model: model.model, streamFn: model.streamFn });
  const result = await client.execute("Look up x");

  check("C.status", result.status === "completed", `status=${result.status}`);
  check("C.tool executed w/ error", executedWith(result.trace, "unreliable_lookup", true), "tool ran, result.isError=true");
  check("C.no internal leak", result.error === undefined, result.error ? JSON.stringify(result.error) : "clean (no stack)");
  check("C.answer", typeof result.answer === "string" && result.answer.includes("fallback"), result.answer);
}

async function caseD(): Promise<void> {
  const model = new ScriptedModelV2();
  model.enqueueTool("get_customer", { name: "Alice" });
  model.enqueueHang();

  const client = new BusinessClient({ tools: [getCustomer], model: model.model, streamFn: model.streamFn });
  const runPromise = client.execute("Find customer Alice");
  // 给第一轮 tool 执行一点时间，再中止。
  setTimeout(() => client.abort(), 60);
  const result = await runPromise;

  check("D.status", result.status === "aborted", `status=${result.status}`);
  check("D.error code", result.error?.code === "aborted", result.error ? result.error.code : "none");
}

async function main(): Promise<void> {
  console.log("=== Phase 27-B acceptance ===");
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  console.log(`\n=== Phase 27-B acceptance: ${passed} passed, ${failed} failed ===`);

  const script = process.argv[1] ?? "phase27b-acceptance.ts";
  console.log(`[acceptance:phase27b] ${script}`);
  if (failed > 0) {
    console.log(`[acceptance:phase27b] FAIL (failures=${failed})`);
    process.exit(1);
  }
  console.log(`[acceptance:phase27b] PASS (failures=0)`);
}

main().catch((e) => {
  console.error("acceptance crashed:", e);
  process.exit(1);
});
