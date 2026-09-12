import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExecutionTrace, LlmCallTrace, TraceEvent } from "./types.js";
import type { PolicyDecision, PolicyToolCall } from "../policy/types.js";

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
    case "message_end":
      return { role: (e as { message?: { role?: string } }).message?.role, text: assistantText((e as { message?: unknown }).message) };
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
export class TraceCollector {
  private current: ExecutionTrace | null = null;
  private last: ExecutionTrace | null = null;
  private seq = 0;

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
      const text = assistantText((e as { message?: unknown }).message);
      if (text) trace.finalAnswer = text;
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
}
