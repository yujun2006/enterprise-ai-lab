# Phase 27 — Public Boundary / Productization Design Gate

> Goal: define the **Minimum Stable Public Surface** of `EnterpriseAiRuntime` based on the verified
> architecture of Phases 1–26. Audit + design + conclusion only. `CODE CHANGED: NO`.
> Every claim below is grounded in current `src/`, `scripts/`, `docs/`, and the installed
> `@earendil-works/pi-ai@0.85.1` (read, not modified).
>
> Tags: `[SOURCE]` = proven by code, `[EXP]` = proven by experiment/test, `[INF]` = architectural
> inference, `[OPEN]` = no evidence yet, `[CORRECTION]` = corrects an earlier finding.

---

## 1. Objective

Establish, from evidence, what a Business Developer must be able to use directly (Business-facing API),
what is Runtime-internal mechanism, and what is Pi-internal — so a stable public contract can be frozen
without leaking Pi internals. No new Manager / SDK / REST / Workflow / Skill / Workspace / Provider
abstraction is introduced.

---

## 2. Current Public API

Derived from `src/index.ts` (module exports) and `src/runtime.ts` (class surface).

### 2.1 `EnterpriseAiRuntime` surface (`src/runtime.ts:58`, options `:43-56`)

```text
EnterpriseAiRuntime
├── constructor(opts: RuntimeOptions)     // model, tools, policy, systemPrompt, streamFn, store, sessionId
├── run(text): Promise<void>              // runtime.ts:212  ← primary execution entry (returns void)
├── prompt(text): Promise<void>           // runtime.ts:207
├── onEvent(listener) / subscribe(listener): () => void   // runtime.ts:190-196  (unsubscribe)
├── registerTool(tool): void              // runtime.ts:198
├── listTools(): string[]                 // runtime.ts:203
├── lastTrace(): ExecutionTrace | undefined   // runtime.ts:226  (read result)
├── transcript(): AgentMessage[]          // runtime.ts:230  (read agent.state.messages)
├── isStreaming: boolean                  // runtime.ts:234  (read agent.state.isStreaming)
├── abort(): void                         // runtime.ts:238  (control)
├── waitForIdle(): Promise<void>          // runtime.ts:242
├── reset(): void                         // runtime.ts:246
├── getSessionId(): string               // runtime.ts:251  (durable session identity)
├── resume(sessionId): Promise<void>      // runtime.ts:261  (reconstruct Session, no reconcile)
└── recover(sessionId, reconcile): Promise<RecoveryResult>  // runtime.ts:276  (durable recovery)
```

### 2.2 Module-level exports (`src/index.ts`)

```text
Business-facing types / values:
  EnterpriseAiRuntime, RuntimeOptions, RuntimeEventListener
  AgentTool, EnterpriseTool                (the Tool type — business defines tools)
  Policy, PolicyDecision, PolicyOutcome, PolicyToolCall
  ExecutionTrace, TraceEvent, LlmCallTrace  (read results)
  RecoveryResult, ReconcileFn, RecoveryDecision, RecoveryStatus, CheckpointPosition,
  ResourceReference, RecoveryCheckpoint, ReplayCapability, DurableRecoveryRecord
  getCustomer, CUSTOMERS, Customer

Internal / injectable (NOT a Business-facing API, but exported):
  ollamaModel, createOllamaRuntimeDeps, OllamaRuntimeDeps   (provider wiring; config-internal)
  ToolRegistry                                       (Runtime-owned directory; business uses registerTool)
  TraceCollector, formatTrace, LlmTraceSink          (collector internal; business uses lastTrace())
  evaluatePolicy                                     (adapter internal; business supplies Policy)
  decideRecovery                                     (recovery decision internal)
  FileRecoveryStore, RecoveryStore                   (injectable store contract)
```

### 2.3 Boundary leak check (`[SOURCE]`)

