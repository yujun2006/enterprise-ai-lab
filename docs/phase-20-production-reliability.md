# Phase 20 — Production Reliability

## 1. Objective

实现 Phase 20-1 唯一一个最小 Production Reliability Vertical Slice：

> **Idempotent State-changing Tool Recovery with Reconciliation**

闭环：Tool Call → Policy → Checkpoint → External Side Effect → Process Death →
Reconstruct → Reconcile → Runtime Decision → New Run → Policy Re-evaluation →
Continue / Skip / Retry / Escalate。

核心验收（已通过实验证明）：

```text
External COMMITTED + Tool Result LOST + Process Death
   ↓ Restart → Reconstruct → Reconcile = SUCCESS → SKIP
   ⇒ External side effect count = 1（绝不重复提交）
```

`CODE CHANGED: YES`（本阶段为实现阶段；新增 `src/recovery/*` + 扩展 `runtime.ts`/`trace/*`）。

## 2. Implemented Vertical Slice

仅实现 Idempotent State-changing Tool 的 Recovery 闭环（Design Gate 选定 Candidate B）：

* 最小 Durable Recovery Record
* operationId / idempotencyKey 传播（Pi hooks，不污染 Tool）
* Checkpoint-before-Tool 持久化（Crash Window 被压缩为可安全解析两态）
* External Resource 对账（三态 SUCCESS / NOT_FOUND / UNKNOWN）
* Runtime Recovery Decision（CONTINUE / SKIP / RETRY / ESCALATE）
* Session 重建（新 Pi Agent / 新 Run）
* 新 Run 重发 → Policy 重评估
* 8 个验收测试 + 3 个额外检查，全部通过

## 3. Architecture

```text
             Enterprise Runtime
                    │
             Recovery Boundary  (Runtime 生命周期能力，非 subsystem)
                    │
        ┌───────────┼───────────────┐
        ↓           ↓               ↓
   Persistence   Reconcile       Decision
   (RecoveryStore) (ReconcileFn)  (Runtime)
        │           │               │
        ↓           ↓               ↓
   Checkpoint   External         CONTINUE/
                Resource         SKIP / RETRY /
                (truth)          ESCALATE
                    │               │
                    └───────┬───────┘
                            ↓
                        New Run
                            │
                            ↓
                         Policy (beforeToolCall → evaluatePolicy)
                            │
                            ↓
                           Pi (Agent)
```

边界归属（与 Phase 19 一致，已落地）：

* **Pi** = 执行引擎（Agent Loop / Tool 执行 / Agent State）。未修改、未 fork。
* **Runtime** = Checkpoint / Recovery / Reconciliation / Recovery Decision / Run 重建。
* **Policy** = Tool Call 治理（Recovery 重发的 Tool Call 必重评）。
* **External Resource** = 副作用真相（Runtime 仅持 idempotencyKey + resourceReference 查询）。
* **Trace** = 观测（新增 checkpoint_created / recovery_started / reconciliation_result / recovery_decision）。

## 4. Durable Recovery Record

`src/recovery/types.ts` — `DurableRecoveryRecord`：

```ts
sessionId, runId, parentRunId?, prompt, status,
checkpoint { position, toolName?, toolArgs?, idempotencyKey?, resourceReference? },
operationId?, updatedAt
```

分类（Design Gate §4.2）：

* REQUIRED（耐久）：`sessionId`（Pi 原生，agent.d.ts:50）、`prompt`、`status`、`checkpoint.position`、`checkpoint.toolName/toolArgs/idempotencyKey/resourceReference`（state-changing 时）、`updatedAt`
* OPTIONAL：`runId`（关联，非恢复身份）、`parentRunId`（血缘）
* NOT REQUIRED（不进 Record）：`activeRun` / `streamingMessage` / `pendingToolCalls` / `abort`（transient）、Trace 事件
* DERIVED（单独存储）：`messages`/transcript 由 `RecoveryStore.saveMessages` 按 `sessionId` 存（Phase 18 边界），**不进 Checkpoint**
* EXTERNAL：`Resource Data` 由 External Resource 拥有，Record 仅持 `resourceReference`

`[SOURCE]` `src/recovery/types.ts`、`src/recovery/file-store.ts`。

## 5. Operation Identity

跨进程 / 跨 Run 稳定身份（用于 Reconciliation）= **`idempotencyKey`**（crash-safe，于 `beforeToolCall` 持久）。

> [CORRECTION Phase 22 / C1] 历史表述曾将 `operationId` + `idempotencyKey` 并列为 durable identity。
> 实际实现中 `operationId` 仅在 **正常 Tool 完成路径**（`afterToolCall` 从 `result.details` 捕获并补写，
> `src/runtime.ts:136-146`）持久化；进程在 `process.exit(137)` 崩溃时 `afterToolCall` 永不触发，
> 故 `operationId` **不**跨进程死亡持久。当前 `operationId` 是 completion 后的回显元数据，
> **不是** Phase 20-1 的 crash-safe recovery identity。真正 crash-safe、并被 `reconcile` 使用的对账身份只有 `idempotencyKey`（见 §7）。

