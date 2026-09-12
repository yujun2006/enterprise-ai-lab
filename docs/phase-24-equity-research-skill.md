# Phase 24 — Equity Research Skill / Complex Business Agent Pressure Test

> Second Business Reference Implementation stress-test of the Enterprise AI Runtime. `CODE CHANGED: NO`.
> `equity-research-skill` is **not** modified, not copied into `enterprise-ai-lab`, and is **not** an
> implementation target — it is a Business Skill / Workflow Reference. We audit it, map it to the Runtime,
> and record capability gaps only.
>
> Runtime facts (`enterprise-ai-lab`) per Phases 20–23: `EnterpriseAiRuntime` = thin facade over one Pi
> `Agent` owning Policy (`beforeToolCall`→`evaluatePolicy`), Checkpoint (`captureCheckpoint`+`idempotencyKey`),
> Recovery (`decideRecovery`/`recover`), Trace (`TraceCollector`), Session (durable) + Run (volatile).
> `Tool` = Pi `AgentTool` (Runtime does NOT execute; Pi does). `Skill`/`Workspace`/`Evaluation`/Multi-Agent
> `Coordinator` are **not implemented** (DEFERRED). Durable identity = `idempotencyKey`; `operationId` is
> post-completion metadata. Workflow-level checkpoint DEFERRED (Phase 20 §4.3). Persistence = File MVP (OQ-3).

---

## PART 1 — Repository Audit

```
Repository: yujun2006/equity-research-skill   (local: /Users/jun/workspace/equity-research-skill)
Role:       Business Skill / Workflow Reference
Runtime:     enterprise-ai-lab (EnterpriseAiRuntime + Pi Agent)
```

Structure (`[SOURCE]`):
- `SKILL.md` (12.5 KB) — entrypoint / orchestration prompt. `[SOURCE] SKILL.md:1-108`
- `README.md`, `README.zh-CN.md`, `README.en.md` (stub) — English/Chinese overviews.
- `references/` — 12 files (~93 KB): `report-template.md`, `output-format.md`, `expectations-investing.md`,
  `forensic-accounting.md`, `base-rates.md`, `cost-of-capital.md`, `valuation-methods.md`, `earnings-mode.md`,
  `data-sources.md`, `industry-routing.md`, `markets-cn-hk.md`, `industry-rules.json`.
- `industries/` — 20 `.md` appendices (~315 KB): SaaS, semiconductors, banks, insurance, pharma, internet-platform,
  consumer, autos-ev, metals-mining, reits, telecom, transport, …
- `scripts/` — `dcf.py` (18 KB), `check_research_output.py` (38 KB). Python 3, **stdlib only, deterministic, no side effects**.
- `tests/` — `test_check_research_output.py` (unit tests of the checker).
- `Example/` — `EXAMPLE_NVDA(.en).md`, `EXAMPLE_GOOGL(.en).md`.
- `reports/` — 15 company folders + `archive/` (author sample outputs: `valuation_<co>.json`, `financials_<co>.csv`, `report_<co>.md`, PDFs).
- `.github/workflows/` — `ci.yml`, `release.yml`.
- `docs/research-methodology/EQUITY_RESEARCH_SKILL_ANALYSIS.md`.

**Absent:** `package.json` (NOT FOUND), any `config` file (NOT FOUND), any DB/vector store (NOT FOUND). This is a
**Markdown-prompt Skill + stdlib Python scripts**, not a package/service. No `allowed-tools` in frontmatter.

---

## PART 2 — Reconstruct the Real Agent

`SKILL.md` instructs a single LLM to act as a senior equity-research analyst and convert a stock request into a
**fact-traceable, source-tagged, nine-chapter institutional report** whose spine is the **expectations gap**
(market-implied vs. independent view), with earnings-quality review *before* valuation. `[SOURCE] SKILL.md:16-33`