The brief's LEAKAGE list — `agent.state`, `activeRun`, `AbortController` (object), `streamFunction`,
`runLoop`, `prepareToolCall`, `executePreparedToolCall` — is **NOT** exposed on the `EnterpriseAiRuntime`
public surface. Pi internals live behind `this.agent` (private, `runtime.ts:67`). Two *read-only* views of
Pi state are exposed: `transcript()` (returns `agent.state.messages`) and `isStreaming` (reads
`agent.state.isStreaming`). `abort()` maps to `agent.abort()` (control, acceptable). `streamFn` is a
constructor option for tests only.

→ **BOUNDARY CLEAN** (minor: `transcript()`/`isStreaming` are read-only Pi-state views; not deep leakage).

---

## 3. Business-facing Boundary

What a Business Developer must use directly.

| Concept | Business-facing? | Evidence |
| --- | --- | --- |
| `EnterpriseAiRuntime` (construct + `run`) | YES | `runtime.ts:58,212` |
| `Tool` (`AgentTool` / `EnterpriseTool`) | YES | `src/tools/get-customer.ts`, `index.ts:11-12`; Phase 25 `run_dcf`/`run_checker` |
| `Policy` (`Policy` fn + `PolicyDecision`) | YES | `src/policy/types.ts:26`; `runtime.ts:47`; Phase 26 trade/account DENY |
| `systemPrompt` (Skill binding point) | YES | `RuntimeOptions.systemPrompt` `runtime.ts:44`; Phase 24 `SKILL.md`→systemPrompt |
| `lastTrace()` / `transcript()` (read results) | YES | `runtime.ts:226,230` |
| `getSessionId()` (durable identity) | YES | `runtime.ts:251` |
| `registerTool` / `listTools` | YES | `runtime.ts:198,203` |
| `recover()` / `resume()` (lifecycle after restart) | YES (advanced) | `runtime.ts:261,276`; Phase 20 exp |
| `onEvent`/`subscribe` (observability hook) | YES | `runtime.ts:190-196` |

---

## 4. Runtime-internal Boundary

Mechanisms the Runtime owns but the Business Developer should NOT drive directly.

| Concept | Runtime-internal? | Evidence |
| --- | --- | --- |
| `ToolRegistry` (directory, no execution) | YES | `src/tools/registry.ts:10`; `runtime.ts:59` |
| `TraceCollector` (observe-only) | YES | `src/trace/collector.ts:45`; `runtime.ts:60` |
| `evaluatePolicy` (Policy adapter) | YES | `src/policy/adapter.ts:21`; `runtime.ts:118` |
| `captureCheckpoint` (Checkpoint write) | YES | `runtime.ts:152-179` |
| `decideRecovery` (recovery decision) | YES | `src/recovery/recovery.ts:13`; `runtime.ts:290` |
| `beforeToolCall` / `afterToolCall` hooks | YES | `runtime.ts:114,136` |
| `makeAgent` / `reconstructAgent` (Pi Agent lifecycle) | YES | `runtime.ts:84,109` |
| `currentRunId` / `currentPrompt` (Run context) | YES | `runtime.ts:68,69` |
| `store` persistence orchestration | YES | `runtime.ts:216,262,277` |

---

## 5. Pi-internal Boundary

Owned by `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`. Never a Business/Runtime API.

| Concept | Pi-internal? | Evidence |
| --- | --- | --- |
| `Agent` loop / `agent.prompt` | YES | `runtime.ts:84-106,207` |
| `Agent State` (`messages`, `tools`, `isStreaming`) | YES | `agent.subscribe` only; read views in `runtime.ts:230,234` |
| Tool execution (`AgentTool.execute`) | YES | `registry.ts:6-9` (Registry does NOT execute) |
| `streamFunction` / Pi model streaming | YES | `runtime.ts:63`; `model.ts:133` |
| Provider / `createProvider` / `openAICompletionsApi` | YES | `src/ollama/model.ts:13,115` |
| `Model` object internals (`compat`, `cost`) | YES | `model.ts:79-103` |

