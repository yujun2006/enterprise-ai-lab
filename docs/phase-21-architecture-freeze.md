# Phase 21 — Architecture Freeze

> Runtime Boundary Audit. `CODE CHANGED: NO`. Every claim below is grounded in current
> `src/`, `scripts/`, and `docs/` as of this phase. Tags:
> `[SOURCE]` = proven by code/test, `[EXP]` = proven by experiment/test run,
> `[INF]` = architectural inference from SOURCE/EXP, `[OPEN]` = no evidence yet.

---

## 1. Objective

Consolidate the Runtime Architecture Contract established across Phase 1–20, and surface
contradictions, duplicated definitions, and unresolved OPEN items — **without changing code**.

---

## 2. Current Runtime Architecture (as built)

| Layer | Component | Reality |
| --- | --- | --- |
| Thin facade | `EnterpriseAiRuntime` (`src/runtime.ts:58`) | Owns Policy hook, Checkpoint, Recovery, Run id, Session id. Wraps one Pi `Agent`. |
| Agent loop | Pi `Agent` (`src/runtime.ts:84-106`) | Owns Agent State, tool execution, tool results. |
| Persistence | `RecoveryStore` (interface `src/recovery/store.ts`) / `FileRecoveryStore` (`file-store.ts`) | File MVP only; injected. |
| Recovery logic | pure `decideRecovery` (`src/recovery/recovery.ts`) | No Manager class. |
| Observability | `TraceCollector` (`src/trace/collector.ts`) | Records events; no decisions. |
| Policy | `evaluatePolicy` (`src/policy/adapter.ts`) | Called inside `beforeToolCall`. |

---

## 3. Component Inventory

> One row per concept the gate asks about. "Exists in `src/`?" is the key discriminator.

### EnterpriseAiRuntime
1. What: thin lifecycle facade over one Pi `Agent`. `src/runtime.ts:58`.
2. Owner: Enterprise (this project). 3. Created: caller (`new EnterpriseAiRuntime`). 4. Mutable by: itself; no external mutation API. 5. Lifecycle: one per Session-process; die with process. 6. Persisted: **no** (only delegates to store). 7. Persists: Session messages + Recovery Record via injected store. 8. Boundary: owns *control points* (policy/checkpoint/recovery), **not** Agent State or tool execution.

### Pi Agent
1. What: `Agent` from `@earendil-works/pi-agent-core`. 2. Owner: Pi library. 3. Created: `makeAgent` (`runtime.ts:84`). 4. Mutable by: Pi loop only. 5. Lifecycle: in-memory; per Runtime instance. 6. Persisted: **no** (memory only, proven Exp2 in `phase-17`). 7. — 8. Boundary: must NOT know about Recovery/Checkpoint/Persistence (`phase-19`, `[SOURCE]` `runtime.ts:83-106`).

### Pi Agent State
1. What: `agent.state` (messages, tools, isStreaming, …). 2. Owner: Pi. 3. Created: Pi. 4. Mutable by: Pi loop. 5. Lifecycle: in-memory. 6. Persisted: **no** directly; only `messages` mirrored via `saveMessages` (`runtime.ts:102,172,218`). 7. Persists: transcript only. 8. Boundary: **≠ Session**, **≠ Checkpoint**, **≠ Trace** (`phase-12`, `[SOURCE]`).

### Session
1. What: durable logical conversation unit; `sessionId` (`runtime.ts:77,94`). 2. Owner: Enterprise Runtime (assigns/holds `sessionId`). 3. Created: `opts.sessionId ?? randomUUID()` (`runtime.ts:77`). 4. Mutable by: Runtime. 5. Lifecycle: survives process death (durable identity). 6. Persisted: yes — `sessionId` + messages (`file-store.ts:26-28,53-59`). 7. Persists: `sessionId`, `messages`. 8. Boundary: `sessionId` stable; `runId`/`toolCallId` are NOT session identity (`phase-20` doc §249).

