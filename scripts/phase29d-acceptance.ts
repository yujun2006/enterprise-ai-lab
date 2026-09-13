/**
 * Phase 29-D — Credential Authorization Acceptance（离线，确定性）。
 *
 * 核心实验：Same Tool / Same Workspace，仅因 Credential Reference 不同 → 不同 Policy Decision。
 *
 *  - Case A: credential = smtp-account   → ALLOW  → Tool 执行
 *  - Case B: credential = smtp-admin-account → DENY → Tool 不执行
 *
 * 关键断言（AC）：Policy 实际收到 context.credentialRef = { type, id }（仅引用，不含密钥），
 * 且该 context 来自当前 Run/Tool Call 的显式传播，不是 global / singleton / process.env。
 *
 * Credential Identity 由 Tool 自身声明（CredentialAwareTool.credential），Runtime 仅传播，
 * 不猜测业务参数、不持有密钥。不引入 CredentialManager / Vault / SecretProvider / IAM / RBAC。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  type Policy,
  type PolicyContext,
  type CredentialContext,
  type CredentialAwareTool,
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
 * send-email 风格 Tool，自行声明所需 Credential Reference（来自 args.accountId）。
 * 用于证明 ALLOW（执行）vs DENY（不执行）：execute 被调用时 counter++。
 */
function makeSendEmailTool(counter: { n: number }): CredentialAwareTool {
  return {
    name: "send_email",
    label: "Send Email",
    description: "Sends an email using a declared SMTP credential (test tool).",
    parameters: Type.Object({ accountId: Type.String(), to: Type.String() }),
    // Phase 29-D — Tool 声明本次调用需要的 Credential Reference（仅 type/id，不含密钥）。
    credential: (args): CredentialContext | undefined => {
      const id = (args as { accountId?: unknown } | undefined)?.accountId;
      return typeof id === "string" ? { type: "smtp", id } : undefined;
    },
    execute: async () => {
      counter.n += 1;
      return { content: [{ type: "text", text: "sent" }], details: { n: counter.n } };
    },
  };
}

async function main(): Promise<void> {
  // 每次 Run 捕获 Policy 实际收到的上下文（证明传播，而非读取 global）。
  let lastReceived: PolicyContext | undefined;

  // Credential-aware policy：仅允许 smtp:smtp-account。
  const credentialPolicy: Policy = (ctx) => {
    lastReceived = ctx;
    const c = ctx.credentialRef;
    if (c?.type === "smtp" && c.id === "smtp-account") {
      return { type: "allow" };
    }
    return { type: "deny", reason: `credential ${c?.type}:${c?.id} denied` };
  };

  // ---- Case A: allowed credential → ALLOW → Tool 执行 ----
  console.log("Case A: workspace=allowed-ws, credential=smtp:smtp-account");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("send_email", { accountId: "smtp-account", to: "a@b.com" });
    m.enqueueFinal("done A");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeSendEmailTool(counter)],
      policy: credentialPolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task A", { workspace: { workspaceId: "allowed-ws" } });

    check("RunResult completed", result.status === "completed", result.status);
    check("Tool executed (counter = 1)", counter.n === 1, counter.n);
    check("Policy received credentialRef.type=smtp", lastReceived?.credentialRef?.type === "smtp", lastReceived?.credentialRef);
    check("Policy received credentialRef.id=smtp-account", lastReceived?.credentialRef?.id === "smtp-account", lastReceived?.credentialRef);
  }

  // ---- Case B: denied credential → DENY → Tool 不执行 ----
  console.log("Case B: workspace=allowed-ws, credential=smtp:smtp-admin-account");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("send_email", { accountId: "smtp-admin-account", to: "a@b.com" });
    m.enqueueFinal("done B");
    const runtime = new EnterpriseAiRuntime({
      tools: [makeSendEmailTool(counter)],
      policy: credentialPolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task B", { workspace: { workspaceId: "allowed-ws" } });

    check("RunResult still completed (deny ≠ run failure)", result.status === "completed", result.status);
    check("Tool NOT executed (counter = 0)", counter.n === 0, counter.n);
    check("Policy received credentialRef.id=smtp-admin-account", lastReceived?.credentialRef?.id === "smtp-admin-account", lastReceived?.credentialRef);
  }

  // ---- Case C: Credential Reference 仅含 type+id，绝不含密钥 ----
  console.log("Case C: Credential Reference is identity-only, not secret material");
  {
    const c = lastReceived?.credentialRef;
    check("credentialRef present", !!c, c);
    check("credentialRef has only type+id (no secret)", (() => {
      if (!c) return false;
      const keys = Object.keys(c).sort();
      return keys.length === 2 && keys[0] === "id" && keys[1] === "type";
    })(), c);
    const forbidden = ["apiKey", "secret", "token", "password", "value", "key", "privateKey"];
    check("credentialRef contains no secret field", !c || forbidden.every((k) => !(k in c)), c);
  }

  // ---- Case D: Tool 无 credential 声明 → credentialRef 为 undefined → 仍被 Policy 评估 ----
  console.log("Case D: Tool without credential declaration");
  {
    const counter = { n: 0 };
    const plain: AgentTool<any> = {
      name: "noop",
      label: "Noop",
      description: "Tool with no credential declaration.",
      parameters: Type.Object({}),
      execute: async () => {
        counter.n += 1;
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };
    const m = new ScriptedModel();
    m.enqueueTool("noop", {});
    m.enqueueFinal("done D");
    const runtime = new EnterpriseAiRuntime({
      tools: [plain],
      policy: credentialPolicy,
      model: m.model,
      streamFn: m.streamFn,
    });
    await runtime.run("task D", { workspace: { workspaceId: "allowed-ws" } });
    check("Policy received credentialRef=undefined (no declaration)", lastReceived?.credentialRef === undefined, lastReceived?.credentialRef);
    check("No-credential Tool is DENIED and NOT executed (counter=0)", counter.n === 0, counter.n);
  }

  console.log(`\nPHASE 29-D ACCEPTANCE: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("PHASE 29-D ACCEPTANCE: FAILED (uncaught)");
  console.error(err);
  process.exit(1);
});
