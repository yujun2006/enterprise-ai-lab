import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentTool,
  type AgentEvent,
  type AgentMessage,
  type BeforeToolCallContext,
  type AfterToolCallContext,
  type BeforeToolCallResult,
  type AfterToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { ollamaModel, createOllamaRuntimeDeps } from "./ollama/model.js";
import { ToolRegistry } from "./tools/registry.js";
import { TraceCollector } from "./trace/collector.js";
import { evaluatePolicy } from "./policy/adapter.js";
import type { Policy, PolicyDecision } from "./policy/types.js";
import type { ExecutionTrace } from "./trace/types.js";
import type {
  DurableRecoveryRecord,
  RecoveryResult,
  ReconcileFn,
  ResourceReference,
} from "./recovery/types.js";
import type { RecoveryStore } from "./recovery/store.js";
import { decideRecovery } from "./recovery/recovery.js";

/**
 * EnterpriseAiRuntime — Phase 1 薄门面 + Phase 20-1 Durable Recovery 边界。
 *
 * Pi 负责 Agent Loop / Tool 执行 / Agent State。
 * Runtime 负责 Checkpoint / Recovery / Reconciliation / Recovery Decision / Run 重建。
 *
 * Recovery 是 Runtime 的一个生命周期能力（recover / resume 方法 + beforeToolCall/afterToolCall
 * 钩子里的 checkpoint 逻辑），不是独立 subsystem，也禁止使用任何 *Manager 类。
 */
export type RuntimeEventListener = (
  event: AgentEvent,
  signal: AbortSignal,
) => void | Promise<void>;

export interface RuntimeOptions {
  systemPrompt?: string;
  tools?: AgentTool<any>[];
  /** Phase 4-C：Enterprise Policy。默认全部放行。 */
  policy?: Policy;
  /** 注入自定义 Model（测试用 scripted model；生产默认 Ollama）。 */
  model?: Model<any>;
  /** 注入自定义 streamFn（测试用；生产默认 Ollama streamFn）。 */
  streamFn?: StreamFn;
  /** Phase 20-1：耐久存储。不配置则禁用 Recovery / Checkpoint。 */
  store?: RecoveryStore;
  /** 跨 Runtime 实例稳定的 Session 身份（用于重建 Session）。 */
  sessionId?: string;
}

export class EnterpriseAiRuntime {
  private readonly registry: ToolRegistry;
  private readonly collector = new TraceCollector();
  private readonly policy: Policy;
  readonly model: Model<any>;
  private readonly streamFn: StreamFn;
  private readonly store?: RecoveryStore;
  private readonly systemPrompt: string;
  private sessionId: string;
  private agent: Agent;
  private currentRunId?: string;
  private currentPrompt = "";

  constructor(opts: RuntimeOptions = {}) {
    this.registry = new ToolRegistry(opts.tools);
    // 默认 Policy：全部放行（不影响 Phase 1–3 既有行为）。
    this.policy = opts.policy ?? ((): PolicyDecision => ({ type: "allow" }));
    this.systemPrompt = opts.systemPrompt ?? "You are a helpful enterprise assistant.";
    this.store = opts.store;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.model = opts.model ?? ollamaModel;
    this.streamFn = opts.streamFn ?? createOllamaRuntimeDeps(this.collector).streamFn;
    this.agent = this.makeAgent([]);
  }

  /** 用持久 messages 构造一个新 Pi Agent（注入恢复信息）。不恢复 activeRun/streaming/abort。 */
  private makeAgent(messages: AgentMessage[]): Agent {
    const agent = new Agent({
      streamFn: this.streamFn,
      initialState: {
        model: this.model,
        systemPrompt: this.systemPrompt,
        tools: this.registry.toAgentTools(),
        messages,
      },
      // 跨实例稳定的 Session 身份（Pi 原生 sessionId，agent.d.ts:50）
      sessionId: this.sessionId,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
    });
    agent.subscribe((event) => this.collector.observe(event));
    // 每次 Run 完成，持久化 transcript（Phase 18 边界：messages 单独存，按 sessionId）
    agent.subscribe((event) => {
      if (event.type === "agent_end" && this.store) {
        this.store.saveMessages(this.sessionId, agent.state.messages).catch(() => {});
      }
    });
    return agent;
  }

  /** 用持久 messages 重建 Session（新 Pi Agent）。 */
  private reconstructAgent(messages: AgentMessage[]): void {
    this.agent = this.makeAgent(messages);
  }

  /** Phase 20-1 Control Point：Policy 先评估；通过后再写 Checkpoint（先于 Tool 执行）。 */
  private beforeToolCall = async (
    ctx: BeforeToolCallContext,
    _signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const policyResult = await evaluatePolicy(this.policy, ctx, {
      onDecision: (call, decision) => this.collector.observePolicyDecision(call, decision),
      onResolved: (call, _decision, outcome, reason) => this.collector.observePolicyResolved(call, _decision, outcome, reason),
    });
    // Policy DENY → 阻止 Tool 执行（Recovery 也不得绕过）
    if (policyResult?.block) return policyResult;

    if (this.store) {
      try {
        await this.captureCheckpoint(ctx);
      } catch (e) {
        // 硬安全要求：Checkpoint 写失败 → Tool 绝不能执行（无耐久身份不可提交副作用）
        return { block: true, reason: `checkpoint write failed: ${(e as Error).message}` };
      }
    }
    return undefined;
  };

