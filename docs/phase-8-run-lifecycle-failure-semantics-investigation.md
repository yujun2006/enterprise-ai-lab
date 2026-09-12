# Phase 8 — Run Lifecycle & Failure Semantics Investigation

## 1. Executive Summary

本 Phase 只调查：**Enterprise Runtime 能否准确、统一地理解一次 Run 的生命周期与最终结果？** 不实现 Retry/Timeout/Checkpoint/Persistence/Error Framework。

核心结论（先给）：

- **Run 一定有 `agent_end`**（正常/失败/中止均产生），它是统一的"Run 结束信号"，但**不携带状态**——状态需从最后一条 message 的 `stopReason` + `errorMessage` + tool `isError` 派生。
- **`stopReason` 不足以作为 Run Status**：(1) Tool Error / Policy DENY 不改变 `stopReason`（仍 `stop`，Run 照常 COMPLETED）；(2) **Abort 与 LLM Failure 在当前栈都坍缩为 `stopReason:"error"`**，仅靠 `errorMessage` 文本区分（"This operation was aborted" vs "Connection error."）——脆弱。
- **Final Answer ≠ Success**：Tool Error 后 LLM 仍可产出 final answer（实验 B），但业务可能失败。
- **三者必须分离**：`Execution Outcome`（COMPLETED/FAILED/ABORTED，Runtime 可派生）≠ `Business Outcome`（用户任务是否完成，属 Evaluation 层，FUTURE）≠ `Trace`（完整发生了什么）。
- **真实 Gap（不阻塞当前范围）**：① Abort 与 FAILED 在 `stopReason` 上不可分；② `errorMessage` 未进入 Trace（TraceCollector 只存 finalAnswer 文本）；③ Policy Control Point 抛异常被**静默吞成 Tool Error**，且无 `policy_decision` 事件 → 在 Trace 中不可见。
- **决策**：当前不需要实现正式 Run State 对象；但本 Phase 已把"派生的 Execution Status 模型"钉死，作为未来 Retry/Timeout/Checkpoint 的前置契约。Retry/Timeout/Idempotency/Checkpoint/Evaluation 均 `FUTURE`。

```text
PHASE 8 INVESTIGATION: COMPLETE
CODE CHANGED: NO
```

## 2. Current Run Lifecycle

`[SOURCE]`（`agent.js` / `agent-loop.js` / `runtime.ts`）

- **Start**：`runtime.run/prompt` → `agent.prompt` → `runPromptMessages` → `runWithLifecycle` 设 `activeRun` + `isStreaming=true`（`agent.js:226-279,326-336`）。
- **Running**：`runAgentLoop`（多 Turn：`streamAssistantResponse` → tool calls → loop → …，`agent-loop.js:120-158`）。
- **End（Three exits）**：
  1. 正常结束：loop 自然终止 / `shouldStopAfterTurn` → emit `agent_end`（`agent-loop.js:154-156`）。
  2. LLM/流 失败或中止：`message.stopReason === "error" | "aborted"` → emit `turn_end` + `agent_end`（`agent-loop.js:124-127`）。
  3. 异常：`runWithLifecycle` catch → `handleRunFailure` 写 `stopReason:"error"|"aborted"` 的 message 并 emit `agent_end`（`agent.js:342-364`）。
- **Q5 — Run 是否一定产生 `agent_end`？** 是（上述三路径在当前 Pi 版本均 emit `agent_end`）。`[SOURCE]`
- **Q3 — 谁决定 Run 结束？** Pi 的 loop / `runWithLifecycle` / `handleRunFailure`；Runtime 仅通过 `waitForIdle`/`abort` 协作（`runtime.ts:111,116`）。

## 3. Pi stopReason Semantics

`[SOURCE]` 完整梳理 `stopReason`：

| stopReason | 设置方 | 触发条件 | Run 是否结束 | 是否成功 |
| --- | --- | --- | --- | --- |
| `stop` | LLM provider | 自然结束 | 是 | 正常（exec COMPLETED） |
| `toolUse`/`tool_calls` | LLM provider | 模型要调用 tool | 否（继续 loop） | — |
| `length` | LLM provider | 触达 max tokens | 是（但先把截断的 tool call 标 isError 再继续） | exec 继续 |
| `error` | Pi (`handleRunFailure`) **或** stream adapter | LLM/流失败 **或** 中止被适配成 error | 是 | **exec FAILED（或 ABORTED，见 §7）** |
| `aborted` | Pi (`handleRunFailure`, `aborted=true`) | 中止且走异常路径 | 是 | exec ABORTED |

