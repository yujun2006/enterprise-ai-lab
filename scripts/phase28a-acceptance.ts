/**
 * Phase 28-A — Minimal Execution Boundary Acceptance（离线，确定性）。
 *
 * 不经过真实 LLM：用 ScriptedModel 驱动 Pi Agent 调用 sandbox_test Tool，
 * 该 Tool 把命令执行委托给 Execution Boundary（独立子进程）。
 *
 * 覆盖：
 *  A 正常命令        B 命令失败        C 超时 kill
 *  D 超时后 Runtime 仍可运行（恢复）   E 多次执行   F cwd 隔离 + 清理
 *  Failure Experiment：sleep 30 + timeout 1000 → 子进程被 kill / Runtime 不挂起 / Trace 记录 / 无残留。
 */
import { existsSync } from "node:fs";
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  createSandboxTestTool,
  type ExecutionResult,
  type ExecutionTraceSink,
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

interface Capture {
  res?: ExecutionResult;
  cwd?: string;
}
/** 把边界结果并入 Runtime Trace，同时捕获 stdout/stderr/exitCode/cwd 供断言使用。 */
function captureSink(runtimeSink: ExecutionTraceSink): { sink: ExecutionTraceSink; cap: Capture } {
  const cap: Capture = {};
  const sink: ExecutionTraceSink = {
    onExecutionStart: (r) => {
      cap.cwd = r.cwd;
      runtimeSink.onExecutionStart?.(r);
    },
    onExecutionFinished: (res) => {
      cap.res = res;
      runtimeSink.onExecutionFinished?.(res);
    },
    onExecutionTimeout: (r) => {
      cap.cwd = r.cwd;
      runtimeSink.onExecutionTimeout?.(r);
    },
  };
  return { sink, cap };
}

async function main(): Promise<void> {
  // ---- Case A: 正常命令 ----
  console.log("Case A: normal command");
  {
    const m = new ScriptedModel();
    m.enqueueTool("sandbox_test", { mode: "echo", text: "hello" });
    m.enqueueFinal("done");
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));
    const result = await runtime.run("run echo");
    check("RunResult completed", result.status === "completed", result.status);
    check("exitCode 0", cap.res?.exitCode === 0, cap.res);
    check("stdout contains hello", (cap.res?.stdout ?? "").includes("hello"), cap.res?.stdout);
    check("not timedOut", cap.res?.timedOut === false);
    check("trace has execution_started", runtime.lastTrace()?.events.some((e) => e.type === "execution_started") === true);
    check("trace has execution_finished", runtime.lastTrace()?.events.some((e) => e.type === "execution_finished") === true);
  }

  // ---- Case B: 命令失败（exit 1）----
  console.log("Case B: command failure (exit 1)");
  {
    const m = new ScriptedModel();
    m.enqueueTool("sandbox_test", { mode: "fail" });
    m.enqueueFinal("continued");
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));
    const result = await runtime.run("run fail");
    check("RunResult still completed (tool error does not abort run)", result.status === "completed", result.status);
    check("exitCode 1", cap.res?.exitCode === 1, cap.res);
  }

  // ---- Case C + D: 超时 kill + 超时后 Runtime 仍可运行 ----
  console.log("Case C: timeout kill");
  {
    const m = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));

    m.enqueueTool("sandbox_test", { mode: "timeout" }); // sleep 30, 边界 timeout 1000ms
    m.enqueueFinal("after-timeout");
    const t0 = Date.now();
    const c = await runtime.run("run timeout");
    const dur = Date.now() - t0;
    check("RunResult completed", c.status === "completed", c.status);
    check("child killed (killed=true)", cap.res?.killed === true, cap.res);
    check("timedOut=true", cap.res?.timedOut === true, cap.res);
    check("exitCode null (killed before exit)", cap.res?.exitCode === null, cap.res);
    check("trace has execution_timeout", runtime.lastTrace()?.events.some((e) => e.type === "execution_timeout") === true);
    check("killed within ~1s (<3s)", dur < 3000, dur);

    // ---- Case D: 超时后 Runtime 仍可用（未挂起）----
    console.log("Case D: Runtime recovery after timeout");
    m.enqueueTool("sandbox_test", { mode: "echo", text: "revived" });
    m.enqueueFinal("ok");
    const d = await runtime.run("run echo after timeout");
    check("Runtime still runs after timeout (completed)", d.status === "completed", d.status);
    check("post-timeout echo stdout ok", (cap.res?.stdout ?? "").includes("revived"), cap.res?.stdout);
  }

  // ---- Case E: 多次执行 ----
  console.log("Case E: multiple executions");
  {
    const m = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));
    for (let i = 0; i < 3; i++) {
      m.enqueueTool("sandbox_test", { mode: "output" });
      m.enqueueFinal(`iter-${i}`);
      const r = await runtime.run(`run ${i}`);
      check(`run ${i} completed`, r.status === "completed", r.status);
      check(`run ${i} stdout captured`, (cap.res?.stdout ?? "").includes("out-line"), cap.res?.stdout);
      check(`run ${i} stderr captured`, (cap.res?.stderr ?? "").includes("err-line"), cap.res?.stderr);
    }
  }

  // ---- Case F: cwd 隔离 + 清理 ----
  console.log("Case F: cwd isolation + cleanup");
  {
    const m = new ScriptedModel();
    const runtime = new EnterpriseAiRuntime({ model: m.model, streamFn: m.streamFn });
    const { sink, cap } = captureSink(runtime.executionTraceSink());
    runtime.registerTool(createSandboxTestTool(sink));
    m.enqueueTool("sandbox_test", { mode: "createfile" }); // 在隔离 cwd 写 marker.txt 并回读
    m.enqueueFinal("ok");
    const r = await runtime.run("createfile");
    check("RunResult completed", r.status === "completed", r.status);
    check("cwd is temporary execution dir", typeof cap.cwd === "string" && (cap.cwd as string).includes("execution-"), cap.cwd);
    check("cwd cleaned up after run (no leftover)", cap.cwd ? !existsSync(cap.cwd) : false, cap.cwd);
  }

  console.log(`\nPHASE 28-A ACCEPTANCE: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PHASE 28-A ACCEPTANCE: FAILED (uncaught)");
  console.error(err);
  process.exit(1);
});
