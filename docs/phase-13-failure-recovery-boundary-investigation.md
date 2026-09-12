# Phase 13 — Failure Recovery Boundary Investigation

## 1. Executive Summary

**当一次 Agent Run 发生 Failure 时：检测与传播归 Pi（Agent Engine），而"这次失败之后怎么办（Continue / Retry / Abort / Escalate）"的 Run 级恢复决策归 Enterprise Runtime（控制平面）。** Policy 只决定单次 Tool Call 的 Allow/Deny/Ask（控制点，不是恢复），Tool 只决定自身执行成败，Evaluation（未来）只判 Business Outcome。Pi 不应拥有恢复决策——它只负责把一次 Run 执行到完成/中止并交还控制权。

```text
PHASE 13 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RETRY IMPLEMENTED: NO
TIMEOUT IMPLEMENTED: NO
CHECKPOINT IMPLEMENTED: NO
RECOVERY FRAMEWORK IMPLEMENTED: NO
```

## 2. Failure Taxonomy

`[SOURCE]`（agent-loop.js / agent.js）+ `[EXP]`（scripts/_investigate-13.ts，已删除）

| Failure | Detected By | Run Continues? | Run Failure? | Recovery Owner |
| --- | --- | --- | --- | --- |
| **Tool Failure** (execute throws) | Pi（`executePreparedToolCall` catch, agent-loop.js:479-485） | ✅ 转 error ToolResult，LLM 继续 | ❌ 否（除非所有 result `terminate`） | Pi（继续）+ Runtime（未来 Retry 决策） |
| **Tool Failure** (isError result) | Pi（`finalizeExecutedToolCall`） | ✅ | ❌ | 同上 |
| **Policy DENY** | Pi（`prepareToolCall` block, agent-loop.js:426-435） | ✅ Tool 不执行，LLM 继续 | ❌ 否（正常控制流） | Policy（决 DENY）+ Pi（继续） |
| **ASK→DENY** | Pi（同 DENY 路径） | ✅ | ❌ 否（正常控制流） | Policy（审批决 DENY） |
| **Argument/Prep Failure** | Pi（`validateToolArguments`/`tool not found` catch, agent-loop.js:402-408,452-458） | ✅ 转 error result，**execute 之前** | ❌ | Pi（准备阶段） |
| **LLM Failure** (provider/network) | Pi（`streamAssistantResponse` 抛 → `runWithLifecycle` catch → `handleRunFailure`, agent.js:339-365） | ❌ 终止 | ✅ 是（`stopReason="error"`） | Pi（终止）+ Runtime（未来 Retry/Abort 决策） |
| **Abort** | Pi（signal 检查 + `handleRunFailure(aborted)`, agent.js:357） | ❌ 终止 | 视为"主动中止"（语义上非失控 Failure） | Runtime（发起 abort） |
| **Timeout**（未来） | 未来 Runtime/Harness 定时器 | 经 abort 终止 | 同 Abort | Runtime/Harness（`abort()`） |
| **`stopReason==="length"`** | Pi（agent-loop.js:137-138） | ✅ 所有 tool call 标记 error 重发 | ❌ | Pi |

**关键结论**：`Tool Failure ≠ Run Failure`、`Policy DENY ≠ Run Failure`、`Final Answer ≠ Business Success`、`stopReason ≠ 完整 Run Status`（详见 §8）。

## 3. Real Execution Flow（含 Failure Point 标注）

`[SOURCE]`

