/**
 * Phase 33-B — Minimal Durable Audit Acceptance.
 *
 * 证明：Runtime 在关键控制点产生的 Audit Event 可安全、持久、可追踪地保存，
 * 并在 Runtime 崩溃 / 重启后继续读取；且与 Trace 严格分离、不含 secret / resource data。
 *
 * 每个 Scenario 使用独立的 audit 文件，避免跨场景事件污染断言。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  getCustomer,
  createSandboxTestTool,
  FileAuditSink,
  type AuditEvent,
  type Policy,
  type Skill,
} from "../src/index.js";

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  if (!cond) {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  } else {
    console.log(`  [PASS] ${name}`);
  }
}

function readAudit(path: string): AuditEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEvent);
}

const allowPolicy: Policy = () => ({ type: "allow" });
const denyGetCustomer: Policy = (ctx) =>
  ctx.toolName === "get_customer" ? { type: "deny", reason: "not allowed" } : { type: "allow" };

const supportSkill: Skill = {
  id: "cs",
  name: "Customer Support",
  instructions: "Help with customers.",
  toolNames: ["get_customer"],
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "phase33b-"));
  let n = 0;
  const fresh = (): string => join(dir, `audit-${++n}.jsonl`);
  console.log(`audit dir: ${dir}\n`);

  // ---------- Scenario 1: in-process tool + allow + identity/workspace/skill + resource ----------
  console.log("Scenario 1: in-process get_customer (allow, identity/workspace/skill)");
  {
    const auditPath = fresh();
    const m = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      model: m.model,
      streamFn: m.streamFn,
      tools: [getCustomer],
      skill: supportSkill,
      audit: new FileAuditSink(auditPath),
      policy: allowPolicy,
    });
    m.enqueueTool("get_customer", { name: "Alice" });
    m.enqueueFinal("done");
    const result = await rt.run("hi", {
      identity: { userId: "u1", tenantId: "t1" },
      workspace: { workspaceId: "w1" },
    });

    const ev = readAudit(auditPath);
    check("audit file created", existsSync(auditPath));
    check("RUN_STARTED persisted", ev.some((e) => e.eventType === "RUN_STARTED"));
    check("RUN_FINISHED persisted", ev.some((e) => e.eventType === "RUN_FINISHED"));
    check("POLICY_DECISION ALLOW persisted", ev.some((e) => e.eventType === "POLICY_DECISION" && e.policyDecision === "ALLOW"));
    check("TOOL_EXECUTION persisted", ev.some((e) => e.eventType === "TOOL_EXECUTION"));
    const toolEv = ev.find((e) => e.eventType === "TOOL_EXECUTION");
    check("resource persisted (in-process)", toolEv?.resource?.type === "customer" && toolEv?.resource?.id === "Alice", toolEv?.resource);
    check("identity persisted", ev[0]?.identity?.userId === "u1", ev[0]?.identity);
    check("workspace persisted", ev.some((e) => e.workspace?.workspaceId === "w1"));
    check("skillId persisted", ev.some((e) => e.skillId === "cs"));
    check("runId persisted", ev.every((e) => typeof e.runId === "string" && e.runId.length > 0));
    check("sessionId persisted", ev.every((e) => typeof e.sessionId === "string" && e.sessionId.length > 0));
    check("RunResult completed", result.status === "completed", result.status);
    check("Trace still works (lastTrace has events)", (rt.lastTrace()?.events.length ?? 0) > 0);
    check("Trace still contains policy trace (unchanged)", !!rt.lastTrace()?.events.some((t) => t.type === "policy_decision"));
  }

  // ---------- Scenario 2: Policy DENY (governance record of denied action) ----------
  console.log("\nScenario 2: Policy DENY (tool must NOT execute, audit records DENY)");
  {
    const auditPath = fresh();
    const m = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      model: m.model,
      streamFn: m.streamFn,
      tools: [getCustomer],
      audit: new FileAuditSink(auditPath),
      policy: denyGetCustomer,
    });
    m.enqueueTool("get_customer", { name: "Bob" });
    m.enqueueFinal("blocked");
    await rt.run("hi", { identity: { userId: "u2" } });

    const ev = readAudit(auditPath);
    const deny = ev.filter((e) => e.eventType === "POLICY_DECISION" && e.toolName === "get_customer");
    check("POLICY_DECISION DENY persisted", deny.some((e) => e.policyDecision === "DENY"));
    check("denied Tool NOT executed (no TOOL_EXECUTION for get_customer)", !ev.some((e) => e.eventType === "TOOL_EXECUTION" && e.toolName === "get_customer"));
  }

  // ---------- Scenario 3: Execution Boundary attribution + credentialRef ----------
  console.log("\nScenario 3: Execution Boundary (runId/sessionId/resource/credentialRef attribution)");
  {
    const auditPath = fresh();
    const m = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      model: m.model,
      streamFn: m.streamFn,
      audit: new FileAuditSink(auditPath),
      policy: allowPolicy,
    });
    rt.registerTool(createSandboxTestTool(rt.executionTraceSink()));
    m.enqueueTool("sandbox_test", { mode: "echo", text: "hi" });
    m.enqueueFinal("ok");
    await rt.run("hi", { workspace: { workspaceId: "wsX" } });

    const ev = readAudit(auditPath);
    const exec = ev.find((e) => e.eventType === "EXECUTION" && e.outcome === "started");
    check("EXECUTION audit persisted", !!exec);
    check("EXECUTION has runId", typeof exec?.runId === "string" && exec.runId !== "unknown", exec?.runId);
    check("EXECUTION has sessionId", typeof exec?.sessionId === "string", exec?.sessionId);
    check("EXECUTION resource identity (no data)", exec?.resource?.type === "customer" && exec?.resource?.id === "123", exec?.resource);
    check("EXECUTION credentialRef identity-only (no secret)", exec?.credentialRef?.type === "test" && exec?.credentialRef?.id === "readonly", exec?.credentialRef);
    check("EXECUTION finished success", ev.some((e) => e.eventType === "EXECUTION" && e.outcome === "success"));
  }

  // ---------- Scenario 4: Restart persistence (two runtimes, same file) ----------
  console.log("\nScenario 4: Restart persistence (A then B, same file, A not overwritten)");
  {
    const auditPath = fresh();
    const rtA = new EnterpriseAiRuntime({
      model: new ScriptedModel().model,
      streamFn: new ScriptedModel().streamFn,
      tools: [getCustomer],
      audit: new FileAuditSink(auditPath),
      policy: allowPolicy,
    });
    const mA = new ScriptedModel();
    mA.enqueueTool("get_customer", { name: "Alice" });
    mA.enqueueFinal("a");
    await rtA.run("run-A", { identity: { userId: "uA" } });

    const rtB = new EnterpriseAiRuntime({
      model: new ScriptedModel().model,
      streamFn: new ScriptedModel().streamFn,
      tools: [getCustomer],
      audit: new FileAuditSink(auditPath),
      policy: allowPolicy,
    });
    const mB = new ScriptedModel();
    mB.enqueueTool("get_customer", { name: "Bob" });
    mB.enqueueFinal("b");
    await rtB.run("run-B", { identity: { userId: "uB" } });

    const ev = readAudit(auditPath);
    const aEvents = ev.filter((e) => e.identity?.userId === "uA");
    const bEvents = ev.filter((e) => e.identity?.userId === "uB");
    check("Run A events present after restart", aEvents.length > 0);
    check("Run B events present", bEvents.length > 0);
    check("Run A not overwritten by B (both runIds present)", new Set(aEvents.map((e) => e.runId)).size >= 1 && new Set(bEvents.map((e) => e.runId)).size >= 1);
  }

  // ---------- Scenario 5: Crash persistence (spawn child → process.exit → read file) ----------
  console.log("\nScenario 5: Crash persistence (child process exits; audit survives)");
  {
    const auditPath = fresh();
    const childPath = join(import.meta.dirname ?? __dirname, "phase33b-crash-child.ts");
    execFileSync("npx", ["tsx", childPath, auditPath], { cwd: join(import.meta.dirname ?? __dirname, ".."), stdio: "ignore" });
    const ev = readAudit(auditPath);
    check("crash: RUN_STARTED survived process exit", ev.some((e) => e.eventType === "RUN_STARTED"));
    check("crash: POLICY_DECISION survived", ev.some((e) => e.eventType === "POLICY_DECISION"));
    check("crash: TOOL_EXECUTION survived", ev.some((e) => e.eventType === "TOOL_EXECUTION"));
  }

  // ---------- Scenario 6: Cross-run isolation ----------
  console.log("\nScenario 6: Cross-run isolation (A=customer:A, B=customer:B)");
  {
    const auditA = fresh();
    const auditB = fresh();
    async function runWith(name: string, userId: string, path: string) {
      const m = new ScriptedModel();
      const rt = new EnterpriseAiRuntime({
        model: m.model,
        streamFn: m.streamFn,
        tools: [getCustomer],
        audit: new FileAuditSink(path),
        policy: allowPolicy,
      });
      m.enqueueTool("get_customer", { name });
      m.enqueueFinal("ok");
      await rt.run(`run ${name}`, { identity: { userId } });
    }
    await runWith("A", "uA", auditA);
    await runWith("B", "uB", auditB);
    const aEv = readAudit(auditA);
    const bEv = readAudit(auditB);
    const aRun = aEv.find((e) => e.eventType === "RUN_STARTED")?.runId;
    const bRun = bEv.find((e) => e.eventType === "RUN_STARTED")?.runId;
    check("A runId != B runId", aRun !== bRun, [aRun, bRun]);
    check("A events never carry B runId", aEv.every((e) => e.runId === aRun));
    check("B events never carry A runId", bEv.every((e) => e.runId === bRun));
    check("A resource id = A only", aEv.every((e) => !e.resource || e.resource.id === "A"));
    check("B resource id = B only", bEv.every((e) => !e.resource || e.resource.id === "B"));
  }

  // ---------- Scenario 7: No credential secret leakage ----------
  console.log("\nScenario 7: No credential secret leakage");
  {
    const auditPath = fresh();
    process.env.API_KEY = "leak-apikey-12345";
    process.env.PASSWORD = "leak-password-12345";
    process.env.TOKEN = "leak-token-12345";
    process.env.SECRET = "leak-secret-12345";
    process.env.CREDENTIAL_VALUE = "leak-credval-12345";
    const m = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      model: m.model,
      streamFn: m.streamFn,
      audit: new FileAuditSink(auditPath),
      policy: allowPolicy,
    });
    rt.registerTool(createSandboxTestTool(rt.executionTraceSink()));
    m.enqueueTool("sandbox_test", { mode: "echo", text: "x" });
    m.enqueueFinal("ok");
    await rt.run("hi");
    const blob = readFileSync(auditPath, "utf8");
    check("no API_KEY value in audit", !blob.includes("leak-apikey-12345"));
    check("no PASSWORD value in audit", !blob.includes("leak-password-12345"));
    check("no TOKEN value in audit", !blob.includes("leak-token-12345"));
    check("no SECRET value in audit", !blob.includes("leak-secret-12345"));
    check("no CREDENTIAL_VALUE in audit", !blob.includes("leak-credval-12345"));
    check("credentialRef is identity-only", !blob.includes("credentialValue"));
    delete process.env.API_KEY;
    delete process.env.PASSWORD;
    delete process.env.TOKEN;
    delete process.env.SECRET;
    delete process.env.CREDENTIAL_VALUE;
  }

  // ---------- Scenario 8: No resource data leakage ----------
  console.log("\nScenario 8: No resource data leakage (only identity {type,id})");
  {
    const auditPath = fresh();
    const m = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      model: m.model,
      streamFn: m.streamFn,
      tools: [getCustomer],
      audit: new FileAuditSink(auditPath),
      policy: allowPolicy,
    });
    m.enqueueTool("get_customer", { name: "Alice" });
    m.enqueueFinal("ok");
    await rt.run("hi");
    const blob = readFileSync(auditPath, "utf8");
    // get_customer 返回的 company/plan 属于 Resource Data，绝不应进入 Audit。
    check("no resource data (company=Acme) in audit", !blob.includes("Acme"));
    check("no resource data (plan=Enterprise) in audit", !blob.includes("Enterprise"));
    check("resource identity only {type,id}", blob.includes('"type":"customer"') && blob.includes('"id":"Alice"'));
  }

  rmSync(dir, { recursive: true, force: true });

  console.log(`\nACCEPTANCE: phase33b — ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`);
  if (failures.length > 0) {
    console.log("Failed:\n" + failures.map((f) => " - " + f).join("\n"));
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