Defined research modes (all inside one six-step workflow, NOT separate skills):
- **Full Deep Research** — default. `[SOURCE] SKILL.md:39`
- **Earnings Research / Deep Earnings Mode** — auto-triggered by earnings/results/call/guidance; reads `earnings-mode.md`. `[SOURCE] SKILL.md:39-40`
- **Valuation** — Step 4, ≥3 methods, all math via `scripts/dcf.py`. `[SOURCE] SKILL.md:58-63`
- **Earnings Quality Review** — Step 2, forensic-accounting → credibility grade **A/B/C/D**; **C/D triggers veto**. `[SOURCE] SKILL.md:48-50`
- **Industry Appendix** — Step 1 routes into `industries/`. `[SOURCE] SKILL.md:46`
- **Source Discipline** — Tier 1–5 sourcing + reconciliation + anti-injection. `[SOURCE] SKILL.md:44, references/data-sources.md`
- **Investment Verdict** — pre-registered label map + counter-case + position sizing. `[SOURCE] SKILL.md:62, references/valuation-methods.md:116-148`

Six-step workflow (`[SOURCE] SKILL.md:35-74`):
- **Step 0** confirm ticker/listing, judge mode, language/format/currency.
- **Step 1** parallel data collection (Tier 1–5); pick 1 primary + optional secondary industry appendix.
- **Step 2** reconcile + timestamp + **earnings-quality check → A/B/C/D; C/D veto**.
- **Step 3** write report (nine chapters), forecast/verification register.
- **Step 4** valuation ≥3 methods, **all via `dcf.py` (JSON config, no mental math)**; run `check_research_output.py`, P0/P1 must fix/explain.
- **Step 4.5** independent-view test + pre-mortem counter-case; *optional* independent sub-agent to attack draft. `[SOURCE] SKILL.md:65-68`
- **Step 5** save Markdown, convert to PDF default, deliver only report via `present_files`; internal files kept but not delivered.

---

## PART 3 — Real Workflow Graph

```
User: "研究一下 NVDA"
 ↓
Step 0  Identify company + ticker + listing; judge mode; language/format
 ↓
Load SKILL.md (role + discipline)
 ↓
Step 1  Parallel data collection (Tier 1–5 via web/connectors)
        → pick industry appendix (industries/<slug>.md)
 ↓
Step 2  Reconcile + timestamp + Earnings Quality (forensic-accounting)
        → credibility grade A/B/C/D  (C/D ⇒ veto buy)
 ↓
Step 3  Draft nine-chapter report (report-template.md / earnings-mode.md)
        → forecast/verification register
 ↓
Step 4  Valuation ≥3 methods
        → ALL via scripts/dcf.py (assumptions JSON → stdout)  [deterministic]
        → run scripts/check_research_output.py  [P0/P1 gate]
 ↓
Step 4.5 Independent-view test + pre-mortem
        → (optional) sub-agent attacks draft
 ↓
Step 5  Save report MD → convert PDF → deliver report only
        → internal: assumptions JSON, dcf stdout, checker output, financials CSV
```

Key: every calculation is **delegated to a deterministic script**; the LLM must not compute. All external data is
**read-only, fetched, untrusted** (anti-injection). The only writes are **local report/artifact files**.

---

## PART 4 — Skill Pressure Test

`SKILL.md` frontmatter = `name` + `description` only (`[SOURCE] SKILL.md:1-14`). **No `allowed-tools`, no lifecycle, no switch.**

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | What does SKILL.md do? | Acts as orchestration prompt: role, discipline, six-step workflow, quality gates. | `SKILL.md:16-107` |
| 2 | Just a Prompt? | Primarily a **prompt/capability profile**; it *references* knowledge+scripts but contains them by pointer. | `SKILL.md:76-92` |
| 3 | Defines a Tool Set? | **No.** No `allowed-tools`; tools (web/file/`dcf.py`/checker) come from the runtime. | `SKILL.md:14` (frontmatter end) |
| 4 | Defines a Workflow? | **Yes** — six explicit steps + sub-steps. | `SKILL.md:35-74` |
| 5 | Defines business rules? | **Yes** — fact/judgment split, source+timestamp, credibility veto, probability-vs-evidence, ±15% calibration. | `SKILL.md:24-30,48-50,61` |
| 6 | Defines quality gates? | **Yes** — C/D veto, P0/P1 checker gate, self-check checklist. | `SKILL.md:50,63,94-107` |
| 7 | Decides when to load references? | **Instructs** the LLM *which* references to read per step (by pointer). | `SKILL.md:43-46,76-92` |
| 8 | Decides when to run scripts? | **Yes** — mandates `dcf.py` for all math, checker before finalize. | `SKILL.md:60,63` |
| 9 | Decides output structure? | **Yes** — nine-chapter template, naming, deliverables-only rule. | `SKILL.md:52-56,70-74` |
| 10 | Decides failure conditions? | Partial — "no falsifiable divergence ⇒ no action", missing data ⇒ "未获取到" (never guess), C/D veto. No hard abort. | `SKILL.md:26,25,50` |

