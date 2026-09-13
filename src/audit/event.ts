import type {
  IdentityContext,
  WorkspaceContext,
  ResourceContext,
  CredentialContext,
} from "../policy/types.js";

/** Phase 33-B — 最小审计事件类型（治理事实，非 Debug / 可观测）。 */
export type AuditEventType =
  | "RUN_STARTED"
  | "POLICY_DECISION"
  | "TOOL_EXECUTION"
  | "EXECUTION"
  | "RUN_FINISHED"
  | "APPROVAL_DECISION";

/**
 * Phase 33-B — AuditEvent = Durable Governance / Accountability 记录。
 *
 * 仅携带最小必要治理事实（与 Trace 严格分离）：
 *  - 关联 ID（runId / sessionId / toolCallId）
 *  - 治理上下文（identity / workspace / skillId）
 *  - 动作（toolName）
 *  - 资源身份（resource，仅 type/id，不含数据）
 *  - 凭证引用（credentialRef，仅 type/id，不含密钥）
 *  - 决策（policyDecision）
 *  - 结果（outcome）
 *
 * 不携带（避免高带宽 / 敏感）：LLM payload、assistant text、tool args、tool result、prompt、secret。
 * resource 只允许 {type,id}；credentialRef 只允许 {type,id}。
 */
export interface AuditEvent {
  eventId: string;
  /** ISO 8601 时间戳（Runtime 生成，审计用，不依赖子进程时钟）。 */
  timestamp: string;
  eventType: AuditEventType;
  runId: string;
  sessionId: string;
  identity?: IdentityContext;
  workspace?: WorkspaceContext;
  skillId?: string;
  toolCallId?: string;
  toolName?: string;
  resource?: ResourceContext;
  credentialRef?: CredentialContext;
  policyDecision?: "ALLOW" | "DENY" | "ASK";
  /** Phase 37-B — Human Approval 决议（治理事实；不含 secret/tool args/result）。 */
  approvalDecision?: "PENDING" | "APPROVED" | "REJECTED";
  outcome?: string;
}

/**
 * Phase 33-B — 最小审计落点接口。
 * 仅 append。不提供 query / search / delete / aggregate / replay / index / subscribe。
 */
export interface AuditSink {
  append(event: AuditEvent): void | Promise<void>;
}

/** 构造一个带 eventId + ISO 时间戳的审计事件（由 Runtime 在控制点调用）。 */
export function makeAuditEvent(base: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...base,
  };
}
