import { randomUUID, createHash } from "node:crypto";
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
import { effectiveToolsFor, composeSystemPrompt } from "./skills/skill.js";
import type { Skill } from "./skills/skill.js";
import { evaluatePolicy } from "./policy/adapter.js";
import type { Policy, PolicyDecision, RunContext, RunContextInput, PolicyOutcome, ResourceContext, CredentialContext } from "./policy/types.js";
import type { AuditSink } from "./audit/event.js";
import { makeAuditEvent } from "./audit/event.js";
import type { ExecutionTrace } from "./trace/types.js";
import type {
  DurableRecoveryRecord,
  RecoveryResult,
  ReconcileFn,
  ResourceReference,
} from "./recovery/types.js";
import type { RecoveryStore } from "./recovery/store.js";
import type { ExecutionTraceSink } from "./execution/types.js";
import { decideRecovery } from "./recovery/recovery.js";

/**
 * Phase 37-B 硬化（C1）：对 Tool 参数做稳定序列化（递归键排序），用于生成 args 指纹。
 * 同一 operation 的 approved 续跑必须 args 指纹一致，否则拒绝。
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

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
  /** Phase 29-B：可选 caller 提供的默认上下文，合并进每次 Run 的 RunContext。 */
  context?: RunContextInput;
  /** Phase 30：可选 Skill 能力声明（仅声明/激活 Tool 能力与 instructions，不持有授权）。 */
  skill?: Skill;
  /** Phase 33-B：可选 Durable Audit 落点（默认不审计；注入后 Runtime 在关键控制点写最小治理事件）。 */
  audit?: AuditSink;
}

/**
 * 一次 Run 的结构化结果（Business-facing，不含任何 Pi 内部状态）。
 *
 * 设计依据（Phase 8 / 17–21）：
 *  - status 描述的是「执行生命周期」状态，不等于业务成功（Business success 由业务层判断）。
 *  - Final Answer ≠ Success：有 answer 也可能 status 非 completed。
 *  - agent_end 不等于成功；abort 与 LLM failure 都可能 stopReason="error"。
 *  - UNKNOWN 不等于 FAILED：无法确定结果时给 unknown，绝不误标 failed。
 *  - Recovery 不是普通 RunResult（走 recover() 单独入口）。
 */
export type RunStatus = "completed" | "failed" | "aborted" | "unknown";

export interface RunError {
  code: "llm_error" | "aborted" | "unknown";
  message: string;
}

export interface RunResult {
  status: RunStatus;
  /** 最终 Assistant 回答（若有）。 */
  answer?: string;
  /** 跨实例稳定的 Session 身份。 */
  sessionId: string;
  /** 本次 Run 的 volatile runId。 */
  runId: string;
  /** 本次 Run 的执行轨迹（只读观测模型，不持有 Pi 对象）。 */
  trace?: ExecutionTrace;
  /** 仅当 status 为 failed / aborted / unknown 时存在，已脱敏（不含堆栈）。 */
  error?: RunError;
}

export class EnterpriseAiRuntime {
  private readonly registry: ToolRegistry;
  private readonly collector: TraceCollector;
  /** Phase 33-B — Durable Audit 落点（可选；不持有则跳过审计）。 */
  private readonly audit?: AuditSink;
  private readonly policy: Policy;
  readonly model: Model<any>;
  private readonly streamFn: StreamFn;
  private readonly store?: RecoveryStore;
  private readonly systemPrompt: string;
  /** Phase 30 — Skill 能力声明（仅声明/激活，不持有授权）。 */
  private readonly skill: Skill | undefined;
  private sessionId: string;
  private agent: Agent;
  private currentRunId?: string;
  private currentPrompt = "";
  /** Phase 29-B — 本次 Run 的 Runtime-owned 上下文，run() 时创建并显式传播到 Policy。 */
  private runContext?: RunContext;
  /** Phase 29-B — 构造函数注入的默认上下文（run 输入可覆盖）。 */
  private readonly defaultContext?: RunContextInput;
  /** 本次 Run 是否被调用方中止（用于区分 aborted vs failed）。 */
  private aborted = false;
  /** Phase 37-B — 进行中的 Human Approval 决议（volatile；durable 真相在 RecoveryStore）。key = approvalId。 */
  private pendingApprovals = new Map<string, { resolve: (o: PolicyOutcome) => void }>();
  /** Phase 37-B — 同一 approvalId 的 terminal transition 串行化锁（保证原子，防竞态）。 */
  private approvalLocks = new Map<string, Promise<void>>();
  private currentApprovalId?: string;
  private askHandled = false;

