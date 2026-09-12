import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";

/**
 * Phase 4-C 最小 Policy Contract。
 *
 * 仅覆盖三种决策：ALLOW / DENY / ASK（Plan A）。
 * 不引入 metadata / priority / policy chain / registry 等扩展。
 */

export type PolicyOutcome = "allow" | "deny";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  /** ASK（Plan A）：在 beforeToolCall 内 await 外部审批，不重新调用 LLM。 */
  | { type: "ask"; approval: () => Promise<PolicyOutcome> };

/** Policy 输入：围绕 Pi 已经提供的 Tool Call 信息，不重新定义 Agent Loop。 */
export interface PolicyToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** Policy = 给定一次 Tool Call，返回一个决策。Policy 本身不执行 Tool。 */
export type Policy = (call: PolicyToolCall) => PolicyDecision;

/** 从 Pi 的 BeforeToolCallContext 抽取 Enterprise Policy 所需的最小信息。 */
export function toolCallFromContext(ctx: BeforeToolCallContext): PolicyToolCall {
  return { toolCallId: ctx.toolCall.id, toolName: ctx.toolCall.name, args: ctx.args };
}