```text
Runtime.run()                         [Runtime: 入口 + 开 Trace(runId)]
  ↓
Agent.prompt(text)
  ↓
runWithLifecycle(executor)            [Pi: 建 activeRun + AbortController]
  ↓
runLoop()
  ↓
prepareNextTurn? (可选, 未用)         [Pi: 未来可改下一 Turn context]
  ↓
streamAssistantResponse()             ──★ LLM Failure Point
  │  抛异常 → runWithLifecycle catch → handleRunFailure(stopReason="error")
  ↓                                     （Run Failure，agent_end）
LLM Response
  ↓
toolCalls? 
  ├─ NO  → turn_end → agent_end (COMPLETED)
  └─ YES
       ↓
prepareToolCall()                     ──★ Argument/Prep Failure Point (execute 之前)
       ↓ (validateToolArguments / tool-not-found → error result)
beforeToolCall (Runtime Policy)       ──★ Policy DENY / ASK→DENY Point
       ↓ (block → error result, Tool 不执行)
executePreparedToolCall()             ──★ Tool Failure Point (execute throws → catch → error result)
       ↓
afterToolCall? (可选, 未用)           [Pi: 未来可改 result/isError/terminate]
       ↓
tool_execution_end (isError?)
       ↓
append result → next LLM             [★ Tool Failure → 此处 LLM 继续（可自我重发 Tool）]
       ↓
shouldStopAfterTurn? (可选, 未用)     [Pi: 未来 Run 级停止/恢复决策点]
       ↓
agent_end
```

每个 Failure Point 的归属见 §4。

## 4. Failure Ownership Matrix

`[SOURCE]` + `[INF]`

| Layer | Detect | Classify | Decide Recovery | Execute Recovery | Observe |
| --- | --- | --- | --- | --- | --- |
| **Pi** | ✅ 所有执行态 Failure | ✅ 转 error/abort/stop | ⚠️ 仅"继续 Loop"与"Run 终止"（error/abort/shouldStop/all-terminate） | ✅ Loop 继续 / 终止 | ✅ 发事件 |
| **Runtime** | ⚠️ 经 onEvent 观测 | ⚠️ 经 Trace/策略语义 | ✅ **Run 级恢复决策**（Retry/Abort/Escalate） | ✅ 触发 `abort()` / 未来 `run()` 重驱 | ✅ TraceCollector |
| **Policy** | ✅ 单 Tool Call 级 | ✅ allow/deny/ask | ❌ 不决 Run 恢复 | ❌ 只 return block | ❌（异常被吞为 Tool Error，见 §9） |
| **Tool** | ✅ 自身执行 | ✅ isError/terminate | ❌ | ✅ execute | ❌ |
| **Harness**（概念, 在 Runtime 内） | 同 Runtime | 同 Runtime | ✅ 未来 Retry/Timeout 编排宿主 | ✅ 未来 | 同 Runtime |
| **Evaluation**（未来） | ❌ | ✅ Business Outcome | ❌（只判不决） | ❌ | ✅ 读 Trace |

**解释**：
- Pi 拥有"执行态 Failure"的检测/分类/传播，以及两种内置恢复动作：**继续 Loop**（Tool/Prep/Policy 错误转 error result，让 LLM 决定下一步）和**终止 Run**（LLM/Abort 失败、`shouldStopAfterTurn`、所有 result `terminate`）。它**不拥有**跨 Run 的 Retry/Abort 意图决策。
- Runtime 是控制平面，接收已终止的 Run，决定"重跑 / 中止 / 升级人工"。这是 **RECOVERY DECISION OWNER**。
- Policy 是 per-Tool-Call 闸门，看不到整次 Run，故不能做 Run 级恢复决策。
- Tool 只对自己负责。

## 5. Retry Granularity Matrix

`[SOURCE]` + `[INF]`

| Retry Target | Meaning | Risk | Current Pi Support | Future Owner |
| --- | --- | --- | --- | --- |
| **LLM Call** | 仅重发本次 LLM request | 低（未执行 Tool） | ❌ pi-ai 当前不原生重试；可在 `streamFn` 包装层做 | pi-ai / Runtime streamFn 包装 |
| **Tool** | 重跑某 Tool.execute | 高（重复副作用） | ❌ **无 native Tool Retry Hook**（afterToolCall 只能改 result，不能重 execute，agent-loop.js:491-525） | Runtime/Harness（重驱或重 prompt）；Tool 自身幂等 |
| **Turn** | 重跑整 Turn（LLM+Tools） | 高（已执行 Tool 重复副作用） | ❌ | Runtime/Harness |
| **Run** | 重新 `Runtime.run()` | 高（transcript 已变，Tool 可能重发） | ⚠️ 现有 `run()` 可重调，但无去重/幂等保护 | Runtime/Harness（需 idempotency/checkpoint） |
| **Agent Execution** | 等同 Run Retry（本架构 1 Agent=1 Run） | 同 Run | ⚠️ | Runtime/Harness |

