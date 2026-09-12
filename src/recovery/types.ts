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

export type RecoveryStatus = "running" | "interrupted" | "recovered";

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
}

export interface DurableRecoveryRecord {
  sessionId: string;
  runId: string;
  parentRunId?: string;
  prompt: string;
  status: RecoveryStatus;
  checkpoint: RecoveryCheckpoint;
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