### Run
1. What: one `agent.prompt()` invocation (`runtime.ts:207,213`). 2. Owner: Runtime. 3. Created: `run()` sets `currentRunId = randomUUID()` (`runtime.ts:213`). 4. Mutable by: Runtime. 5. Lifecycle: starts at `run()`, ends at `agent_end`. **Not durable** (`phase-19`: `runId` is NOT recovery identity). 6. Persisted: **no**. 7. — 8. Boundary: `Run ≠ Session`, `runId ≠ operationId` (audit confirmed).

### Run Context
1. What: per-Run transient frame (`currentRunId`, `currentPrompt`, `collector.startRun`). 2. Owner: Runtime. 3. Created: `run()` (`runtime.ts:213-215`). 4. Mutable by: Runtime. 5. Lifecycle: per Run. 6. Persisted: **no**. 7. — 8. Boundary: in-memory; not part of Checkpoint.

### Tool Registry
1. What: name→`AgentTool` map (`src/tools/registry.ts:10`). 2. Owner: Runtime (`runtime.registry`). 3. Created: Runtime ctor (`runtime.ts:72`). 4. Mutable by: `registerTool` (`runtime.ts:198`). 5. Lifecycle: per Runtime instance. 6. Persisted: **no**. 7. — 8. Boundary: directory only; does NOT execute tools (`registry.ts:6-9`).

### Tool (AgentTool)
1. What: `AgentTool` from Pi. 2. Owner: caller/Enterprise (definition), Pi (execution). 3. Created: caller. 4. Mutable by: none at runtime. 5. Lifecycle: static definition. 6. Persisted: **no** (closure/function not serialized). 7. — 8. Boundary: **≠ Resource**; must NOT import Checkpoint/Store/Runtime (`phase-20` §8, `[SOURCE]` fixtures only echo `operationId` via `result.details`).

### Policy
1. What: `Policy` fn (`src/policy/types.ts`). 2. Owner: Enterprise (caller-supplied). 3. Created: caller. 4. Mutable by: caller. 5. Lifecycle: per Runtime. 6. Persisted: **no**. 7. — 8. Boundary: decides *can this call execute*; **≠ Recovery**; Recovery MUST re-enter Policy (`runtime.ts:118,302-304`).

### Skill
1. What: *Capability Scope* (architectural). 2. Owner: —. 3–8. **No code in `src/`.** Only referenced in `phase-14-skill-boundary-investigation.md`. `[ARCHITECTURAL/DEFERRED]`.

### Workspace
1. What: *Resource Scope* (architectural). 2. **No Workspace class in `src/`.** Only `workspaceId: string` survives inside `ResourceReference` (`recovery/types.ts:22`; captured `runtime.ts:183`). `[ARCHITECTURAL/DEFERRED]`.

### Resource (External Resource)
1. What: external system owning side-effect truth. 2. Owner: **External** (not Runtime). 3. Created: external. 4. Mutable by: external. 5. Lifecycle: external. 6. Persisted by: external (NOT by Runtime). 7. Runtime persists only `ResourceReference` (`recovery/types.ts:21-24`). 8. Boundary: `ResourceReference ≠ Resource Data` (`phase-15`, `[SOURCE]` `recovery/types.ts`).

### Trace
1. What: `ExecutionTrace` (`src/trace/types.ts`). 2. Owner: Runtime/TraceCollector. 3. Created: `TraceCollector`. 4. Mutable by: collector only. 5. Lifecycle: in-memory per Run. 6. Persisted: **no** (observability only). 7. — 8. Boundary: **≠ Checkpoint**, **≠ Recovery Decision**, **≠ Evaluation** (`phase-11`, `[SOURCE]` collector only emits events).

