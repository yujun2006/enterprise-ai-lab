# Phase 27-B — Public API + Business Client Design Gate

> 目标：让一个 Business Client 通过**稳定、最小的 Public API** 调用 `EnterpriseAiRuntime`，
> 并获得**明确的 RunResult**。审计 + 设计 + 实现 + acceptance。`CODE CHANGED: YES`
> （仅新增/收敛 Public API，未引入 Phase 27-B 禁止的 Manager / SDK / REST / Workflow / Skill /
> Workspace / Provider 等子系统）。
>
> 标签：`[SOURCE]` 代码证据，`[EXP]` 实验/acceptance 证据，`[INF]` 架构推断。

---

## 1. Current API Audit

### 1.1 哪些已被 Business Client 实际使用？

新 `BusinessClient`（`scripts/phase27b-business-client.ts`）只用到：

```text
EnterpriseAiRuntime (构造 + run + abort + getSessionId)
AgentTool / Policy / RunResult / RunStatus / RunError (类型)
Model (仅测试注入 ScriptedModel)
```

`[EXP]` acceptance 四用例全部经此路径跑通。

### 1.2 哪些只是内部实现却被 export 出去了？

`src/index.ts` 当前还导出（供 Phase 20/25/26 实验/acceptance 复用，但**非稳定 Public Contract**）：

```text
ollamaModel / createOllamaRuntimeDeps        (Provider 装配；配置内部)
ToolRegistry                                 (Runtime 目录；Business 用 registerTool)
TraceCollector / formatTrace                 (collector 内部；Business 用 lastTrace)
evaluatePolicy                               (Policy 适配器内部；Business 提供 Policy)
decideRecovery / RecoveryStore / FileRecoveryStore (Recovery 决策/存储内部)
RecoveryResult / ReconcileFn / 各 Recovery 类型   (recover() 返回/入参)
```

这些保留是为了不破坏既有 regression（Phase 20/25/26 脚本直接 import 它们），但它们**不是**
Business-facing 契约。收敛决策见 §9。

### 1.3 `EnterpriseAiRuntime` 当前真正稳定的输入？

```text
RuntimeOptions = { systemPrompt?, tools?, policy?, model?, streamFn?, store?, sessionId? }
```

`run(text)` 的真正稳定输入是**一个 prompt 字符串**；Skill 不是 `run()` 的参数，而是通过
`systemPrompt + tools + policy` 的组合（Phase 27-A §6：`runtime.run({skill})` 不需要）。

### 1.4 为什么 `run(text): Promise<void>` 不适合做最终 Business API？

- 返回 `void` → Business Client 拿不到「这次 Run 到底成功/失败/中止」，**必须**回头读
  `lastTrace()` / `transcript()`，违反「提交任务 → 获得结果」的心智模型。
- `void` 无法表达 Phase 8 的 failure semantics（Final Answer ≠ Success；abort ≠ LLM failure）。
- 真实调用链 `LLM → Tool → Policy → Tool Result → LLM → Result` 需要一个**结构化终点**。

### 1.5 Business Client 最少需要知道哪些概念？

```text
Runtime（构造） / Task（run 的入参）/ RunResult（run 的返回）/ Tool / Policy / Session id
```

### 1.6 Business Client 不应直接知道（明确禁止泄漏）

```text
Pi Agent / Agent State / ToolRegistry / TraceCollector / Policy evaluator
RecoveryStore / Provider / streamFunction / beforeToolCall / afterToolCall / runLoop
```

`[SOURCE]` `BusinessClient` 仅调用 `new EnterpriseAiRuntime(...)` / `run` / `abort` / `getSessionId`；
不 import 任何 Pi 内部类型（除测试注入的 `Model`/`StreamFn` 类型）。

---

## 2. Business Client Use Case

```text
Business Client
   │  new EnterpriseAiRuntime({ tools, policy, model, systemPrompt })
   ▼
   │  const result = await client.execute("Find customer Alice")
   ▼
EnterpriseAiRuntime.run(task)
   │  → Pi Agent → LLM → Tool Call → Policy(ALLOW) → Tool Exec → Tool Result → LLM → Stop
   ▼
RunResult { status, answer, sessionId, runId, trace?, error? }
   │
   ▼
Business Client 直接拿到结构化结果，无需理解 Pi 内部
```

`BusinessClient` 只做四件事：构造 Runtime、`execute(task)`、`abort()`、读 `sessionId`。
`[EXP]` 见 `scripts/phase27b-business-client.ts` + `scripts/phase27b-acceptance.ts`。

---

## 3. Public / Internal Boundary