**注意**：即使**没有 Runtime Retry**，实验 Exp1 已证明 LLM 会在同一次 Run 内**自我重发 Tool**（2× `tool_execution_end`）。因此幂等性问题在"无 Retry"时也存在 → 工具幂等是独立于 Retry 的底线要求。

## 6. Failure → Recovery Decision Map

`[INF]` + `[EXP]`

```text
Tool Failure (isError)
   ↓ Can Agent continue?
   ├── YES → Pi 继续 Loop（LLM 看到 error，或自我重发 Tool）   [EXP: Exp1]
   └── 模型放弃 → Final Answer → agent_end(COMPLETED)
        ↓ Business Outcome 由 Evaluation 判（可能 FAILED）      [§8]

Policy DENY / ASK→DENY
   ↓ Tool 不执行，error result 回 LLM
   → Pi 继续 Loop → agent_end(COMPLETED)                       [EXP: Exp2/Exp3]
   （这不是 Failure，无恢复决策）

LLM Failure
   ↓ Pi 终止 Run → agent_end(stopReason="error")
   → Runtime 收 Run，做 Recovery Decision:
        ├── Retry?（未来，需幂等/Checkpoint）
        ├── Abort?（已终止，无意义）
        └── Escalate?（人工/告警，未来）

Abort / Timeout
   ↓ Pi 终止 Run（stopReason 见 §9 区分问题）
   → Runtime 已知是自己发起（若主动 abort）→ 无需 Recovery
```

## 7. Retry Safety / Idempotency

`[EXP]`（Exp6/Exp7）+ `[INF]`

- **`toolCallId` 是否足够解决重复执行？** ❌ **不足**。实验 Exp7：两次 Run 的 `toolCallId` 不同（`call_pubslpu1…` vs `call_sdq61vyc…`）——Retry 会触发**新的 LLM 调用 → 新的 toolCallId**，旧 id 不能去重。
- **什么情况下会重复执行？** 任何"重新驱动"路径：`run()` 重跑（Exp6：`sideEffectCounter` 2→4→6）、Turn 重跑、甚至**同 Run 内 LLM 自我重发 Tool**（Exp1：单 Run 内 2 次 execute）。
- **哪些 Tool 可以自动 Retry？** 只读 / 幂等 / 显式标记 `idempotent` 的 Tool。
- **哪些不应自动 Retry？** 有副作用且非幂等的 Tool（`create_order` 类）——否则双单。
- **未来需要什么机制？** `Idempotency Key` / `Business Transaction ID` / `External Deduplication` / `Persistence`（见 Phase 12）；以及 Runtime 在触发 Retry 前对 Tool 做幂等性判定（可复用 Tool Registry 的元数据）。

## 8. Execution vs Business Outcome

`[INF]` + `[EXP]`

| 维度 | 谁定义 | 当前系统能力 |
| --- | --- | --- |
| **Execution Outcome** | Pi（`stopReason`："stop"=完成 / "error"=失败 / "aborted"=中止） | ✅ 可观测（`agent_end` message.stopReason） |
| **Business Outcome** | **无系统定义**；应由 Runtime/Evaluation 从 Trace（Tool 结果 + final answer）判断 | ❌ 当前无；例：Tool 失败、LLM 说"无法创建订单"→ Execution=COMPLETED，Business=FAILED |
| **Trace** | Runtime（观察态） | ⚠️ 记录 events/llmCalls/finalAnswer，但**不记录 stopReason/errorMessage**（见 §9） |

**要点**：`stopReason` ≠ Business Outcome。一个 Run 可 Execution COMPLETED 而 Business FAILED。Business Outcome 判断是 **Evaluation（未来）** 的职责，且必须基于 Trace，不能基于 stopReason。

## 9. Trace Observability Gaps（重验 Phase 8）

`[SOURCE]`（collector.ts）+ `[EXP]`