### Checkpoint
1. What: `RecoveryCheckpoint` inside `DurableRecoveryRecord` (`recovery/types.ts:26-44`). 2. Owner: Runtime (written in `captureCheckpoint`). 3. Created: `captureCheckpoint` (`runtime.ts:152-179`). 4. Mutable by: Runtime (also `afterToolCall` advances position, `runtime.ts:143`). 5. Lifecycle: per Tool-call; durable. 6. Persisted: **yes** (via store). 7. Persists: position, toolName, toolArgs, idempotencyKey, resourceReference (`runtime.ts:162-168`). 8. Boundary: **≠ Trace**, **≠ AgentState**, **≠ messages**.

### Recovery
1. What: `recover()` lifecycle capability (`runtime.ts:276-306`) + pure `decideRecovery`. 2. Owner: **Enterprise Runtime** (Decision Owner). 3. Created: Runtime method. 4. Mutable by: Runtime. 5. Lifecycle: invoked after process restart. 6. Persisted: marks record `status:"recovered"` (`runtime.ts:293`). 7. — 8. Boundary: **≠ Policy**; **never auto-executes tool** (`runtime.ts:302-304` returns retry plan only).

### RecoveryStore
1. What: interface (`recovery/store.ts`) / `FileRecoveryStore`. 2. Owner: Enterprise (caller injects). 3. Created: caller. 4. Mutable by: Runtime via injected instance. 5. Lifecycle: per Runtime. 6. Persisted: yes (file). 7. Persists: Recovery Record + messages. 8. Boundary: storage abstraction only; MVP=File, Production=OPEN.

### External Resource (test fixture)
1. What: `ExternalResource` class in `scripts/_p20_fixtures.ts` (NOT in `src/`). 2. Owner: test. 3. — 4. — 5. — 6. Persisted: `external.json` in tmp dir. 7. — 8. Boundary: stands in for real external side-effect truth.

---

## 4. Ownership Matrix

| Concept | Owner | Lifecycle | Persistent? | Mutable By | Notes |
| --- | --- | --- | --- | --- | --- |
| Agent Loop | Pi | in-memory, per proc | no | Pi | `runtime.ts:84` |
| Agent State | Pi | in-memory, per proc | no | Pi | only `messages` mirrored |
| Session | Enterprise Runtime | durable | yes (id+msgs) | Runtime | `sessionId` stable |
| Run | Runtime | per `run()` | no | Runtime | `runId` NOT durable |
| Run Context | Runtime | per Run | no | Runtime | transient frame |
| Tool Registry | Runtime | per instance | no | Runtime | dir only, no exec |
| Tool | caller/Pi(exec) | static | no | — | closure not serialized |
| Policy | caller | per instance | no | caller | re-evaluated on retry |
| Skill | — | — | no | — | **not implemented** |
| Workspace | — | — | no | — | only `workspaceId` str |
| Resource Reference | Runtime | per checkpoint | yes | Runtime | pointer only |
| Resource Data | **External** | external | external | external | truth owner |
| Trace | Runtime/Collector | per Run | no | Collector | observability only |
| Checkpoint | Runtime | per tool-call | yes | Runtime | inside RecoveryRecord |
| Recovery | **Runtime** | on restart | marks record | Runtime | Decision Owner |
| RecoveryStore | caller | per instance | yes (file) | Runtime(via inj) | MVP=File |

**Ownership conflicts found:** none structural. Single nuance — `Skill`/`Workspace` are documented
ownership scopes with **zero code**, so their "owner" is currently undefined (`[DEFERRED]`).

---

## 5. Lifecycle Model

```
User
 └─ Session (sessionId, durable)            runtime.ts:77,94
     └─ Run (runId, volatile)               runtime.ts:213
         └─ Pi Agent (in-memory)            runtime.ts:84
             └─ Tool Call (toolCallId)      pi-agent-core
                 └─ Tool.execute            pi
                     └─ External Resource   external (truth)
```