传播路径（不污染 Tool）：

```text
Runtime.beforeToolCall(ctx)
   │ ctx.args.idempotencyKey  (Tool 参数，或由调用方提供)
   ▼
RecoveryStore.save(record)        ← 在 Tool.execute 之前持久（最早点）
   │
Tool.execute(params)
   │ 用 idempotencyKey 调 External（幂等）
   ▼
result.details.operationId        ← Tool 在 details 回传，Runtime.afterToolCall 捕获
   ▼
RecoveryStore.update(record.operationId)
```

* `idempotencyKey` 在 `beforeToolCall` 从 `ctx.args` 捕获并持久（崩溃前/后均可对账，是 crash-safe 身份）。
* `operationId` 由 Tool 经 `result.details` 回传，**仅正常完成时** `afterToolCall` 补写；进程死亡（崩溃窗口）时不会持久（见上方 C1）。
* **`runId` / `toolCallId` 不是 External Operation Identity**（每次新 Run / 新 Tool Call 都不同，已实验证明）。

`[SOURCE]` `src/runtime.ts` `beforeToolCall`/`afterToolCall`/`captureCheckpoint`；`[EXP]` Test 8 仅证明**正常完成路径**下 `idempotencyKey` 稳定、`runId`/`toolCallId` 不同；`operationId` 跨进程死亡的 crash 耐久性 **未** 由 Test 8 证明（Test 8 不触发 `process.exit(137)`）。

## 6. Checkpoint Ordering

```text
Checkpoint WRITE (beforeToolCall, 持 idempotencyKey)
        ↓
External COMMIT (Tool.execute 内)
        ↓
process dies?
```

硬规则（已落地 + 实验验证）：

* Checkpoint **先于** External commit 持久（beforeToolCall 在 tool.execute 之前 awaited 写盘）。
* 若 Checkpoint 写失败 → `beforeToolCall` 返回 `{block:true}`，**Tool 绝不执行**（无耐久身份不可提交副作用）。`[EXP]` CF 测试：count=0。
* 禁止 External commit → Checkpoint 的反向顺序（会产生“已提交但无身份”窗口）。

`[SOURCE]` `src/runtime.ts` `beforeToolCall`（`captureCheckpoint` 在 Policy 通过后立即 await 写盘；catch → block）。

## 7. Reconciliation

`recover(sessionId, reconcile)` 持有 `idempotencyKey` + `resourceReference`，调用注入的 `ReconcileFn`：

```ts
type ReconcileFn = (key: string, ref?) => Promise<"SUCCESS"|"NOT_FOUND"|"UNKNOWN"> | ...
```

* External Resource 拥有真实副作用状态；Runtime 不拥有 Resource Data。
* 三态：`SUCCESS` / `NOT_FOUND` / `UNKNOWN`。
* 真实闭环由“提供 ReconcileFn 的 External 集成”注入；测试用 `ExternalResource`（文件型，幂等 commit）验证。

`[SOURCE]` `src/recovery/types.ts` `ReconcileFn`；`[EXP]` Test 3（SUCCESS）、Test 4（NOT_FOUND）、Test 5（UNKNOWN）。

## 8. Recovery Decision

```text
SUCCESS   → SKIP          (committed；绝不重试)
NOT_FOUND → replay "safe"  ? RETRY : ESCALATE
UNKNOWN   → ESCALATE      (绝不盲重试)
```

Decision Owner = **Enterprise Runtime**（`decideRecovery`，`src/recovery/recovery.ts`）。
`replay` 用 Pi 原生 `AgentTool.replay`（types.d.ts:350-351）：`"safe"` 仅表示“允许 Recovery 考虑重放”，**不代表必须 Retry**（SUCCESS 仍 SKIP）。

`[SOURCE]` `src/recovery/recovery.ts`、`src/runtime.ts` `recover`；`[EXP]` 全部决策测试通过。

## 9. Policy Interaction

Recovery RETRY = 新 Run = 新 Tool Call → `beforeToolCall` → `evaluatePolicy`。

* RETRY 不在此直接调用 `Tool.execute`；`recover` 返回 `retry` 计划，由调用方经新 Run 重发。
* SKIP / ESCALATE 不触发 Tool。
* 新 Run 的工具调用**必经 Policy**（runtime.ts:52 的 `beforeToolCall`）。

`[EXP]` Test 6：NOT_FOUND→RETRY，新 Tool Call 被 Policy DENY → Tool 执行次数 = 0（Recovery 未绕过 Governance）。

