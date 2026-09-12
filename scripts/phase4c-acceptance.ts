/**
 * Phase 4-C Acceptance — 真实 Ollama + 真实 pi-agent-core，零 mock。
 *
 * 验证：ALLOW / DENY / ASK(Plan A) 经 Pi beforeToolCall Control Point 落地。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { EnterpriseAiRuntime, formatTrace } from "../src/index.js";
import { getCustomer } from "../src/tools/get-customer.js";
import type { ExecutionTrace, Policy, PolicyDecision } from "../src/index.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROMPT = "查询 Alice 的客户信息";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

/** 带执行计数的 get_customer 包装（仅用于断言 Tool 是否真的被 Pi 调用）。 */
function makeCountingTool(counter: { n: number }): AgentTool<any, any> {
  return {
    ...getCustomer,
    execute: async (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      counter.n++;
      return (getCustomer.execute as any)(id, params, signal, onUpdate);
    },
  } as AgentTool<any, any>;
}

async function runCase(policy: Policy): Promise<{ counter: { n: number }; trace: ExecutionTrace }> {
  const counter = { n: 0 };
  const runtime = new EnterpriseAiRuntime({ tools: [makeCountingTool(counter)], policy });
  await runtime.run(PROMPT);
  const trace = runtime.lastTrace();
  if (!trace) throw new Error("no trace produced");
  return { counter, trace };
}

const execStarts = (t: ExecutionTrace) => t.events.filter((e) => e.type === "tool_execution_start");
const execEnds = (t: ExecutionTrace) => t.events.filter((e) => e.type === "tool_execution_end");
const policyDecisions = (t: ExecutionTrace) => t.events.filter((e) => e.type === "policy_decision");
const policyResolved = (t: ExecutionTrace) => t.events.filter((e) => e.type === "policy_resolved");
const llmCount = (t: ExecutionTrace) => t.llmCalls.length;
function resultText(ev: { data: { result?: { content?: { text?: string }[] } } }): string {
  const c = ev.data.result?.content;
  if (!Array.isArray(c)) return "";
  return c.map((b) => b.text ?? "").join("");
}

async function main(): Promise<void> {
  // ---- Test 1 + Test 5 (baseline): ALLOW ----
  const allowPolicy: Policy = () => ({ type: "allow" });
  const allowCase = await runCase(allowPolicy);
  check("T1 tool executed exactly once (ALLOW)", allowCase.counter.n === 1, `count=${allowCase.counter.n}`);
  check("T1 no error ToolResult (ALLOW)", execEnds(allowCase.trace).every((e) => e.data.isError === false));
  check("T1 final answer exists", allowCase.trace.finalAnswer.length > 0);
  check("T1 policy_decision = allow", policyDecisions(allowCase.trace).some((e) => e.data.decision === "allow"));
  const allowLlm = llmCount(allowCase.trace);
  console.log(`    (baseline LLM calls = ${allowLlm})`);

  // ---- Test 2: DENY ----
  const denyPolicy: Policy = (call) =>
    call.toolName === "get_customer" ? { type: "deny", reason: "Policy denied: get_customer is restricted" } : { type: "allow" };
  const denyCase = await runCase(denyPolicy);
  check("T2 tool executed ZERO times (DENY)", denyCase.counter.n === 0, `count=${denyCase.counter.n}`);
  const denyEnds = execEnds(denyCase.trace);
  check("T2 tool_execution_end isError=true", denyEnds.length > 0 && denyEnds.every((e) => e.data.isError === true));
  const deniedResult = denyEnds.find((e) => resultText(e).includes("Policy denied"));
  check("T2 deny reason in ToolResult", !!deniedResult, deniedResult ? resultText(deniedResult) : "(none)");
  check("T2 agent reaches agent_end", denyCase.trace.endedAt !== null);
  check("T2 final answer exists (Agent continues)", denyCase.trace.finalAnswer.length > 0);
  check("T2 policy_resolved = deny", policyResolved(denyCase.trace).some((e) => e.data.outcome === "deny"));

  // ---- Test 3 + Test 6: ASK → ALLOW ----
  const askAllowPolicy: Policy = () => ({ type: "ask", approval: async () => { await delay(100); return "allow"; } });
  const askAllowCase = await runCase(askAllowPolicy);
  check("T3 tool executed exactly once after ASK→ALLOW", askAllowCase.counter.n === 1, `count=${askAllowCase.counter.n}`);
  check("T3 policy_decision = ask", policyDecisions(askAllowCase.trace).some((e) => e.data.decision === "ask"));
  check("T3 policy_resolved = allow", policyResolved(askAllowCase.trace).some((e) => e.data.outcome === "allow"));
  const askEv = policyDecisions(askAllowCase.trace).find((e) => e.data.decision === "ask");
  const askExec = execStarts(askAllowCase.trace)[0];
  check(
    "T3/T6 toolCallId stable (ask == executed)",
    !!askEv && !!askExec && askEv.data.toolCallId === askExec.data.toolCallId,
    askEv && askExec ? `${askEv.data.toolCallId} == ${askExec.data.toolCallId}` : "?",
  );
  const askLlm = llmCount(askAllowCase.trace);

  // ---- Test 5: ASK must NOT add an LLM call ----
  check("T5 ASK does not trigger extra LLM call", allowLlm === askLlm, `allow=${allowLlm} ask=${askLlm}`);

  // ---- Test 4: ASK → DENY ----
  const askDenyPolicy: Policy = () => ({ type: "ask", approval: async () => { await delay(100); return "deny"; } });
  const askDenyCase = await runCase(askDenyPolicy);
  check("T4 tool executed ZERO times (ASK→DENY)", askDenyCase.counter.n === 0, `count=${askDenyCase.counter.n}`);
  const askDenyEnds = execEnds(askDenyCase.trace);
  check("T4 tool_execution_end isError=true", askDenyEnds.length > 0 && askDenyEnds.every((e) => e.data.isError === true));
  const approverDenied = askDenyEnds.find((e) => resultText(e).includes("Policy denied by approver"));
  check("T4 approver deny reason in ToolResult", !!approverDenied, approverDenied ? resultText(approverDenied) : "(none)");
  check("T4 policy_resolved = deny", policyResolved(askDenyCase.trace).some((e) => e.data.outcome === "deny"));
  check("T4 agent continues (final answer)", askDenyCase.trace.finalAnswer.length > 0);

  // ---- Test 7: Policy does NOT execute Tool (separation) ----
  // DENY 路径：Policy 返回 deny，tool.execute 计数为 0，但 Pi 仍发出 tool_execution_end。
  check(
    "T7 Policy decides / Pi executes separation",
    denyCase.counter.n === 0 && execEnds(denyCase.trace).length > 0,
  );

  // ---- Real human-readable trace (ASK → ALLOW) ----
  console.log("\n" + formatTrace(askAllowCase.trace));
}

main()
  .then(() => {
    console.log(`\n=== Phase 4-C acceptance: ${failures === 0 ? "PASS" : "FAIL"} (failures=${failures}) ===`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("ACCEPTANCE ERROR:", e);
    process.exit(1);
  });