| Concept | Public (Business-facing) | Internal (Runtime/Pi) |
| --- | --- | --- |
| Runtime | `EnterpriseAiRuntime` + `run`/`abort`/`getSessionId`/`registerTool`/`listTools`/`onEvent`/`lastTrace`/`transcript` | `makeAgent`/`reconstructAgent`/`beforeToolCall`/`afterToolCall`/`captureCheckpoint` |
| Run | `run()` 返回 `RunResult`；`runId` 在 `RunResult` 内 | `currentRunId`/`currentPrompt` 私有 |
| Result | `RunResult` / `RunStatus` / `RunError` | `collector` 内部状态 |
| Tool | `AgentTool`（Business 提供） | `ToolRegistry`（目录）、`AgentTool.execute`（Pi 执行） |
| Policy | `Policy` 函数（Business 提供） | `evaluatePolicy`（适配器）、`beforeToolCall` 控制点 |
| Trace | `lastTrace()` / `transcript()`（读） | `TraceCollector`（`observe` 内部） |
| Recovery | `recover()` / `resume()`（生命周期入口） | `decideRecovery`、Checkpoint 写、store 协调 |
| Session | `getSessionId()` | `sessionId` 持久身份 |
| Provider | —（env 配置） | `createProvider` / `openAICompletionsApi` / pi-ai catalog |
| Pi Agent | — | `Agent` loop / `agent.state` / `streamFn` |

**BOUNDARY CLEAN**：`EnterpriseAiRuntime` 的公共方法不暴露 `agent.state`、`activeRun`、
`AbortController`、`streamFunction`、`runLoop`、`prepareToolCall`、`executePreparedToolCall`。

---

## 4. Run Input Contract

```ts
async run(text: string): Promise<RunResult>
```

- 输入：**单个 prompt 字符串**（任务描述）。不接收 `skill` 对象、不接收 tool 列表（tools 在
  构造时给定）、不接收 policy（构造时给定）。
- 一次 `run()` = 一次 Run（volatile `runId`）。Session 跨多次 `run()` 稳定（同 `sessionId`）。
- 与 Phase 27-A 一致：Skill 是 `systemPrompt + tools + policy` 的组合约定，不是 `run()` 的参数。

---

## 5. RunResult Contract

```ts
export type RunStatus = "completed" | "failed" | "aborted" | "unknown";

export interface RunError {
  code: "llm_error" | "aborted" | "unknown";
  message: string;            // 脱敏：不含原始异常/堆栈
}

export interface RunResult {
  status: RunStatus;          // 执行生命周期状态（≠ 业务成功）
  answer?: string;            // 最终 Assistant 回答（若有）
  sessionId: string;          // 稳定 Session 身份
  runId: string;              // 本次 Run 的 volatile id
  trace?: ExecutionTrace;     // 只读观测模型（不持有 Pi 对象）
  error?: RunError;           // 仅 failed/aborted/unknown 时存在
}
```

`[SOURCE]` `src/runtime.ts`：`RunResult`/`RunStatus`/`RunError` 新增并自 `src/index.ts` 导出。
`ExecutionTrace` 新增 `stopReason?` / `errorMessage?` 字段（用于推断 status，见 §6）。

设计取舍（不照抄 brief 的结构，基于真实生命周期）：

- **status 是执行状态，不是业务成功**：有 `answer` 也可能 `status !== "completed"`（e.g. 被中止）。
- **包含 `trace?`**：Business 常需 observability；`ExecutionTrace` 已是干净只读模型，不含 Pi 内部对象。
  同时保留 `lastTrace()` 方法，二者等价（trace 即本次 lastTrace）。

---

## 6. Error / Failure Semantics

依据 Phase 8（Final Answer ≠ Success；agent_end ≠ 成功）与 Phase 17–21（Recovery ≠ RunResult）：

| 真实情况 | Pi 信号 | `RunResult.status` |
| --- | --- | --- |
| Run 正常结束且有回答 | 最终 assistant `stopReason="completed"` | `completed` |
| 调用方 `abort()` | `aborted=true` 标志 **或** `stopReason="aborted"` | `aborted` |
| LLM/stream 抛错（未编码为 stopReason） | `prompt()` reject | `failed`（`error.code="llm_error"`） |
| 最终 assistant `stopReason="error"` | — | `failed` |
| 无法确定结果（无 agent_end/stopReason） | — | `unknown`（**绝不**标 `failed`） |

关键约束：

- **UNKNOWN ≠ FAILED**：无法确定时给 `unknown`，避免误判（Phase 8）。
- **abort ≠ LLM failure**：二者 Pi 都可能给 `error` 态，但 Runtime 用 `this.aborted` 标志区分
  （`abort()` 置位），`aborted` 单独成状态。
