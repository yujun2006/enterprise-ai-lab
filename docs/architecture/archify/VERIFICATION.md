# Source Verification — Architecture Relationships

> Every relationship below is verified against the actual repository (`src/`).
> No hypothetical components are referenced. Generated as companion evidence to the
> Archify diagrams (the diagrams omit `sources` so they do not require pinned repo metadata).

## Core components (verified present)

| Component | Source | Role |
| --- | --- | --- |
| `EnterpriseAiRuntime` | `src/runtime.ts:100` | Thin facade: Run lifecycle + Recovery/Approval control points |
| `ToolRegistry` | `src/tools/registry.ts:36` | Tool catalog + Resource/Credential identity (no execution) |
| `TraceCollector` | `src/trace/collector.ts:56` | Read-only execution observation (in-memory) |
| `evaluatePolicy` (Policy Adapter) | `src/policy/adapter.ts:37` | Maps Enterprise Policy → Pi control point (ALLOW/DENY/ASK) |
| `RecoveryStore` / `FileRecoveryStore` | `src/recovery/store.ts:10`, `src/recovery/file-store.ts:15` | Durable recovery record + session transcript |
| `AuditSink` / `FileAuditSink` | `src/audit/event.ts:56`, `src/audit/file-sink.ts:13` | Append-only governance facts |
| `ExecutionBoundary` | `src/execution/boundary.ts:52` | Isolated child-process command execution |
| `ScriptedModel` / Ollama | `src/scripted-model.ts:43`, `src/ollama/model.ts` | Model + StreamFn (test vs prod) |
| `Skill` | `src/skills/skill.ts:14` | Capability declaration (not auth) |
| `pi-agent-core` `Agent` | external dep; built in `src/runtime.ts:148` | Agent loop, Tool execution, Agent state |

## Verified relationships

- Runtime owns `ToolRegistry` + `TraceCollector` → `src/runtime.ts:130,140`.
- `beforeToolCall` evaluates Policy, then checkpoints before tool → `src/runtime.ts:199-293`.
- Policy ASK writes a durable pending approval → `src/runtime.ts:256-260`, `persistPendingApproval:369`.
- Checkpoint persisted *before* tool with `idempotencyKey` → `src/runtime.ts:328-354` + `scripts/_p20_fixtures.ts:reconcileFileExternal`.
- `afterToolCall` advances record to `recovered` + records `operationId` → `src/runtime.ts:316-322`.
- `RecoveryStore` = ONE record per session (`recovery-<sessionId>.json`) → `src/recovery/file-store.ts:22`.
- Audit is append-only, never read back as state → `src/audit/file-sink.ts:16` (`append` only).
- `ExecutionBoundary` isolates side-effects in a child process + sanitized env → `src/execution/boundary.ts:29-40,74`.
- Session continuity = persisted messages (`saveMessages`/`loadMessages`) → `src/runtime.ts:163-167`.
- Run is a volatile envelope; `runId` regenerated per `run()` → `src/runtime.ts:521`.
- Recovery reconstructs the **Session**, never the old Run → `src/runtime.ts:674-704`.
- Human approval (`approvalId`) outlives the original Run → `src/runtime.ts:433` (`applyDecision`), `types.ts:48-49`.

## Boundary findings (no new subsystem)

- Human Approval = `Policy ASK` + `DurableRecoveryRecord` + `approvalId` (Phase 37-B). Not a subsystem.
- Long-Horizon = repeated Runs under one durable Session (Phase 38-A Design Gate: CASE A — no new Runtime Boundary).
- No `ApprovalManager` / `WorkflowEngine` / `Orchestrator` / `Queue` / `EventBus` exist in `src/`.

## Artifact paths

- Architecture: `docs/architecture/archify/enterprise-runtime-architecture.html`
- Workflow: `docs/architecture/archify/enterprise-runtime-workflow.html`
- Lifecycle: `docs/architecture/archify/durable-recovery-lifecycle.html`
- Specs (JSON): `docs/architecture/archify/*.json`
