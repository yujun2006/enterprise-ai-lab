# Phase 23 — Business Agent Pilot / Runtime Capability Gap

> Business Reference Implementation stress-test of the Enterprise AI Runtime. `CODE CHANGED: NO`.
> `ai-job-search` is **not** modified, not copied into `enterprise-ai-lab`, and is **not** an
> implementation target — it is a Business Workflow Reference. We audit it, map it to the Runtime,
> and record capability gaps only.
>
> Runtime facts (`enterprise-ai-lab`) are grounded in Phases 20–22 audit: `EnterpriseAiRuntime` is a
> thin facade over one Pi `Agent` owning Policy hook (`beforeToolCall`→`evaluatePolicy`), Checkpoint
> (`captureCheckpoint`), Recovery (`recover`/`decideRecovery`), Run id, Session id. `Tool` = Pi `AgentTool`.
> `Skill`/`Workspace`/`Evaluation`/Multi-Agent `Coordinator` are **not implemented** (DEFERRED). Durable
> identity = `idempotencyKey` (crash-safe); `operationId` is post-completion metadata (Phase 21/22).

---

## PART 0 — Repository Identification

```
Repository: yujun2006/ai-job-search   (local: /Users/jun/workspace/ai-job-search)
Role:       Business Agent / Workflow Reference
Runtime:     enterprise-ai-lab (EnterpriseAiRuntime + Pi Agent)
```

Confirmed present locally. Read-only audit; no upstream modification.

---

## PART 1 — Understand ai-job-search BEFORE Mapping

`ai-job-search` is a **prompt/Markdown-driven Claude Code agent** (not a compiled app). "Business logic"
lives in Markdown command/skill files; only real code is a set of TypeScript portal CLIs + Python utils.
It is already a **fork populated with one candidate's profile** (`CLAUDE.md:1`, 郁军/Yu Jun).

Structure (`[SOURCE]`):
- `README.md`, `CLAUDE.md` (profile + rules), `AGENTS.md` (thin-pointer design for non-ClaudeCode runtimes), `SETUP.md`, `CHANGELOG.md`, `SECURITY.md`.
- `.claude/commands/` — 12 slash-command prompts.
- `.claude/skills/` — 3 skills: `job-application-assistant/`, `job-scraper/`, `upskill/`.
- `.claude/agents/` — 1 agent def `gemini-research-expert.md` (unused).
- `.claude/settings.json` — permission allowlist.
- `.agents/skills/` — 6 portal CLI skills (each `cli/` TS project).
- `tools/` (9 Python: lint/security/robots/salary/upstream), `tests/` (25), `cv/`, `cover_letters/`, `documents/`, `templates/`, `assets/`, `upskill/`.
- No root `package.json` (prompt project; TS CLIs self-contained), no `*.db`/sqlite, no vector store.

---

## PART 2 — Reconstruct Actual Business Workflow

Reconstructed from code/prompts (not just README). Real stages:

1. **Profile setup** — `/setup` populates `CLAUDE.md` + profile skill files + `search-queries.md`. `[SOURCE] setup.md:1-433`
2. **Scrape jobs** — `/scrape` = `job-scraper` skill: discover installed portal CLIs, run in parallel, WebSearch fallback, dedupe vs `seen_jobs.json` + tracker, quick-fit, present table. `[SOURCE] job-scraper/SKILL.md:37-256`
3. **Rank / match** — `/rank`: parallel sub-agents score all `new` postings → ranked shortlist with vetoes. `[SOURCE] rank.md:1-148`
4. **Apply / draft / review / revise** — `/apply <url|text>` drafter→reviewer:
   - fit eval (`04-job-evaluation.md`), optional salary lookup → draft CV+CL (LaTeX) → **reviewer sub-agent** (Agent tool, fresh context) critiques → revise → **mandatory PDF compile + visual + ATS inspect** → record tracker CSV + archive posting. `[SOURCE] apply.md:1-357`
5. **Generate CV / cover letter / application-form fields** — Steps 2–3 (+ form fields). `[SOURCE] apply.md:346-352`
6. **Record outcome / interviewer prep** — `/outcome`, `/interview`. `[SOURCE] outcome.md:1-196, interview.md:1-109`
7. **Upskill / reporting / sync** — `/upskill` gap heatmap, `/html-report`, `/notion-sync`, `/gmail-sync`.

