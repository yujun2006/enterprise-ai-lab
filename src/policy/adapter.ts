import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Policy, PolicyDecision, PolicyOutcome, PolicyToolCall } from "./types.js";
import { toolCallFromContext } from "./types.js";

/**
 * Phase 4-C Policy Adapter — 把 Enterprise Policy 接到 Pi 的正式 Control Point。
 *
 * - ALLOW  → 返回 undefined（Pi 正常执行 tool.execute）
 * - DENY   → 返回 { block: true, reason }（Pi 构造 error ToolResult，tool.execute 永不调用）
 * - ASK    → await approval()：allow 等价 ALLOW，deny 等价 DENY
 *
 * 本适配器不修改 Pi、不执行 Tool、不重新调用 LLM。
 */
export interface PolicyTraceHooks {
  onDecision?: (call: PolicyToolCall, decision: PolicyDecision) => void;
  onResolved?: (call: PolicyToolCall, decision: PolicyDecision, outcome: PolicyOutcome, reason?: string) => void;
}

const APPROVER_DENY_REASON = "Policy denied by approver";

export async function evaluatePolicy(
  policy: Policy,
  ctx: BeforeToolCallContext,
  hooks: PolicyTraceHooks = {},
): Promise<BeforeToolCallResult | undefined> {
  const call = toolCallFromContext(ctx);
  const decision = policy(call);
  hooks.onDecision?.(call, decision);

  switch (decision.type) {
    case "allow":
      return undefined;
    case "deny":
      hooks.onResolved?.(call, decision, "deny", decision.reason);
      return { block: true, reason: decision.reason };
    case "ask": {
      const outcome = await decision.approval();
      if (outcome === "allow") {
        hooks.onResolved?.(call, decision, "allow");
        return undefined;
      }
      hooks.onResolved?.(call, decision, "deny", APPROVER_DENY_REASON);
      return { block: true, reason: APPROVER_DENY_REASON };
    }
  }
}