  constructor(opts: RuntimeOptions = {}) {
    this.registry = new ToolRegistry(opts.tools);
    // 默认 Policy：全部放行（不影响 Phase 1–3 既有行为）。
    this.policy = opts.policy ?? ((): PolicyDecision => ({ type: "allow" }));
    this.systemPrompt = opts.systemPrompt ?? "You are a helpful enterprise assistant.";
    this.store = opts.store;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.defaultContext = opts.context;
    this.skill = opts.skill;
    this.audit = opts.audit;
    // Phase 33-B — Audit 落点注入 TraceCollector（供 Execution Boundary 控制点复用同一 sink）。
    this.collector = new TraceCollector(opts.audit);
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
        systemPrompt: composeSystemPrompt(this.systemPrompt, this.skill),
        tools: effectiveToolsFor(this.skill, this.registry.toAgentTools()),
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

  /** Phase 29-B — 创建本次 Run 的 Runtime-owned RunContext（runId/sessionId/task 由 Runtime 生成）。 */
  private makeRunContext(task: string, input?: RunContextInput): RunContext {
    const merged: RunContextInput = { ...this.defaultContext, ...(input ?? {}) };
    const ctx: RunContext = {
      runId: this.currentRunId ?? randomUUID(),
      sessionId: this.sessionId,
      task,
    };
    if (merged.identity) ctx.identity = merged.identity;
    if (merged.workspace) ctx.workspace = merged.workspace;
    return ctx;
  }

  /** 兜底：若 beforeToolCall 在 run() 之外被触发（理论上不会），用当前实例状态构造最小 RunContext。 */
  private fallbackRunContext(): RunContext {
    return {
      runId: this.currentRunId ?? "unknown",
      sessionId: this.sessionId,
      task: this.currentPrompt,
    };
  }

  /** Phase 20-1 Control Point：Policy 先评估；通过后再写 Checkpoint（先于 Tool 执行）。 */
  private beforeToolCall = async (
    ctx: BeforeToolCallContext,
    _signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    // Phase 29-B：Runtime-owned RunContext 通过显式参数传播到 Policy，不使用 global/singleton/env。
    const rc = this.runContext ?? this.fallbackRunContext();
    // Phase 29-C：Resource Identity 由 Tool 自身声明（registry.resourceOf），Runtime 仅作为控制平面传播。
    const resource = this.registry.resourceOf(ctx.toolCall.name, ctx.args);
    // Phase 29-D：Credential Reference 由 Tool 自身声明（registry.credentialOf），Runtime 仅传播，不持有密钥/语义。
    const credentialRef = this.registry.credentialOf(ctx.toolCall.name, ctx.args);
    // Phase 37-B — Human-Gated Recovery：评估 Policy 之前先对账 durable approval truth。
    // 若上次执行已把本操作决议为 rejected / approved（崩溃续跑恢复点），直接短路：
    //   - 不重新 await 人工、不重新写 checkpoint（避免覆盖 approved / 重复 human gate）
    //   - approved 直接放行 resume；外部副作用由 Tool idempotencyKey 保证至多一次
    if (this.store) {
      const prior = await this.store.load(this.sessionId);
      if (prior?.status === "rejected") {
        return { block: true, reason: "approval rejected (durable)" };
      }
      if (prior?.status === "approved") {
        // Phase 37-B 硬化（C1）：approved 是「operation-scoped」——必须匹配原始 checkpoint 的
        // toolName + args 指纹。任何不匹配（不同 Tool / 不同参数）都视为新操作，必须重新走 Policy，
        // 绝不可被旧 approval 静默放行（防 prompt-injection 借已批准身份执行其它 Tool）。
        const cp = prior.checkpoint;
        const fp = this.fingerprintArgs(ctx.args);
        if (cp.toolName !== ctx.toolCall.name || cp.argsFingerprint !== fp) {
          return {
            block: true,
            reason: `approved operation mismatch (durable): expected ${cp.toolName ?? "?"}@${cp.argsFingerprint ?? "?"}, got ${ctx.toolCall.name}@${fp}`,
          };
        }
        this.audit?.append(makeAuditEvent({
          eventType: "TOOL_EXECUTION",
          runId: rc.runId,
          sessionId: rc.sessionId,
          identity: rc.identity,
          workspace: rc.workspace,
          skillId: this.skill?.id,
          toolCallId: ctx.toolCall.id,
          toolName: ctx.toolCall.name,
          resource,
          credentialRef,
          outcome: "started",
        }));
        return undefined;
      }
    }

    const policyResult = await evaluatePolicy(this.policy, rc, ctx, resource, credentialRef, {
      onDecision: (call, decision) => {
        this.collector.observePolicyDecision(call, decision);
        // Phase 33-B — Durable Audit：Policy 决策控制点（含 resource/credentialRef；ALLOW/DENY/ASK 均为治理事实）。
        this.audit?.append(makeAuditEvent({
          eventType: "POLICY_DECISION",
          runId: rc.runId,
          sessionId: rc.sessionId,
          identity: rc.identity,
          workspace: rc.workspace,
          skillId: this.skill?.id,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          resource,
          credentialRef,
          policyDecision: decision.type === "ask" ? "ASK" : decision.type === "deny" ? "DENY" : "ALLOW",
        }));
      },
      onResolved: (call, _decision, outcome, reason) => this.collector.observePolicyResolved(call, _decision, outcome, reason),
      // Phase 37-B — Runtime owns the durable pending approval lifecycle（ASK → durable pending → human → resume）。
      onAskBegin: async (call, decision) => {
        this.askHandled = true;
        this.currentApprovalId = await this.persistPendingApproval(ctx, rc, resource, credentialRef);
        this.registerPendingApproval(this.currentApprovalId, decision);
      },
      onAskDecided: async (call, _decision, outcome) => {
        if (this.currentApprovalId) await this.finalizeApproval(this.currentApprovalId, outcome);
      },
    });
    try {
      // Policy DENY → 阻止 Tool 执行（Recovery 也不得绕过）
      if (policyResult?.block) return policyResult;
      // Phase 33-B — Durable Audit：Policy 放行后记录 Tool 执行开始（resource/credentialRef 来自 Tool 声明）。
      this.audit?.append(makeAuditEvent({
        eventType: "TOOL_EXECUTION",
        runId: rc.runId,
        sessionId: rc.sessionId,
        identity: rc.identity,
        workspace: rc.workspace,
        skillId: this.skill?.id,
        toolCallId: ctx.toolCall.id,
        toolName: ctx.toolCall.name,
        resource,
        credentialRef,
        outcome: "started",
      }));

      if (this.store && !this.askHandled) {
        try {
          await this.captureCheckpoint(ctx);
        } catch (e) {
          // 硬安全要求：Checkpoint 写失败 → Tool 绝不能执行（无耐久身份不可提交副作用）
          return { block: true, reason: `checkpoint write failed: ${(e as Error).message}` };
        }
      }
      return undefined;
    } finally {
      // Phase 37-B 硬化（I1）：ASK 决议（含 DENY 早返）后必须复位 askHandled / currentApprovalId，
      // 否则后续 Tool Call 会跳过 captureCheckpoint（静默丢失耐久身份 → 崩溃不可恢复）。
      this.askHandled = false;
      this.currentApprovalId = undefined;
    }
  };

  private afterToolCall = async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    // Phase 33-B — Durable Audit：Tool 执行结束（成功 / 错误；resource/credentialRef 重新派生自 Tool 声明）。
    const rc = this.runContext ?? this.fallbackRunContext();
    const isError = (ctx.result as { isError?: boolean } | undefined)?.isError ?? false;
    this.audit?.append(makeAuditEvent({
      eventType: "TOOL_EXECUTION",
      runId: rc.runId,
      sessionId: rc.sessionId,
      identity: rc.identity,
      workspace: rc.workspace,
      skillId: this.skill?.id,
      toolCallId: ctx.toolCall.id,
      toolName: ctx.toolCall.name,
      resource: this.registry.resourceOf(ctx.toolCall.name, ctx.args),
      credentialRef: this.registry.credentialOf(ctx.toolCall.name, ctx.args),
      outcome: isError ? "error" : "success",
    }));
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

  /** Phase 37-B 硬化（C1）：args 指纹（sha256 前 32 位）。 */
  private fingerprintArgs(args: unknown): string {
    return createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 32);
  }