`/scrape` is a **skill** (frontmatter `name: scrape`), not a command file. `[SOURCE] job-scraper/SKILL.md:1-9`

---

## PART 3 — Business Workflow Map (actual)

```
User
 ↓ /setup
Profile (CLAUDE.md + profile skills + search-queries.md)
 ↓ /scrape  (job-scraper skill)
Portal CLIs (parallel) + WebSearch fallback
 ↓ dedupe vs seen_jobs.json + tracker
New matches (quick fit)
 ↓ /rank  (parallel scoring sub-agents)
Ranked shortlist (vetoes)
 ↓ /apply <url>  (drafter session)
 ├─ evaluate fit (04-job-evaluation)
 ├─ draft CV + cover letter (LaTeX)
 ├─ reviewer sub-agent (Agent tool, fresh ctx) critiques
 ├─ revise
 ├─ compile PDF + ATS/visual inspect
 ├─ record tracker CSV + archive posting (documents/applications/<company>_<role>/)
 └─ optional /notion-sync (upsert) — only external WRITE
 ↓ /outcome  (update tracker status)
 ↓ /interview (prep from archive)
 ↺ calibration back into /setup
```

Note: **no automated external job-portal submission**. `/apply` generates materials + archives locally +
optional Notion upsert (idempotent). Referral links are generated for the user to open manually
(`job-scraper/SKILL.md:160-183` explicitly "never fetch/scrape … links, not results"). Highest-risk
external write = Notion upsert (idempotent on `Key`). Gmail MCP is **read-only**.

---

## PART 4 — Identify Business Components

| Exists in ai-job-search | Maps to Runtime | Meaning for Runtime |
| --- | --- | --- |
| Business workflow (skills+commands) | caller-supplied orchestration | Runtime is a harness; workflow = business logic, not a Runtime feature |
| Skill (`SKILL.md`) | — (no Skill in Runtime) | capability-activation profile (prompt+tool selection+knowledge) |
| Prompt / framework `.md` | system prompt / tool config | expressible as agent prompt |
| Tool (CLI / MCP / LLM / LaTeX) | `AgentTool` | wrap external action as `AgentTool.execute` |
| Sub-agent (reviewer/rank) | — / Tool | ephemeral context; expressible as a Tool (LLM critique) |
| External Resource (portals/Notion/Gmail) | `ResourceReference` + `ReconcileFn` | External owns data; Runtime holds ref + idempotencyKey |
| User data (profile, tracker, CV) | Session / persisted files | single-user; no Workspace |
| Intermediate state (`seen_jobs.json`, tracker CSV) | Recovery Record / Session messages | file-based resumability |
| Output (CV/CL PDF, archive) | Tool result / Resource | local artifacts |
| Conversation continuity | Session | currently via shared files, not a Session object |

---

## PART 5 — Skill Audit

`Skill` = folder + `SKILL.md` (YAML frontmatter `name`/`description`/`allowed-tools`/`enabled` + Markdown body)
plus reference `.md` files. `[SOURCE] job-application-assistant/SKILL.md:1-9`

1. Defined how: `SKILL.md` with frontmatter + body. ✓
2. Contains: workflow knowledge/prompts + reference files. ✓
3. Contains Prompt? **Yes** (Markdown body is the prompt). ✓
4. Selects Tools? **Yes** (`allowed-tools:` list). `[SOURCE] job-application-assistant/SKILL.md:7`
5. Workflow knowledge? **Yes** (Step-by-step workflow in body). ✓
6. Lifecycle? Implicit — loaded into the session when triggered; no explicit start/stop state file.
7. Switches? Trigger phrases / frontmatter; skills activate per task, not by an explicit switch API.
8. Bound to Agent instance? No — loaded into the current session's context.

Compare to Phase 14: `Skill = Named Capability Activation Profile`. → **PARTIAL MATCH**: the *concept*
matches (named, prompt + tool selection + knowledge). But the Runtime has **no Skill implementation**
at all (Phase 14 DEFERRED). The business proves Skills are a real, heavily-used mechanism; the Runtime
can host the *behavior* by embedding skill prompts into the agent prompt + providing the right tool set,
without a dedicated Skill subsystem.