1. **`errorMessage` / `stopReason` 未进 Trace**：`TraceCollector.observe` 不抽取 `agent_end` message 的 `stopReason`/`errorMessage`（collector.ts:84-108）。运行时可经 `onEvent` 观测，但 Trace 不持久化 → 未来 Evaluation 无法直接读 Run 状态。
2. **Policy Hook 异常被吞为 Tool Error**：`prepareToolCall` 的 `try/catch`（agent-loop.js:452-458）把 Policy/校验异常转成通用 error ToolResult → Trace 只见 `tool_execution_end.isError`，**无"policy_exception"语义**。
3. **★ 本 Phase 新增发现 — Abort 与 LLM Failure 不可靠区分**：实验 Exp4 vs Exp5 二者均 `stopReason="error"`，仅靠 `errorMessage` 自由文本区分（"Connection error." vs "This operation was aborted"）。这与 `agent.js:357` 的 `aborted?"aborted":"error"` 源码暗示**不符**——本构建下实验为权威：实际均表现为 `"error"`。

**Fix Now? or Future?** → **FUTURE（最小 Observability Gap，不现在重构 Trace）**。理由：① 本 Phase 禁止改 Runtime/Trace；② 修复是加字段而非改架构；③ 即便修，`errorMessage` 自由文本仍不可靠。推荐未来最小动作：在 `ExecutionTrace` 增加 `stopReason`+`errorMessage` 字段、增加显式 `policy_error` 事件、并让 Runtime 把"自己发起的 abort 意图"写入 Run Context/Trace（因为 Pi 不保证标记）。**现在不实现。**

## 10. Recovery Boundary Decision

`[DECISION]`

```text
RECOVERY DECISION OWNER = Enterprise Runtime（控制平面）
```

| 层 | 拥有 |
| --- | --- |
| **Pi** | 执行态 Failure 检测/分类/传播；Loop 继续；Run 终止（error/abort/shouldStop/all-terminate）。**不拥有**跨 Run 恢复决策。 |
| **Runtime** | Run 级恢复决策（Retry/Abort/Escalate）；Policy 注入；abort 发起；Tool 注册/可见性；Trace。 |
| **Policy** | 单 Tool Call 的 Allow/Deny/Ask 控制点。**不拥有** Run 恢复。 |
| **Harness**（概念, 在 Runtime 内） | 未来 Retry/Timeout 的编排宿主（重驱 `run()` / `abort()` 定时器）。 |
| **Tool** | 自身执行成败 + `isError`/`terminate`。 |
| **Evaluation**（未来） | Business Outcome 判断（读 Trace），不决执行。 |

**为什么 Recovery Decision 不应塞进 Pi？**
- Pi 的职责是"把一次 Run 执行到完成/中止并交还控制权"。注入企业级 Retry/升级/跨 Run 逻辑，会把控制平面关注耦合进 Agent Engine，破坏 Phase 9/10 已确认的边界。
- Pi 无 Business Outcome 概念、无跨 Run 状态、无企业上下文（user/session/approval queue），无法正确做"是否该 Retry 这笔订单"。

**为什么 Recovery Decision 不应塞进 Policy？**
- Policy 是 per-Tool-Call 闸门（allow/deny/ask），视野仅限单次调用，看不到整次 Run 的成败链路，无法决定 Run 级 Retry。
- 实验 §9.2 证明：Policy/校验异常会被 Pi 吞成通用 Tool Error → 让 Policy 承担恢复会进一步丢失语义。

## 11. Future Boundary（仅列，不实现）

`[INF]`（延续 Phase 10/11/12）

| 能力 | 挂载点 | 依赖 |
| --- | --- | --- |
| **Retry** | Runtime/Harness：重驱 `run()` 或重 prompt | 工具幂等性（Registry 元数据）/ Checkpoint / Persistence；`toolCallId` 不足 |
| **Timeout** | Runtime/Harness 定时器 → `agent.abort()` | 底层 signal 已齐备；需 Runtime 自记"timeout 意图"以区分 Abort（§9.3） |
| **Checkpoint** | Pi `messages` + Runtime `runId` 的外部投影 | 不移动 `agent.state` |
| **Persistence** | 外部 adapter，读 Pi `messages` | 不夺 Pi 所有权 |
| **Evaluation** | 未来层，读 Trace 判 Business Outcome | 需 §9 的 Trace 增强（stopReason/errorMessage） |