---

## 6. Skill Boundary

Re-verified against Phase 14 + 24 + 25 + 26 (all `CODE CHANGED: NO/experiment-only`).

- Phase 14 defines **Skill = Named Capability Activation Profile** = `(systemPrompt + Tool Set selection +
  optional Policy Context)` bound to a Session/Run. `src/` contains **zero** Skill code (`[SOURCE]`
  Phase 21 §3/§11: Skill absent from `src/`).
- Phase 24 (`equity-research-skill`): the real skill is a prompt (`SKILL.md`) + knowledge pointers
  (`references/`,`industries/`) + deterministic scripts (`dcf.py`, `check_research_output.py`). It defines
  **no tools, no lifecycle, no switching**. → matches Phase 14; no Skill Runtime needed.
- Phase 25: the script-workflow slice runs **as-is** through `AgentTool` + Pi loop; the skill's "when to
  call" logic is consumed by the LLM as prompt, not a Runtime mechanism.
- Phase 26: `SKILL.md` loaded **verbatim** as `systemPrompt`; references exposed via on-demand tools; no
  Skill Manager.

**Conclusion:** `Skill = Business-side composition convention` (systemPrompt + Tool list + Policy context),
**NOT** a Runtime primitive and **NOT** a future public abstraction on its own. A Business Developer
composes a skill → `{ systemPrompt, tools, policy }` and passes it to the constructor / `run`. Do NOT create
`SkillManager` / `SkillRegistry` / `SkillLoader` (forbidden; Phase 14/17/24 confirm overengineering).

→ `runtime.run({ prompt, skill })` is **not** needed; skill接入 is via composition through existing
`systemPrompt` + `tools` + `policy` options.

---

## 7. Tool Boundary

- `Tool` = Pi `AgentTool` (`src/tools/get-customer.ts`, `index.ts:11`). Business **defines** tools; the
  Runtime **owns the directory** (`ToolRegistry`, `registry.ts:10`) but **does NOT execute** them — Pi's
  Agent Loop calls `AgentTool.execute` (`registry.ts:6-9`, `[SOURCE]`).
- Phase 25: real business tools (`run_dcf`, `run_checker`) are plain `AgentTool` wrapping `python3` scripts;
  the artifact (`valuation_output.txt`) is a **business-managed local file**, not Runtime state
  (`[EXP]` Phase 25 §7).
- Phase 26: 8 business tools (web/reference/dcf/checker) wired and executed by the real Runtime.

**Conclusion:** `Tool` is a **stable Business-facing abstraction**. Runtime should **NOT** own Tool
execution; it only owns registration/visibility. Business Application provides Tools; Runtime provides
execution control (Policy + Checkpoint + Trace). KEEP as business-facing.

---

## 8. Policy Boundary

- `Policy = (call: PolicyToolCall) => PolicyDecision` (`src/policy/types.ts:26`). Business **supplies** the
  fn; Runtime **evaluates** it inside `beforeToolCall` (`runtime.ts:118`, `[SOURCE]`).
- Three decisions: `allow` / `deny` / `ask`. `ask` = in-run `await approval()` — **no durable semantics**;
  it is a synchronous approval gate, not a persisted queue (`policy/adapter.ts:36-44`, `[SOURCE]`).
- **Policy ≠ Recovery**: a recovery RETRY returns a retry plan; the caller re-issues a NEW Run that
  re-enters `beforeToolCall → evaluatePolicy` (`runtime.ts:302-304`, `[EXP]` Phase 20 T6). Recovery never
  bypasses Policy.

**Conclusion:** `Policy` is **Business-facing configuration** (the decision fn). The *evaluation adapter*
(`evaluatePolicy`) and the *control point* are Runtime-internal. ASK has no durable/escalation channel yet
(OPEN: OQ-2). KEEP `Policy` as business-facing; keep decision evaluation internal.

