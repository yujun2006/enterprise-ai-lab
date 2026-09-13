/**
 * Phase 34-B Acceptance — Crash Recovery Wiring（真实 process.exit(137) + 真实持久化）。
 *
 * 验证链：Run → durable checkpoint → process crash → restart → discover → reconstruct
 *         → reconcile → decide → new Run resume。
 *
 * 不依赖真实 LLM：用 ScriptedModel 确定性驱动 Tool Call + 真实 FileRecoveryStore / FileAuditSink。
 * 运行：npm run acceptance:phase34b
 */
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EnterpriseAiRuntime, FileRecoveryStore } from "../src/index.js";
import type { AgentTool, ReconcileFn } from "../src/index.js";
import {
  ScriptedModel,
  ExternalResource,
  makeCommitTool,
  reconcileFileExternal,
  type CrashMode,
} from "./_p20_fixtures.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

/** 启动崩溃子进程，返回退出码。 */
function runChild(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/_p34b_child.ts")], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function main(): Promise<void> {
  // ============ Case A — Tool 未执行前 crash → 无副作用，recovery 不重复执行 ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p34b-A-"));
    const session = "sess-A";
    const key = "op-A";
    const code = await runChild({ P34_DIR: dir, P34_SESSION: session, P34_KEY: key, P34_MODE: "start-exit" });
    check("A child exited 137 (process death before tool)", code === 137, `code=${code}`);

    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    check("A no recovery record (crash before checkpoint)", (await store.load(session)) === undefined);

    const rt = new EnterpriseAiRuntime({ sessionId: session, store, tools: [makeCommitTool(ext, "none")] });
    const res = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("A decision == continue", res.decision === "continue", res.decision);
    check("A external side effect count == 0 (no re-execution)", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
  }

  // ============ Case B + E — crash before commit → RETRY → 新 Run resume（无重复副作用） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p34b-B-"));
    const session = "sess-B";
    const key = "op-B";
    const code = await runChild({ P34_DIR: dir, P34_SESSION: session, P34_KEY: key, P34_MODE: "precommit-exit" });
    check("B child exited 137 (process death before commit)", code === 137, `code=${code}`);

    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const rec = await store.load(session);
    check("B recovery record persisted (before_tool / running)", rec?.checkpoint.position === "before_tool" && rec?.status === "running", String(rec?.status));

    // Case D — 重启后「发现」unfinished record（不依赖预知 sessionId）
    const all = await store.list();
    check("D discover unfinished record via store.list()", all.some((r) => r.sessionId === session && r.status === "running"), `found=${all.length}`);

    const model = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(ext, "none")],
    });
    const res = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("B decision == RETRY (NOT_FOUND + replay safe)", res.decision === "retry", res.decision);
    check("B retry plan present", !!res.retry, "");

    // Case E — recovery plan → 新 Run（resume = 新 Run，不复活旧 loop）
    model.enqueueTool({ name: res.retry!.toolName, arguments: res.retry!.args as Record<string, unknown> });
    model.enqueueFinal("done");
    await rt.run("retry run");
    await rt.waitForIdle();
    check("E new Run produced exactly 1 side effect (no duplicate)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
  }

  // ============ Case C — External committed + crash → SUCCESS → SKIP（无重复副作用） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p34b-C-"));
    const session = "sess-C";
    const key = "op-C";
    const code = await runChild({ P34_DIR: dir, P34_SESSION: session, P34_KEY: key, P34_MODE: "commit-exit" });
    check("C child exited 137 (process death after commit)", code === 137, `code=${code}`);

    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    check("C External COMMITTED before crash (count = 1)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);

    const model = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(ext, "none")],
    });
    const res = await rt.recoverIfUnfinished(reconcileFileExternal(ext));
    check("C decision == SKIP (SUCCESS)", res.decision === "skip", res.decision);
    // 即使继续新 Run，idempotent tool 不产生新副作用
    model.enqueueFinal("already committed");
    await rt.run("continue");
    await rt.waitForIdle();
    check("C external count still 1 (no duplicate side effect)", (await ext.commitCount()) === 1, `count=${await ext.commitCount()}`);
  }

  // ============ Case F — UNKNOWN → ESCALATE（不自动 retry） ============
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "p34b-F-"));
    const session = "sess-F";
    const key = "op-F";
    const code = await runChild({ P34_DIR: dir, P34_SESSION: session, P34_KEY: key, P34_MODE: "precommit-exit" });
    check("F child exited 137 (process death before commit)", code === 137, `code=${code}`);

    const store = new FileRecoveryStore(dir);
    const ext = new ExternalResource(path.join(dir, "external.json"));
    const unknownReconcile: ReconcileFn = () => "UNKNOWN";
    const model = new ScriptedModel();
    const rt = new EnterpriseAiRuntime({
      sessionId: session,
      store,
      model: model.model,
      streamFn: model.streamFn,
      tools: [makeCommitTool(ext, "none")],
    });
    const res = await rt.recoverIfUnfinished(unknownReconcile);
    check("F decision == ESCALATE (UNKNOWN)", res.decision === "escalate", res.decision);
    check("F no retry plan (never blind-retry UNKNOWN)", res.retry === undefined, "");
    check("F external count == 0 (no automatic Tool execution)", (await ext.commitCount()) === 0, `count=${await ext.commitCount()}`);
  }

  console.log(`\n=== Phase 34-B acceptance: ${failures === 0 ? "PASS" : "FAIL"} (failures=${failures}) ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ACCEPTANCE ERROR:", e);
  process.exit(1);
});
