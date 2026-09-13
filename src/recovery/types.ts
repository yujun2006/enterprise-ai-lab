import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Phase 20-1 — Recovery type contracts.
 *
 * Minimal durable recovery record. Deliberately does NOT contain:
 *   - AgentState (activeRun / streaming / abort / pendingToolCalls)
 *   - Trace events
 *   - Resource Data (owned by External Resource)
 * Session messages are persisted separately (Phase 18 boundary), keyed by sessionId.
 */

/**
 * Phase 37-B — Human-Gated Recovery 扩展（非新 Boundary）：
 *   pending_approval = 已写 durable pending，等待人工决议（崩溃可恢复）
 *   approved         = 人工已批准、待执行（可能在 approval 与 tool 之间崩溃 → resume）
 *   rejected         = 人工拒绝，终态，Tool 永不执行
 * Approval 是 Operation State（复用 DurableRecoveryRecord），不是 Run Lifecycle（RunStatus 不变）。
 */
export type RecoveryStatus = "running" | "interrupted" | "recovered" | "pending_approval" | "approved" | "rejected";

export type CheckpointPosition =
  | "before_tool"
  | "during_tool"
  | "after_tool_before_result"
  | "after_tool_result";

export interface ResourceReference {
  workspaceId?: string;
  resourceId?: string;
}

export interface RecoveryCheckpoint {
  position: CheckpointPosition;
  toolName?: string;
  toolArgs?: unknown;
  idempotencyKey?: string;
  resourceReference?: ResourceReference;
  /** Phase 37-B 硬化：Tool 参数的稳定指纹（sha256 前 32 位）。approved 续跑时强制校验 args 指纹 + toolName，
   *  不匹配则拒绝（人批准的是「这个 operation」，不是任意后续 Tool Call）。 */
  argsFingerprint?: string;
}

export interface DurableRecoveryRecord {
  sessionId: string;
  runId: string;
  parentRunId?: string;
  prompt: string;
  status: RecoveryStatus;
  checkpoint: RecoveryCheckpoint;
  /** Phase 37-B — Human Approval 稳定身份 / 幂等 key（operation-level，非 sessionId）。 */
  approvalId?: string;
  /** Filled after a normal tool completion (from result.details.operationId). */
  operationId?: string;
  updatedAt: number;
}

export type ReconcileResult = "SUCCESS" | "NOT_FOUND" | "UNKNOWN";
export type RecoveryDecision = "continue" | "skip" | "retry" | "escalate";
export type ReplayCapability = "never" | "safe";

/** Runtime-owned reconcile callback. Reads the External Resource's truth. */
export type ReconcileFn = (
  key: string,
  ref?: ResourceReference,
) => Promise<ReconcileResult> | ReconcileResult;

export interface RecoveryResult {
  decision: RecoveryDecision;
  operationId?: string;
  idempotencyKey?: string;
  toolName?: string;
  args?: unknown;
  /** Present when decision === "retry". The caller re-issues this Tool Call via a new Run (Policy re-evaluated). */
  retry?: { toolName: string; args: unknown };
}

export type { AgentMessage };
