/**
 * Phase 35-B Thin Adapter Tool（实验代码，非生产路径）。
 *
 * 这是一个 AgentTool，其 execute 仅做一件事：
 *   把 Tool Call（含 Runtime-owned meta）通过最小 stdio JSON-line 转发给 MCP-style Server。
 *
 * 它不做 Policy / Recovery / Audit / Resource Auth / Credential Auth / Retry 决策。
 * Context 来源复用既有 Kernel 注入机制：
 *   - runId/sessionId 来自 executionTraceSink().runIdentity()（与 Execution Boundary 同源）
 *   - resource/credentialRef 由本 Tool 自身声明函数提供（与进程内 Tool 一致）
 *
 * 不引入任何 *Manager / *Registry / *Gateway。
 */
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionTraceSink } from "../src/execution/types.js";

export interface McpAdapterDeps {
  /** 实验 Server 入口（scripts/_p35_mcp_server.ts）。 */
  serverEntry: string;
  /** 与 Server / reconcile 共享的外部副作用文件。 */
  extFile: string;
  /** Server 收到的 call 记录（供断言 Server 收到 0 / N 次）。 */
  callsLog: string;
  /** Server 启动时的 env keys 快照（供断言无 secret env 泄漏）。 */
  envLog: string;
  /** 延迟取 Runtime 的 ExecutionTraceSink（避免构造期循环引用）。 */
  sink: () => ExecutionTraceSink;
  timeoutMs?: number;
  /** 透传给 Server 的环境（仅 P35_*，绝不传完整 process.env）。 */
  extraEnv?: Record<string, string>;
  /** 传输失败时是否模拟「Runtime 宿主进程在 Tool 执行中途崩溃」（process.exit(137)）。 */
  dieOnTransport?: boolean;
  /** 期望 Server 返回坏 JSON（用于 MALFORMED 断言）。 */
  badResponseExpected?: boolean;
}

export function makeMcpCommitTool(deps: McpAdapterDeps): AgentTool<any, any> {
  const execute = async (_id: string, params: { idempotencyKey: string }): Promise<{
    content: { type: string; text: string }[];
    details: { operationId: string; committed: boolean };
  }> => {
    const key = params.idempotencyKey;
    const identity = deps.sink().runIdentity();
    const request = {
      method: "tools/call",
      name: "create_customer",
      arguments: { idempotencyKey: key },
      meta: {
        runId: identity?.runId,
        sessionId: identity?.sessionId,
        toolName: "create_customer",
        resource: { type: "customer", id: key },
        credentialRef: { type: "crm", id: "readonly" },
      },
    };
    const result = await callServer(deps, request);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: { operationId: key, committed: result.committed },
    };
  };

  return {
    name: "create_customer",
    label: "Create Customer (MCP external)",
    description: "Create a customer via external MCP-style server (idempotent by idempotencyKey).",
    parameters: Type.Object({ idempotencyKey: Type.String() }),
    replay: "safe",
    resource: (args: { idempotencyKey: string }) => ({ type: "customer", id: String(args.idempotencyKey) }),
    credential: () => ({ type: "crm", id: "readonly" }),
    execute,
  } as unknown as AgentTool<any, any>;
}

/**
 * 薄 Transport：spawn Server → 写一行 request → 读一行 response → kill。
 * 传输失败（超时 / 无响应 / 坏响应 / Server 异常退出）一律映射为 reject（错误），
 * 绝不伪造 NOT_FOUND / 绝不自行重试。Recovery 由 Runtime 经 reconcile 决定。
 */
async function callServer(
  deps: McpAdapterDeps,
  request: unknown,
): Promise<{ committed: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", deps.serverEntry],
      {
        env: {
          P35_EXT: deps.extFile,
          P35_CALLS_LOG: deps.callsLog,
          P35_ENV_LOG: deps.envLog,
          P35_CRASH: deps.extraEnv?.P35_CRASH ?? "none",
          P35_BAD: deps.extraEnv?.P35_BAD ?? "0",
          ...deps.extraEnv,
        } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );

    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      fail("MCP_TRANSPORT_TIMEOUT");
    }, deps.timeoutMs ?? 5000);

    function fail(msg: string): void {
      // 投机修复禁止：传输失败不得假设结果，不得重试；仅抛错交 Runtime Recovery。
      if (deps.dieOnTransport) process.exit(137); // 模拟 Runtime 宿主在 Tool 执行中途崩溃
      reject(new Error(msg));
    }
    function ok(v: { committed: boolean }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(v);
    }

    child.stdout!.on("data", (c) => {
      buffer += c.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let r: { method: string; ok?: boolean; committed?: boolean };
        try {
          r = JSON.parse(line);
        } catch {
          if (deps.badResponseExpected) {
            settled = true;
            clearTimeout(timer);
            fail("MCP_MALFORMED_RESPONSE");
            return;
          }
          continue; // 半行，继续等待
        }
        if (r.method === "tools/call" && r.ok) {
          ok({ committed: r.committed === true });
          return;
        }
        settled = true;
        clearTimeout(timer);
        fail("MCP_UNEXPECTED " + line);
        return;
      }
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail("MCP_TRANSPORT_FAILURE code=" + code);
    });

    child.stdin!.write(JSON.stringify(request) + "\n");
  });
}
