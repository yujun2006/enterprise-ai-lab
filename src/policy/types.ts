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

/** Phase 29-B — Identity context。caller-supplied，本 Story 不做身份验证（信任边界属后续）。 */
export interface IdentityContext {
  userId?: string;
  tenantId?: string;
  orgId?: string;
}

/** Phase 29-B — Workspace context。 */
export interface WorkspaceContext {
  workspaceId: string;
}

/**
 * Phase 29-B — Runtime-owned context for a single Run。
 *
 * 由 EnterpriseAiRuntime 在 run() 时创建并显式传播到 Policy Control Point。
 * identity / workspace 是 caller 提供的上下文（不是被验证过的可信身份声明）。
 * 认证 / 信任边界属于后续 Story，不在本 Story 范围。
 */
export interface RunContext {
  runId: string;
  sessionId: string;
  task: string;
  identity?: IdentityContext;
  workspace?: WorkspaceContext;
}

/** Phase 29-B — 调用方可在启动 Run 时提供的可选上下文；runId/sessionId/task 由 Runtime 生成。 */
export interface RunContextInput {
  identity?: IdentityContext;
  workspace?: WorkspaceContext;
}

/** Policy 输入：围绕 Pi 已提供的 Tool Call 信息。 */
export interface PolicyToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/**
 * Phase 29-C — Resource Identity（仅标识，不含 Resource Data）。
 *
 * 描述「Tool 正在访问哪个资源」，例如 { type: "customer", id: "alice" }。
 * 由 Tool / Resource integration 声明（见 ResourceAwareTool），Runtime 不猜测业务参数语义。
 * 与 Recovery 的 ResourceReference 职责不同（后者用于重定位外部操作）。
 */
export interface ResourceContext {
  type: string;
  id: string;
}

/**
 * Phase 29-D — Credential Reference（仅引用，不是密钥本身）。
 *
 * 描述「Tool 本次调用需要使用哪个 Credential」，例如 { type: "api-key", id: "crm-readonly" }。
 * 由 Tool / Integration 声明（见 CredentialAwareTool），Runtime 只传播、不持有语义、不持有密钥。
 * 与 Recovery 的 ResourceReference 职责不同。绝对不能携带 secret / token / password / key value。
 */
export interface CredentialContext {
  type: string;
  id: string;
}

/**
 * Phase 29-B — Policy Context = RunContext + Tool Call + 扩展占位。
 *
 * - 保留 PolicyToolCall 的扁平字段（toolCallId / toolName / args）以兼容既有 Policy。
 * - resource：29-C 起携带 Resource Identity（仅 type/id，不含数据）。
 * - credentialRef：29-D 起携带 Credential Reference（仅 type/id，不含密钥）。
 * - Policy 输入从「只有 Tool」演进为「RunContext + Tool + Resource + CredentialRef」，
 *   决策契约（ALLOW/DENY/ASK）不变。
 */
export interface PolicyContext extends RunContext, PolicyToolCall {
  resource?: ResourceContext;
  credentialRef?: CredentialContext;
}

/** Policy = 给定一次 PolicyContext，返回一个决策。Policy 本身不执行 Tool。 */
export type Policy = (context: PolicyContext) => PolicyDecision;

/** 从 Pi 的 BeforeToolCallContext 抽取 Enterprise Tool Call 所需的最小信息。 */
export function toolCallFromContext(ctx: BeforeToolCallContext): PolicyToolCall {
  return { toolCallId: ctx.toolCall.id, toolName: ctx.toolCall.name, args: ctx.args };
}
