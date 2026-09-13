/**
 * Phase 31 — Execution Boundary Context Propagation Acceptance（离线，确定性）。
 *
 * 中央命题：Runtime-owned 执行上下文（runId/sessionId/toolName/resource/credentialRef）
 * 能否安全、显式、可追踪地跨越 Execution Boundary 到达 Child Process，且 secret 绝不跨边界。
 *
 * 复用既有调用链：Runtime → Tool.execute() → executeInBoundary()，
 * 不新增 ExecutionFacade / ExecutionService（Context 通过 ExecutionRequest.context 显式参数传播；
 * runId/sessionId 由 Tool 通过已注入的 ExecutionTraceSink.runIdentity() 取得，无需新抽象）。
 *
 * Cases：
 *   A  context reaches child（runId/sessionId/toolName/resource/credentialRef 均被子进程观察到）
 *   B  run isolation（Run A → run-A，Run B → run-B，互不串号）
 *   C  secret non-leakage（Runtime SECRET 不进子进程；credentialRef 仅 {type,id}）
 *   D  timeout still works（sleep 30 + 1000ms kill；Runtime 继续）
 *   E  failure attribution（exit 1 → trace 含 runId/toolName/status；trace 无 secret）
 */
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  createSandboxTestTool,
  type ExecutionResult,
  type ExecutionTraceSink,
  type ExecutionContext,
} from "../src/index.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

// 仅身份引用允许出现在上下文中；任何下列 token 出现都视为 secret 泄漏。
const FORBIDDEN = ["apiKey", "token", "password", "secret", "privateKey", "credentialValue", "sk-"];

interface Capture {
  res?: ExecutionResult;
  cwd?: string;
}
/** 把边界结果并入 Runtime Trace，并捕获 raw ExecutionResult / cwd 供断言。 */
function captureSink(runtimeSink: ExecutionTraceSink): { sink: ExecutionTraceSink; cap: Capture } {
  const cap: Capture = {};
  const sink: ExecutionTraceSink = {
    runIdentity: () => runtimeSink.runIdentity?.(),
    onExecutionStart: (r, ctx) => {
      cap.cwd = r.cwd;
      runtimeSink.onExecutionStart?.(r, ctx);
    },
    onExecutionFinished: (res, ctx) => {
      cap.res = res;
      runtimeSink.onExecutionFinished?.(res, ctx);
    },
    onExecutionTimeout: (r, ctx) => {
      cap.cwd = r.cwd;
      runtimeSink.onExecutionTimeout?.(r, ctx);
    },
  };
  return { sink, cap };
}