- **Tool Failure 不终止 Run**：Tool 返回 `isError` 结果时，Pi 把它作为普通 Tool Result 回给 LLM，
  Run 仍 `completed`；错误只体现在 `trace`（`tool_execution_end.result.isError=true`），**不**泄漏为
  RunResult.error（无内部异常/堆栈）。`[EXP]` Case C。
- **Policy DENY 不终止 Run**：Tool 被阻挡（合成 error ToolResult，真实 `execute` 不调用），Run 仍
  `completed`；deny 只体现在 `trace`（`policy_decision`）。`[EXP]` Case B。
- **Recovery 不是 RunResult**：`recover()` 返回独立的 `RecoveryResult`，走单独生命周期入口；RunResult
  不表示恢复结果（Phase 20/21）。

`[SOURCE]` `src/runtime.ts:buildRunResult()`：依据 `collector.lastTrace().stopReason` + `this.aborted`
推导 status，并对 `failed/aborted/unknown` 填充脱敏 `error`。

`[CORRECTION]` 实现中发现 Pi 的 `tool_execution_end` 事件**顶层** `isError` 在「Tool 返回 isError 结果
但未抛异常」时为 `false`，真正错误位在 `result.isError`（agent-loop.js：`createErrorToolResult` 仅用于
catch 路径）。acceptance 据此读 `result.isError`，避免误判。

---

## 7. Trace Exposure Decision

- **暴露**：`RunResult.trace?`（本次 `ExecutionTrace`）+ `lastTrace()` / `transcript()` / `onEvent()`。
- **不暴露**：`TraceCollector` 实例、`observe*` 方法、Pi 事件对象本身。
- `ExecutionTrace` = 只读观测模型（`runId/prompt/events/llmCalls/finalAnswer/stopReason`）；不含 Pi
  对象、不含 Agent State 引用。`[SOURCE]` `src/trace/types.ts`。
- `Trace ≠ Checkpoint ≠ Audit`：Checkpoint 由 Runtime 内部写；Audit（业务审计轨迹）未实现、非本阶段范围。

---

## 8. Recovery Exposure Decision

- `recover(sessionId, reconcile)` / `resume(sessionId)` **保留为公开生命周期入口**（advanced）。
- `recover()` 返回的 `RecoveryResult` 是独立类型，**不是** `RunResult`。
- Recovery **决策**（`decideRecovery`）、Checkpoint 写（`captureCheckpoint`）、store 协调均为
  Runtime 内部，Business 不直接调用。
- `RunResult` 不承载恢复语义（Phase 17–21）。

---

## 9. Export Surface Decision

**Stable Public（冻结契约，新增）**：

```text
EnterpriseAiRuntime
AgentTool / EnterpriseTool          (Tool 契约)
Policy / PolicyDecision             (Policy 契约)
RunResult / RunStatus / RunError    (Run 结果契约)
ExecutionTrace / TraceEvent / LlmCallTrace   (Trace 只读模型)
```

**Internal（为测试/实验复用而 export，非稳定契约，Phase 27-C 可进一步收敛）**：

```text
ToolRegistry, TraceCollector, formatTrace, evaluatePolicy,
decideRecovery, FileRecoveryStore, RecoveryStore, RecoveryResult 及 Recovery 子类型,
ollamaModel, createOllamaRuntimeDeps
```

决策：**保留** internal 导出以维持 Phase 20/25/26 regression 可编译（不破坏既有实验），但在本文档
明确标记其非稳定契约。不新增任何 `*Manager` / `Client` 包装类（「能由 EnterpriseAiRuntime 完成的事
不要创建 Manager」）。

---

## 10. Backward Compatibility Decision

- **`run()` 签名**：`Promise<void>` → `Promise<RunResult>`。这是**加性变更**——既有调用
  `await runtime.run(...)` 忽略返回值，全部兼容。`[EXP]` Phase 20/25 acceptance 未改动即 PASS。
- **`prompt()`**：保持 `Promise<void>`（更底层入口；`run()` 内部调用它）。
- **新增导出**：`RunResult`/`RunStatus`/`RunError` 自 `index.ts` 导出（附加，无破坏）。
- **既有 acceptance 修改**：无。仅新增 `scripts/phase27b-*.ts` 与 `package.json` 的
  `acceptance:phase27b` 脚本。`src/` 变更仅 `runtime.ts`（RunResult + stopReason 标志）、
  `trace/types.ts`（`stopReason`/`errorMessage` 字段）、`trace/collector.ts`（捕获二者）、
  `index.ts`（导出类型）。
