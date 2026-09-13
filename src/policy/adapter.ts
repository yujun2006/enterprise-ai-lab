import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type {
  Policy,
  PolicyDecision,
  PolicyOutcome,
  PolicyToolCall,
  PolicyContext,
  RunContext,
  ResourceContext,
  CredentialContext,
} from "./types.js";
import { toolCallFromContext } from "./types.js";

/**
 * Phase 4-C Policy Adapter — 把 Enterprise Policy 接到 Pi 的正式 Control Point。
 *
 * - ALLOW  → 返回 undefined（Pi 正常执行 tool.execute）
 * - DENY   → 返回 { block: true, reason }（Pi 构造 error ToolResult，tool.execute 永不调用）
 * - ASK    → await approval()：allow 等价 ALLOW，deny 等价 DENY
 *
 * Phase 29-B：evaluatePolicy 现在接收 Runtime 创建的 RunContext，并将其与 Tool Call
 * 合并为 PolicyContext 传给 Policy。Context 通过显式参数传播，不使用 global / singleton / env。
 *
 * 本适配器不修改 Pi、不执行 Tool、不重新调用 LLM。
 */
export interface PolicyTraceHooks {
  onDecision?: (call: PolicyToolCall, decision: PolicyDecision) => void;
  onResolved?: (call: PolicyToolCall, decision: PolicyDecision, outcome: PolicyOutcome, reason?: string) => void;
  /** Phase 37-B — ASK 分支 await 人工之前触发（Runtime 在此写 durable pending approval）。 */
  onAskBegin?: (call: PolicyToolCall, decision: PolicyDecision) => void | Promise<void>;
  /** Phase 37-B — 人工决议后触发（Runtime 在此写 terminal approval decision）。 */
  onAskDecided?: (call: PolicyToolCall, decision: PolicyDecision, outcome: PolicyOutcome) => void | Promise<void>;
}

const APPROVER_DENY_REASON = "Policy denied by approver";

export async function evaluatePolicy(
  policy: Policy,
  runContext: RunContext,
  beforeCtx: BeforeToolCallContext,
  resource?: ResourceContext,
  credentialRef?: CredentialContext,
  hooks: PolicyTraceHooks = {},
): Promise<BeforeToolCallResult | undefined> {
  const toolCall = toolCallFromContext(beforeCtx);
  const policyContext: PolicyContext = {
    ...runContext,
    ...toolCall,
    resource: resource,
    credentialRef: credentialRef,
  };
  const decision = policy(policyContext);
  hooks.onDecision?.(policyContext, decision);

  switch (decision.type) {
    case "allow":
      return undefined;
    case "deny":
      hooks.onResolved?.(policyContext, decision, "deny", decision.reason);
      return { block: true, reason: decision.reason };
    case "ask": {
      // onDecision 已在 switch 前触发（POLICY_DECISION=ASK）。
      // Phase 37-B — await 人工之前先写 durable pending（Runtime-owned lifecycle）。
      await hooks.onAskBegin?.(policyContext, decision);
      const outcome = await decision.approval();
      // Phase 37-B — 人工决议后写 terminal decision（原子转换）。
      await hooks.onAskDecided?.(policyContext, decision, outcome);
      hooks.onResolved?.(policyContext, decision, outcome);
      return outcome === "allow" ? undefined : { block: true, reason: APPROVER_DENY_REASON };
    }
  }
}