---

## PART 6 — Tool Audit (Business Tool Matrix)

| Tool | Read/Write | External System | Side Effect | Idempotent | Policy |
| --- | --- | --- | --- | --- | --- |
| Portal CLIs (`bun run …/cli.ts search/detail`) | Read | jobbank/linkedin/freehire… | none (GET) | Yes | ALLOW (`settings.json`) |
| `salary_lookup.py` | Read | local `salary_data.json` | none | Yes | ALLOW |
| `lualatex`/`xelatex` | Write (local) | local FS (`cv/`,`cover_letters/`) | local PDF | Yes (reproducible) | ALLOW |
| `pdftotext` | Read | local PDF | none | Yes | ALLOW |
| `WebFetch`/`WebSearch` | Read | web (untrusted) | none | N/A | native |
| `robots_check.py` | Read | `robots.txt` | none | Yes | — |
| **Gmail MCP** | Read | Gmail (user acct) | none (read-only) | by msg id | — |
| **Notion MCP** (`mcp__notion__*`) | **Write** | Notion (user acct) | upsert rows/pages | **Yes (upsert on `Key`)** | ASK/ALLOW |
| `Agent` tool (reviewer/rank) | — | LLM (Gemini/Claude) | none (orchestration) | ephemeral | — |

State-changing external tool = **Notion upsert only**, and it is **idempotent** (key-based). Local file
writes (CV/CL) are not "external" side effects in the Runtime's sense (re-runnable). No non-idempotent
external submission exists.

---

## PART 7 — External Resource Audit

| Resource | Owner | Source of Truth | R/W | Reference | Data |
| --- | --- | --- | --- | --- | --- |
| Job portals (CLI) | portal | portal | R | URL/query | portal |
| Web pages | web | web | R | URL | web |
| Local files (profile/CV/CL) | candidate | local FS | R/W | path | local |
| Gmail | user account | Gmail | R | msg id | Gmail |
| Notion | user account | Notion | **W (upsert)** | DB id/`Key` | Notion |
| LLM (Claude/Gemini) | provider | provider | R | — | — |

Phase 15 boundary `Tool=Action / Resource=Target / External=Data Owner` holds: portals/Notion/Gmail own
their data; Runtime would hold only a `ResourceReference` + `idempotencyKey`. The business does **not**
need the Runtime to own any Resource Data.

---

## PART 8 — Workspace Pressure Test

`ai-job-search` is a **single-user fork**: profile + all state are one user's. No per-user directory
partitioning, tenant id, or workspace abstraction. Personal-data isolation is via `.gitignore`
(`SECURITY.md:15`, `gitignore:21-99`) + per-application folder (`documents/applications/<company>_<role>/`,
`documents/README.md:118-131`). README warns a fork is public and recommends a private remote
(`README.md:81-88`).

→ **Workspace Requirement = NOT PROVEN.** Do **not** invent a Workspace abstraction. Runtime's
`workspaceId` string (in `ResourceReference`) is sufficient if ever needed; no Workspace subsystem required.

---

## PART 9 — Session / Run Mapping

| ai-job-search | Runtime candidate | Status |
| --- | --- | --- |
| Whole job-search campaign (setup→…→interview, resumable across invocations) | **Session** (`sessionId` durable, messages persisted) | SUPPORTED (currently via files) |
| Each slash-command invocation (`/scrape`, `/apply`, …) | **Run** (`runId` volatile, one `prompt()`) | SUPPORTED |
| `seen_jobs.json`, tracker CSV, application archive | **Persistent state** (Recovery Record / Session messages) | SUPPORTED (file-based today) |
| In-flight LLM/tool context | **Transient state** (Agent State, Run Context) | SUPPORTED |

The business has **no formal Session/Run object**; continuity is purely shared files, each command a
fresh invocation re-reading file state. Porting would map the campaign → one Session, each command → a
Run; the Runtime's Session durability would *improve* resumability vs raw files.

---

## PART 10 — Runtime Mapping

