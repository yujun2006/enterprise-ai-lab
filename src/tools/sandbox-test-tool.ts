/**
 * Phase 28-A — Sandbox Test Tool（实验用，非业务 Tool）。
 *
 * 不修改任何现有业务 Tool。本 Tool 演示：
 *  - Tool 语义不变（仍是 AgentTool.execute，由 Pi Agent Loop 调用）。
 *  - 但危险计算（shell 命令）不再在 Runtime 主进程内执行，而是委托给 Execution Boundary（子进程）。
 *
 * 支持用例（mode）：
 *  - echo：正常命令（exit 0，stdout 含文本）
 *  - fail：失败命令（exit 1）
 *  - timeout：长命令（sleep 30），由边界 timeout 强制 kill
 *  - output：同时产生 stdout / stderr
 *  - createfile：在隔离 cwd 内创建文件并回读（验证 cwd 隔离 + 清理）
 *  - context：回显 EXECUTION_CONTEXT_JSON（验证 Phase 31 跨边界 Context 传播）
 *  - envdump：回显子进程环境（验证 Phase 31 secret 隔离：Runtime env 不泄漏）
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { executeInBoundary } from "../execution/boundary.js";
import type { ExecutionTraceSink, ExecutionContext } from "../execution/types.js";
import type { ResourceContext, CredentialContext } from "../policy/types.js";
import type { ResourceAwareTool, CredentialAwareTool } from "./registry.js";

export type SandboxMode = "echo" | "fail" | "timeout" | "output" | "createfile" | "context" | "envdump";

const SandboxParams = Type.Object({
  mode: Type.String(),
  text: Type.Optional(Type.String()),
});

/** Phase 31 — 本 Tool 声明的 Resource Identity（仅标识，非数据）。 */
function declaredResource(_args: unknown): ResourceContext | undefined {
  return { type: "customer", id: "123" };
}
/** Phase 31 — 本 Tool 声明的 Credential Reference（仅引用，非密钥）。 */
function declaredCredential(_args: unknown): CredentialContext | undefined {
  return { type: "test", id: "readonly" };
}

function commandFor(mode: SandboxMode, text?: string): { command: string; args: string[] } {
  switch (mode) {
    case "echo":
      return { command: "echo", args: [text ?? "hello"] };
    case "fail":
      return { command: "sh", args: ["-c", "exit 1"] };
    case "timeout":
      return { command: "sleep", args: ["30"] };
    case "output":
      return { command: "sh", args: ["-c", "echo out-line; echo err-line 1>&2"] };
    case "createfile":
      return { command: "sh", args: ["-c", "printf 'data' > marker.txt && cat marker.txt"] };
    case "context":
      // 子进程仅打印 Runtime 显式注入的执行上下文（不含任何 secret / process.env）。
      return { command: "sh", args: ["-c", "printf '%s' \"$EXECUTION_CONTEXT_JSON\""] };
    case "envdump":
      // 回显子进程可见环境，用于断言 Runtime env 未泄漏。
      return { command: "sh", args: ["-c", "env"] };
  }
}

/**
 * 创建一个把命令执行委托给 Execution Boundary 的测试 Tool。
 * @param sink 可选 Trace 回调；传入 `runtime.executionTraceSink()` 即可并入 Runtime ExecutionTrace。
 *             该 sink 同时提供 runIdentity()，使本 Tool 能构建跨边界的 ExecutionContext。
 */
export function createSandboxTestTool(
  sink?: ExecutionTraceSink,
): ResourceAwareTool & CredentialAwareTool {
  return {
    name: "sandbox_test",
    label: "Sandbox Test Tool",
    description:
      "Executes a controlled shell command through the Execution Boundary (separate child process). Phase 28-A/31 experiment only.",
    parameters: SandboxParams,
    // Phase 29-C / 29-D：Tool 声明其访问的 Resource / 所需 Credential Reference。
    resource: declaredResource,
    credential: declaredCredential,
    execute: async (_toolCallId: string, args: unknown) => {
      const a = args as { mode: string; text?: string };
      const mode = a.mode as SandboxMode;
      const { command, args: cmdArgs } = commandFor(mode, a.text);
      // timeout 用例用 1000ms 强制 kill；其余用例给足 8s 上限。
      const timeoutMs = mode === "timeout" ? 1000 : 8000;
      // Phase 31 — 构建 Runtime-owned 的只读执行上下文（runId/sessionId 来自 sink，tool/resource/credential 来自本 Tool 声明）。
      const identity = sink?.runIdentity?.();
      const context: ExecutionContext = {
        runId: identity?.runId ?? "unknown",
        sessionId: identity?.sessionId ?? "unknown",
        toolName: "sandbox_test",
        resource: declaredResource(args),
        credentialRef: declaredCredential(args),
      };
      const res = await executeInBoundary({ command, args: cmdArgs, timeoutMs, context }, sink);
      const details = { mode, ...res };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