## 12. Acceptance Criteria 自检

```text
PHASE 13 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RETRY IMPLEMENTED: NO
TIMEOUT IMPLEMENTED: NO
CHECKPOINT IMPLEMENTED: NO
PERSISTENCE IMPLEMENTED: NO
RECOVERY FRAMEWORK IMPLEMENTED: NO
ERROR_MANAGER IMPLEMENTED: NO
FAILURE_MANAGER IMPLEMENTED: NO
STATE_MANAGER IMPLEMENTED: NO
PI MODIFIED: NO
RUNTIME NOT REFACTORED: YES
```

**若今天完全不实现 Retry/Recovery，Enterprise Runtime 是否仍成立？→ YES。** Failure 检测/传播已由 Pi 正确完成并暴露为 `agent_end` 事件与 `stopReason`/`errorMessage`；Runtime 已能观测全部 Failure（onEvent/Trace）并执行唯一已实现的恢复动作 `abort()`。Run 级 Retry/升级是 Future 控制平面扩展，非当前阻塞。唯一需记录的是 §9 的 Observability Gap（stopReason/errorMessage/policy_error 未入 Trace），列为 Future 最小增强，不现在实现。

## 13. Evidence / Source Table

| 结论 | 位置 | 标记 |
| --- | --- | --- |
| Tool throw → catch → error result，Loop 继续 | agent-loop.js:479-485, 142-147 | `[SOURCE]` |
| 所有 result `terminate` 才终止 batch | agent-loop.js:384-386 | `[SOURCE]` |
| Policy DENY → block → error result，Tool 不执行 | agent-loop.js:426-435 | `[SOURCE]` |
| Argument/Prep failure 在 execute 之前 | agent-loop.js:402-408, 452-458 | `[SOURCE]` |
| LLM Failure → handleRunFailure(stopReason error) | agent.js:339-365, 357 | `[SOURCE]` |
| hooks 接线：beforeToolCall/afterToolCall/shouldStopAfterTurn/prepareNextTurn 均存在，仅 beforeToolCall 被 Runtime 用 | agent-loop.js:412,494,154,90 | `[SOURCE]` |
| `stopReason==="length"` 全 tool 标 error | agent-loop.js:137-138 | `[SOURCE]` |
| toolCallId 来自 LLM 生成，Run 内稳定 | agent-loop.js:266,299,535,544 | `[SOURCE]` |
| Exp1 Tool throws → run 继续 + LLM 自我重发 Tool(2× isError) | scripts/_investigate-13.ts | `[EXP]` |
| Exp2/3 DENY/ASK→DENY → Tool 不执行(counter 不变)，run 完成 | 同上 | `[EXP]` |
| Exp6 Retry → sideEffectCounter 2→4→6（重复副作用） | 同上 | `[EXP]` |
| Exp7 toolCallId 跨 Run 不同（非去重键） | 同上 | `[EXP]` |
| Exp4 LLM Failure → stop="error", err="Connection error." | 同上 | `[EXP]` |
| Exp5 Abort → stop="error", err="This operation was aborted"（与 LLM Failure 不可靠区分） | 同上 | `[EXP]` |
| `errorMessage`/`stopReason` 未进 Trace | collector.ts:84-108 | `[SOURCE]` |
| Recovery Decision Owner = Runtime；不塞 Pi/Policy | §4,§10 | `[DECISION]`/`[INF]` |

---

```text
PHASE 13 INVESTIGATION: COMPLETE
CODE CHANGED: NO

NEXT STEP (must NOT auto-start):
停止。不进入 Phase 14，不顺手实现 Retry / Timeout / Checkpoint / Persistence /
Recovery Framework / ErrorManager / FailureManager / StateManager。
若未来实现 Retry：仅在 Runtime/Harness 层重驱 run()，并对 Tool 做幂等性判定
（Registry 元数据）+ Checkpoint/Persistence；禁止把恢复逻辑塞进 Pi 或 Policy。
若未来修 §9 Observability Gap：最小增强 ExecutionTrace（stopReason/errorMessage）
+ policy_error 事件 + Runtime 自记 abort 意图，不重构 Trace 架构。
```