  private extractResourceReference(args: Record<string, unknown>): ResourceReference | undefined {
    const ref: ResourceReference = {};
    if (typeof args.workspaceId === "string") ref.workspaceId = args.workspaceId;
    if (typeof args.resourceId === "string") ref.resourceId = args.resourceId;
    return ref.workspaceId || ref.resourceId ? ref : undefined;
  }

  // ---- Phase 37-B — Human-Gated Recovery Extension ----
  // 设计依据（Phase 37-A Design Gate）：Human Approval 不是新 Runtime Boundary，
  // 而是 Policy ASK + Durable Pending Operation（复用 DurableRecoveryRecord / RecoveryStore / Recovery）。
  // 不引入 ApprovalManager / ApprovalService / ApprovalEngine / HumanLoopManager 等 subsystem。

  /** 写 durable pending approval（await 人工之前）。复用 DurableRecoveryRecord；approvalId 稳定且持久。 */
  private async persistPendingApproval(
    ctx: BeforeToolCallContext,
    rc: RunContext,
    resource: ResourceContext | undefined,
    credentialRef: CredentialContext | undefined,
  ): Promise<string> {
    if (!this.store) return randomUUID();
    const existing = await this.store.load(this.sessionId);
    const approvalId = existing?.approvalId ?? randomUUID();
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
    const resourceReference = this.extractResourceReference(args);
    const record: DurableRecoveryRecord = {
      sessionId: this.sessionId,
      runId: rc.runId,
      prompt: this.currentPrompt,
      status: "pending_approval",
      checkpoint: {
        position: "before_tool",
        toolName: ctx.toolCall.name,
        toolArgs: ctx.args,
        idempotencyKey,
        resourceReference,
        argsFingerprint: this.fingerprintArgs(ctx.args),
      },
      approvalId,
      updatedAt: Date.now(),
    };
    await this.store.save(record);
    await this.store.saveMessages(this.sessionId, this.agent.state.messages);
    this.collector.observeCheckpoint({ sessionId: this.sessionId, runId: rc.runId, idempotencyKey, toolName: ctx.toolCall.name });
    this.audit?.append(makeAuditEvent({
      eventType: "APPROVAL_DECISION",
      runId: rc.runId,
      sessionId: this.sessionId,
      identity: rc.identity,
      workspace: rc.workspace,
      skillId: this.skill?.id,
      toolCallId: ctx.toolCall.id,
      toolName: ctx.toolCall.name,
      resource,
      credentialRef,
      approvalDecision: "PENDING",
    }));
    return approvalId;
  }