| ai-job-search | Enterprise Runtime | Status | Evidence |
| --- | --- | --- | --- |
| Business Agent (orchestrating session) | `EnterpriseAiRuntime` instance | PARTIAL | runtime wraps one Pi Agent; workflow must be supplied as tools/prompt |
| Conversation | Session | PARTIAL→SUPPORTED | `sessionId` durable (`runtime.ts:77,94`); business uses files today |
| Execution | Run | SUPPORTED | Run = one `prompt()` (`runtime.ts:207,213`) |
| Skill | Skill | GAP | no Skill in Runtime (Phase 14 DEFERRED); expressible via prompt+tools |
| Tool | Tool (`AgentTool`) | SUPPORTED | wraps any external action (`registry.ts`); Pi executes |
| Permission | Policy | SUPPORTED | `settings.json` allowlist ≈ `evaluatePolicy` ALLOW/ASK/DENY (`runtime.ts:118`) |
| Job Data | Resource (`ResourceReference`) | SUPPORTED | External owns data; reconcile via `idempotencyKey` (`runtime.ts:286`) |
| User Scope | Workspace? | NOT PROVEN | single-user; no namespace (PART 8) |
| Execution Log | Trace | PARTIAL | tool-level events captured (`collector.ts`); business-step level not |
| Interrupted Work | Recovery | PARTIAL | idempotent external (Notion upsert) covered; workflow-level checkpoint DEFERRED |
| Business Quality | Evaluation | NOT A GAP | expressible as a Tool; Runtime needs no eval subsystem |

Status vocabulary used: SUPPORTED / PARTIAL / GAP / NOT NEEDED / NOT PROVEN.

---

## PART 11 — Policy Pressure Test

Real permission model (`settings.json:1-11`): pre-approves `Skill(job-application-assistant)`,
`Bash(bun run:*)`, `salary_lookup.py`, `pdftotext`; WebFetch/WebSearch native. Maps directly to Runtime
`Policy` (`beforeToolCall`→`evaluatePolicy`, `runtime.ts:118`).

- **Safe to automate (ALLOW):** search/scrape/fetch, salary lookup, generate CV/CL locally, dedupe.
- **Require confirmation (ASK):** Notion upsert (external write), any future real job-portal submission.
- **Deny:** none obvious; `settings.json` rejects unknown CLI flags (exit 1) so a dropped filter can't
  silently change results (`linkedin cli.ts:86-103`, per Phase-22 audit of business repo).

→ Runtime `Policy` (ALLOW/ASK/DENY/ABSTAIN) expresses the business need naturally. **No new Policy feature required.**

---

## PART 12 — Trace Pressure Test

Runtime `TraceCollector` records: `tool_execution_*` (toolCallId/toolName/args/result/isError),
`policy_decision`, `checkpoint_created`, `recovery_*` (`collector.ts:112-168`). This answers:
- What tool was called / args / result / which LLM call / policy decision / where failed / why Run ended → **YES (tool level)**.
- Reconstruct business-step-level flow (setup→scrape→apply) → **NO** (that is agent orchestration logic, not tool calls).

→ **PARTIAL / GAP (P2):** tool-level trace is sufficient for "what happened"; business-step trace would
require the agent to emit step events (business concern, not a Runtime gap). No change to Trace needed.

---

## PART 13 — Reliability Pressure Test

Representative state-changing external tool = **Notion upsert** (idempotent on `Key`). Phase 20 model:

```
Policy → Checkpoint(idempotencyKey) → Tool.execute(Notion upsert)
   → Crash? → Reconstruct → Reconcile(idempotencyKey) → Decide → New Run
```

Fits exactly: `idempotencyKey` persisted pre-tool (`runtime.ts:171`), reconcile uses it (`runtime.ts:286`),
decision = SKIP/RETRY/ESCALATE (`recovery.ts`). Local CV/CL writes are re-runnable (not external). The
business has **no non-idempotent external submission**, so the Runtime Recovery Boundary covers its only
real external write. Workflow-level checkpoint (multi-step resume) is DEFERRED (Phase 20 §4.3) — the
business currently achieves resumability via files, which is adequate. **Model adapts; no re-proof needed.**

---

## PART 14 — Evaluation Boundary