**Classification vs Phase 14 `Skill = Named Capability Activation Profile`:**
→ **MATCH**. The real skill is exactly a *named* (`equity-research`) *capability activation profile*: trigger
description + prompt (role/workflow/rules) + pointers to knowledge (`references/`,`industries/`) and deterministic
tools (`scripts/`). It does **not** define tools, lifecycle, or switching — those are runtime/business concerns. The
large knowledge base + validation scripts are *content the LLM consumes*, not new Runtime mechanics.

---

## PART 5 — Critical Question: Is Skill Still Just Prompt + Tool Set?

This project is the hardest test of Phase 23's conclusion (Skill ≈ Prompt + Tool Set). Findings:

- `SKILL.md` + `references/` (93 KB) + `industries/` (315 KB) + `scripts/` + `tests/` together form
  **Capability + Knowledge + Workflow + Validation + Execution Rules** — but every layer is consumed by the LLM
  or executed as a plain script:
  - Knowledge (`references/`,`industries/`) → **prompt context** (loaded by the LLM per step).
  - Workflow + business rules + quality gates → **prompt instructions** the LLM follows.
  - Deterministic calc/validation (`scripts/`) → **Tools** (AgentTool wrapping `dcf.py` / `check_research_output.py`).
  - Tests (`tests/`) → validate the **Tools**, not the Runtime.
- The skill does **NOT** own a tool set, lifecycle, or switch; it is purely a profile that *points* to runtime tools.

**Conclusion:** The complexity is in *content*, not in required *Runtime mechanics*. The Runtime still only needs to
(a) execute the referenced scripts as Tools, (b) enforce Policy. The LLM consumes the knowledge/workflow/rules. A
dedicated **Skill Runtime / Skill Manager** would be **overengineering** (forbidden this phase; also fails the
Phase 17 test: not required by the Runtime, fully expressible as prompt+tools, it is business logic).

The genuine, *non-blocking* wrinkle: assembling ~400 KB of knowledge + dynamic industry selection into one agent
prompt is a **prompt-assembly / context-management** concern (business layer), not a Runtime capability. A future
*skill registry/loader* is a business-layer convenience, not a Runtime gap.

→ **Phase 23 conclusion HOLDS: Skill = Prompt (+ knowledge pointers) + Tool Set; Runtime needs no Skill abstraction.**

---

## PART 6 — Tool Audit

| Tool | Class | Input | Output | R/W | Side Effect | External System | Idempotent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `scripts/dcf.py` | Deterministic calc | assumptions JSON | stdout text | R (file) | **NONE** | local | yes (seeded MC) |
| `scripts/check_research_output.py` | Validation | report+JSON+CSV | stdout issue list (exit 1 on P0/P1) | R | **NONE** | local | yes |
| WebFetch / WebSearch / browser | Data retrieval | URL/query | page/text | R | none | web/portals | n/a |
| Market-data connector (IBKR etc., optional) | Data retrieval | query | quotes | R | none | vendor | n/a |
| File write (report/JSON/CSV) | File generation | content | local file | **W (local)** | local artifact | local FS | re-runnable |
| PDF/.docx/.xlsx convert | Report generation | MD | document | W (local) | local artifact | local FS | re-runnable |
| `present_files` | Delivery | path | deliver report | R/export | none | — | — |

