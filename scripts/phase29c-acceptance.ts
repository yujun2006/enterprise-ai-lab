/**
 * Phase 29-C — Resource Authorization Acceptance（离线，确定性）。
 *
 * 核心实验：Same User / Same Workspace / Same Tool，仅因 Resource 不同 → 不同 Policy Decision。
 *
 *  - Case A: workspace=allowed-ws, resource=customer:allowed-customer   → ALLOW  → Tool 执行
 *  - Case B: workspace=allowed-ws, resource=customer:forbidden-customer → DENY   → Tool 不执行
 *  - Case C: workspace=forbidden-ws, resource=customer:allowed-customer → DENY（证明 authz = workspace + resource）
 *
 * 关键断言（AC-7/AC-8）：Policy 实际收到 context.resource = { type, id }（仅标识，不含数据），
 * 且该 context 来自当前 Run/Tool Call 的显式传播，不是 global / singleton / process.env。
 *
 * Resource Identity 由 Tool 自身声明（ResourceAwareTool.resource），Runtime 仅传播，不猜测业务参数。
 * 不引入 ResourceManager / PermissionManager / IAM / RBAC / CredentialManager 等抽象。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  type Policy,
  type PolicyContext,
  type ResourceContext,
  type ResourceAwareTool,
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

/**
 * 计数 Tool，自行声明 Resource Identity（来自 args.resourceId）。
 * 用于证明 ALLOW（执行）vs DENY（不执行）：execute 被调用时 counter++。
 */
function makeResourceTool(counter: { n: number }): ResourceAwareTool {
  return {
    name: "resource_op",
    label: "Resource Op",
    description: "Performs an op on a declared resource (test tool).",
    parameters: Type.Object({ resourceId: Type.String() }),
    resource: (args): ResourceContext | undefined => {
      const id = (args as { resourceId?: unknown } | undefined)?.resourceId;
      return typeof id === "string" ? { type: "customer", id } : undefined;
    },
    execute: async () => {
      counter.n += 1;
      return { content: [{ type: "text", text: "ok" }], details: { n: counter.n } };
    },
  };
}

async function main(): Promise<void> {
  // 每次 Run 捕获 Policy 实际收到的上下文（证明传播，而非读取 global）。
  let lastReceived: PolicyContext | undefined;

  // Resource + Workspace aware policy：仅当 workspace=allowed-ws 且 resource=customer:allowed-customer 时 ALLOW。
  // 证明 Authorization = Workspace + Tool + Resource（PolicyContext 同时携带二者，policy 可任意组合）。
  const resourcePolicy: Policy = (ctx) => {
    lastReceived = ctx;
    const wsOk = ctx.workspace?.workspaceId === "allowed-ws";
    const resOk = ctx.resource?.type === "customer" && ctx.resource.id === "allowed-customer";
    if (wsOk && resOk) {
      return { type: "allow" };
    }
    return {
      type: "deny",
      reason: `ws=${ctx.workspace?.workspaceId} resource=${ctx.resource?.type}:${ctx.resource?.id} denied`,
    };
  };

  // ---- Case A: allowed resource → ALLOW → Tool 执行 ----
  console.log("Case A: workspace=allowed-ws, resource=customer:allowed-customer");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("resource_op", { resourceId: "allowed-customer" });
    m.enqueueFinal("done A");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeResourceTool(counter)],
      policy: resourcePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task A", { workspace: { workspaceId: "allowed-ws" } });

    check("RunResult completed", result.status === "completed", result.status);
    check("Tool executed (counter = 1)", counter.n === 1, counter.n);
    check("Policy received resource.type=customer", lastReceived?.resource?.type === "customer", lastReceived?.resource);
    check("Policy received resource.id=allowed-customer", lastReceived?.resource?.id === "allowed-customer", lastReceived?.resource);
  }

  // ---- Case B: forbidden resource → DENY → Tool 不执行 ----
  console.log("Case B: workspace=allowed-ws, resource=customer:forbidden-customer");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("resource_op", { resourceId: "forbidden-customer" });
    m.enqueueFinal("done B");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeResourceTool(counter)],
      policy: resourcePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task B", { workspace: { workspaceId: "allowed-ws" } });

    check("RunResult still completed (deny ≠ run failure)", result.status === "completed", result.status);
    check("Tool NOT executed (counter = 0)", counter.n === 0, counter.n);
    check("Policy received resource.id=forbidden-customer", lastReceived?.resource?.id === "forbidden-customer", lastReceived?.resource);
  }

  // ---- Case C: allowed resource but forbidden workspace → DENY ----
  console.log("Case C: workspace=forbidden-ws, resource=customer:allowed-customer");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("resource_op", { resourceId: "allowed-customer" });
    m.enqueueFinal("done C");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeResourceTool(counter)],
      policy: resourcePolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task C", { workspace: { workspaceId: "forbidden-ws" } });

    check("RunResult still completed", result.status === "completed", result.status);
    check("Tool NOT executed under forbidden workspace (counter = 0)", counter.n === 0, counter.n);
    check("Policy received workspace=forbidden-ws (combined authz)", lastReceived?.workspace?.workspaceId === "forbidden-ws", lastReceived?.workspace);
  }

  // ---- Case D: Resource Data 不进入 Policy ----
  console.log("Case D: Policy receives Resource Identity, not Resource Data");
  {
    check("resource has only type+id (no data leak)", (() => {
      const r = lastReceived?.resource;
      if (!r) return false;
      const keys = Object.keys(r).sort();
      return keys.length === 2 && keys[0] === "id" && keys[1] === "type";
    })(), lastReceived?.resource);
  }

  console.log(`\nPHASE 29-C ACCEPTANCE: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PHASE 29-C ACCEPTANCE: FAILED (uncaught)");
  console.error(err);
  process.exit(1);
});