---

## 9. Session / Run Boundary

- `Session` = durable logical unit; `sessionId` stable across runs/process death
  (`runtime.ts:77,94,282`; `[EXP]` Phase 20 T1/T7). `Run` = one `run()` invocation; `runId` volatile,
  **not** durable (`runtime.ts:213`; `[SOURCE]` Phase 21 §3).
- The minimal model `runtime.run(prompt)` already covers the Business need. No `Session`/`Run` *object* API
  is required for a local pilot. `getSessionId()` is sufficient to expose durable identity.

**Conclusion:** Session/Run stay as **Runtime lifecycle concepts**, not public API objects. DEFER
`SessionManager` / `RunManager` (forbidden; Phase 21 §12). Expose only `run()` + `getSessionId()` +
`resume()`/`recover()`.

> Note: `run(text)` returns `Promise<void>`; the result is read via `lastTrace()` + `transcript()`
> (`runtime.ts:212,226,230`). A structured `RunResult` is **not** currently part of the contract — a
> future productization convenience, recorded as a design note (P2), **not** implemented now.

---

## 10. Trace Boundary

- `TraceCollector` records agent events + LLM interactions + policy/checkpoint/recovery events
  (`trace/collector.ts`; `runtime.ts:98`). It performs **no** control, replay, or business evaluation
  (`[SOURCE]` Phase 21 §13).
- Phase 24: Runtime Trace = execution-level (LLM/Tool/Policy/Run); the **Business Audit Trail** (conclusion
  → assumptions → valuation → sources) lives inside the report + `check_research_output.py` output — a
  **Business-layer artifact**, not Runtime semantics.

**Conclusion:** `Trace` read API (`lastTrace()` / `transcript()` / `onEvent()`) is **Business-facing
observability**. The `TraceCollector` internals are Runtime-internal. `Trace ≠ Checkpoint ≠ Audit`. Audit
(operator-facing audit log) is **not** implemented and **deferred** (not in scope of Phase 27). KEEP the
read API; keep collector internal.

---

## 11. Recovery Boundary

- `recover(sessionId, reconcile)` reconstructs the Session (new Pi Agent, new Run), calls the injected
  `ReconcileFn` (External truth), then `decideRecovery` → `CONTINUE/SKIP/RETRY/ESCALATE`, marks the record
  `recovered`, and **returns a retry plan** (`runtime.ts:276-306`, `[SOURCE]`).
- `recover()` **never** re-executes the old Pi Run; retry is issued by the **caller** via a new `run()`
  (`runtime.ts:302-305`, `[EXP]` Phase 20 T3). `Policy ≠ Recovery` (§8).

**Conclusion:** The Business Developer **does not** call the recovery *decision* — Runtime owns it
(`decideRecovery`, `captureCheckpoint`). The Business Developer may call `recover()`/`resume()` as a
**lifecycle entry after restart**, supplying the External `ReconcileFn`. Runtime exposes only
`Run Result / Error / Escalation` (`RecoveryResult`). `recover()` entry = public; decision + checkpoint =
**internal**. (Consistent with Phase 20/21; no `RecoveryManager`.)

---

## 12. Resource / Workspace Boundary

- `ResourceReference` (`workspaceId?`, `resourceId?`) is the **only** Resource concept in `src/`
  (`recovery/types.ts:21-24`); it is a pointer captured at checkpoint time (`runtime.ts:181-186`). The
  **Resource Data** is owned by the External system (`[SOURCE]` Phase 15/21 §3). `Workspace` = only the
  `workspaceId: string` inside `ResourceReference`; **no Workspace class/manager** exists
  (`[SOURCE]` Phase 21 §3, §11).
- Phase 24/25: Workspace requirement **NOT PROVEN** (per-company files; no namespace/multi-tenant).