**State-changing actions:** ONLY **local file writes** (report, assumptions JSON, financials CSV, dcf stdout capture).
NO external state-changing write. NO trade/order/account action (explicitly forbidden: `SKILL.md:32`). The checker is
a **read-only validator** (exit code 1 on P0/P1: `check_research_output.py:715-728`).

---

## PART 7 — Tool Boundary Pressure Test

```
LLM
 ↓ (tool_call: run dcf.py with assumptions JSON)
Enterprise Tool (AgentTool wrapping dcf.py)
 ↓ (local deterministic execution, reads file, prints)
Tool Result (stdout)  ──→  Pi Agent  ──→ LLM
```
Maps **directly** to `Pi Agent → Enterprise Tool → Local/External Execution → Tool Result → LLM`. `[SOURCE] dcf.py:12-15,214`
(`random.Random(seed,42)` deterministic; stdout only; no file/network). `check_research_output.py` likewise is a pure
read-only Tool. → **NOT A GAP.** Deterministic scripts are ideal Enterprise Tools.

---

## PART 8 — Resource Pressure Test

| Item | Classification | Owner | Source of Truth | R/W |
| --- | --- | --- | --- | --- |
| `references/*.md`, `industries/*.md`, `Example/*` | **Knowledge** (prompt context) | skill author | skill repo | R |
| `scripts/*` | **Tool** (deterministic) | skill author | skill repo | R |
| SEC filings / earnings / market data (Tier 1–5) | **External Data** | issuer/exchange/vendor/web | external system | R |
| Generated report (PDF/MD) | **Artifact** | agent/local FS | local | W (local) |
| valuation assumptions JSON, financials CSV, dcf stdout | **Tool Output / Artifact** | agent/local FS | local | W (local) |
| prior report / model files (carry-forward) | **Artifact** (versioned) | agent/local FS | local | R/W (append) |

Phase 15 boundary holds:
- **Tool = Action** (scripts, web fetch, file write).
- **Resource = Target/Data** (financial data from external systems; External owns it; cite source+timestamp).
- **Workspace = Scope** → NOT PROVEN (see PART 10).
- **External System = Source of Truth** (Tier 1–5 providers own data; skill only cites).

`references/`/`industries/` are **Knowledge**, not Runtime Resources — the Runtime need not manage them (they are
prompt context). Generated artifacts are **local files**, not external Resources. The Runtime's `ResourceReference`
model is sufficient for the only true external data (cite + reconcile).

---

## PART 9 — Resource Lifecycle

Lifecycle observed: Fetch (web) → Store (working dir, per company) → Read (LLM + scripts) → Update (re-run carries
forward) → Compare (forecast register vs actuals) → Archive (date-stamped, never overwrite: `SKILL.md:73`) →
Generate (report). 

Large intermediate artifacts (valuation JSON, financials CSV, dcf stdout) are **business-managed local files** with a
naming/discipline convention. The Runtime does **not** need an artifact-lifecycle manager — that is business-layer
file management (anti-overengineering). `ResourceReference` + `idempotencyKey` are irrelevant here because there is
**no external state-changing write** to reconcile. → **NOT A GAP.**

---

## PART 10 — Workspace Pressure Test

Separation is purely **per-company files** (`reports/<company>/…`), by folder name only. `[SOURCE] reports/*`
No user / portfolio / multi-tenant / namespace mechanism. Cross-day continuity = file carry-forward (don't overwrite,
date-stamp, forecast register appends hit/miss). `[SOURCE] report-template.md:82-101, earnings-mode.md:153`

→ **Workspace Requirement = NOT PROVEN** (same as Phase 23). Do **not** invent a Workspace abstraction. A Research
Project is a folder of files, not a Runtime scope.

---

## PART 11 — Session / Run Pressure Test

| equity-research | Runtime candidate | Status |
| --- | --- | --- |
| One company's research (initial + updates across days) | **Research Project ≈ Session** (durable, messages) | SUPPORTED (file-based today) |
| Each research invocation (initial report / update) | **Run** (one `prompt()`) | SUPPORTED |
| Prior predictions / model files / forecast register | **Project state** (business-managed files; Session messages help) | SUPPORTED (file-based) |
| Report version / model version | business file naming (`SKILL.md:73`) | business-layer |

