export { EnterpriseAiRuntime } from "./runtime.js";
export type { RuntimeEventListener, RuntimeOptions, RunResult, RunStatus, RunError } from "./runtime.js";
export { ollamaModel, createOllamaRuntimeDeps } from "./ollama/model.js";
export type { OllamaRuntimeDeps } from "./ollama/model.js";

/** 确定性测试后端（实验用；让 Consumer / 离线 HTTP 不依赖真实 LLM）。 */
export { ScriptedModel } from "./scripted-model.js";

export { ToolRegistry } from "./tools/registry.js";
export type { ResourceAwareTool, CredentialAwareTool } from "./tools/registry.js";

/** Phase 30 — 最小 Skill 能力声明（declaration，不是 authorization）。 */
export type { Skill } from "./skills/skill.js";
export { effectiveToolsFor, composeSystemPrompt } from "./skills/skill.js";
export { getCustomer, CUSTOMERS } from "./tools/get-customer.js";
export type { Customer } from "./tools/get-customer.js";

/** Phase 28-A — 最小 Execution Boundary（实验能力）。 */
export { executeInBoundary } from "./execution/boundary.js";
export type { ExecutionRequest, ExecutionResult, ExecutionTraceSink, ExecutionContext } from "./execution/types.js";
export { createSandboxTestTool } from "./tools/sandbox-test-tool.js";
export type { SandboxMode } from "./tools/sandbox-test-tool.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
export type { AgentTool };
export type EnterpriseTool = AgentTool<any>;

export { TraceCollector } from "./trace/collector.js";
export { formatTrace } from "./trace/format.js";
export type { ExecutionTrace, TraceEvent, LlmCallTrace, LlmTraceSink } from "./trace/types.js";

/** Phase 33-B — 最小 Durable Audit（治理事实；与 Trace 严格分离，无 Manager/Service/Engine）。 */
export type { AuditEvent, AuditEventType, AuditSink } from "./audit/event.js";
export { FileAuditSink, makeAuditEvent } from "./audit/file-sink.js";

export { evaluatePolicy } from "./policy/adapter.js";
export type {
  Policy,
  PolicyDecision,
  PolicyToolCall,
  PolicyOutcome,
  PolicyContext,
  RunContext,
  RunContextInput,
  IdentityContext,
  WorkspaceContext,
  ResourceContext,
  CredentialContext,
} from "./policy/types.js";

export { FileRecoveryStore } from "./recovery/file-store.js";
export type { RecoveryStore } from "./recovery/store.js";
export { decideRecovery } from "./recovery/recovery.js";
export type {
  DurableRecoveryRecord,
  RecoveryResult,
  ReconcileFn,
  ReconcileResult,
  RecoveryDecision,
  RecoveryStatus,
  CheckpointPosition,
  ResourceReference,
  RecoveryCheckpoint,
  ReplayCapability,
} from "./recovery/types.js";