`Run completed` ≠ `Business success`, and the business already enforces this:
- Job relevance scored by `04-job-evaluation.md` (5-dim fit → bands; deal-breaker vetoes). `[SOURCE] rank.md:68-76, apply.md:53`
- CV/CL quality gated by verification checklist (factual accuracy, LaTeX, **compiled-PDF 2-page inspect**, **ATS text-layer + keyword coverage**). `[SOURCE] apply.md:253-287,299-313`

→ Evaluation Requirement **exists** in the business, but it is **expressible as a Tool** (LLM scoring +
checklist). Runtime needs no `Evaluation` subsystem. `Execution Outcome ≠ Business Outcome` is a real and
already-handled boundary. **NOT A GAP at Runtime level.**

---

## PART 15 — Multi-Agent Pressure Test

- `/apply` reviewer = sub-agent via `Agent` tool, `general-purpose`, **fresh context**, returns feedback, discarded. `[SOURCE] apply.md:107-186`
- `/rank` scorers = parallel `general-purpose` sub-agents, ephemeral. `[SOURCE] rank.md:38`
- `/scrape` may parallelize via Agent tool. `[SOURCE] job-scraper/SKILL.md:8,73`
- Named agent `.claude/agents/gemini-research-expert.md` exists but is **not invoked** anywhere. `[SOURCE] search: unused`

→ These are **real separate execution contexts but ephemeral, stateless, single-task**. No durable
multi-agent system, no delegated long-lived state, no Coordinator. `apply`/`interview` are run by the main
session itself. → **Multi-Agent Requirement = NOT PROVEN** (no Coordinator). The reviewer/ranker can be
expressed as a Tool (LLM critique / scoring) on the Runtime. Runtime's "Agent = Runtime instance;
Multi-Agent = independent instances + minimal delegation; no Coordinator" (Phase 16/19) remains valid.

---

## PART 16 — Capability Gap Classification

**P0 — Blocking:** none. The Runtime can host the business as a harness (Session + Runs + Tools + Policy +
Checkpoint/Recovery + Trace). No missing primitive blocks a local pilot.

**P1 — Important (production quality, not blocking a local pilot):**
- Persistence production backend (File MVP only; multi-process durability OPEN = OQ-3, Phase 20 §14/§22).
  Local pilot is fine; elevates to P1 only when leaving single-machine demo.

**P2 — Future:**
- Skill subsystem (runtime has none; expressible via prompt+tools → not blocking).
- Workflow-level checkpoint / orchestration (DEFERRED; business uses files; caller orchestrates).
- Business-step Trace (tool-level covered; step-level = agent concern).
- Multi-Agent sub-agent spawning (expressible as Tool; no Coordinator needed).

**NOT A GAP (real business need, expressible by existing Runtime primitives):**
- Evaluation (Tool), Workspace (single-user, NOT PROVEN), Resource (reference model fits), Policy (matches),
  Tool (wraps any external action), Session/Run (concepts exist).

---

## PART 17 — Anti-Overengineering Check

For each candidate gap, the 5-question test:

| Candidate | Required by business? | Direct SOURCE? | Runtime can express? | Business logic not Runtime? | Future scaling only? | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Skill subsystem | uses Skills, but behavior expressible | yes (SKILL.md) | **yes** (prompt+tools) | partly | no | NOT A GAP (overengineering to add) |
| Workspace | no (single-user) | NOT PROVEN | n/a | — | no | NOT NEEDED |
| Evaluation | yes (quality) | yes | **yes** (Tool) | yes | no | NOT A GAP |
| Multi-Agent Coordinator | no (ephemeral sub-agents) | NOT PROVEN | **yes** (Tool) | partly | no | NOT A GAP |
| Production storage | only for multi-proc | OQ-3 | no (MVP only) | partly | **yes** | P1 (defer) |
| Workflow checkpoint | resumable via files | DEFERRED | caller does | yes | partly | P2 |

Only **production storage** is a genuine Runtime limitation, and only at production scale. Everything else
the business needs is expressible with existing Runtime primitives (Tools + Policy + Session + Checkpoint
+ Recovery + Trace). **No REAL BLOCKING CAPABILITY GAP.**

---

## PART 18 — Final Pressure Report