The business carries a Research Project across days via files, not a Session object. Porting → one Session per company
research, each invocation a Run; Session durability would *improve* resumability. The project metadata is
business-managed (file naming). → **Session + Run concepts SUFFICIENT; project metadata is business-layer.**

---

## PART 12 — Long-running Workflow Pressure Test

This is the sharpest new pressure vs ai-job-search: a research task may run 10 min → hours → multiple days
(data collection + modeling + writing + checker loop). Risk: **process death mid-research loses in-flight LLM work**
(draft, analysis, collected data).

Phase 20 Recovery model targets **idempotent external state-changing tools**. This business has **NONE** (only local
file writes, re-runnable). So Tool-level Recovery does **not apply** here at all. The exposure is **workflow-level
intermediate state** (LLM reasoning + collected data + draft), which Phase 20 **DEFERRED** (§4.3: caller orchestrates).

- Business mitigant today: file carry-forward (re-run reads prior model files; date-stamped; forecast register).
  A crash → re-run from Step 0, but prior artifacts reduce re-work. Cost = compute/time, **not data corruption**.
- Is this a Runtime gap? The deferred workflow-level checkpoint would help, but it is **expressible by the business
  layer** (the skill already does file-based resumability) and the forbidden Runtime features (Workflow Engine,
  Coordinator) are out of scope. → **NOT a blocking gap; the deferred Phase 20 item, now more acutely relevant.**

---

## PART 13 — Checkpoint Pressure Test

Scenario: Business ✓ → Financial ✓ → Valuation ✓ → Report Generation ✗ (crash).
- Tool-level Recovery: N/A (no external side-changing tool).
- Workflow-level Recovery: would resume from Valuation. This is the **DEFERRED** Phase 20 §4.3 item.
- Business today: re-runs; prior valuation JSON + financials CSV are on disk, so Valuation re-use is possible
  manually; the LLM draft is lost and re-written.

→ **Workflow Checkpoint Requirement = REAL but DEFERRED (Phase 20 §4.3).** Classify **P2** (future; not blocking;
expressible by business-layer file management; forbidden to add Workflow Engine/Coordinator this phase). It is a
*biming-scale* concern, not a *correctness* blocker (no external corruption possible).

---

## PART 14 — Trace Pressure Test

Runtime `TraceCollector` records tool-level events: `tool_execution_*`, `policy_decision`, `checkpoint_created`,
`recovery_*`. For equity research this captures: which script ran (dcf.py/checker), args (assumptions JSON path),
result, policy decision, which LLM call. → **sufficient for "what happened at execution level."**

The business needs a **Business Audit Trail**: conclusion → assumptions → valuation → financials → sources →
timestamps. This lives **inside the report + assumptions JSON + checker output** (the skill mandates source+timestamp
discipline: `SKILL.md:25,55`). That is a **Business-layer artifact**, not Runtime semantics. The Runtime should
**NOT** understand `Revenue/EBITDA/DCF/WACC/Fair Value` — those are LLM output / file content.

→ **PARTIAL / NOT A GAP:** Runtime Trace = execution observability (LLM/Tool/Policy/Run/Recovery). **Business Audit
Trail = Business Agent** (enforced by `references/data-sources.md` + `check_research_output.py` + report template).
No Runtime change needed. (Same boundary as Phase 23, now explicit.)

---

## PART 15 — Evaluation Pressure Test

Quality checks exist and are substantial: DCF validation (WACC>g P0, prob sum=1 P1), financial consistency
(FCF=CFO−Capex P1), source discipline, earnings quality (**Beneish M-Score** P1), verdict-label mapping, industry-KPI
rules — all in `scripts/check_research_output.py` (exit 1 on P0/P1: `:715-728`). `[SOURCE] check_research_output.py:386,441,667,614`

`Run completed` (report generated) ≠ `Business success` (checker passes, credibility ≥C, label consistent). This is the
Phase 23 Execution≠Business Outcome boundary, now with a **deterministic validator**.