- Pi 仅在这两处写 `stopReason`：`agent.js:357`（`aborted?"aborted":"error"`）、`agent-loop.js:124`（读取）。
- `agent-loop.js:137`：`stopReason==="length"` → `failToolCallsFromTruncatedMessage`（tool call 标 isError，不执行），loop 继续。
- **关键**：`tool_execution_end.isError` 与 message `stopReason` 是**两条独立信号**——Tool Error 不改 message `stopReason`（仍 `stop`），只在 tool 事件中。

## 4. Normal Completion

`[EXPERIMENT]` A：简单问题 → `stopReasons:["stop"]`，`agentEnd:true`，无 `toolErrors`，`finalAnswer:"OK"`。
⇒ 成功证据 = **最后 message `stopReason:"stop"` 且全程无 `toolErrors`/`errorMessage`**。`agent_end` 本身不证明成功（失败也有 `agent_end`）。

## 5. Tool Error

`[EXPERIMENT]` B：`boom` 抛错 → `stopReasons:["stop"]`（仍 COMPLETED），`toolErrors:[true]`，`finalAnswer:"...error when calling the boom tool..."`。
`[SOURCE]` Pi `prepareToolCall`/`finalizeExecutedToolCall` 的 `try/catch` 把异常转 `createErrorToolResult(isError:true)` 回灌 loop（`agent-loop.js:452-456,479-483,515-518`），**loop 继续**。
**结论**：Tool Error **≠** Run Failure。Execution 仍 COMPLETED；Business Outcome 未知（可能失败）。

## 6. Policy DENY / ASK

`[EXPERIMENT]` C（DENY）：`stopReasons:["stop"]`，`toolErrors:[true]`，`policyDecisions:["deny"]`，`finalAnswer:"...don't have the necessary permissions..."`。
`[EXPERIMENT]` D1（ASK→ALLOW）：tool 正常执行（`toolErrors:[false]`）。D2（ASK→DENY）：`toolErrors:[true]`，`policyDecisions:["ask"]`，`finalAnswer:"policy denial..."`。
`[SOURCE]` DENY/ASK→DENY 均返回 `{block:true}` → `createErrorToolResult(isError:true)`（`agent-loop.js:426-436`；`policy/adapter.ts:34-44`），loop 继续。
**结论**：Policy DENY / ASK→DENY **≠** Run Failure——这是**正常业务拒绝**（exec COMPLETED，tool isError=blocked）。ASK 是 in-process 等待，不改变 Run 生命周期（`[DECISION]`）。

## 7. Abort / Cancellation

`[EXPERIMENT]` E：`stopReasons:["error"]`，`lastErrorMessage:"This operation was aborted"`，`agentEnd:true`，`finalAnswer:""`。
`[SOURCE]` `runtime.abort()` → `activeRun.abortController.abort()`（`agent.js:202`）；signal 贯穿 loop（`agent-loop.js` 多处 `signal?.aborted`）。
**关键发现**：在当前 Ollama/openai-completions 栈，abort 被 stream 适配成一条 `stopReason:"error"` 的 message（走 `agent-loop.js:124` 而非 `handleRunFailure` 的 `aborted` 分支），故**Abort 与 LLM Failure 都表现为 `stopReason:"error"`**，仅 `errorMessage` 文本不同（"This operation was aborted" vs "Connection error."）。
- **Q7** Abort 产生 `agent_end`？是。
- **Q8** Abort 的 `stopReason`？观察到的为 `"error"`（Pi 另支持 `"aborted"` 分支，但是否命中取决于 adapter/时序）。
- **Q9** Abort ≠ Failure？**概念上成立**（ABORTED 是控制流取消，非执行失败），但**当前 Pi/adapter 不把它可靠编码为独立 `stopReason`**——仅凭 `stopReason` 无法区分。**需 Runtime 自己记录 abort 意图**（如 `abort()` 时置 `abortedByUs` 标志）才能可靠区分。`[DECISION]`

## 8. LLM / Provider Failure

`[EXPERIMENT]` F（`OLLAMA_BASE_URL` 指向死地址）：`stopReasons:["error"]`，`lastErrorMessage:"Connection error."`，`agentEnd:true`，`finalAnswer:""`。
`[SOURCE]` 流失败 → `runWithLifecycle` catch → `handleRunFailure(stopReason:"error")`（`agent.js:342-359`）；或适配成 error message 走 `agent-loop.js:124`。
**结论**：LLM/Provider Failure = **exec FAILED**（`stopReason:"error"`，非空 `errorMessage`）。与 Abort 形态相同，仅 `errorMessage` 语义不同。