Recovery (verified from `runtime.ts:276-306`):
```
Old Run ──process death──▶ Persisted Session + Recovery Record
        └─ reconstructAgent (new Pi Agent, new Run)   runtime.ts:283
        └─ reconcile(idempotencyKey, resourceReference) runtime.ts:286
        └─ decideRecovery(result, tool.replay)          runtime.ts:290
        └─ mark status:"recovered"                      runtime.ts:293
        └─ RETURN retry plan (caller issues NEW Run)    runtime.ts:302-305
```

Verified invariants (`[SOURCE]`):
- **Recovery NEVER resumes old Run**: `reconstructAgent` builds a fresh `Agent` (`runtime.ts:109-111`); old `agent` reference dropped.
- `old runId != new runId`: `run()` always `randomUUID()` (`runtime.ts:213`); recovery does not reuse it.
- `old toolCallId != new toolCallId`: regenerated by Pi per Tool call.
- `sessionId` stable: `recover` reassigns `this.sessionId = sessionId` (`runtime.ts:282`).
- operation identity: `idempotencyKey` stable (persisted pre-tool); `operationId` stable only on normal completion (see §9).

---

## 6. State Boundaries

| Wrong equality | Status | Evidence |
| --- | --- | --- |
| Trace = Checkpoint | ✅ separated | collector emits; checkpoint in store |
| Checkpoint = Agent State | ✅ separated | `recovery/types.ts` ≠ `agent.state` |
| Agent State = Session | ✅ separated | messages mirrored, state not (`runtime.ts:102`) |
| Run = Session | ✅ separated | `runId` volatile, `sessionId` durable |
| RunId = OperationId | ✅ separated | audit §9 |
| ToolCallId = Durable Identity | ✅ separated | audit §9 |

No code currently *asserts* these equalities. One **documentation** overclaim exists (§9 / §14).

---

## 7. Reliability Boundary

| Unit | Can retry? | Dup side-effect risk | Needs checkpoint? | Needs reconcile? | Who decides? |
| --- | --- | --- | --- | --- | --- |
| LLM Call | Pi-internal | n/a | no | no | Pi |
| Tool Call (read-only) | safe | none | yes (pre-tool) | no | Runtime/Policy |
| Tool Call (state-changing) | only if idempotent | yes if no idempotency | **yes** | **yes** | **Runtime** |
| Turn | Pi | n/a | no | no | Pi |
| Run | no (volatile) | — | no | no | — |
| Agent Execution | no | — | no | no | — |

Confirmed model (`[SOURCE]`/`[INF]` from `phase-17..20`):
- `UNKNOWN ≠ FAILED`: `decideRecovery` maps `UNKNOWN → escalate`, never retry (`recovery.ts:20-21`).
- `Timeout ≠ automatically FAILED`: no timeout handling in `src/` → `[OPEN]` (architectural gap, not contradicted).
- `External Resource = side-effect truth`: reconcile reads external (`runtime.ts:286`); checkpoint never infers it.
- `Recovery Decision Owner = Enterprise Runtime`: `decideRecovery` is Runtime-owned (`recovery.ts`).
- `Policy ≠ Recovery`: retry path re-enters `beforeToolCall` → Policy (`runtime.ts:118,302`).

---

## 8. Checkpoint / Recovery Contract

Verified against `runtime.ts`:
- Order **Policy → Checkpoint → External Side Effect** holds for `idempotencyKey`:
  `beforeToolCall`: policy eval (`runtime.ts:118`) → `captureCheckpoint`+`store.save` (`runtime.ts:127,171`) → Pi executes tool → external commit. `[SOURCE]`
- `Checkpoint.position = "before_tool"` semantics (`runtime.ts:163`): durable identity written *before* tool executes; if commit then crash, identity already on disk. `[SOURCE]`
- Crash window: checkpoint written *before* external commit (`phase-20` §15). If checkpoint write fails → tool blocked (`runtime.ts:128-131`). `[SOURCE]`
- `Reconstruct → Reconcile → Decide → Resume`: `recover()` does Reconstruct/Reconcile/Decide
  (`runtime.ts:283,286,290`) and returns a retry plan; it does **NOT** itself execute the resumed
  tool. "Resume" is realized by the **caller** issuing a new `run()` (`phase20-acceptance.ts` Test 3
  re-runs `runtime.run`). → naming nuance, see §14-C2.