→ **Evaluation = a Tool** (AgentTool wrapping `check_research_output.py`), NOT a Runtime Evaluation Engine. The
business-quality logic is *encoded in the script* (business logic), executed by the Runtime as a Tool. **NOT A GAP.**
Do **not** mistake the Business Quality Checker for a Runtime Evaluation capability.

---

## PART 16 — Multi-Agent Pressure Test

Only one delegation mention: Step 4.5 "条件允许时用独立子 agent 攻击草稿论点后再定稿" (`SKILL.md:67`) — **optional,
undefined** (no lifecycle/state/tool-set specified). No `Task()`/spawn/delegation definitions; no agent registry;
sub-agent strings appear only in *delivered sample reports* (author narration), not as a skill mechanism.

→ **MULTI-AGENT REQUIREMENT = NOT PROVEN.** Roles (analyst / counter-case author / pre-mortem reviewer) are different
**LLM prompts/tasks in one session**. The optional attacker sub-agent is expressible as a Tool (LLM critique) if
desired. Phase 16 model ("Agent = Runtime instance; no Coordinator") remains valid.

---

## PART 17 — Capability Gap Classification

**P0 — Blocking:** none. The Runtime can host the skill as a harness (prompt + Tools + Policy + Session/Run + Trace).
No missing primitive blocks it.

**P1 — Important (production only):** Persistence production backend (File MVP; multi-process durability OPEN = OQ-3).
Local pilot fine; elevates at production scale only.

**P2 — Future:**
- Workflow-level checkpoint (DEFERRED Phase 20 §4.3) — more relevant for long-running research, but expressible via
  file carry-forward; forbidden to add Workflow Engine/Coordinator.
- Large-skill prompt assembly / context management (~400 KB knowledge + dynamic industry selection) — business-layer
  concern, not a Runtime primitive.

**NOT A GAP (real need, expressible by existing Runtime primitives):**
- Skill (Prompt + knowledge pointers + Tools; no Skill Runtime needed — PART 5).
- Tool / deterministic scripts (AgentTool wraps `dcf.py`/`checker` — PART 6/7).
- Policy (ALLOW data fetch; DENY trade/account even if connector allows — strengthens `SKILL.md:32` self-discipline).
- Resource (reference model fits; External owns data — PART 8/9).
- Workspace (NOT PROVEN — PART 10).
- Session/Run (concepts suffice; project state business-layer — PART 11).
- Trace (execution-level; Business Audit Trail is business-layer — PART 14).
- Evaluation (Tool — PART 15).
- Multi-Agent (NOT PROVEN — PART 16).
- Recovery (no external state-changing write → model N/A; only local re-runnable files — PART 12/13).

---

## PART 18 — Final Pressure Report

| Boundary | Business Pressure | Evidence | Severity | Decision |
| --- | --- | --- | --- | --- |
| Session | research project spans days via files | `report-template.md:82-101` | P2 | SUPPORTED (port to Session) |
| Run | each invocation = one run | `SKILL.md:35-74` | — | SUPPORTED |
| Tool | deterministic scripts + web + file | `dcf.py`, `check_research_output.py` | — | SUPPORTED |
| Policy | ALLOW fetch; DENY trade (hard rule) | `SKILL.md:32` | — | SUPPORTED (enforces safety) |
| Trace | tool-level; no business semantics | `collector.ts` events | P2 | PARTIAL (exec ok; audit=bus) |
| Recovery | **no external write**; local only | `dcf.py` stdout-only; `SKILL.md:32` | N/A | NOT APPLICABLE |
| Persistence | File MVP ok; prod OPEN | `FileRecoveryStore` | P1 (prod) | PARTIAL |
| Skill | heavy knowledge+scripts+validation | `SKILL.md`+`references/`+`industries/` | P2 | MATCH (no Skill Runtime) |
| Workspace | per-company files only | `reports/*` | NOT PROVEN | NOT NEEDED |
| Resource | external data + local artifacts | `data-sources.md` Tiers 1–5 | — | SUPPORTED |
| Evaluation | deterministic checker (P0/P1) | `check_research_output.py` | NOT A GAP | NOT A GAP (Tool) |
| Multi-Agent | optional undefined sub-agent | `SKILL.md:67` | NOT PROVEN | NOT PROVEN |
| Workflow checkpoint | long-running resume | PART 12/13 | P2 | DEFERRED (Phase 20 §4.3) |
| Large context | ~400KB knowledge load | `references/`+`industries/` | P2 | business-layer |