## 9. Runtime Exception（Policy Control Point 崩溃）

`[EXPERIMENT]` G：Policy 函数直接 `throw` → `stopReasons:["stop"]`（**COMPLETED**），`toolErrors:[true]`，**`policyDecisions:[]`（无 policy_decision 事件）**，`finalAnswer:"...error looking up the customer..."`。
`[SOURCE]` `beforeToolCall` 在 `prepareToolCall` 的 `try` 内（`agent-loop.js:412-418`）；抛错被 `catch`（`agent-loop.js:452-457`）转成 `isError` tool result，`hooks.onDecision` 从未被调用（`policy/adapter.ts:27` 在 throw 前）。
**结论（重要 Gap）**：**Policy Control Point 的异常被静默吞成 Tool Error**——Run 照常 COMPLETED，但**没有任何 `policy_decision`/`policy_resolved` Trace 事件**，根因（Policy bug）在 Trace 中不可见。`[DECISION]` 未来需统一 Error Event 暴露此类 Runtime 层异常。

## 10. Execution Outcome vs Business Outcome

`[DECISION]` 必须分离三层：

```text
Execution Outcome  = Run 是怎么结束的（COMPLETED / FAILED / ABORTED）
                      Runtime 可派生，属 Runtime 职责边界。
Business Outcome    = 用户真正想完成的事做成没有？（成功/失败/未知）
                      NOT Runtime 职责 → Evaluation 层（FUTURE）。
Trace               = 过程中发生了什么（events / tool isError / policy / LLM）。
```

例（实验 B）：Tool Error + LLM 恢复 + Final Answer ⇒ **Execution=COMPLETED，Business=FAILED/UNKNOWN，Trace=完整**。例（实验 C）：Policy DENY ⇒ **Execution=COMPLETED，Business=DENIED（正常业务结果，非失败），Trace=完整**。

## 11. Failure Taxonomy

| # | 场景 | message stopReason | tool isError | policy 事件 | Execution | Business |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 正常成功 | `stop` | 无 | — | COMPLETED | 未知(Eval) |
| 2 | Tool Error + 恢复 | `stop` | true | allow | COMPLETED | 未知/可能失败 |
| 3 | Policy DENY | `stop` | true(block) | deny | COMPLETED | DENIED（正常） |
| 4 | ASK→ALLOW | `stop` | false | ask | COMPLETED | 未知 |
| 5 | ASK→DENY | `stop` | true(block) | ask | COMPLETED | DENIED |
| 6 | User/Runtime Abort | `error` | 无 | — | ABORTED* | 未完成 |
| 7 | LLM/Provider Failure | `error` | 无 | — | FAILED | 未完成 |
| 8 | Policy 异常(崩溃) | `stop` | true | **无** | COMPLETED(隐藏错误) | 未知 |

\* 当前 `stopReason:"error"`，需 `errorMessage`/"abortedByUs" 标志才能可靠判定 ABORTED。

## 12. Error / Trace Relationship

`[INFERENCE]` + `[SOURCE]`
- **Q11 — 当前 Trace 是否足够重建 Run Failure？** 部分：tool `isError`、policy 决策已入 Trace；但 **`errorMessage` 未入 Trace**（TraceCollector 仅存 `finalAnswer` 文本，错误时为空，`trace/collector.ts:100-103`），故"为何失败"无法从 Trace 还原。
- **Q12 — 是否存在只存在于 exception、未进 Trace 的错误？** 是：① `errorMessage` 不入 Trace；② **Policy Control Point 异常无 `policy_decision` 事件**（实验 G）→ 完全不可见。
- **Q13 — 未来是否需要统一 Error Event？** 建议 `FUTURE`：如 `run_error` 事件携带 `{stopReason, errorMessage, classification: tool|llm|policy|runtime|abort}`，使失败可追溯。不实现。

## 13. Tool Side Effects

`[INFERENCE]` 当前 Runtime **不知道 Tool 是否产生外部副作用**：`isError` 只表示 Tool 执行抛错/被拦，不代表"外部动作未发生"。例：订单已创建成功，Tool 自身 timeout 抛错 → `isError:true` 但业务动作已发生。
⇒ **Retry / Recovery / Idempotency 未来不能只凭 `isError` 决策**（需 Tool 自报副作用/幂等键）。`[DECISION]` 记录为 FUTURE，当前不实现。

