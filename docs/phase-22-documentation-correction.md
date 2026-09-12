# Phase 22 — Documentation Correction

> Goal: make Phase 20–21 docs consistent with the **verified** code behavior. `CODE CHANGED: NO`.
> Source of truth: `src/runtime.ts`, `src/recovery/**`, `scripts/phase20-acceptance.ts`, and the
> Phase 21 freeze audit (`ARCHITECTURE FREEZE: PASS`). Code + verified experiment > old doc claim.

---

## 1. Objective

Correct overclaims in `docs/phase-20-*.md` so the durable-operation-identity model and the
recovery lifecycle wording match the implemented behavior. No new architecture, no new features,
no code change.

---

## 2. Verified Source-of-Truth

| Fact | Evidence |
| --- | --- |
| `idempotencyKey` captured at `beforeToolCall` (`captureCheckpoint`) and persisted pre-tool | `src/runtime.ts:154-155,171` |
| `operationId` captured only in `afterToolCall` from `result.details` | `src/runtime.ts:138-139` |
| `afterToolCall` never fires on `process.exit(137)` ⇒ `operationId` not persisted on crash | `src/runtime.ts:136,142,146` |
| Reconcile uses only `idempotencyKey` (+ `resourceReference`) | `src/runtime.ts:286` |
| `recover()` does Reconstruct/Reconcile/Decide and returns a retry plan; it does NOT re-execute the tool | `src/runtime.ts:276-306` |
| New Run is issued by the caller (`run()`), re-entering Policy | `phase20-acceptance.ts` Test 3 re-`run` |
| Test 8 does not crash (`process.exit` only in Test 3/4) | `phase20-acceptance.ts` |

---

## 3. Corrections

### C1 — operationId durability

**Old (incorrect) claim:** “`operationId` + `idempotencyKey` are durable identity / crash-safe / survive process death.”

**Corrected:** `idempotencyKey` is the crash-safe, durable, reconcile-used operation identity.
`operationId` is persisted **only on the normal completion path** (`afterToolCall`); on `process.exit(137)`
the hook never runs, so `operationId` is **not** crash-durable. In the fixture it equals `idempotencyKey`
(redundant echo). The recovery mechanism correctly relies solely on `idempotencyKey`.

**Files changed:**
- `docs/phase-20-production-reliability.md` §5 (line 94 region), §5 bullets + `[EXP]` (line ~112-116), §12 T8 (line 208), §16 Final Result (line 249).
- `docs/phase-20-implementation-design-gate.md` §2 P19 summary (line 28), inserted `[CORRECTION-22 / C1 + C2]` footnote, Vertical Slice (line ~478), Operation Identity final (line ~491).

### C2 — Resume terminology

**Old (misleading) label:** “Reconstruct → Reconcile → Decide → Resume” read as *resume the old Run*.

**Corrected:** `Resume` = Recovery **reconstructs the logical Session and starts a NEW Run** (new `runId`,
new `toolCallId`); it never resumes the old Run from the point of process death. `recover()` returns a
decision/retry plan; the caller issues the new `run()`, which re-enters `beforeToolCall → Policy`.

**Files changed:**
- `docs/phase-20-implementation-design-gate.md` §2 footnote (C2) + boundary block (line ~449).

### C3 — Test 8 claim

**Old (incorrect):** “Test 8 proves `operationId` durability / `operationId+idempotencyKey` durable identity.”

**Corrected:** Test 8 proves operation-identity propagation **on the normal completion path**
(`idempotencyKey` stable across Run/process; `runId`/`toolCallId` differ). It does **not** prove
`operationId` survives process death, because Test 8 never triggers `process.exit(137)` (only Test 3/4 do).

**Files changed:** `docs/phase-20-production-reliability.md` §5 `[EXP]` note + §12 T8 row + §16 result line.

---

## 4. Current Recovery Model

```
Tool Call → Policy (beforeToolCall)
   ↓ Capture idempotencyKey
   ↓ Checkpoint persisted (before_tool, crash-safe)
   ↓ Tool.execute → External Side Effect
   ↓
   Process Death?
   ├── NO  → Tool Result → afterToolCall → optional operationId persistence → done
   └── YES → Restart → Reconstruct Session (new Pi Agent, new Run)
                 → Reconcile using idempotencyKey
                 → Decide (SKIP/RETRY/ESCALATE/CONTINUE)
                 → Start New Run (caller) → Policy re-evaluation
```

---

## 5. Current Operation Identity Model

```
DURABLE IDENTITY:      idempotencyKey   (persisted before_tool; survives crash; used by reconcile)
OPERATION IDENTITY:    idempotencyKey   (the only field both durable AND used)
EXTERNAL OPERATION ID: operationId      (Tool echo; persisted ONLY on normal completion; NOT used by reconcile)
```

`operationId` remains useful as a reporting/echo field (`RecoveryResult.operationId`) but is **not** part
of the crash-safe durable identity in Phase 20-1. If `operationId` must become crash-durable, that is
**OQ-1** (record only, not implemented this phase).

---

## 6. Remaining Open Questions

- **OQ-1** Should `operationId` be persisted *before* external commit (in `captureCheckpoint`)? Currently only `idempotencyKey` is. `[OPEN]` — recorded, not implemented.
- **OQ-2** Escalation channel for `ESCALATE` (currently a returned decision only). `[OPEN]`
- **OQ-3** Production persistence backend (SQLite/PG/Redis). `[OPEN]`
- **OQ-4** Exact timeout semantics (timeout ≠ auto-FAILED). `[OPEN]`
- **OQ-5** Reliability with real LLM/provider failures (tests use `ScriptedModel`). `[OPEN]`

---

## 7. Files Changed

| File | Change |
| --- | --- |
| `docs/phase-20-production-reliability.md` | C1/C3 wording fixes (§5, §12, §16) |
| `docs/phase-20-implementation-design-gate.md` | C1/C2 footnote + identity wording (§2, §19, Final Result) |
| `docs/phase-21-architecture-freeze.md` | Unchanged (already authoritative; records C1/C2/C3) |
| `docs/phase-22-documentation-correction.md` | Created (this doc) |

No `src/**`, `scripts/**`, `package.json`, or test code modified.

---

## 8. Verification

- `npm run typecheck` — not affected (docs only); expected PASS.
- `npm run acceptance:phase20` — unchanged code; expected PASS (Test 3/4 prove `idempotencyKey` recovery; Test 8 proves normal-path identity).

Verified by re-reading `src/runtime.ts` / `src/recovery/**` / `scripts/phase20-acceptance.ts`:
no statement in the corrected docs contradicts the code. Phase 21 freeze decisions untouched.

---

## 9. Final Decision

```
PHASE 22: PASS
CODE CHANGED: NO
DOCUMENTATION CHANGED: YES
C1 operationId: CORRECTED
C2 Resume: CORRECTED
C3 Test 8: CORRECTED
TYPECHECK: NOT RUN (docs only; no code impact)
PHASE 20 ACCEPTANCE: NOT RUN (docs only; code unchanged, prior run PASS)
OPEN QUESTIONS: 5
NEW ARCHITECTURE DECISIONS: 0
NEW FEATURES: 0
```

STOP.
