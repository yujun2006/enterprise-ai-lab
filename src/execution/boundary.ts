/**
 * Phase 28-A — Minimal Execution Boundary（实验能力，非完整 Sandbox）。
 *
 * 职责：把「可能不可信/受限的计算」从 Runtime 主 Node 进程移到一个**独立子进程**，
 * 并具备最小可控能力：独立进程、timeout + kill、stdout/stderr 捕获、退出码、
 * cwd 隔离（每次临时目录）、结束清理。
 *
 * 不负责（明确 DEFER）：内存/CPU 上限、网络隔离、文件系统权限、容器/kernel 隔离。
 * 不暴露 child_process 给 Business Client；Business 只看到 Tool 的 RunResult。
 *
 * 位置（本 Phase 关键决策）：
 *   EnterpriseAiRuntime → Policy(beforeToolCall) → Execution Boundary → Child Process → Command
 * 即边界在「Policy 允许之后、Tool 业务动作之内」；Tool 语义不变（execute 仍存在），
 * 只是 Tool 内部把危险计算委托给这个边界。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRequest, ExecutionResult, ExecutionTraceSink, ExecutionContext } from "./types.js";

/**
 * Phase 31 — 最小安全 env：仅透传命令运行所需的基础变量 + 显式执行上下文。
 *
 * 绝不继承 process.env（避免 Runtime 进程的 secret/token/password 泄漏给子进程）。
 * 子进程唯一可见的「Runtime 上下文」是 EXECUTION_CONTEXT_JSON，且其内容仅为身份引用
 * （runId/sessionId/toolName/resource{type,id}/credentialRef{type,id}），不含任何 secret。
 */
function buildChildEnv(context?: ExecutionContext): Record<string, string> {
  const env: Record<string, string> = {};
  // 仅保留让 echo/sleep/sh 等基础命令可运行的最小 allowlist。
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TERM"]) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  if (context) {
    env.EXECUTION_CONTEXT_JSON = JSON.stringify(context);
  }
  return env;
}

/**
 * 在独立子进程中执行一个命令，并返回结构化结果。
 *
 * - cwd 未提供时，自动创建 `os.tmpdir()/execution-<rand>` 临时目录（cwd 隔离），结束后删除（cleanup）。
 * - timeoutMs>0 时，超时触发 SIGKILL，并标记 timedOut/killed。
 * - stdout/stderr 完整捕获（未做大小限制；大输出截断属后续 Sandbox 能力）。
 *
 * @param req 命令请求
 * @param sink 可选 Trace 回调（Runtime 注入其 TraceCollector 即可并入 ExecutionTrace）
 */
export async function executeInBoundary(
  req: ExecutionRequest,
  sink?: ExecutionTraceSink,
): Promise<ExecutionResult> {
  const useProvidedCwd = typeof req.cwd === "string";
  const cwd = useProvidedCwd ? req.cwd! : await mkdtemp(join(tmpdir(), "execution-"));

  const cleanup = async (): Promise<void> => {
    if (useProvidedCwd) return;
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  };

  const startedAt = Date.now();
  sink?.onExecutionStart?.({ ...req, cwd }, req.context);

  return new Promise<ExecutionResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    let settled = false;

    const child = spawn(req.command, req.args ?? [], {
      cwd,
      env: buildChildEnv(req.context),
    });

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    const timer =
      req.timeoutMs && req.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killed = true;
            sink?.onExecutionTimeout?.({ ...req, cwd }, req.context);
            child.kill("SIGKILL");
          }, req.timeoutMs)
        : null;

    const settle = async (result: ExecutionResult): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sink?.onExecutionFinished?.(result, req.context);
      // 进程结束后清理临时 cwd（仅自动目录），await 完成再 resolve，保证 run() 返回时无残留。
      await cleanup();
      resolve(result);
    };

    child.on("error", (err: Error) => {
      void settle({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[spawn error] ${err.message}`,
        durationMs: Date.now() - startedAt,
        timedOut,
        killed,
      });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      void settle({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        killed: killed || signal === "SIGKILL",
      });
    });
  });
}