- 不为了兼容旧实验造复杂 adapter。

---

## 11. Acceptance Criteria

`scripts/phase27b-acceptance.ts`（离线，ScriptedModel，无需 Ollama）：

| Case | 场景 | 断言 | 结果 |
| --- | --- | --- | --- |
| A | Normal Run | `status=completed`；`answer` 含 "Alice"；`sessionId` 匹配；`trace` 存在；`get_customer` 成功执行；无 `error` | PASS |
| B | Policy DENY | `status=completed`；`get_customer` **无成功执行**（被阻挡）；`policy_decision=deny` 可见；有 `answer` | PASS |
| C | Tool Failure | `status=completed`；`unreliable_lookup` 执行且 `result.isError=true`；`error` 未泄漏内部异常；有 `answer` | PASS |
| D | Abort | 调用 `abort()` 后 `status=aborted`；`error.code="aborted"` | PASS |

`[EXP]` 结果：`=== Phase 27-B acceptance: 17 passed, 0 failed ===`（4 用例 × 多断言）。

覆盖的完整调用链：
`Business Client → Public API → EnterpriseAiRuntime → Pi Agent → LLM → Tool Call → Policy →
Tool Execution → Tool Result → LLM → RunResult → Business Client`。

---

## 12. STOP Condition

```text
1. Business Client 可调用 Runtime                  ✓ (BusinessClient.execute)
2. Business Client 不依赖 Pi 内部                  ✓ (仅 Public API)
3. Runtime 返回明确结构化结果                      ✓ (RunResult)
4. Tool / Policy / Trace / Recovery 边界未破坏      ✓ (见 §3/§7/§8；regression 绿)
5. 正常 Run PASS                                   ✓ Case A
6. Policy DENY PASS                                ✓ Case B
7. Tool Failure PASS                               ✓ Case C
8. Typecheck PASS                                  ✓
9. Regression PASS                                  ✓ Phase 20/25/27-B
```

**ALL MET → STOP.**

---

## Verification

```text
TYPECHECK:              PASS  (tsc --noEmit)
PHASE 27-B ACCEPTANCE:  PASS  (17 passed, 0 failed)
REGRESSION:
  acceptance:phase20   PASS  (failures=0)
  phase25 experiment   PASS  (skill slice completed)
  phase26              (experiment-only, 需真实 Ollama；由 phase20/25/27b 设计覆盖，未离线重跑)
CODE SEMANTICS:        UNCHANGED (仅增加 RunResult 返回值 + trace stopReason 捕获)
```

---

## Final Report

```text
PHASE 27-B RESULT

CODE CHANGED: YES (Public API only)

DOCUMENTS:
docs/phase-27b-public-api-design-gate.md

PUBLIC API:
EnterpriseAiRuntime.run(text): Promise<RunResult>
RunResult { status, answer?, sessionId, runId, trace?, error? }
RunStatus = completed | failed | aborted | unknown
BusinessClient.execute(task): Promise<RunResult>

BUSINESS CLIENT:
scripts/phase27b-business-client.ts (仅用 Public API)

RUN RESULT:
status=completed|failed|aborted|unknown；Final Answer≠Success；UNKNOWN≠FAILED；
abort≠LLM failure（aborted 标志区分）；Tool/Policy 失败不终止 Run

EXPORT CHANGES:
+ RunResult / RunStatus / RunError (稳定 Public)
  内部导出（ToolRegistry/TraceCollector/evaluatePolicy/decideRecovery/...）保留复用，标记非稳定契约

ACCEPTANCE:
scripts/phase27b-acceptance.ts — 17 passed, 0 failed (Cases A/B/C/D)

TYPECHECK:
PASS

REGRESSION:
PASS (phase20 + phase25 + phase27b)

ARCHITECTURE DECISION:
冻结 Public 契约 = EnterpriseAiRuntime + Tool + Policy + RunResult + Trace(read) + Recovery 入口。
run() 返回结构化 RunResult；不泄漏 Pi 内部；未新增任何 Manager/SDK/REST/Workflow/Skill/Workspace/Provider。

P0:
NONE
P1:
(同 Phase 27-A：生产持久化 OQ-3 / 升级通道 OQ-2 / 超时语义 OQ-4 — 不变)
P2:
(同 Phase 27-A：workflow checkpoint / Audit / 大上下文装配 — 不变)

NEXT:
Phase 27-C / STOP（Product Delivery：npm/HTTP/Docker/Auth/SaaS 等均不在此阶段）
STOP.
```
