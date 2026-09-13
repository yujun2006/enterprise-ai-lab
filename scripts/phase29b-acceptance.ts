/**
 * Phase 29-B — Context Propagation Acceptance（离线，确定性）。
 *
 * 核心实验：同一个 Tool，仅因 Workspace Context 不同，产生不同的 Policy Decision。
 *
 *  - Case A: workspaceId = "allowed-ws"   → Policy ALLOW  → Tool 执行
 *  - Case B: workspaceId = "forbidden-ws" → Policy DENY   → Tool 不执行
 *
 * 关键断言（AC-8）：Policy 实际收到的 workspace 来自 Runtime 创建的 RunContext，
 * 通过 beforeToolCall → evaluatePolicy → policy(context) 显式传播；
 * 不是从 global / singleton / process.env 读取。
 *
 * 不引入 RBAC / IAM / PermissionManager / ContextManager 等抽象。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  type Policy,
  type PolicyContext,
} from "../src/index.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

/** 计数 Tool：execute 被调用时 n++，用于证明 ALLOW（执行）vs DENY（不执行）。 */
function makeCountingTool(counter: { n: number }): AgentTool<any> {
  return {
    name: "count",
    label: "Count",
    description: "Increments a counter (test tool).",
    parameters: Type.Object({}),
    execute: async () => {
      counter.n += 1;
      return { content: [{ type: "text", text: "counted" }], details: { n: counter.n } };
    },
  };
}

async function main(): Promise<void> {
  // 每次 Run 捕获 Policy 实际收到的上下文（证明传播，而非读取 global）。
  let lastReceived: PolicyContext | undefined;

  const workspacePolicy: Policy = (ctx) => {
    lastReceived = ctx;
    if (ctx.workspace?.workspaceId === "allowed-ws") return { type: "allow" };
    return { type: "deny", reason: `workspace ${ctx.workspace?.workspaceId ?? "none"} not allowed` };
  };

  // ---- Case A: allowed-ws → ALLOW → Tool 执行 ----
  console.log("Case A: workspace = allowed-ws");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("count", {});
    m.enqueueFinal("done A");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeCountingTool(counter)],
      policy: workspacePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task A", { workspace: { workspaceId: "allowed-ws" } });

    check("RunResult completed", result.status === "completed", result.status);
    check("Tool executed (counter = 1)", counter.n === 1, counter.n);
    check("Policy received workspace=allowed-ws", lastReceived?.workspace?.workspaceId === "allowed-ws", lastReceived?.workspace);
    check("Policy received runId (propagated)", typeof lastReceived?.runId === "string" && lastReceived.runId.length > 0, lastReceived?.runId);
    check("Policy received sessionId (propagated)", typeof lastReceived?.sessionId === "string" && lastReceived.sessionId.length > 0, lastReceived?.sessionId);
    check("Policy received task=prompt (propagated)", lastReceived?.task === "task A", lastReceived?.task);
    check("Policy received tool name", lastReceived?.toolName === "count", lastReceived?.toolName);
  }

  // ---- Case B: forbidden-ws → DENY → Tool 不执行 ----
  console.log("Case B: workspace = forbidden-ws");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("count", {});
    m.enqueueFinal("done B");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeCountingTool(counter)],
      policy: workspacePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task B", { workspace: { workspaceId: "forbidden-ws" } });

    check("RunResult still completed (deny ≠ run failure)", result.status === "completed", result.status);
    check("Tool NOT executed (counter = 0)", counter.n === 0, counter.n);
    check("Policy received workspace=forbidden-ws", lastReceived?.workspace?.workspaceId === "forbidden-ws", lastReceived?.workspace);
  }

  // ---- Case C: per-Run 隔离（不继承上一次 Run 的 workspace）----
  console.log("Case C: per-Run context isolation");
  {
    // 上一轮是 forbidden-ws；本轮再次用 allowed-ws，必须重新 ALLOW，证明 context 是 per-Run 的。
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("count", {});
    m.enqueueFinal("done C");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeCountingTool(counter)],
      policy: workspacePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    await runtime.run("task C", { workspace: { workspaceId: "allowed-ws" } });
    check("Re-run with allowed-ws ALLOWs again (no shared state)", counter.n === 1, counter.n);
    check("Last received workspace is allowed-ws (not leaked forbidden-ws)", lastReceived?.workspace?.workspaceId === "allowed-ws", lastReceived?.workspace);
  }

  // ---- Case D: 无 workspace → 默认 DENY（证明 workspace 参与决策）----
  console.log("Case D: no workspace supplied");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("count", {});
    m.enqueueFinal("done D");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeCountingTool(counter)],
      policy: workspacePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    await runtime.run("task D");
    check("Tool NOT executed without workspace", counter.n === 0, counter.n);
    check("Policy received undefined workspace", lastReceived?.workspace === undefined, lastReceived?.workspace);
  }

  console.log(`\nPHASE 29-B ACCEPTANCE: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PHASE 29-B ACCEPTANCE: FAILED (uncaught)");
  console.error(err);
  process.exit(1);
});