---

## PART 19 — Next Phase Candidate

No **P0** and no **P1 that blocks a local pilot**. Only production persistence (OQ-3) is a genuine Runtime limitation,
at scale only — already OPEN from Phase 20.

```
Next Phase Candidate from P0/P1: N
```

Deferred (informational, NOT blocking, IMPLEMENTATION: DEFERRED):
- **Production Persistence Backend** (OQ-3): multi-process durability. Evidence: File MVP; Impact: prod scale only;
  Minimal: swap `RecoveryStore` impl; Why insufficient: single-writer MVP.
- **Workflow-level Checkpoint** (Phase 20 §4.3): long-running resume. Evidence: PART 12/13; Impact: compute cost on
  crash, not data corruption; Why deferred: expressible by business-layer file carry-forward; forbidden Workflow Engine.
- **Large-skill Prompt Assembly** (business-layer): load ~400 KB knowledge + dynamic industry selection. Evidence:
  PART 5/8; Why not a Runtime gap: prompt context is business-assembled; Pi Agent context window handles it.

---

## Phase 24 Result

```
REPOSITORY: yujun2006/equity-research-skill  (Business Skill / Workflow Reference)
RUNTIME:     enterprise-ai-lab (EnterpriseAiRuntime + Pi Agent)

CODE CHANGED: NO
BUSINESS REPO MODIFIED: NO

P0 (Blocking): 0
P1 (Important, blocks pilot): 0  (only P1-at-production = persistence/OQ-3, deferred)
P2 (Future): Workflow-level checkpoint (DEFERRED §4.3); Large-skill prompt assembly; Skill MATCH (no Runtime needed)
NOT A GAP: Skill (Prompt+Tools), Tool/deterministic scripts, Policy, Resource, Workspace(NOT PROVEN),
           Session/Run, Trace, Evaluation(Tool), Multi-Agent(NOT PROVEN), Recovery(N/A — no external write)

REAL BLOCKING CAPABILITY GAP: NONE

KEY FINDINGS vs ai-job-search (Phase 23):
  - Skill is HEAVIER (SKILL.md + 12 refs + 20 industries + 2 scripts + tests) but STILL a Capability
    Activation Profile → no Skill Runtime needed (Phase 23 conclusion HOLDS).
  - Tools are DETERMINISTIC & SIDE-EFFECT-FREE (dcf.py, checker) → ideal Enterprise Tools; no mental math.
  - NO external state-changing write (only local files; hard "never trade" rule) → Phase 20 Recovery N/A here.
  - Long-running / multi-day → workflow-level checkpoint (DEFERRED §4.3) more relevant but NOT blocking.
  - Business Audit Trail = business-layer (report+JSON+checker), NOT Runtime semantics.
  - Evaluation = deterministic Tool (checker), NOT a Runtime Evaluation Engine.
  - Policy DENY for trade/account STRENGTHENS the skill's self-discipline (Runtime enforces, LLM only asks).

RUNTIME SUFFICIENT AS HARNESS: YES
  - Prompt/SKILL.md → agent system prompt (+ knowledge pointers)
  - scripts/dcf.py, check_research_output.py → AgentTool (deterministic, local)
  - web fetch / file write → AgentTool (read / local-write)
  - Policy → ALLOW fetch, DENY trade/account
  - Session/Run → durable Session + volatile Run
  - Trace → tool-level observability

NEXT PHASE: N (no P0/P1)
DEFERRED CANDIDATES: Production Persistence (OQ-3); Workflow-level Checkpoint (§4.3); Large-skill Prompt Assembly

STOP.
```