## 14. Future Retry / Timeout Implications

`[INFERENCE]`（不实现，仅前置条件）
- **Retry** 需要：① 区分 failed vs aborted（见 §7，当前不可靠）；② 知道失败发生在哪个 Tool Call；③ 知道是否已产生副作用（§13）。⇒ 必须建立在"正式 Execution Status + 副作用标注"之上。
- **Timeout** 需区分：LLM timeout / Tool timeout / Whole-Run timeout（当前仅手动 `abort()`，无分层）。
- **结论**：Retry/Timeout/Checkpoint 的前置契约 = 本 Phase 钉死的 Execution Status 模型 + 统一 Error Event + 副作用可见性。**当前都不需要**（`FUTURE`）。

## 15. Run Lifecycle Model

`[DECISION]` 最终模型（按 Pi 真实语义，标注归属）：

```text
                 ┌──────────────┐
                 │    START     │  (runtime.run/prompt)
                 └──────┬───────┘
                        ↓
                    RUNNING        ← Pi: runWithLifecycle + loop
                     /  |  \
                    /   |   \
                   ↓    ↓    ↓
            COMPLETED FAILED ABORTED     ← 派生状态（见下）
              (loop    (stopReason  (stopReason
              自然结束)  "error"+)   "error"+abort*)
```

- `COMPLETED`：最后 message `stopReason ∈ {stop, toolUse→结束}`，无致命错误（可含 tool isError / policy deny，属 warnings）。
- `FAILED`：最后 message `stopReason:"error"` 且非 abort（errorMessage = provider/infra 错误）。
- `ABORTED`：`stopReason:"error"` + `errorMessage` 含 abort **或** Runtime `abortedByUs` 标志为真（当前需补此标志）。
- 归属：**Pi-owned**：loop、`stopReason`、`errorMessage`、abort signal。**Runtime-owned（建议 FUTURE）**：Execution Status 派生 + `abortedByUs` 标志 + 统一 Error Event。**Derived**：当前状态由 Runtime 侧按上述规则推断（无代码对象）。**Future**：正式 Run State 对象（当 Retry/Timeout/Checkpoint 需要时）。

## 16. Ownership Matrix

| Concern | Pi | Runtime | Tool | Policy | Future |
| --- | --- | --- | --- | --- | --- |
| Agent Loop | ✅ | | | | |
| LLM failure | ✅(检测) | 观测 | | | 分类(Future) |
| Tool failure | ✅(catch→isError) | 观测(Trace) | ✅(throw) | | |
| Policy DENY | ✅(block) | 观测(Trace) | | ✅(决定) | |
| Abort | ✅(signal) | ✅(调用 abort) | | | `abortedByUs` 标志(Future) |
| Run status | 提供原始信号 | **应拥有派生**(Future) | | | 正式 Run State(Future) |
| Final answer | ✅(产出) | 暴露 | | | |
| Business success | | | | | Evaluation(Future) |
| Retry | | (需 Run State) | | | FUTURE |
| Timeout | | (需分层) | | | FUTURE |
| Idempotency | | (需副作用标注) | ✅(自报) | | FUTURE |

## 17. Decision Matrix

| Capability | 当前问题 | 是否阻塞 | 当前决策 |
| --- | --- | --- | --- |
| Run State | 无显式枚举，仅派生 | 否（当前范围） | FUTURE（本 Phase 已钉定模型） |
| Error Classification | abort/FAILED 不可分；Policy 异常不可见；errorMessage 不入 Trace | 否 | FUTURE（统一 Error Event） |
| Cancellation | abort 功能可用，但坍缩为 "error" | 否 | CURRENT（补 `abortedByUs` 标志 → FUTURE） |
| Retry | 无 | 否 | FUTURE |
| Timeout | 无分层 | 否 | FUTURE |
| Idempotency | Runtime 不知副作用 | 否 | FUTURE |
| Checkpoint | 无 | 否 | FUTURE |
| Evaluation | 无（业务成功） | 否 | FUTURE |

## 18. Final Decision

