/** Phase 3 — 最小 Execution Trace 数据模型（仅观察，不控制）。 */

/** 一条被观察到的 Pi AgentEvent 的轻量记录。 */
export interface TraceEvent {
  /** 观察序列号（本进程内递增）。 */
  sequence: number;
  /** 观察时刻（collector 本地时钟，非 Pi 时间戳；Pi 事件本身不带 timestamp）。 */
  timestamp: number;
  /** Pi 事件类型，例如 agent_start / tool_execution_start / agent_end。 */
  type: string;
  /** 从原事件中提取的关键字段（仅复制可序列化部分，不持有 Pi 对象）。 */
  data: Record<string, unknown>;
}

/**
 * 一次真正发给 LLM 的 request 的 Trace（经 Pi 官方 onPayload 实际捕获）。
 * request 直接保存 provider 发出的完整 payload，可回答「这次 LLM 到底收到了什么」。
 */
export interface LlmCallTrace {
  /** 与本 trace 内 agent event 同一递增序列空间，便于合并时间线。 */
  sequence: number;
  /** model id（来自 onPayload 的 model 参数，例如 qwen2.5:14b）。 */
  model: string;
  /** provider 实际发送的完整 request payload（model / messages / tools / stream / …）。 */
  request: Record<string, unknown>;
  /** HTTP 响应元数据（来自 Pi 官方 onResponse；非 response body）。 */
  responseMetadata?: {
    status?: number;
    headers?: Record<string, string>;
  };
}

/** 一次 Agent Run 的执行轨迹。 */
export interface ExecutionTrace {
  /** Trace 自身的 runId（由 TraceCollector 生成；Pi 的 agent_start 不带 runId）。 */
  runId: string;
  startedAt: number;
  endedAt: number | null;
  /** 本次 run 的用户 prompt（由 Runtime.run() 注入；非 Pi 事件）。 */
  prompt: string;
  /** Agent Event Trace（来自 pi-agent-core 事件流）。 */
  events: TraceEvent[];
  /** LLM Interaction Trace（来自 Pi 官方 onPayload / onResponse，经 streamFn 包装）。 */
  llmCalls: LlmCallTrace[];
  /** 最终 Assistant 回答文本（从 message_end 事件提取）。 */
  finalAnswer: string;
  /**
   * 最终 Assistant 消息的 stopReason（从 message_end 事件提取）。
   * 取值来自 pi-agent-core： "completed" | "error" | "aborted"（toolUse 非终止态）。
   * 用于推断 RunResult.status；UNKNOWN 不等于 FAILED（Phase 8）。
   */
  stopReason?: string;
  /** 当 stopReason === "error" 时，由 Pi 填充的错误信息（不泄漏原始异常/堆栈）。 */
  errorMessage?: string;
}

/**
 * Phase 3-C 注入点：由 Runtime 持有的 collector 实现，
 * 通过包装 streamFn 的 onPayload / onResponse 调用（src/ollama/model.ts）。
 * 仅观察，不改变 request / response。
 */
export interface LlmTraceSink {
  observeLlmRequest(payload: unknown, model: { id: string }): void;
  observeLlmResponse(meta: { status?: number; headers?: Record<string, string> }, model: { id: string }): void;
}
