import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExecutionTrace, LlmCallTrace, TraceEvent } from "./types.js";
import type { PolicyDecision, PolicyToolCall } from "../policy/types.js";
import type { ExecutionRequest, ExecutionResult, ExecutionTraceSink, ExecutionContext } from "../execution/types.js";
import type { IdentityContext, WorkspaceContext } from "../policy/types.js";
import { makeAuditEvent } from "../audit/event.js";
import type { AuditSink } from "../audit/event.js";

/** 从一条 message 中提取 assistant 文本（忽略 toolCall / thinking 等非文本块）。 */
function assistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown } | undefined;
  if (!m || m.role !== "assistant") return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b: { type?: string; text?: string }) => b?.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text)
      .join("");
  }
  return "";
}

/** 从 Pi AgentEvent 提取可供 Trace 记录的最小字段。 */
function extractData(e: AgentEvent): Record<string, unknown> {
  switch (e.type) {
    case "turn_end":
      return { toolResults: (e as { toolResults?: unknown[] }).toolResults?.length ?? 0 };
    case "message_end": {
      const msg = (e as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
      return {
        role: msg?.role,
        text: assistantText(msg),
        stopReason: msg?.stopReason,
        errorMessage: msg?.errorMessage,
      };
    }
    case "tool_execution_start":
      return { toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
    case "tool_execution_update":
      return { toolName: e.toolName };
    case "tool_execution_end":
      return { toolCallId: e.toolCallId, toolName: e.toolName, isError: e.isError, result: e.result };
    default:
      return {};
  }
}

/**
 * TraceCollector — Enterprise Runtime 拥有的只读观测组件。
 *
 * 只通过 `observe(event)` 接收 pi-agent-core 已发出的 AgentEvent；
 * 不修改、不控制、不重放 Agent Loop / Tool Execution / LLM 调用。
 */
export class TraceCollector implements ExecutionTraceSink {
  private current: ExecutionTrace | null = null;
  private last: ExecutionTrace | null = null;
  private seq = 0;
  /** Phase 33-B — 可选 Durable Audit 落点（Runtime 注入；不持有则跳过审计）。 */
  private readonly audit?: AuditSink;
  /** Phase 31 — Runtime-owned Run 身份（由 Runtime 在 run() 时显式设置，供 Tool 构建 ExecutionContext）。 */
  private runId?: string;
  private runSessionId?: string;
  /** Phase 33-B — 供 EXECUTION 审计事件携带的治理上下文（均来自 Runtime-owned RunContext，非 ambient）。 */
  private auditIdentity?: IdentityContext;
  private auditWorkspace?: WorkspaceContext;
  private auditSkillId?: string;

  constructor(audit?: AuditSink) {
    this.audit = audit;
  }

  /** 在一次 run() 开始时由 Runtime 调用：记录 prompt 并开辟新 trace。 */
  startRun(prompt: string): void {
    this.seq = 0;
    this.current = {
      runId: randomUUID(),
      startedAt: Date.now(),
      endedAt: null,
      prompt,
      events: [],
      llmCalls: [],
      finalAnswer: "",
    };
  }

  /** 由 streamFn 包装的 onPayload 调用：记录一次真实 LLM request（完整 payload）。 */
  observeLlmRequest(payload: unknown, model: { id: string }): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    const call: LlmCallTrace = {
      sequence: this.seq,
      model: model.id,
      request: payload as Record<string, unknown>,
    };
    this.current!.llmCalls.push(call);
  }

  /** 由 streamFn 包装的 onResponse 调用：记录 HTTP 响应元数据（status / headers）。 */
  observeLlmResponse(meta: { status?: number; headers?: Record<string, string> }, _model: { id: string }): void {
    const trace = this.current;
    if (!trace) return;
    const last = trace.llmCalls[trace.llmCalls.length - 1];
    if (last) last.responseMetadata = { status: meta.status, headers: meta.headers };
  }

  /** 由 Runtime 在收到任意 AgentEvent 时透传调用（仅观察）。 */
  observe(e: AgentEvent): void {
    if (!this.current) {
      // 防御：run() 之外产生的事件也保底记录一条匿名 trace。
      this.startRun("");
    }
    const trace = this.current!;
    this.seq += 1;
    const ev: TraceEvent = {
      sequence: this.seq,
      timestamp: Date.now(),
      type: e.type,
      data: extractData(e),
    };
    trace.events.push(ev);

    if (e.type === "message_end") {
      const msg = (e as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
      const text = assistantText(msg);
      if (text) trace.finalAnswer = text;
      // 仅由最终 assistant 消息决定 run 终止态（toolResult 消息不覆盖）。
      if (msg?.role === "assistant") {
        if (typeof msg.stopReason === "string") trace.stopReason = msg.stopReason;
        if (typeof msg.errorMessage === "string") trace.errorMessage = msg.errorMessage;
      }
    }
    if (e.type === "agent_end") {
      trace.endedAt = Date.now();
      this.last = trace;
      this.current = null;
    }
  }

  /** 记录一次 Policy 决策（在 beforeToolCall 命中时，await 审批前）。 */
  observePolicyDecision(call: PolicyToolCall, decision: PolicyDecision): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({
      sequence: this.seq,
      timestamp: Date.now(),
      type: "policy_decision",
      data: {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
        decision: decision.type,
        reason: decision.type === "deny" ? decision.reason : undefined,
      },
    });
  }

  /** 记录一次 Policy 决策的最终结果（ASK 审批完成 / DENY 直接生效）。 */
  observePolicyResolved(call: PolicyToolCall, _decision: PolicyDecision, outcome: "allow" | "deny", reason?: string): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({
      sequence: this.seq,
      timestamp: Date.now(),
      type: "policy_resolved",
      data: { toolCallId: call.toolCallId, toolName: call.toolName, outcome, reason },
    });
  }

  /** Phase 20-1: observe a durable checkpoint being written before a Tool executes. */
  observeCheckpoint(record: { sessionId: string; runId: string; idempotencyKey?: string; toolName?: string }): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({
      sequence: this.seq,
      timestamp: Date.now(),
      type: "checkpoint_created",
      data: { sessionId: record.sessionId, runId: record.runId, idempotencyKey: record.idempotencyKey, toolName: record.toolName },
    });
  }

  /** Phase 20-1: observe the start of a recovery flow. */
  observeRecovery(info: { type: "recovery_started"; sessionId: string; fromRun: string }): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({ sequence: this.seq, timestamp: Date.now(), type: "recovery_started", data: info });
  }

  /** Phase 20-1: observe the External reconciliation result. */
  observeReconcile(result: string): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({ sequence: this.seq, timestamp: Date.now(), type: "reconciliation_result", data: { result } });
  }

  /** Phase 20-1: observe the Runtime recovery decision. */
  observeDecision(decision: string): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({ sequence: this.seq, timestamp: Date.now(), type: "recovery_decision", data: { decision } });
  }

  /** 返回最近一次已完成 run 的 trace。 */
  lastTrace(): ExecutionTrace | undefined {
    return this.last ?? undefined;
  }

  /** Phase 31 — Runtime 在 run() 时显式注入当前 Run 的身份（供 ExecutionContext 构建；非 ambient）。 */
  setRunContext(ctx: {
    runId: string;
    sessionId: string;
    identity?: IdentityContext;
    workspace?: WorkspaceContext;
    skillId?: string;
  }): void {
    this.runId = ctx.runId;
    this.runSessionId = ctx.sessionId;
    this.auditIdentity = ctx.identity;
    this.auditWorkspace = ctx.workspace;
    this.auditSkillId = ctx.skillId;
  }

  /** Phase 31 — 供 Tool（仅持有 ExecutionTraceSink）读取当前 Run 的 Runtime-owned 身份。 */
  runIdentity(): { runId: string; sessionId: string } | undefined {
    if (this.runId && this.runSessionId) return { runId: this.runId, sessionId: this.runSessionId };
    return undefined;
  }

  /** Phase 31 — 从 ExecutionContext 抽取「仅身份引用」的归因数据（resource/credentialRef 均为 {type,id}，无 secret）。 */
  private executionAttribution(ctx?: ExecutionContext): Record<string, unknown> {
    if (!ctx) return {};
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      toolName: ctx.toolName,
      resource: ctx.resource,
      credentialRef: ctx.credentialRef,
    };
  }

  /** Phase 28-A/31: Execution Boundary 生命周期 — 子进程启动（cwd 隔离 + Run/Tool 归因）。 */
  onExecutionStart(req: ExecutionRequest, ctx?: ExecutionContext): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({
      sequence: this.seq,
      timestamp: Date.now(),
      type: "execution_started",
      data: { command: req.command, args: req.args, cwd: req.cwd, timeoutMs: req.timeoutMs, ...this.executionAttribution(ctx) },
    });
    // Phase 33-B — Durable Audit：Execution 控制点（复用 Phase 31 ExecutionContext，仅身份引用，无 secret）。
    if (this.audit) {
      this.audit.append(makeAuditEvent({
        eventType: "EXECUTION",
        runId: ctx?.runId ?? this.runId ?? "unknown",
        sessionId: ctx?.sessionId ?? this.runSessionId ?? "unknown",
        identity: this.auditIdentity,
        workspace: this.auditWorkspace,
        skillId: this.auditSkillId,
        toolName: ctx?.toolName ?? req.command,
        resource: ctx?.resource,
        credentialRef: ctx?.credentialRef,
        outcome: "started",
      }));
    }
  }

  /** Phase 28-A/31: Execution Boundary 生命周期 — 子进程结束（退出码 / 时长 / 是否超时/kill + 归因）。 */
  onExecutionFinished(res: ExecutionResult, ctx?: ExecutionContext): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({
      sequence: this.seq,
      timestamp: Date.now(),
      type: "execution_finished",
      data: { exitCode: res.exitCode, durationMs: res.durationMs, timedOut: res.timedOut, killed: res.killed, ...this.executionAttribution(ctx) },
    });
    if (this.audit) {
      const outcome = res.timedOut || res.killed ? "killed" : res.exitCode === 0 ? "success" : "failure";
      this.audit.append(makeAuditEvent({
        eventType: "EXECUTION",
        runId: ctx?.runId ?? this.runId ?? "unknown",
        sessionId: ctx?.sessionId ?? this.runSessionId ?? "unknown",
        identity: this.auditIdentity,
        workspace: this.auditWorkspace,
        skillId: this.auditSkillId,
        toolName: ctx?.toolName ?? "unknown",
        resource: ctx?.resource,
        credentialRef: ctx?.credentialRef,
        outcome,
      }));
    }
  }

  /** Phase 28-A/31: Execution Boundary 生命周期 — 子进程因超时被执行 kill（含归因）。 */
  onExecutionTimeout(req: ExecutionRequest, ctx?: ExecutionContext): void {
    if (!this.current) this.startRun("");
    this.seq += 1;
    this.current!.events.push({
      sequence: this.seq,
      timestamp: Date.now(),
      type: "execution_timeout",
      data: { command: req.command, args: req.args, ...this.executionAttribution(ctx) },
    });
    if (this.audit) {
      this.audit.append(makeAuditEvent({
        eventType: "EXECUTION",
        runId: ctx?.runId ?? this.runId ?? "unknown",
        sessionId: ctx?.sessionId ?? this.runSessionId ?? "unknown",
        identity: this.auditIdentity,
        workspace: this.auditWorkspace,
        skillId: this.auditSkillId,
        toolName: ctx?.toolName ?? req.command,
        resource: ctx?.resource,
        credentialRef: ctx?.credentialRef,
        outcome: "timeout",
      }));
    }
  }
}