| Boundary | Business Pressure | Evidence | Severity | Decision |
| --- | --- | --- | --- | --- |
| Session | campaign spans invocations via files | `documents/`, `seen_jobs.json`, tracker | P2 | SUPPORTED (port to Session) |
| Run | each command = one invocation | skills/commands | — | SUPPORTED |
| Tool | CLIs/MCP/LLM wrap as `AgentTool` | portal CLIs, Notion MCP | — | SUPPORTED |
| Policy | per-tool allowlist + ASK for write | `settings.json:1-11` | — | SUPPORTED |
| Trace | tool-level only; no step trace | `collector.ts` events | P2 | PARTIAL |
| Recovery | only idempotent external write (Notion) | `notion-sync` upsert on `Key` | P2 | PARTIAL (idempotent covered; wf-level deferred) |
| Persistence | File MVP ok locally; prod OPEN | `FileRecoveryStore` | P1 (prod) | PARTIAL |
| Skill | heavy capability activation | `SKILL.md` | P2 | GAP (expressible via prompt+tools) |
| Workspace | single-user, no namespace | `README.md:81-88`, gitignore | NOT PROVEN | NOT NEEDED |
| Resource | portals/Notion/Gmail external | `ResourceReference` model | — | SUPPORTED |
| Evaluation | fit score / ATS / reviewer | `04-job-evaluation.md`, `apply.md` | NOT A GAP | NOT A GAP (Tool) |
| Multi-Agent | ephemeral sub-agents | `apply.md:107`, `rank.md:38` | P2 | NOT PROVEN (no Coordinator) |

---

## PART 19 — Next Phase Candidate

No **P0** and no **P1 that blocks a local pilot**. The only P1-grade item is production-grade persistence
(OQ-3), already an OPEN question from Phase 20, deferred by design.

```
Next Phase Candidate from P0/P1: N
```

Deferred (informational, NOT blocking, IMPLEMENTATION: DEFERRED):
- **Production Persistence Backend** (OQ-3): SQLite/Postgres/Redis for multi-process durability.
  Evidence: File MVP (`file-store.ts`); Impact: required only beyond single-machine demo;
  Minimal capability: swap `RecoveryStore` impl; Why insufficient: File MVP is single-writer.
- **Optional Skill tooling**: encode `SKILL.md` (prompt+`allowed-tools`) as agent prompt + per-task
  tool set. Evidence: `SKILL.md:1-9`; Why not a Runtime gap: expressible without a Skill subsystem.

---

## Phase 23 Result

```
REPOSITORY: yujun2006/ai-job-search (Business Agent / Workflow Reference)
RUNTIME:     enterprise-ai-lab (EnterpriseAiRuntime + Pi Agent)

CODE CHANGED: NO
BUSINESS REPO MODIFIED: NO

P0 (Blocking): 0
P1 (Important, blocks pilot): 0  (only P1-at-production = persistence/OQ-3, deferred)
P2 (Future): Skill subsystem, Workflow-level checkpoint, Business-step Trace, Multi-Agent spawn
NOT A GAP: Evaluation (Tool), Workspace (single-user), Resource (model fits),
           Policy (matches), Tool (wraps), Session/Run (exist)

REAL BLOCKING CAPABILITY GAP: NONE

RUNTIME SUFFICIENT AS HARNESS: YES
  - Tool        → AgentTool (wrap CLIs/MCP/LLM)
  - Permission  → Policy (ALLOW/ASK/DENY)
  - Durable id  → idempotencyKey (crash-safe)
  - Recovery    → covers only idempotent external write (Notion upsert)
  - Session/Run → durable Session + volatile Run
  - Trace       → tool-level observability

KEY FINDINGS:
  - Business has NO non-idempotent external submission → Recovery Boundary fits cleanly.
  - Workspace NOT PROVEN (single-user) → do not invent.
  - Skill/Evaluation/Multi-Agent expressible via existing primitives → not Runtime gaps.
  - Only production persistence (OQ-3) is a genuine Runtime limitation, at scale only.

NEXT PHASE: N (no P0/P1)
DEFERRED CANDIDATES: Production Persistence (OQ-3); optional Skill-as-prompt tooling

STOP.
```