## 10. Session Reconstruction

`resume(sessionId)` / `recover(sessionId, ...)` 加载持久 transcript（messages），构造**新 Pi Agent**（同 `sessionId`，新 Run）：

```text
Persisted Session + Recovery Record
   ↓ new Pi Agent (new runId)
   ↓ (recover) Reconcile → Decide
   ↓ (retry) New Run → Policy
```

`[EXP]` Test 1/7/8：新 Runtime 实例 `resume` 后 `sessionId` 相同、`runId` 不同、`messages` 续接、`toolCallId` 不同。

## 11. Crash Simulation

真实子进程（`scripts/_p20_child.ts`）+ `process.exit(137)`：

* commit-exit：`External COMMITTED` → `process.exit(137)`（result 丢失）
* precommit-exit：`process.exit(137)`（External 未提交）

父进程以同一 `dir` 重建 Runtime 并 `recover`。

`[EXP]` Test 3 / Test 4：子进程退出码 = 137；Checkpoint 存在；External 状态符合预期。

## 12. Acceptance Tests

| # | 测试 | 结果 |
| --- | --- | --- |
| T1 | Session Reconstruction（新 Runtime / 新 Pi Agent / 同 sessionId） | PASS |
| T2 | Read-only Safe Replay | PASS |
| T3 | COMMITTED → SKIP（真实进程死亡，side effect count=1） | PASS |
| T4 | NOT_FOUND → RETRY（真实进程死亡，重试后 count=1） | PASS |
| T5 | UNKNOWN → ESCALATE（无自动执行） | PASS |
| T6 | Policy Re-evaluation（RETRY 被 DENY → 不执行） | PASS |
| T7 | Session Continuity（新 Run，逻辑连续） | PASS |
| T8 | Operation Identity — 正常完成路径下 `idempotencyKey` 稳定（`runId`/`toolCallId` 不同）；`operationId` 仅 completion 回显、非 crash-durable | PASS |
| +1 | Checkpoint Failure → Tool MUST NOT execute | PASS |
| +2 | Duplicate Replay → External count=1 | PASS |
| +3 | Policy DENY During Recovery（同 T6 强化） | PASS |

运行：`npm run acceptance:phase20`（不需真实 LLM；用 ScriptedModel 确定性驱动；崩溃用真实子进程）。

## 13. Failure Semantics

* **Checkpoint 写失败** → Tool 不执行（block）。
* **External SUCCESS** → SKIP（已提交，不重试）。
* **External NOT_FOUND + replay safe** → RETRY（新 Run 重发，幂等去重）。
* **External NOT_FOUND + replay never** → ESCALATE。
* **External UNKNOWN** → ESCALATE（不盲重试）。
* **Policy DENY** → Tool 不执行（无论正常还是 Recovery RETRY）。

## 14. Known Limitations

* External Resource 为文件型测试桩；生产 External 集成需各自提供 `ReconcileFn`。
* UNKNOWN 的退避 / 人工介入协议未定义（仅 ESCALATE）。
* 生产存储（SQLite/Postgres/Redis）未定（MVP = File，`temp+rename` 原子写）。
* 多写者并发下 FileRecoveryStore 一致性未验证（MVP 单写者）。
* 仅单 Agent；Multi-Agent Recovery 未做。

## 15. Deferred Items

* Workflow-level checkpoint（Run-level + Session transcript 足够）
* Multi-Agent Coordinator（Phase 16/19 No Coordinator 仍成立）
* RecoveryManager / RetryManager / CheckpointManager / PersistenceManager / ResumeManager（禁止）
* DB / Redis / Queue / 2PC / Saga
* 自动 UNKNOWN 重试
* Durable Pi / Pi fork / Pi modification

## 16. Final Result

```text
SLICE: Idempotent State-changing Tool Recovery with Reconciliation — IMPLEMENTED & VERIFIED
UNKNOWN ≠ FAILED: proven (Test 5 ESCALATE)
External = side-effect truth: proven (Test 3/4 reconcile 驱动决策)
Recovery Decision Owner = Runtime: proven (decideRecovery)
Recovery = 新 Run = 新 Tool Call → Policy 重评: proven (Test 6)
idempotencyKey = 跨进程/Run 稳定身份（crash-safe，reconcile 使用）: proven (Test 3/7/8)；operationId = 正常完成回显元数据，非 crash-durable: proven (Test 8 不崩溃)
sessionId durable / runId / toolCallId 否: proven (Test 1/7/8)
Checkpoint 先于 External commit: proven (§6 + CF 测试)
CODE CHANGED: YES (新增 src/recovery/*，扩展 runtime.ts / trace/*)
IMPLEMENTATION: REQUIRED → DONE (Phase 20-1)
```