  private afterToolCall = async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    if (this.store) {
      const details = ctx.result?.details as { operationId?: unknown } | undefined;
      const opId = details && typeof details.operationId === "string" ? details.operationId : undefined;
      const record = await this.store.load(this.sessionId);
      if (record) {
        record.operationId = opId ?? record.operationId;
        record.checkpoint.position = "after_tool_result";
        record.status = "recovered";
        record.updatedAt = Date.now();
        await this.store.save(record);
      }
    }
    return undefined;
  };

  /** Checkpoint 在 Tool 执行之前持久化（含 idempotencyKey）。崩溃窗口被压缩为可安全解析的两态。 */
  private async captureCheckpoint(ctx: BeforeToolCallContext): Promise<void> {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
    const resourceReference = this.extractResourceReference(args);
    const record: DurableRecoveryRecord = {
      sessionId: this.sessionId,
      runId: this.currentRunId ?? "unknown",
      prompt: this.currentPrompt,
      status: "running",
      checkpoint: {
        position: "before_tool",
        toolName: ctx.toolCall.name,
        toolArgs: ctx.args,
        idempotencyKey,
        resourceReference,
      },
      updatedAt: Date.now(),
    };
    await this.store!.save(record);
    await this.store!.saveMessages(this.sessionId, this.agent.state.messages);
    this.collector.observeCheckpoint({
      sessionId: this.sessionId,
      runId: this.currentRunId ?? "unknown",
      idempotencyKey,
      toolName: ctx.toolCall.name,
    });
  }

  private extractResourceReference(args: Record<string, unknown>): ResourceReference | undefined {
    const ref: ResourceReference = {};
    if (typeof args.workspaceId === "string") ref.workspaceId = args.workspaceId;
    if (typeof args.resourceId === "string") ref.resourceId = args.resourceId;
    return ref.workspaceId || ref.resourceId ? ref : undefined;
  }

  // ---- 公开 API（Phase 1 兼容） ----

  onEvent(listener: RuntimeEventListener): () => void {
    return this.agent.subscribe(listener);
  }

  subscribe(listener: RuntimeEventListener): () => void {
    return this.onEvent(listener);
  }

  registerTool(tool: AgentTool<any>): void {
    this.registry.register(tool);
    this.agent.state.tools = this.registry.toAgentTools();
  }

  listTools(): string[] {
    return this.registry.names();
  }

  async prompt(text: string): Promise<void> {
    await this.agent.prompt(text);
  }

  /** 开启一次 Execution Trace 并开始运行。 */
  async run(text: string): Promise<void> {
    this.currentRunId = randomUUID();
    this.currentPrompt = text;
    this.collector.startRun(text);
    if (this.store) {
      try {
        await this.store.saveMessages(this.sessionId, this.agent.state.messages);
      } catch {
        /* best-effort */
      }
    }
    return this.prompt(text);
  }

  lastTrace(): ExecutionTrace | undefined {
    return this.collector.lastTrace();
  }

  transcript(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  abort(): void {
    this.agent.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  reset(): void {
    this.agent.reset();
  }

  /** 跨实例稳定的 Session 身份。 */
  getSessionId(): string {
    return this.sessionId;
  }

  // ---- Phase 20-1 Recovery 边界 ----

  /**
   * 重建 Session（无中断 Tool 的续跑）。加载持久 transcript，构造新 Pi Agent。
   * 与 recover() 的区别：resume 不调用 Reconcile / 不做 Recovery Decision。
   */
  async resume(sessionId: string): Promise<void> {
    if (!this.store) throw new Error("RecoveryStore not configured; resume unavailable");
    const messages = (await this.store.loadMessages(sessionId)) ?? [];
    this.sessionId = sessionId;
    this.reconstructAgent(messages);
  }

  /**
   * Durable Recovery：Reconstruct → Reconcile → Decide →（Resume 由调用方驱动）。
   *
   * - 加载持久 Recovery Record + transcript，构造新 Pi Agent（新 Run）。
   * - 用 operationId/idempotencyKey 向 External 对账（reconcile 回调，由 External 集成注入）。
   * - Runtime 决定 CONTINUE / SKIP / RETRY / ESCALATE（结合 Tool.replay）。
   * - retry 时不在此直接执行 Tool；返回 retry 计划，由调用方经新 Run（beforeToolCall → Policy）重发。
   */
  async recover(sessionId: string, reconcile: ReconcileFn): Promise<RecoveryResult> {
    if (!this.store) throw new Error("RecoveryStore not configured; recovery unavailable");
    const record = await this.store.load(sessionId);
    if (!record) return { decision: "continue" };

    const messages = (await this.store.loadMessages(sessionId)) ?? [];
    this.sessionId = sessionId;
    this.reconstructAgent(messages);

    this.collector.observeRecovery({ type: "recovery_started", sessionId, fromRun: record.runId });
    const result = await reconcile(record.checkpoint.idempotencyKey ?? "", record.checkpoint.resourceReference);
    this.collector.observeReconcile(result);

    const tool = record.checkpoint.toolName ? this.registry.get(record.checkpoint.toolName) : undefined;
    const decision = decideRecovery(result, tool?.replay);
    this.collector.observeDecision(decision);

    await this.store.save({ ...record, status: "recovered", parentRunId: record.runId, updatedAt: Date.now() });

    const base: RecoveryResult = {
      decision,
      operationId: record.operationId,
      idempotencyKey: record.checkpoint.idempotencyKey,
      toolName: record.checkpoint.toolName,
      args: record.checkpoint.toolArgs,
    };
    if (decision === "retry" && record.checkpoint.toolName && record.checkpoint.toolArgs !== undefined) {
      base.retry = { toolName: record.checkpoint.toolName, args: record.checkpoint.toolArgs };
    }
    return base;
  }
}