**Conclusion:** Resource/Workspace have **not** reached the level of a public API. DEFER any
`WorkspaceManager` / `ResourceManager` (forbidden; evidence insufficient). Keep only the
`ResourceReference` pointer (internal to recovery). `[DEFER]`.

---

## 13. Provider Boundary

Re-audited against the installed `@earendil-works/pi-ai@0.85.1`.

- `src/ollama/model.ts:36-67` switches provider via env (`LLM_PROVIDER` default `"ollama"`; `"deepseek"`
  supported). It builds a `Model` object manually (`model.ts:79-103`) with `api:"openai-completions"`,
  `provider`, `baseUrl`, `reasoning`, `compat`, and constructs a Pi `Provider` via `createProvider` +
  `openAICompletionsApi` (`model.ts:114-126`). No Provider abstraction subsystem is added
  (`[SOURCE]` `model.ts:28-33`).
- **`[CORRECTION]` — earlier Phase 26 DeepSeek audit false-negative.** This gate re-read the installed
  `pi-ai@0.85.1` and found:
  - `dist/providers/data/deepseek.json` — a **native deepseek provider catalog** with models
    `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`
    (`provider:"deepseek"`, `baseUrl:"https://api.deepseek.com"`, `api:"openai-completions"`).
  - `dist/api/openai-completions.js:1250` — `const isDeepSeek = provider === "deepseek" || baseUrl
    .toLowerCase().includes("deepseek.com")` driving `requiresReasoningContentOnAssistantMessages` and
    `thinkingFormat:"deepseek"`.
  The earlier audit's `search_content` returned 0 matches (false negative — the catalog file + compat
  branch **do** exist). **Therefore DeepSeek IS reachable through pi-ai's native openai-completions path**:
  with `LLM_PROVIDER=deepseek` + `DEEPSEEK_API_KEY`, `model.ts` sets `provider:"deepseek"` +
  `baseUrl:"https://api.deepseek.com"`, and pi-ai's `isDeepSeek` handling activates. `deepseek-v4-flash`
  is OpenAI-compatible; no dedicated adapter is needed.
- This confirms the Provider Boundary conclusion: **Provider implementation is internal**. Business configures
  via env (`LLM_PROVIDER`/`LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`); Runtime→pi-ai→provider. A
  `ProviderManager` is **completely unnecessary**.

---

## 14. Minimum Stable Public Surface

Concepts with real evidence support (KEEP):

```text
EnterpriseAiRuntime          (construct + run + lifecycle)
Tool        (AgentTool / EnterpriseTool)
Policy       (Policy fn + PolicyDecision)
Trace        (lastTrace / transcript / onEvent  — read observability)
Session id   (getSessionId)
Recovery entry (resume / recover + RecoveryResult — lifecycle after restart)
```

NOT PUBLIC (internal / injectable / deferred):

```text
Pi Agent / Agent Loop / Agent State
AbortController (object) / streamFunction / runLoop / prepareToolCall / executePreparedToolCall
RecoveryStore (injectable contract only)
Checkpoint implementation (captureCheckpoint / position)
decideRecovery (decision internal)
Provider implementation (createProvider / openAICompletionsApi / pi-ai catalog)
Tool execution internals (AgentTool.execute)
ResourceReference (recovery-internal pointer)
Workspace (no abstraction)
Skill (composition convention, not a type)
```

> `RunResult` is **absent** from the current contract (`run()` → `void`). It is a candidate future addition
> for productization convenience, but the existing read API (`lastTrace`/`transcript`) already covers the
> need. Listed as design note (P2), **not** added now.

---

## 15. Public API Stability Assessment

Per concept — A. does a Business Developer need to understand it? B. should it survive Pi-internal change?
C. is there real experiment support?