/** 运行一个 sandbox_test mode，返回子进程结果与本次 Run 的 trace。 */
async function main(): Promise<void> {
  // 在 Runtime 进程内埋一个假 secret（仅测试用，不进入任何 Credential Store）。
  process.env.SECRET_SHOULD_NOT_CROSS_BOUNDARY = "leak-NO-12345";

  /** 单个 Run：构造 runtime + sink，执行某 mode，返回 { res, trace, childContext, cap }。 */
  async function oneRun(mode: string, text?: string): Promise<{
    res?: ExecutionResult;
    trace: ReturnType<EnterpriseAiRuntime["lastTrace"]>;
    childContext?: ExecutionContext;
    cap: Capture;
  }> {
    const m = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));
    m.enqueueTool("sandbox_test", { mode, text });
    m.enqueueFinal(`done ${mode}`);
    await runtime.run(`run ${mode}`, { workspace: { workspaceId: "ws" } });
    let childContext: ExecutionContext | undefined;
    if (mode === "context" && cap.res) {
      try {
        childContext = JSON.parse(cap.res.stdout.trim()) as ExecutionContext;
      } catch {
        childContext = undefined;
      }
    }
    return { res: cap.res, trace: runtime.lastTrace(), childContext, cap };
  }

  function traceHasSecret(trace: ReturnType<EnterpriseAiRuntime["lastTrace"]>): boolean {
    const blob = JSON.stringify(trace?.events ?? []);
    return FORBIDDEN.some((t) => blob.toLowerCase().includes(t.toLowerCase())) || blob.includes("SECRET_SHOULD_NOT_CROSS_BOUNDARY");
  }

  // ---- Case A: context reaches child ----
  console.log("Case A: runtime context reaches child process");
  {
    const { res, childContext, trace } = await oneRun("context");
    check("child stdout parseable as ExecutionContext", !!childContext, res?.stdout);
    check("child sees runId", !!childContext?.runId && childContext.runId !== "unknown", childContext);
    check("child sees sessionId", !!childContext?.sessionId, childContext);
    check("child sees toolName=sandbox_test", childContext?.toolName === "sandbox_test", childContext);
    check("child sees resource {type:customer,id:123}", childContext?.resource?.type === "customer" && childContext.resource.id === "123", childContext?.resource);
    check("child sees credentialRef {type:test,id:readonly}", childContext?.credentialRef?.type === "test" && childContext.credentialRef.id === "readonly", childContext?.credentialRef);
    // 与 trace 内 execution_started 记录的 runId 一致（同一 Runtime-owned 身份）。
    const started = trace?.events.find((e) => e.type === "execution_started");
    check("trace execution_started carries runId", (started?.data as { runId?: string })?.runId === childContext?.runId, started?.data);
    check("trace has no secret", !traceHasSecret(trace));
  }

  // ---- Case B: run isolation ----
  console.log("Case B: run isolation (Child A→run-A, Child B→run-B)");
  {
    const a = await oneRun("context");
    const b = await oneRun("context");
    check("Run A and Run B have distinct runId", a.childContext?.runId !== b.childContext?.runId, [a.childContext?.runId, b.childContext?.runId]);
    check("Child A bound to run-A", a.childContext?.runId === (a.trace?.events.find((e) => e.type === "execution_started")?.data as { runId?: string })?.runId, a.childContext?.runId);
    check("Child B bound to run-B (not run-A)", b.childContext?.runId === (b.trace?.events.find((e) => e.type === "execution_started")?.data as { runId?: string })?.runId && b.childContext?.runId !== a.childContext?.runId, b.childContext?.runId);
  }

  // ---- Case C: secret non-leakage ----
  console.log("Case C: credential secret does NOT propagate");
  {
    const dump = await oneRun("envdump");
    check("child env does NOT contain Runtime SECRET", !(dump.res?.stdout ?? "").includes("SECRET_SHOULD_NOT_CROSS_BOUNDARY"), dump.res?.stdout.slice(0, 200));
    check("child env does NOT inherit full process.env (no npm_/PATH leak of secret)", !(dump.res?.stdout ?? "").includes("leak-NO-12345"));
    const ctxRun = await oneRun("context");
    const blob = JSON.stringify(ctxRun.childContext);
    check("EXECUTION_CONTEXT_JSON has no forbidden secret token", !FORBIDDEN.some((t) => blob.toLowerCase().includes(t.toLowerCase())), blob);
    check("credentialRef is identity-only (type/id)", ctxRun.childContext?.credentialRef?.type === "test" && ctxRun.childContext.credentialRef.id === "readonly", ctxRun.childContext?.credentialRef);
  }

  // ---- Case D: timeout regression ----
  console.log("Case D: timeout still works (sleep 30 + 1000ms kill; Runtime continues)");
  {
    const m = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));
    m.enqueueTool("sandbox_test", { mode: "timeout" });
    m.enqueueFinal("after-timeout");
    const t0 = Date.now();
    const c = await runtime.run("run timeout", { workspace: { workspaceId: "ws" } });
    const dur = Date.now() - t0;
    check("RunResult completed", c.status === "completed", c.status);
    check("child killed", cap.res?.killed === true, cap.res);
    check("timedOut=true", cap.res?.timedOut === true, cap.res);
    check("exitCode null (killed)", cap.res?.exitCode === null, cap.res);
    check("killed within ~1s (<3s)", dur < 3000, dur);
    check("trace has execution_timeout", runtime.lastTrace()?.events.some((e) => e.type === "execution_timeout") === true);
    // Runtime 在超时后仍可用（Phase 28-A 回归）。
    m.enqueueTool("sandbox_test", { mode: "echo", text: "revived" });
    m.enqueueFinal("ok");
    const d = await runtime.run("run echo after timeout", { workspace: { workspaceId: "ws" } });
    check("Runtime still runs after timeout", d.status === "completed", d.status);
  }

  // ---- Case E: failure attribution + trace no secret ----
  console.log("Case E: child failure is attributable (exit 1) and trace has no secret");
  {
    const { res, trace } = await oneRun("fail");
    const finished = trace?.events.find((e) => e.type === "execution_finished");
    check("execution_finished has exitCode=1", (finished?.data as { exitCode?: number })?.exitCode === 1, finished?.data);
    check("execution_finished carries runId (attribution)", typeof (finished?.data as { runId?: string })?.runId === "string", finished?.data);
    check("execution_finished carries toolName", (finished?.data as { toolName?: string })?.toolName === "sandbox_test", finished?.data);
    check("trace contains no secret (incl. Runtime SECRET)", !traceHasSecret(trace), "see trace");
  }

  // 清理测试 secret。
  delete process.env.SECRET_SHOULD_NOT_CROSS_BOUNDARY;

  console.log(`\nPHASE 31 ACCEPTANCE: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("PHASE 31 ACCEPTANCE: FAILED (uncaught)");
  console.error(err);
  process.exit(1);
});