---

## 9. Operation Identity (re-audit of the crash path)

### idempotencyKey
- Who creates: caller/LLM as Tool arg (`ctx.args.idempotencyKey`). `[SOURCE] runtime.ts:154-155`
- When captured: `beforeToolCall` → `captureCheckpoint`, **before** tool executes. `[SOURCE] runtime.ts:155,127`
- When persisted: inside `captureCheckpoint` via `store.save`. `[SOURCE] runtime.ts:171`
- Where: `recovery-<sessionId>.json` → `checkpoint.idempotencyKey`. `[SOURCE] file-store.ts:22-24,37-39`
- Used by Reconcile: **yes**, sole key. `[SOURCE] runtime.ts:286`
- Stable across Run/process: **yes** (persisted pre-tool, survives `exit(137)`). `[EXP] phase20 Test 3`

### operationId
- Who creates: Tool/External, echoed in `result.details.operationId`. `[SOURCE] runtime.ts:138-139`
- When obtained: `afterToolCall`, i.e. **after** tool returns (after external commit). `[SOURCE] runtime.ts:138-139`
- When persisted: `afterToolCall` → `store.save(record)` (`runtime.ts:142,146`).
- Can it survive process death? **NO in the crash path.** `afterToolCall` never fires when the tool
  does `process.exit(137)` mid-execute, so `operationId` is **never written** for Test 3/4. `[SOURCE] runtime.ts:136,142,146`
- Used by Reconcile: **no** — reconcile uses only `idempotencyKey`. `[SOURCE] runtime.ts:286`
- Is it actually required? **No** for the recovery mechanism. In the fixture it equals `idempotencyKey`
  (`makeCommitTool` returns `details:{operationId:key}`). It is a redundant echo + reporting field. `[INF]`

### Conclusion
```
DURABLE IDENTITY:      idempotencyKey   (proven, used by reconcile, survives crash)
OPERATION IDENTITY:    idempotencyKey   (the only field that is both durable & used)
EXTERNAL OPERATION ID: operationId      (Tool echo; durable ONLY on normal completion; NOT used)
```

**Contradiction:** `phase-20-implementation-design-gate.md` and `phase-20-production-reliability.md`
claim *"operationId + idempotencyKey = 跨进程/Run 稳定身份"* (`phase-20-…md:94,249`). This holds for
`idempotencyKey` but **not** for `operationId` in the crash scenario the phase is built to prove
(`process.exit(137)` ⇒ `afterToolCall` skipped ⇒ `operationId` absent from disk). The running slice is
correct because reconciliation relies solely on `idempotencyKey`; the durable-identity *claim* overstates
`operationId`. `[CONTRADICTION]` (doc vs code; behavioral recovery unaffected).

---

## 10. Persistence Boundary

Runtime persists **only** (`[SOURCE] file-store.ts` + `runtime.ts`):
- Session `messages` (`runtime.ts:102,172,218`; `file-store.ts:49-51,53-59`)
- `sessionId` (inside record + messages filename)
- Recovery Record (`DurableRecoveryRecord`, `runtime.ts:171,146,293`)
- operation identity = `checkpoint.idempotencyKey` (+ `resourceReference`)
- `checkpoint.position`, `toolName`, `toolArgs`

Runtime does **NOT** persist (`[SOURCE]` no code path):
- Tool function / closure (`AgentTool` never serialized)
- AbortController / streaming state / `activeRun` / in-flight stream (`phase-12`, `runtime.ts` makes fresh Agent)
- Resource Data (owned by External)
- `runId` / `toolCallId` as identity

