/**
 * Phase 35-B Acceptance — External Tool Boundary (MCP Validation)（真实进程 + 真实持久化）。
 *
 * 验证：把 state-changing Tool 从 Runtime 进程内移到进程外（最小 MCP-style stdio Server）后，
 * Phase 20–34 的 Kernel Contract 是否仍然成立：
 *   S1 Policy 前置门  S2 Context 往返  S3 Secret 不泄漏  S4 Resource 仅标识
 *   S5 Audit 归属      S6 提交前崩溃→RETRY  S7 提交后崩溃→SKIP  S8 UNKNOWN→ESCALATE
 *   S9 跨 Run 隔离     S10 Recovery 发现
 *
 * 不修改任何 src/ Kernel 原语；仅新增实验文件。运行：npx tsx scripts/phase35b-acceptance.ts
 */
import { mkdtemp } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EnterpriseAiRuntime, FileRecoveryStore, FileAuditSink } from "../src/index.js";
import type { Policy, ReconcileFn } from "../src/index.js";
import { ScriptedModel, ExternalResource, reconcileFileExternal } from "./_p20_fixtures.js";
import { makeMcpCommitTool } from "./_p35_mcp_fixtures.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function readLines(p: string): Promise<string[]> {
  try {
    return (await fs.readFile(p, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
async function readAudit(p: string): Promise<any[]> {
  const lines = await readLines(p);
  return lines.map((l) => JSON.parse(l));
}

/** 启动崩溃子进程，返回退出码。子进程继承本进程 env（含 secret），但 Server 只收到显式 P35_*。 */
function runChild(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/_p35b_child.ts")], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

function buildRuntime(opts: {
  sessionId: string;
  store: FileRecoveryStore;
  audit?: FileAuditSink;
  model: ScriptedModel;
  dir: string;
  policy?: Policy;
}) {
  const extFile = path.join(opts.dir, "external.json");
  const callsLog = path.join(opts.dir, "calls.log");
  const envLog = path.join(opts.dir, "env.log");
  let runtime: EnterpriseAiRuntime;
  runtime = new EnterpriseAiRuntime({
    sessionId: opts.sessionId,
    store: opts.store,
    audit: opts.audit,
    policy: opts.policy,
    model: opts.model.model,
    streamFn: opts.model.streamFn,
    tools: [
      makeMcpCommitTool({
        serverEntry: path.resolve("scripts/_p35_mcp_server.ts"),
        extFile,
        callsLog,
        envLog,
        sink: () => runtime.executionTraceSink(),
      }),
    ],
  });
  return runtime;
}

async function main(): Promise<void> {
  const SERVER = path.resolve("scripts/_p35_mcp_server.ts");

  // ============ S1 — Policy DENY：MCP Server 收到 0 call，External 0 副作用 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p35b-S1-"));
    const extFile = path.join(dir, "external.json");
    const callsLog = path.join(dir, "calls.log");
    const envLog = path.join(dir, "env.log");
    const auditFile = path.join(dir, "audit.jsonl");
    const ext = new ExternalResource(extFile);
    const store = new FileRecoveryStore(dir);
    const audit = new FileAuditSink(auditFile);
    const denyPolicy: Policy = (ctx) =>
      ctx.toolName === "create_customer" ? { type: "deny", reason: "blocked" } : { type: "allow" };
    const model = new ScriptedModel();
    model.enqueueTool({ name: "create_customer", arguments: { idempotencyKey: "Alice" } });
    model.enqueueFinal("denied");
    const runtime = buildRuntime({ sessionId: "sess-S1", store, audit, model, dir, policy: denyPolicy });
    await runtime.run("create Alice");
    await runtime.waitForIdle();
    check("S1 external side effect == 0", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
    check("S1 server never spawned (calls.log absent)", !(await exists(callsLog)));
    const evts = await readAudit(auditFile);
    const denyEvt = evts.find((e) => e.eventType === "POLICY_DECISION" && e.toolName === "create_customer");
    check("S1 policy decision == DENY", denyEvt?.policyDecision === "DENY");
    const started = evts.find(
      (e) => e.eventType === "TOOL_EXECUTION" && e.outcome === "started" && e.toolName === "create_customer",
    );
    check("S1 NO tool execution started (server not called)", started === undefined);
  }

  // ============ S2 Context 往返 / S3 Secret 不泄漏 / S4 Resource 仅标识 / S5 Audit 归属 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p35b-CTX-"));
    const extFile = path.join(dir, "external.json");
    const callsLog = path.join(dir, "calls.log");
    const envLog = path.join(dir, "env.log");
    const auditFile = path.join(dir, "audit.jsonl");
    const secrets = { FAKE_SECRET: "super-secret-value", API_KEY: "sk-12345", PASSWORD: "pw-999", TOKEN: "tok-abc" };
    Object.assign(process.env, secrets);
    const ext = new ExternalResource(extFile);
    const store = new FileRecoveryStore(dir);
    const audit = new FileAuditSink(auditFile);
    const model = new ScriptedModel();
    model.enqueueTool({ name: "create_customer", arguments: { idempotencyKey: "Alice" } });
    model.enqueueFinal("done");
    const runtime = buildRuntime({ sessionId: "sess-CTX", store, audit, model, dir });
    const res = await runtime.run("create Alice");
    await runtime.waitForIdle();
    check("S2 run completed", res.status === "completed", res.status);
    check("S4 external has exactly 1 (Alice)", (await ext.commitCount()) === 1);

    const calls = (await readLines(callsLog)).map((l) => JSON.parse(l));
    const call = calls[0];
    check("S2 server received exactly 1 call", calls.length === 1, `n=${calls.length}`);
    check("S2 meta.runId present", !!call?.meta?.runId);
    check("S2 meta.sessionId == sess-CTX", call?.meta?.sessionId === "sess-CTX");
    check(
      "S2 meta.resource == {customer,Alice}",
      call?.meta?.resource?.type === "customer" && call?.meta?.resource?.id === "Alice",
    );
    check(
      "S2 meta.credentialRef == {crm,readonly}",
      call?.meta?.credentialRef?.type === "crm" && call?.meta?.credentialRef?.id === "readonly",
    );

    const callsText = await fs.readFile(callsLog, "utf8");
    const envText = await fs.readFile(envLog, "utf8");
    const leak = Object.values(secrets).some((v) => callsText.includes(v) || envText.includes(v));
    check("S3 no secret VALUE in calls/env logs", !leak);
    const envKeys: string[] = JSON.parse(envText);
    check(
      "S3 server env has no secret KEYS",
      !["FAKE_SECRET", "API_KEY", "PASSWORD", "TOKEN"].some((k) => envKeys.includes(k)),
      envKeys.join(","),
    );

    const evts = await readAudit(auditFile);
    const started = evts.find(
      (e) => e.eventType === "TOOL_EXECUTION" && e.outcome === "started" && e.toolName === "create_customer",
    );
    check("S5 audit TOOL_EXECUTION(started) present", !!started);
    check("S5 audit runId present", !!started?.runId);
    check("S5 audit sessionId == sess-CTX", started?.sessionId === "sess-CTX");
    check("S5 audit resource == {customer,Alice}", started?.resource?.type === "customer" && started?.resource?.id === "Alice");
    check(
      "S5 audit credentialRef == {crm,readonly}",
      started?.credentialRef?.type === "crm" && started?.credentialRef?.id === "readonly",
    );
    check(
      "S5 audit POLICY_DECISION == ALLOW",
      evts.find((e) => e.eventType === "POLICY_DECISION" && e.toolName === "create_customer")?.policyDecision === "ALLOW",
    );
    check("S5 no secret VALUE in audit", !Object.values(secrets).some((v) => JSON.stringify(evts).includes(v)));
    check("S5 audit has NO args/result payload leak", !JSON.stringify(evts).includes("super-secret-value"));

    for (const k of Object.keys(secrets)) delete process.env[k];
  }

  // ============ S6 提交前崩溃 → External NOT_FOUND → RETRY（无重复） + S10 Recovery 发现 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p35b-S6-"));
    const key = "op-S6";
    const code = await runChild({ P35_DIR: dir, P35_SESSION: "sess-S6", P35_KEY: key, P35_CRASH: "before" });
    check("S6 child exited 137 (death before commit)", code === 137, `code=${code}`);
    const extFile = path.join(dir, "external.json");
    const ext = new ExternalResource(extFile);
    check("S6 external NOT_FOUND (count 0)", (await ext.commitCount()) === 0);
    const store = new FileRecoveryStore(dir);
    const rec = await store.load("sess-S6");
    check("S6 recovery record running/before_tool", rec?.checkpoint.position === "before_tool" && rec?.status === "running");
    const all = await store.list();
    check("S10 discovered unfinished op via store.list()", all.some((r) => r.sessionId === "sess-S6" && r.status === "running"));

    const model = new ScriptedModel();
    const rt = buildRuntime({ sessionId: "sess-S6", store, model, dir });
    const rr = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("S6 decision == RETRY", rr.decision === "retry", rr.decision);
    check("S6 retry plan present", !!rr.retry);
    model.enqueueTool({ name: rr.retry!.toolName, arguments: rr.retry!.args as Record<string, unknown> });
    model.enqueueFinal("done");
    await rt.run("retry");
    await rt.waitForIdle();
    check("S6 external side effect == 1 (no duplicate)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
  }

  // ============ S7 提交后崩溃（result 丢失）→ External SUCCESS → SKIP（无重复） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p35b-S7-"));
    const key = "op-S7";
    const code = await runChild({ P35_DIR: dir, P35_SESSION: "sess-S7", P35_KEY: key, P35_CRASH: "after" });
    check("S7 child exited 137 (death after commit)", code === 137, `code=${code}`);
    const extFile = path.join(dir, "external.json");
    const ext = new ExternalResource(extFile);
    check("S7 external COMMITTED before crash (count 1)", (await ext.commitCount()) === 1);
    const store = new FileRecoveryStore(dir);
    const model = new ScriptedModel();
    const rt = buildRuntime({ sessionId: "sess-S7", store, model, dir });
    const rr = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("S7 decision == SKIP", rr.decision === "skip", rr.decision);
    model.enqueueFinal("already committed");
    await rt.run("continue");
    await rt.waitForIdle();
    check("S7 external count still 1 (no duplicate)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
  }

  // ============ S8 传输失败 + reconcile UNKNOWN → ESCALATE（绝不自动 retry） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p35b-S8-"));
    const key = "op-S8";
    const code = await runChild({ P35_DIR: dir, P35_SESSION: "sess-S8", P35_KEY: key, P35_CRASH: "before" });
    check("S8 child exited 137 (transport failure)", code === 137, `code=${code}`);
    const extFile = path.join(dir, "external.json");
    const ext = new ExternalResource(extFile);
    check("S8 external NOT_FOUND (count 0)", (await ext.commitCount()) === 0);
    const store = new FileRecoveryStore(dir);
    const unknownReconcile: ReconcileFn = () => "UNKNOWN";
    const model = new ScriptedModel();
    const rt = buildRuntime({ sessionId: "sess-S8", store, model, dir });
    const rr = await rt.recoverIfUnfinished(unknownReconcile);
    check("S8 decision == ESCALATE", rr.decision === "escalate", rr.decision);
    check("S8 no retry plan (never blind-retry UNKNOWN)", rr.retry === undefined);
    check("S8 external count still 0 (no automatic side effect)", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
  }

  // ============ S9 跨 Run 隔离：不同 run/session/resource 不互相泄漏 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p35b-S9-"));
    const extFile = path.join(dir, "external.json");
    const auditFile = path.join(dir, "audit.jsonl");
    const ext = new ExternalResource(extFile);
    const store = new FileRecoveryStore(dir);
    const audit = new FileAuditSink(auditFile);

    const modelA = new ScriptedModel();
    modelA.enqueueTool({ name: "create_customer", arguments: { idempotencyKey: "Alice" } });
    modelA.enqueueFinal("done");
    const rtA = buildRuntime({ sessionId: "sess-S9", store, audit, model: modelA, dir });
    await rtA.run("create Alice");
    await rtA.waitForIdle();

    const modelB = new ScriptedModel();
    modelB.enqueueTool({ name: "create_customer", arguments: { idempotencyKey: "Bob" } });
    modelB.enqueueFinal("done");
    const rtB = buildRuntime({ sessionId: "sess-S9", store, audit, model: modelB, dir });
    await rtB.run("create Bob");
    await rtB.waitForIdle();

    check("S9 external has 2 (Alice,Bob)", (await ext.commitCount()) === 2, `count=${await ext.commitCount()}`);
    const evts = await readAudit(auditFile);
    const started = evts.filter((e) => e.eventType === "TOOL_EXECUTION" && e.outcome === "started");
    const runIds = new Set(started.map((e) => e.runId));
    check("S9 two distinct runIds", runIds.size === 2, `n=${runIds.size}`);
    const aliceEvt = started.find((e) => e.resource?.id === "Alice");
    const bobEvt = started.find((e) => e.resource?.id === "Bob");
    check("S9 Alice run != Bob run", !!aliceEvt && !!bobEvt && aliceEvt.runId !== bobEvt.runId);
    check("S9 Alice event resource Alice", aliceEvt?.resource?.type === "customer" && aliceEvt?.resource?.id === "Alice");
    check("S9 Bob event resource Bob", bobEvt?.resource?.type === "customer" && bobEvt?.resource?.id === "Bob");
    check("S9 no cross-run resource leakage (Bob != Alice)", bobEvt?.resource?.id !== "Alice");
  }

  console.log(`\n=== Phase 35-B acceptance: ${failures === 0 ? "PASS" : "FAIL"} (failures=${failures}) ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ACCEPTANCE ERROR:", e);
  process.exit(1);
});