`[DECISION]`
- **Q14** 当前能否可靠判断 completed/failed/aborted？completed=能；failed=基本能（`stopReason:"error"`）；**aborted 不能仅靠 `stopReason` 区分**（需 errorMessage 启发式或 Runtime abort 标志）。另：Policy 异常不可见。
- **Q15** `agent_end` 可作统一 completion signal？**是**（总是触发），但需结合最后 message 派生状态。
- **Q16** `stopReason` 足够作 Run Status？**否**（Tool/Policy 错误不改它；abort 坍缩；`length` 特殊）。
- **Q17** Tool Error = Run Failure？**否**。
- **Q18** Policy DENY = Run Failure？**否**（业务拒绝）。
- **Q19** Abort = Failure？**概念否**；结构上当前不可分。
- **Q20** Final Answer = Success？**否**。
- **Q21** Business Success 属 Runtime？**否**（Evaluation 层）。
- **Q22** Retry/Timeout 需先建正式 Run State？**是**（作为前置契约，可先"派生+文档"，后"对象化"）。
- **Q23** 当前是否值得实现正式 Run State？**否**（单进程/短 Run/Ollama 稳定）。但本 Phase 已将 Execution Status 模型与 Error/Trace 边界钉死，供未来直接复用。

**Decision**：当前 **不实现** Run State / Retry / Timeout / Checkpoint / Error Framework。仅记录模型与 Gap。

## 19. Evidence / Source Table

| 结论 | 文件:行 | 标记 |
| --- | --- | --- |
| Run 三出口均 emit agent_end | `agent.js:342-364`；`agent-loop.js:124-127,154-156` | `[SOURCE]` |
| `stopReason` 仅 Pi 两处写（`error`/`aborted`） | `agent.js:357`；`agent-loop.js:124` | `[SOURCE]` |
| `length` → tool call 标 isError 但 loop 继续 | `agent-loop.js:137-139` | `[SOURCE]` |
| Tool 异常被 catch 转 isError 回灌 loop | `agent-loop.js:452-456,479-483,515-518` | `[SOURCE]` |
| Policy DENY/ASK→DENY → block isError，loop 继续 | `agent-loop.js:426-436`；`policy/adapter.ts:34-44` | `[SOURCE]` |
| abort → AbortController + signal 贯穿 | `agent.js:202`；`agent-loop.js` 多处 | `[SOURCE]` |
| Policy 异常被吞成 tool isError，无 policy 事件 | `agent-loop.js:412-418,452-457`；`policy/adapter.ts:27` | `[SOURCE]` |
| 实验 A 正常：stop="stop", COMPLETED | `scripts/_investigate-8.ts` A | `[EXP]` |
| 实验 B Tool Error：stop="stop", tool isError, COMPLETED | 同上 B | `[EXP]` |
| 实验 C DENY：stop="stop", tool isError, decision deny | 同上 C | `[EXP]` |
| 实验 D ASK→ALLOW/DENY：loop 不变，block 时 isError | 同上 D1/D2 | `[EXP]` |
| 实验 E Abort：stop="error", errorMessage "This operation was aborted" | 同上 E | `[EXP]` |
| 实验 F LLM 失败：stop="error", errorMessage "Connection error." | 同上 F (坏 base url) | `[EXP]` |
| 实验 G Policy 抛错：stop="stop", tool isError, 无 policy 事件 | 同上 G | `[EXP]` |
| Abort 与 FAILED 在 stopReason 上不可分 | §7,§8 | `[DECISION]` |
| Execution≠Business≠Trace 三层分离 | §10 | `[DECISION]` |
| errorMessage 未入 Trace / Policy 异常不可见（Gap） | §12 | `[INFERENCE]` |
| 当前不实现 Run State/Retry/Timeout/Checkpoint | §17,§18 | `[DECISION]` |

---

```text
PHASE 8 INVESTIGATION: COMPLETE

CODE CHANGED: NO

RUN STATE IMPLEMENTED: NO

RETRY IMPLEMENTED: NO

TIMEOUT IMPLEMENTED: NO

CHECKPOINT IMPLEMENTED: NO

NEXT RECOMMENDED STEP:
不实现任何新模块。若下一真实场景进入"多实例/长 Run/网络不稳/需合规审计"，
优先补两件最小、非破坏性的可观测性增强（仍不实现 Run State 对象）：
(1) TraceCollector 记录 message.stopReason + errorMessage（使失败可重建）；
(2) Runtime 在 abort() 时置 abortedByUs 标志，以可靠区分 ABORTED vs FAILED。
这两项是未来 Retry/Timeout/Checkpoint 的前置契约，但当前范围仍非必需。
```