`FileRecoveryStore` real behavior: temp-file + atomic rename per write (`file-store.ts:30-35`);
one record file + one messages file per `sessionId`. MVP storage only; **Production storage = OPEN**
(`phase-20` §22, `file-store.ts:8-14`).

---

## 11. Skill / Workspace / Resource

| Concept | Implemented in `src/`? | Status |
| --- | --- | --- |
| Skill (Capability Scope) | **no** (not referenced anywhere in `src/`) | `[ARCHITECTURAL/DEFERRED]` (phase-14) |
| Workspace (Resource Scope) | no class; only `workspaceId: string` in `ResourceReference` | `[ARCHITECTURAL/DEFERRED]` (phase-15) |
| Resource (External) | `ResourceReference` type only; `ExternalResource` is a **test fixture** (`scripts/_p20_fixtures.ts`) | Reference: implemented; Data: External-owned |
| Tool ≠ Resource | Tool is `AgentTool`; Resource is external — distinct | `[SOURCE]` consistent |
| Policy ≠ Skill | Policy implemented; Skill absent | `[SOURCE]` consistent |

Boundary `Skill ≠ Workspace ≠ Resource ≠ Tool ≠ Policy` is **documented and not contradicted by code**;
only Skill/Workspace lack any implementation.

---

## 12. Multi-Agent Boundary

- `Agent = EnterpriseAiRuntime instance` (`runtime.ts:58`). `[SOURCE]`
- Multi-Agent = multiple independent Runtime instances + minimal delegation. `[INF] phase-16`
- No `Coordinator` / `AgentManager` / `MessageBus` / shared state in `src/`. (`search_content` returned
  zero matches for `Coordinator|AgentManager|MessageBus`.) `[SOURCE]`
- No code deviates from this model. `[CONSISTENT]`

---

## 13. Trace Boundary

`TraceCollector` (`src/trace/collector.ts`) emits events: `observePolicyDecision` (`:112`),
`observePolicyResolved` (`:130`), `observeCheckpoint` (`:142`), `observeRecovery` (`:154`),
`observeReconcile` (`:161`), `observeDecision` (`:168`), plus `tool_execution_*` via `agent.subscribe`
(`runtime.ts:98`). It performs **no** resume, persistence, recovery decision, or business evaluation.
`[SOURCE]` → Trace ≠ Checkpoint ≠ Recovery ≠ Evaluation. **Consistent.**

---

## 14. Contradictions

**C1 — operationId durability overclaim (doc vs code).**
`phase-20-…md:94,249` state `operationId+idempotencyKey` are durable identity. Code: `operationId`
persisted only in `afterToolCall` (`runtime.ts:142,146`), which is skipped on `process.exit(137)`;
reconcile uses only `idempotencyKey` (`runtime.ts:286`). → durable identity is `idempotencyKey` alone.
Actual recovery is correct; the *claim* is overstated. `[CONTRADICTION]`

**C2 — "Resume" naming vs implementation.**
Docs (design-gate §26, phase-20 §11) describe `Reconstruct→Reconcile→Decide→Resume` as one recovery flow.
`recover()` does Reconstruct/Reconcile/Decide and returns a retry plan; the resumed Tool Call is issued
by the **caller** via a new `run()` (`runtime.ts:302-305`; `phase20-acceptance.ts` Test 3). Recovery does
not itself execute. Naming nuance, not a behavioral bug. `[CONTRADICTION/MINOR]`

**C3 — "operationId proven (Test 8)" scope.**
`phase-20-…md:249` marks `operationId+idempotencyKey` "proven (Test 8)". Test 8 does **not** crash
(`process.exit` only in Test 3/4); it therefore validates the normal-completion path where `operationId`
*is* back-filled. The crash-path durability of `operationId` is unproven. `[CONTRADICTION]` (sub-case of C1)