| Concept | A | B | C | Score |
| --- | --- | --- | --- | --- |
| `EnterpriseAiRuntime` | yes | yes | yes (Ph 1–26) | **KEEP** |
| `Tool` | yes | yes | yes (getCustomer/dcf/checker/Meituan) | **KEEP** |
| `Policy` | yes | yes | yes (Ph 4-C/20/26) | **KEEP** |
| `Trace` (read) | yes | yes | yes (Ph 3/20/26) | **KEEP** |
| `Skill` | no (composition) | yes | yes (Ph 14/24/25/26) | **DEFER** (convention, not a type) |
| `Session` | no (`getSessionId` enough) | yes | yes (Ph 20) | **DEFER** (no object API) |
| `Run` | no (`run()` enough) | yes | yes (Ph 20) | **DEFER** (no object API) |
| `Recovery` (entry) | yes (after restart) | yes | yes (Ph 20) | **KEEP** (entry; decision internal) |
| `Resource` | no (External-owned) | n/a | Ph 15/24 | **DEFER** |
| `Workspace` | no | n/a | not proven | **DEFER** |
| `Provider` | no (env config) | yes (pi-ai) | Ph 26.1-A | **INTERNAL** |

Scoring rule honored: "future might need" alone does NOT earn KEEP. `Skill`/`Session`/`Run`/`Resource`/
`Workspace` are DEFERRED because no experiment demands a dedicated API object; `Provider` is INTERNAL.

---

## 16. Productization Capability Gap

Strict: `P0` blocking · `P1` important (production) · `P2` future · `NONE` no blocking capability.

- **P0 (Blocking): NONE.** Phases 24/25/26 each report `RUNTIME CAPABILITY GAP: NO`; the current Runtime
  already hosts a real Business Agent (skill + tools + policy + trace + session/run + recovery entry)
  end-to-end. No missing primitive blocks a local pilot.
- **P1 (Important, production scale):**
  - **Production Persistence Backend** (OQ-3): `FileRecoveryStore` is single-writer MVP; multi-process
    durability needs SQLite/PG/Redis. Local pilot fine; elevates at scale. (`[OPEN]` Phase 20 §22, 21 OQ-3)
  - **Escalation Channel** (OQ-2): `ESCALATE` is currently a returned `RecoveryDecision` only; no operator
    notification path. Needed for production reliability. (`[OPEN]` Phase 21 OQ-2)
  - **Timeout / Failure Classification** (OQ-4): no timeout handling; `UNKNOWN≠FAILED` holds but timeout ≠
    auto-FAILED is undefined. (`[OPEN]` Phase 21 OQ-4)
- **P2 (Future, NOT blocking):**
  - **Workflow-level checkpoint** (Phase 20 §4.3 DEFERRED): long-running research resume; expressible via
    business-layer file carry-forward; forbidden to add Workflow Engine/Coordinator.
  - **`RunResult` structured return** (design note §9/§14): `run()` → `void` today; convenience only.
  - **Business Audit Trail** (Phase 24 §14): lives in report+checker output; not Runtime semantics.
  - **Large-skill prompt assembly / context management** (~400 KB knowledge + dynamic industry selection):
    business-layer concern (Phase 24/25).
  - **Multi-Agent / Workspace / Skill Manager**: explicitly **NOT NEEDED** (Phase 16/21/24/25).

> SDK packaging / npm publishing / REST API / UI / SaaS / Multi-Agent Coordinator are **not** auto-classified
> as P0/P1 here — they are distribution/deployment concerns, not Runtime capability gaps.

---

## 17. Architecture Decision

The boundary is internally consistent and productization-ready at the *capability* level. Freeze the
following public contract:

```text
Business Agent
     │   Business-facing API
     ▼
EnterpriseAiRuntime          ← run() / Tool / Policy / Trace(read) / Session id / recover-resume
     │   Runtime-internal: ToolRegistry, TraceCollector, evaluatePolicy,
     │                    captureCheckpoint, decideRecovery, Agent lifecycle
     ▼
@earendil-works/pi-agent-core   ← Agent Loop, Tool execution, Agent State  (Pi-internal)
     │
     ▼
@earendil-works/pi-ai          ← Provider / Model / openai-completions  (Pi-internal)
     │
     ▼
Provider (ollama / deepseek via env config)   ← internal; no ProviderManager
     │
     ▼
Model (Qwen / DeepSeek-v4-flash …)
```

Modifications vs the brief's template (evidence-driven, not mechanical):
- `Provider` box kept explicitly internal; `DeepSeek` reachable via pi-ai native catalog + `isDeepSeek`
  compat (`[CORRECTION]` §13).
- `Skill` is **not** a box — it is composition (systemPrompt+tools+policy), not a Runtime layer.
- `Workspace` / `Resource Manager` boxes omitted (no evidence; DEFERRED).
- `Recovery` shown as a Runtime-internal decision + a public `recover()` entry, not a subsystem.

---

## 18. Deferred Items

- `Skill` as a public type/manager (composition convention; Phase 14/24/25/26).
- `Session`/`Run` object APIs (use `run()` + `getSessionId()`).
- `WorkspaceManager` / `ResourceManager` (no evidence).
- `ProviderManager` (unnecessary; env config suffices).
- `Workflow Engine` / `Coordinator` / `Multi-Agent` (Phase 16/24 not proven).
- `Audit` (business-layer artifact; not Runtime semantics).
- `Evaluation Engine` (checker = Business Tool; Phase 24/25).
- `RunResult` structured return (convenience; P2).
- Production Persistence / Escalation Channel / Timeout semantics (P1; OQ-2/3/4).

---

## 19. Final Verdict

```text
PHASE 27 DESIGN GATE: PASS (audit + design; CODE CHANGED: NO)

MINIMUM STABLE PUBLIC SURFACE:
  EnterpriseAiRuntime, Tool, Policy, Trace(read), Session id, Recovery entry(resume/recover)

BOUNDARY: CLEAN (read-only Pi-state views via transcript()/isStreaming; no Pi internals leaked)

SKILL:        DEFER   (Business-side composition convention; not a Runtime type)
TOOL:         KEEP    (Business provides; Runtime owns registry only, Pi executes)
POLICY:       KEEP    (Business-facing config; evaluation internal; ASK not durable)
SESSION:      DEFER   (durable id via getSessionId; no object API)
RUN:          DEFER   (run() entry suffices; no object API)
TRACE:        KEEP    (lastTrace/transcript/onEvent read API; collector internal)
RECOVERY:     KEEP    (recover()/resume() entry public; decision + checkpoint internal)
RESOURCE:     DEFER   (External-owned; ResourceReference internal pointer only)
WORKSPACE:    DEFER   (not proven; string only)
PROVIDER:     INTERNAL (env config; pi-ai native deepseek reachable; no ProviderManager)

P0: NONE
P1: Production Persistence (OQ-3); Escalation Channel (OQ-2); Timeout semantics (OQ-4)
P2: Workflow checkpoint; RunResult; Business Audit; Large-context assembly

CORRECTION: earlier Phase 26 DeepSeek audit was a false negative —
            pi-ai@0.85.1 ships deepseek.json + isDeepSeek compat; DeepSeek is reachable
            via openai-completions (LLM_PROVIDER=deepseek), provider stays internal.

NEXT: Do NOT implement the public API yet. Await audit review; decide Phase 28 scope
      (recommended: P1 production-persistence + escalation channel, or RunResult convenience).
STOP.
```

---

## Verification (§20 of brief)

- `npm run typecheck` — `CODE CHANGED: NO` (doc only); expected PASS. (run below)
- `npm run acceptance:phase20` — unchanged `src/`; expected PASS (Phase 20 slice). (run below)
- `git status --short` — only `docs/phase-27-public-boundary-design-gate.md` added. (run below)
