import type { ReconcileResult, RecoveryDecision, ReplayCapability } from "./types.js";

/**
 * Pure Recovery Decision function (Phase 20-1).
 *
 * Decision Owner = Enterprise Runtime. Uses the External reconcile result plus the
 * tool's declared replay capability (Pi's native `AgentTool.replay`).
 *
 *   SUCCESS   → SKIP          (committed; never retry)
 *   NOT_FOUND → replay "safe" ? RETRY : ESCALATE
 *   UNKNOWN   → ESCALATE      (never blind-retry an UNKNOWN)
 */
export function decideRecovery(
  reconcile: ReconcileResult,
  replay: ReplayCapability | undefined,
): RecoveryDecision {
  switch (reconcile) {
    case "SUCCESS":
      return "skip";
    case "UNKNOWN":
      return "escalate";
    case "NOT_FOUND":
      return replay === "safe" ? "retry" : "escalate";
  }
}