No duplicated Manager/Coordinator definitions, no code↔test conflicts beyond C1–C3, no stale
"old concept" reintroduced. (Skill/Workspace are consistently DEFERRED across all docs.)

---

## 15. Implemented

- Enterprise `Runtime` facade + `beforeToolCall`/`afterToolCall` control points. `[SOURCE] runtime.ts`
- Policy evaluation gating every tool call (incl. recovery retries). `[SOURCE] runtime.ts:118,302`
- `ToolRegistry`. `[SOURCE]`
- Session durability (`sessionId` + messages persist/reconstruct). `[EXP] phase20 Test 1/7`
- `DurableRecoveryRecord` + `RecoveryCheckpoint`. `[SOURCE]`
- `FileRecoveryStore` (atomic temp+rename). `[SOURCE]`
- Checkpoint-before-tool (idempotencyKey persisted pre-execution). `[EXP] phase20 Test 3`
- `decideRecovery` (SUCCESS→skip, NOT_FOUND→retry/escalate, UNKNOWN→escalate). `[SOURCE] recovery.ts`
- Reconciliation via injected `ReconcileFn` using `idempotencyKey`. `[SOURCE] runtime.ts:286`
- Recovery does not resume old Run; new Run + re-Policy. `[EXP] phase20 Test 3/4/6`
- External UNKNOWN → ESCALATE (no blind retry). `[EXP] phase20 Test 5`
- Trace events for checkpoint/recovery/reconcile/decision. `[SOURCE]`
- Idempotent state-changing tool recovery (the Vertical Slice). `[EXP] phase20 Tests 3/4
- `operationId` echo capture on normal completion. `[EXP] phase20 Test 8

## 16. Deferred (architectural, no code)

- Skill capability scope. (phase-14)
- Workspace resource scope (only `workspaceId` string exists). (phase-15)
- Workflow-level checkpoint. (phase-20 §20)
- Multi-Agent Coordinator / shared state. (phase-16)
- Durable Pi / durable approval queue / Audit / Evaluation. (phase-6/7)
- Timeout/failure classification beyond UNKNOWN≠FAILED. (phase-17)
- Production storage (SQLite/Postgres/Redis). (phase-20 §22)

## 17. Open Questions

- **OQ-1** Should `operationId` be persisted *before* external commit (in `captureCheckpoint`) so it is
  durable across crash too? Currently only `idempotencyKey` is. Decision needed if `operationId` must be
  a true durable identity. `[OPEN]` (derives from C1)
- **OQ-2** How is `ESCALATE` surfaced to an operator? Currently a returned decision only; no escalation
  channel. `[OPEN]`
- **OQ-3** Production storage choice. `[OPEN]` (phase-20 §22)
- **OQ-4** Timeout semantics (timeout ≠ auto-FAILED). No implementation. `[OPEN]`
- **OQ-5** Real-LLM tool-call reliability (scripted model used in tests; no Ollama failure injection). `[OPEN]`

---

## 18. Final Architecture Diagram

```
                         Enterprise Runtime
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                  │
           Session            Policy             (Skill)*
              │                 │                  │
              ▼                 │              (Tool Set)
              Run               │
              │                 │
              ▼                 ▼
        Pi Agent Loop ───── Tool Call
              │                 │
              │              Checkpoint (idempotencyKey, before_tool)
              │                 │
              │                 ▼
              │             Tool.execute
              │                 │
              │                 ▼
              │          External Resource (truth)
              │
              ├──────── Trace (observability only)
              │
              └──────── Recovery (recover)
                            │
                 Reconstruct → Reconcile (idempotencyKey)
                            ↓
                         Decide (Runtime-owned)
                            ↓
                 retry plan → caller issues New Run → Policy
```
`*` Skill = DEFERRED (no code). Diagram matches code except: (a) `Resume` is caller-driven, not inside
`recover` (C2); (b) durable operation identity is `idempotencyKey`, not `operationId+idempotencyKey` (C1).

---

## 19. Architecture Freeze Gate