  /**
   * 把 evaluatePolicy 的 `await decision.approval()` 解阻塞到本 Runtime 的 pending deferred：
   *   - applyDecision(approvalId) 是 Runtime-owned 决议入口（外部 / 人工皆经此写入 store）
   *   - Policy 自带的 approval()（真实人工入口）也经 applyDecision 写入 store
   * 两者最终都走 finalizeApproval；store（DurableRecoveryRecord）是唯一真相源，promise 仅承载
   * 已提交的 durable outcome（见 resolvePendingApproval）。竞态由 withApprovalLock 串行化，
   * 先拿到锁者写入 terminal status，后者为幂等 no-op，故决议确定、唯一。
   */
  private registerPendingApproval(approvalId: string, decision: PolicyDecision): void {
    let resolveFn!: (o: PolicyOutcome) => void;
    const promise = new Promise<PolicyOutcome>((res) => { resolveFn = res; });
    this.pendingApprovals.set(approvalId, { resolve: resolveFn });
    if (decision.type === "ask") {
      // Phase 37-B 硬化（C2）：人类决议与 applyDecision 共用同一 durability 路径，禁止 human.then(resolveFn)
      // 直接解阻塞 promise（否则 promise 值与 store 真相脱钩，出现「rejected 但 tool 执行」竞态）。
      // 人类决议改为 applyDecision(approvalId, o) —— 先经 finalizeApproval 写 store，再统一 resolve 承诺值。
      const human = decision.approval();
      human.then((o) => { void this.applyDecision(approvalId, o); }).catch(() => {});
      decision.approval = () => promise;
    }
  }

  /** Runtime-owned 人工决策入口（Runtime 拥有 approval lifecycle）。同时被 Policy approval() 与 applyDecision 调用。 */
  async applyDecision(approvalId: string, outcome: PolicyOutcome): Promise<void> {
    return this.resolvePendingApproval(approvalId, outcome);
  }

