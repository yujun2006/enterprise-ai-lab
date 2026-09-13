/**
 * Phase 28-A / 31 — Execution Boundary 类型（最小实验，非 Sandbox 系统）。
 *
 * 只描述「一次受限命令执行」的请求/结果与 Trace 回调。
 * 不引入 SandboxManager / ResourceManager / ContextManager 等任何 *Manager 类。
 *
 * Phase 31 增加：ExecutionContext（Runtime-owned 的只读执行元数据，跨边界传播，
 * 仅身份引用，绝不含 secret），以及 ExecutionRequest.context。
 */

import type { ResourceContext, CredentialContext } from "../policy/types.js";

/**
 * Phase 31 — ExecutionContext = Runtime-owned 只读执行元数据。
 *
 * 通过显式参数（ExecutionRequest.context → 子进程 EXECUTION_CONTEXT_JSON）跨越边界，
 * 不使用 global / singleton / ambient context。
 *
 * 仅含身份引用：
 *   runId / sessionId     — Runtime 生成（RunContext）
 *   toolName              — Tool 自身标识
 *   resource?             — { type, id }，ResourceContext（声明，非数据）
 *   credentialRef?        — { type, id }，CredentialRef（引用，非密钥）
 *
 * 永远不允许：skill / systemPrompt / messages / identity secrets / credential value /
 * resource data / process.env / arbitrary metadata。
 */
export interface ExecutionContext {
  runId: string;
  sessionId: string;
  toolName: string;
  resource?: ResourceContext;
  credentialRef?: CredentialContext;
}

/** 一次边界执行的请求。cwd 省略时由 boundary 自动分配临时隔离目录。 */
export interface ExecutionRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Phase 31 — 显式、Runtime-owned 的执行上下文（仅身份引用，无 secret）。 */
  context?: ExecutionContext;
}

/** 一次边界执行的结果（结构化的 Tool 可观测输出）。 */
export interface ExecutionResult {
  /** 子进程退出码；被 kill 或未启动时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 是否因超时触发 kill。 */
  timedOut: boolean;
  /** 子进程是否被（强制）终止。 */
  killed: boolean;
}

/**
 * 执行边界的生命周期 Trace 回调（可选）。
 * 由 ExecutionBoundary 在执行前后调用；Runtime 的 TraceCollector 实现它，
 * 使「Execution Boundary lifecycle」进入同一 ExecutionTrace。
 *
 * Phase 31 扩展：
 *  - 增加 `runIdentity()`：允许 Tool（仅持有此 sink）读取当前 Run 的 Runtime-owned 身份，
 *    以构建 ExecutionContext（runId/sessionId 不在 Tool.execute 的 args 中，必须显式取得）。
 *  - onExecution* 增加可选 ctx 参数，使 execution 事件携带 run/tool 归因（不泄露 secret）。
 */
export interface ExecutionTraceSink {
  /** Phase 31 — 当前 Run 的 Runtime-owned 身份（供 Tool 构建 ExecutionContext）。 */
  runIdentity?(): { runId: string; sessionId: string } | undefined;
  onExecutionStart?(req: ExecutionRequest, ctx?: ExecutionContext): void;
  onExecutionFinished?(res: ExecutionResult, ctx?: ExecutionContext): void;
  onExecutionTimeout?(req: ExecutionRequest, ctx?: ExecutionContext): void;
}
