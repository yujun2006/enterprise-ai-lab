/**
 * Phase 20-1 Acceptance — Idempotent State-changing Tool Recovery with Reconciliation.
 *
 * 不依赖真实 LLM / Ollama：用 ScriptedModel 确定性驱动 Tool Call。
 * 崩溃测试（Test 3 / Test 4）通过真实子进程 process.exit(137) 模拟进程死亡。
 *
 * 运行：npm run acceptance:phase20
 */
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EnterpriseAiRuntime } from "../src/index.js";
import { FileRecoveryStore } from "../src/recovery/file-store.js";
import type { RecoveryStore, Policy, AgentTool } from "../src/index.js";
import {
  ScriptedModel,
  ExternalResource,
  makeCommitTool,
  makeReadOnlyTool,
  reconcileFileExternal,
  type CrashMode,
} from "./_p20_fixtures.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

function wrapTool(tool: AgentTool<any, any>, counter: { n: number }): AgentTool<any, any> {
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      counter.n++;
      return tool.execute(id, params, signal, onUpdate);
    },
  } as AgentTool<any, any>;
}

/** 启动崩溃子进程，返回退出码。 */
function runChild(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/_p20_child.ts")], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function main(): Promise<void> {
  // ============ Test 3 — COMMITTED → SKIP（核心，真实进程死亡） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-t3-"));
    const session = "sess-3";
    const key = "op-123";
    const code = await runChild({ P20_DIR: dir, P20_SESSION: session, P20_KEY: key, P20_MODE: "commit-exit" });
    check("T3 child exited 137 (process death)", code === 137, `code=${code}`);

    const store = new FileRecoveryStore(dir);
    const resource = new ExternalResource(path.join(dir, "external.json"));
    const rec = await store.load(session);
    check("T3 checkpoint persisted after crash", !!rec, "");
    check("T3 durable idempotencyKey == op-123", rec?.checkpoint.idempotencyKey === key, String(rec?.checkpoint.idempotencyKey));
    check("T3 External COMMITTED (side effect count = 1)", (await resource.commitCount()) === 1, `count=${await resource.commitCount()}`);

    const model = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(resource, "none")],
    });
    const res = await runtime.recover(session, reconcileFileExternal(resource));
    check("T3 Recovery Decision == SKIP", res.decision === "skip", res.decision as string);
    check("T3 external count still 1 (no new side effect)", (await resource.commitCount()) === 1, `count=${await resource.commitCount()}`);
    check("T3 idempotencyKey stable across restart", res.idempotencyKey === key, String(res.idempotencyKey));
  }

  // ============ Test 4 — NOT_FOUND → RETRY（真实进程死亡 + 新 Run 重发） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-t4-"));
    const session = "sess-4";
    const key = "op-404";
    const code = await runChild({ P20_DIR: dir, P20_SESSION: session, P20_KEY: key, P20_MODE: "precommit-exit" });
    check("T4 child exited 137 (process death before commit)", code === 137, `code=${code}`);

    const store = new FileRecoveryStore(dir);
    const resource = new ExternalResource(path.join(dir, "external.json"));
    check("T4 External NOT committed (count = 0)", (await resource.commitCount()) === 0, `count=${await resource.commitCount()}`);

    const model = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(resource, "none")],
    });
    const res = await runtime.recover(session, reconcileFileExternal(resource));
    check("T4 Recovery Decision == RETRY", res.decision === "retry", res.decision as string);
    check("T4 retry plan present", !!res.retry, "");

    // RETRY 经新 Run：重发同一 idempotencyKey 的 Tool Call（beforeToolCall → Policy 重评）
    model.enqueueTool({ name: res.retry!.toolName, arguments: res.retry!.args as Record<string, unknown> });
    model.enqueueFinal("done");
    await runtime.run("retry run");
    await runtime.waitForIdle();
    check("T4 RETRY produced exactly 1 side effect", (await resource.commitCount()) === 1, `count=${await resource.commitCount()}`);
  }

  // ============ Test 5 — UNKNOWN → ESCALATE（不自动重试） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-t5-"));
    const session = "sess-5";
    const key = "op-unknown";
    const store = new FileRecoveryStore(dir);
    const resource = new ExternalResource(path.join(dir, "external.json"));
    // 模拟一个中断 Run 遗留的 Checkpoint（未走真实崩溃，仅验证决策）
    await store.save({
      sessionId: session,
      runId: "r-old",
      prompt: "x",
      status: "running",
      checkpoint: { position: "before_tool", toolName: "commit_record", toolArgs: { idempotencyKey: key }, idempotencyKey: key },
      updatedAt: Date.now(),
    });
    const model = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(resource, "none")],
    });
    const res = await runtime.recover(session, () => "UNKNOWN");
    check("T5 Recovery Decision == ESCALATE", res.decision === "escalate", res.decision as string);
    check("T5 no automatic Tool execution (external count = 0)", (await resource.commitCount()) === 0, `count=${await resource.commitCount()}`);
  }

  // ============ Test 6 — Policy Re-evaluation during Recovery (DENY blocks RETRY) ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-t6-"));
    const session = "sess-6";
    const key = "op-6";
    const store = new FileRecoveryStore(dir);
    const resource = new ExternalResource(path.join(dir, "external.json"));
    await store.save({
      sessionId: session,
      runId: "r-old",
      prompt: "x",
      status: "running",
      checkpoint: { position: "before_tool", toolName: "commit_record", toolArgs: { idempotencyKey: key }, idempotencyKey: key },
      updatedAt: Date.now(),
    });
    const counter = { n: 0 };
    const policy: Policy = (call) => (call.toolName === "commit_record" ? { type: "deny", reason: "recovery denied" } : { type: "allow" });
    const model = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [wrapTool(makeCommitTool(resource, "none"), counter)],
      policy,
    });
    const res = await runtime.recover(session, () => "NOT_FOUND");
    check("T6 Recovery Decision == RETRY (NOT_FOUND + replay safe)", res.decision === "retry", res.decision as string);
    model.enqueueTool({ name: res.retry!.toolName, arguments: res.retry!.args as Record<string, unknown> });
    model.enqueueFinal("done");
    await runtime.run("retry run");
    await runtime.waitForIdle();
    check("T6 Policy DENY → Tool NOT executed on RETRY", counter.n === 0, `count=${counter.n}`);
  }

  // ============ Test 1 / 7 / 8 — Session Reconstruction + Continuity + Durable Identity ============
  {
    // --- Test 1 + 7：重建 Session，新 Run，逻辑连续 ---
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-t1-"));
    const session = "sess-1";
    const store = new FileRecoveryStore(dir);
    const modelA = new ScriptedModel();
    const runtimeA = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: modelA.model,
      streamFn: modelA.streamFn,
      tools: [makeReadOnlyTool()],
    });
    modelA.enqueueTool({ name: "echo", arguments: { value: "hi" } });
    modelA.enqueueFinal("answered");
    await runtimeA.run("hi");
    await runtimeA.waitForIdle();
    const runA = runtimeA.lastTrace()?.runId;
    const callA = runtimeA.lastTrace()?.events.find((e) => e.type === "tool_execution_start")?.data.toolCallId as string | undefined;

    // 模拟进程死亡：全新 Runtime 实例（同 store + sessionId）
    const modelB = new ScriptedModel();
    const runtimeB = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: modelB.model,
      streamFn: modelB.streamFn,
      tools: [makeReadOnlyTool()],
    });
    await runtimeB.resume(session);
    check("T1/T7 same sessionId across restart", runtimeB.getSessionId() === session, runtimeB.getSessionId());
    check("T1/T7 transcript reconstructed (messages > 0)", runtimeB.transcript().length > 0, `len=${runtimeB.transcript().length}`);
    modelB.enqueueTool({ name: "echo", arguments: { value: "again" } });
    modelB.enqueueFinal("answered2");
    await runtimeB.run("again");
    await runtimeB.waitForIdle();
    const runB = runtimeB.lastTrace()?.runId;
    const callB = runtimeB.lastTrace()?.events.find((e) => e.type === "tool_execution_start")?.data.toolCallId as string | undefined;
    check("T7 new Run (runId differs)", runB !== runA, `${runA} vs ${runB}`);
    check("T8 toolCallId differs across Run/process", callB !== callA, `${callA} vs ${callB}`);

    // --- Test 8：durable operation identity 跨 Run/进程稳定 ---
    const dir8 = await mkdtemp(path.join(os.tmpdir(), "p20-t8-"));
    const session8 = "sess-8";
    const key8 = "op-8";
    const store8 = new FileRecoveryStore(dir8);
    const resource8 = new ExternalResource(path.join(dir8, "external.json"));
    const mA = new ScriptedModel();
    const rtA = new EnterpriseAiRuntime({
      sessionId: session8,
      store: store8,
      model: mA.model,
      streamFn: mA.streamFn,
      tools: [makeCommitTool(resource8, "none")],
    });
    mA.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key8 } });
    mA.enqueueFinal("done");
    await rtA.run("commit");
    await rtA.waitForIdle();
    const recA = await store8.load(session8);
    check("T8 idempotencyKey durable == op-8", recA?.checkpoint.idempotencyKey === key8, String(recA?.checkpoint.idempotencyKey));
    check("T8 operationId durable == op-8 (captured afterToolCall)", recA?.operationId === key8, String(recA?.operationId));

    const mB = new ScriptedModel();
    const rtB = new EnterpriseAiRuntime({
      sessionId: session8,
      store: store8,
      model: mB.model,
      streamFn: mB.streamFn,
      tools: [makeCommitTool(resource8, "none")],
    });
    await rtB.resume(session8);
    const recB = await store8.load(session8);
    check("T8 idempotencyKey stable across restart", recB?.checkpoint.idempotencyKey === key8, "");
    check("T8 operationId stable across restart", recB?.operationId === key8, "");
    mB.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key8 } });
    mB.enqueueFinal("done");
    await rtB.run("again");
    await rtB.waitForIdle();
    check("T8 runId differs (new Run)", rtB.lastTrace()?.runId !== recA?.runId, `${recA?.runId} vs ${rtB.lastTrace()?.runId}`);
  }

  // ============ Test 2 — Read-only Safe Replay ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-t2-"));
    const session = "sess-2";
    const store = new FileRecoveryStore(dir);
    const counter = { n: 0 };
    const mA = new ScriptedModel();
    const rtA = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: mA.model,
      streamFn: mA.streamFn,
      tools: [wrapTool(makeReadOnlyTool(), counter)],
    });
    mA.enqueueTool({ name: "echo", arguments: { value: "v" } });
    mA.enqueueFinal("a");
    await rtA.run("v");
    await rtA.waitForIdle();
    const c1 = counter.n;
    // 模拟进程死亡：新 Runtime 重建 Session 后重放 read-only Tool
    const mB = new ScriptedModel();
    const rtB = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: mB.model,
      streamFn: mB.streamFn,
      tools: [wrapTool(makeReadOnlyTool(), counter)],
    });
    await rtB.resume(session);
    mB.enqueueTool({ name: "echo", arguments: { value: "v2" } });
    mB.enqueueFinal("a2");
    await rtB.run("v2");
    await rtB.waitForIdle();
    check("T2 read-only Tool replayed safely (executed again)", counter.n > c1, `c1=${c1} c2=${counter.n}`);
  }

  // ============ Extra — Checkpoint Failure → Tool MUST NOT execute ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-cf-"));
    const session = "sess-cf";
    class FailingStore implements RecoveryStore {
      async save(): Promise<void> {
        throw new Error("disk full");
      }
      async load(): Promise<undefined> {
        return undefined;
      }
      async saveMessages(): Promise<void> {}
      async loadMessages(): Promise<undefined> {
        return undefined;
      }
    }
    const store = new FailingStore();
    const counter = { n: 0 };
    const model = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [wrapTool(makeCommitTool(new ExternalResource(path.join(dir, "ext.json")), "none"), counter)],
    });
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: "op-cf" } });
    model.enqueueFinal("done");
    await runtime.run("x");
    await runtime.waitForIdle();
    check("CF checkpoint write failure → Tool NOT executed", counter.n === 0, `count=${counter.n}`);
  }

  // ============ Extra — Duplicate Replay → external side effect count = 1 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p20-dup-"));
    const session = "sess-dup";
    const store = new FileRecoveryStore(dir);
    const resource = new ExternalResource(path.join(dir, "external.json"));
    const model = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(resource, "none")],
    });
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: "op-dup" } });
    model.enqueueFinal("d1");
    await runtime.run("c1");
    await runtime.waitForIdle();
    model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: "op-dup" } });
    model.enqueueFinal("d2");
    await runtime.run("c2");
    await runtime.waitForIdle();
    check("Duplicate Replay → external side effect count == 1", (await resource.commitCount()) === 1, `count=${await resource.commitCount()}`);
  }

  console.log(`\n=== Phase 20-1 acceptance: ${failures === 0 ? "PASS" : "FAIL"} (failures=${failures}) ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ACCEPTANCE ERROR:", e);
  process.exit(1);
});