  private async resolvePendingApproval(approvalId: string, outcome: PolicyOutcome): Promise<void> {
    await this.finalizeApproval(approvalId, outcome);
    // Phase 37-B 硬化（C2）：promise 解阻塞值必须是「store 提交后的真相」而非输入 outcome。
    // 无论 human 还是 applyDecision 谁先拿到锁，promise 值 == durable status（store 为唯一真相源）。
    const entry = this.pendingApprovals.get(approvalId);
    if (entry) {
      this.pendingApprovals.delete(approvalId);
      const rec = this.store ? await this.store.load(this.sessionId) : undefined;
      const committed: PolicyOutcome =
        rec && rec.approvalId === approvalId && rec.status === "approved" ? "allow"
        : rec && rec.approvalId === approvalId && rec.status === "rejected" ? "deny"
        : outcome; // 无 store：退化为输入值（无耐久语义）
      entry.resolve(committed);
    }
  }

  /** atomic terminal transition：仅当仍为 pending_approval 才转换；否则幂等 no-op（防重复 / 竞态）。 */
  private async finalizeApproval(approvalId: string, outcome: PolicyOutcome): Promise<void> {
    await this.withApprovalLock(approvalId, async () => {
      if (!this.store) return;
      const rec = await this.store.load(this.sessionId);
      if (!rec || rec.approvalId !== approvalId) return; // operation mismatch / not found
      if (rec.status !== "pending_approval") return; // 已是终态 → 幂等 no-op
      rec.status = outcome === "allow" ? "approved" : "rejected";
      rec.updatedAt = Date.now();
      await this.store.save(rec);
      this.audit?.append(makeAuditEvent({
        eventType: "APPROVAL_DECISION",
        runId: rec.runId,
        sessionId: this.sessionId,
        toolName: rec.checkpoint.toolName,
        approvalDecision: outcome === "allow" ? "APPROVED" : "REJECTED",
      }));
    });
  }

  /** 同一 approvalId 的 terminal transition 串行化（防并发 Approve/Reject 竞态）。 */
  private async withApprovalLock(approvalId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.approvalLocks.get(approvalId) ?? Promise.resolve();
    const next = prev.finally(fn);
    this.approvalLocks.set(approvalId, next);
    try {
      await next;
    } finally {
      if (this.approvalLocks.get(approvalId) === next) this.approvalLocks.delete(approvalId);
    }
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
    this.agent.state.tools = effectiveToolsFor(this.skill, this.registry.toAgentTools());
  }

  listTools(): string[] {
    return this.registry.names();
  }

  /**
   * Phase 30 — 返回当前 Skill 激活后「实际对 Pi 可见」的 Tool 名称集合。
   * 无 Skill（或未声明 toolNames）→ 与 listTools() 一致（全部已注册 Tool）。
   */
  listEffectiveTools(): string[] {
    return effectiveToolsFor(this.skill, this.registry.toAgentTools()).map((t) => t.name);
  }

  /** Phase 30 — 返回组合后的 system prompt（Runtime 基础指令 + Skill 激活指令）。 */
  effectiveSystemPrompt(): string {
    return composeSystemPrompt(this.systemPrompt, this.skill);
  }

  /** Phase 30 — 当前激活的 Skill（若构造时未提供则为 undefined）。仅供测试/可观测。 */
  activeSkill(): Skill | undefined {
    return this.skill;
  }

  async prompt(text: string): Promise<void> {
    await this.agent.prompt(text);
  }