1. Are Runtime boundaries internally consistent? **Yes** (Pi owns loop/state; Runtime owns policy/checkpoint/recovery; External owns truth).
2. Is ownership unambiguous? **Yes** (single nuance: Skill/Workspace owner undefined because unimplemented).
3. Is Session / Run / Run Context clear? **Yes** (`sessionId` durable; `runId` volatile; context transient).
4. Is Agent State separated from durable state? **Yes** (only `messages` mirrored; state in-memory).
5. Is Trace separated from Checkpoint? **Yes** (collector emits; store persists).
6. Is Recovery separated from Policy? **Yes** (retry re-enters Policy; recovery never executes tool).
7. Is External Resource the side-effect truth? **Yes** (reconcile reads external).
8. Is durable identity clearly defined? **Partially** — `idempotencyKey` clearly; `operationId` claim overstated (C1).
9. Is Skill / Workspace / Resource boundary clear? **Yes** (documented; Skill/Workspace unimplemented, not contradicted).
10. Is Multi-Agent still minimal? **Yes** (no Coordinator/Manager/Bus).

## 20. Final Decision

```
ARCHITECTURE FREEZE: PASS

CONTRADICTIONS:
2 hard doc-vs-code (C1 operationId durability overclaim; C3 Test-8 scope) + 1 minor naming (C2 Resume)
  → all documentation-level; running recovery slice is behaviorally correct (relies on idempotencyKey).

OPEN QUESTIONS:
5 (OQ-1..OQ-5)

IMPLEMENTATION CHANGES:
0
```

**Freeze rationale:** The runtime boundary contract is internally consistent and the Phase 20-1 Vertical
Slice is behaviorally sound. The only defects are in *documentation claims* about `operationId` durability
and the "Resume" step naming — they do not affect the implemented recovery (which correctly uses
`idempotencyKey` and a caller-driven new Run). No code change is warranted by this audit; the
contradictions are recorded for a future doc-correction phase.

---

## Phase 21 Result

ARCHITECTURE FREEZE: PASS

COMPONENTS AUDITED: 17 (Runtime, Pi Agent, Agent State, Session, Run, Run Context, Tool Registry, Tool, Policy, Skill, Workspace, Resource, Trace, Checkpoint, Recovery, RecoveryStore, External Resource)

OWNERSHIP CONFLICTS: 0 (structural); 2 concepts (Skill/Workspace) have no owner because unimplemented

LIFECYCLE CONFLICTS: 0 (Recovery never resumes old Run; new runId/toolCallId verified)

STATE BOUNDARY CONFLICTS: 0 (all wrong-equalities absent in code)

RELIABILITY CONFLICTS: 0 (UNKNOWN≠FAILED, External=truth, Policy≠Recovery all hold)

OPERATION IDENTITY STATUS: idempotencyKey DURABLE+USED; operationId durable only on normal completion, NOT used by reconcile → claim overstated (C1/C3)

PERSISTENCE STATUS: Session messages + Recovery Record + idempotencyKey persisted; Tool closure/Run/stream NOT persisted; File MVP, Production OPEN

SKILL/WORKSPACE/RESOURCE STATUS: Skill DEFERRED (no code); Workspace DEFERRED (string only); Resource Reference implemented, Data External-owned

MULTI-AGENT STATUS: minimal; no Coordinator/Manager/Bus; consistent

IMPLEMENTATION CHANGES: NO

DOCUMENT CREATED: docs/phase-21-architecture-freeze.md

OPEN QUESTIONS: OQ-1 (persist operationId pre-commit?), OQ-2 (escalation channel), OQ-3 (production storage), OQ-4 (timeout semantics), OQ-5 (real-LLM reliability)

NEXT STEP: If desired, a Phase 22 doc-correction pass to align `phase-20-*.md` claims (operationId durability, Resume naming) with the verified code — no `src/` change required. Do NOT enter new feature phases.

STOP.