  /** 开启一次 Execution Trace 并开始运行，返回结构化 RunResult（Business-facing）。 */
  async run(text: string, context?: RunContextInput): Promise<RunResult> {
    this.currentRunId = randomUUID();
    this.currentPrompt = text;
    this.aborted = false;
    this.runContext = this.makeRunContext(text, context);
    // Phase 31 — 将 Runtime-owned Run 身份显式注入 TraceCollector，供 Tool 构建跨边界 ExecutionContext。
    // Phase 33-B — 同时注入治理上下文（identity/workspace/skillId），供 EXECUTION 审计事件携带（非 ambient）。
    this.collector.setRunContext({
      runId: this.currentRunId,
      sessionId: this.sessionId,
      identity: this.runContext.identity,
      workspace: this.runContext.workspace,
      skillId: this.skill?.id,
    });
    this.collector.startRun(text);
    // Phase 33-B — Durable Audit：Run 开始控制点。
    this.audit?.append(makeAuditEvent({
      eventType: "RUN_STARTED",
      runId: this.currentRunId,
      sessionId: this.sessionId,
      identity: this.runContext.identity,
      workspace: this.runContext.workspace,
      skillId: this.skill?.id,
    }));
    if (this.store) {
      try {
        await this.store.saveMessages(this.sessionId, this.agent.state.messages);
      } catch {
        /* best-effort */
      }
    }
    try {
      await this.prompt(text);
    } catch (e) {
      // 真正的运行期失败（LLM/stream 抛错，未编码为 stopReason）。
      const trace = this.collector.lastTrace();
      this.audit?.append(makeAuditEvent({
        eventType: "RUN_FINISHED",
        runId: this.currentRunId,
        sessionId: this.sessionId,
        identity: this.runContext.identity,
        workspace: this.runContext.workspace,
        skillId: this.skill?.id,
        outcome: "failed",
      }));
      return {
        status: "failed",
        sessionId: this.sessionId,
        runId: trace?.runId ?? "unknown",
        answer: trace?.finalAnswer || undefined,
        trace,
        error: { code: "llm_error", message: (e as Error).message || "Run failed" },
      };
    }
    const result = this.buildRunResult();
    // Phase 33-B — Durable Audit：Run 结束控制点（outcome = 生命周期状态）。
    this.audit?.append(makeAuditEvent({
      eventType: "RUN_FINISHED",
      runId: this.currentRunId,
      sessionId: this.sessionId,
      identity: this.runContext.identity,
      workspace: this.runContext.workspace,
      skillId: this.skill?.id,
      outcome: result.status,
    }));
    return result;
  }

  /** 把真实 Run 生命周期收敛为结构化 RunResult（不泄漏 Pi 内部状态）。 */
  private buildRunResult(): RunResult {
    const trace = this.collector.lastTrace();
    const stopReason = trace?.stopReason;
    let status: RunStatus;
    if (this.aborted || stopReason === "aborted") status = "aborted";
    else if (stopReason === "error") status = "failed";
    else if (stopReason === "completed" || (trace?.finalAnswer ?? "") !== "") status = "completed";
    else status = "unknown";

    const result: RunResult = {
      status,
      sessionId: this.sessionId,
      runId: trace?.runId ?? "unknown",
    };
    if (trace?.finalAnswer) result.answer = trace.finalAnswer;
    if (trace) result.trace = trace;
    if (status === "failed") {
      result.error = { code: "llm_error", message: trace?.errorMessage ?? "Run ended with error stopReason" };
    } else if (status === "aborted") {
      result.error = { code: "aborted", message: "Run aborted by caller" };
    } else if (status === "unknown") {
      result.error = { code: "unknown", message: "Run outcome could not be determined; do not treat as failure" };
    }
    return result;
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
    this.aborted = true;
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

  /**
   * Phase 28-A — 暴露 Runtime 的 TraceCollector 作为 Execution Boundary 的 Trace 回调。
   * Tool 在委托边界执行时传入此 sink，即可把「子进程 lifecycle」并入同一 ExecutionTrace。
   */
  executionTraceSink(): ExecutionTraceSink {
    return this.collector;
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

  /**
   * Phase 34-B — Recovery wiring（薄封装，不引入新概念 / 不引入 Manager）。
   *
   * 若当前 session 存在「未完成」的 Recovery Record（status !== "recovered"），
   * 则自动进入 Recover 路径：Reconstruct → Reconcile → Decide。否则返回 continue。
   * Decision Owner = EnterpriseAiRuntime；外部 outcome authority = External Resource；
   * Policy / Audit / Trace / Pi 均不负责 Recovery。
   */
  async recoverIfUnfinished(reconcile: ReconcileFn): Promise<RecoveryResult> {
    if (!this.store) return { decision: "continue" };
    const record = await this.store.load(this.sessionId);
    if (!record || record.status === "recovered") return { decision: "continue" };
    // Phase 37-B — Human-Gated Operation：Runtime 不替人工做决策，不自动执行 Tool。
    // pending_approval / approved / rejected 由后续 Run 的 beforeToolCall 对账 durable truth 后 resume / block。
    if (record.status === "pending_approval" || record.status === "approved" || record.status === "rejected") {
      return { decision: "continue" };
    }
    return this.recover(this.sessionId, reconcile);
  }
}
