# Phase 10 — Harness Boundary Investigation

## 1. Executive Summary

**Harness 不需要作为独立模块存在。** 它的职责（包住一次 / 一组顺序 Run 的执行边界）已被 `EnterpriseAiRuntime` 实际承担，且 Pi 自身也有 `runWithLifecycle` 内层边界。只有当未来出现 Session / Retry / Timeout / Checkpoint / Multi-Agent 等多 Run 协调需求时，才值得把"Harness"显式拆出（且形态是 Model A：Runtime 内的子层，非包裹 Runtime）。

```text
PHASE 10 INVESTIGATION: COMPLETE
CODE CHANGED: NO
HARNESS IMPLEMENTED: NO
```

## 2. Harness Definition（严格定义）

> **Harness = 包住一次（或一组顺序）Agent Run 的执行边界协调器**：负责 Run 的进入/退出、统一订阅生命周期事件、把外层控制（abort / timeout / retry）翻译成对 Pi Agent 的信号，并持有该边界内的执行上下文。
> 它不拥有 LLM 推理、Tool 实现、Policy 决策或业务结果——这些分别由 Pi / Tool / Policy 拥有。

（当前该职责已**融合在 `EnterpriseAiRuntime` 内**，不是独立模块。）

## 3. Boundary Diagram

`[SOURCE]`（`runtime.ts:86-94`；`agent.js:226-229, 326-348`；`agent-loop.js:285-363`）

```text
Enterprise (业务 / 调用方)
      ↓
Enterprise Runtime  = 企业控制平面  +  【Harness 职责（当前已融合于此）】
      │     ├─ Policy (beforeToolCall)        ── Control
      │     ├─ Tool Visibility (Registry)     ── Control
      │     ├─ Trace / LLM Trace (subscribe)  ── Observation
      │     ├─ Run entry: run()→agent.prompt  ── Harness: 进入 Run
      │     └─ abort()→agent.abort()          ── Harness: 外层控制
      ↓
Pi Agent Core (Agent Engine)  ── 自带内层边界 runWithLifecycle
      │     ├─ Agent Loop
      │     ├─ LLM Interaction (pi-ai onPayload/onResponse)
      │     ├─ Tool Call Decision / Execution
      │     ├─ Context / Messages (agent.state)
      │     └─ runWithLifecycle (activeRun + AbortController + finishRun)
      ↓
pi-ai
      ↓
Model (Ollama)
```

**Harness 的位置 = Runtime 内部（Model A），不是 Runtime 外层（Model B），也不是横向机制（Model C）。** 因为 `run()` 已经在 Runtime 内对 `agent.prompt()` 做包裹，`subscribe`/`abort` 都在 Runtime 内完成；没有第二层包裹 Runtime 的事实。

## 4. Responsibility Matrix

`[SOURCE]` + `[INF]`。列：Pi / Runtime / Harness / Future。

| Capability | Pi | Runtime | Harness | Future |
| --- | --- | --- | --- | --- |
| Agent Loop | ✅ | | （Runtime 内职责） | |
| LLM | ✅ | 观察(onPayload/Resp) | | |
| Tool Execution | ✅(调用) | ✅(实现) | | |
| Policy | | ✅(beforeToolCall) | | |
| Trace | | ✅(collect) | | |
| Run Lifecycle（外层） | | ✅(run + abort) | ✅=Runtime 内 | |
| Run Lifecycle（内层） | ✅(runWithLifecycle) | | | |
| Retry | | | （Run 级=重跑 run） | ✅(调度器) |
| Timeout | ✅(signal 机制) | (可触发 abort) | | ✅(定时器→abort) |
| Checkpoint | ✅(拥有 state) | (读 state) | | ✅(需 State 所有权) |
| Persistence | | | | ✅(外部 adapter) |
| Evaluation | | (Trace 源) | | ✅(读 Trace 的独立系统) |
| Multi-Agent | | (每 Agent 一实例) | | ✅(协调器) |

> "Harness" 列当前无独立模块——其职责全部落在 Runtime 列。

## 5. Control / Observation / Execution / Governance Map

`[SOURCE]` + `[INF]`

| 维度 | 负责方 | 说明 |
| --- | --- | --- |
| **Execution** | Pi（Agent Engine） | Loop / LLM / Tool 决策与执行 / Context / Run 机制 |
| **Control** | Runtime（正式）+ Pi 钩子（未用） | `beforeToolCall`(block) / `abort` / Tool Set / config；Pi 另提供 `afterToolCall`/`shouldStopAfterTurn`/`prepareNextTurn`(未用) |
| **Observation** | Runtime（Trace） | `agent.subscribe` 事件 + pi-ai `onPayload`/`onResponse`；listener 为 void（只能看不能改） |
| **Governance** | Runtime（当前）= Policy + Tool Visibility + Trace | 审计就绪；Audit/Eval 属 Future |
| **Harness（概念）** | Runtime 内 | 上述 Control/Observation 包住 Execution 的那道边界；当前与 Runtime 融合 |

## 6. Pi 已有 Hook 的角色判定

`[SOURCE]`（`agent.js:98-102, 146-149, 202-204, 226-229`；`runtime.ts:52-61`；`agent-loop.js:285-459`）

| Hook | 类型 | 当前使用 | 备注 |
| --- | --- | --- | --- |
| `prompt(input)` | Entry | Runtime 用（run→prompt） | Run 进入点 |
| `subscribe(listener)` | Observation | Runtime 用（Trace/onEvent） | void listener，不可回改 |
| `beforeToolCall` | Control | Runtime 用（Policy） | block/allow/ask/terminate |
| `abort()` | Control | Runtime 用（abort→agent.abort） | 外层终止整 Run |
| `afterToolCall` | Control(未用) | 否 | 未来可变换 Tool 结果 |
| `shouldStopAfterTurn` | Control(未用) | 否 | 未来每 Turn 终止（max-turns 治理） |
| `prepareNextTurn`/`WithContext` | Control(未用) | 否 | 未来注入/裁剪 context |
| `runWithLifecycle` | Pi 内层边界 | Pi 内部 | activeRun + AbortController |

> 若未来拆出 Harness，上述 `prompt`/`subscribe`/`beforeToolCall`/`abort` 正是 Harness 应适配的 Pi seam；`afterToolCall`/`shouldStopAfterTurn`/`prepareNextTurn` 是未来 Harness 能力（结果变换 / max-turns / context 注入）的可选 seam，**无需改 Pi**。

## 7. 三个概念必须区分

`[DECISION]`

- **Pi Agent Core = Agent Engine**：执行 Agent。拥有 loop / LLM / tool 决策与执行 / context / run 机制。回答"如何产出 token 与调用 tool"。
- **Enterprise Runtime = 企业控制平面**：Policy / Tool Visibility / Trace / Control Points / Run entry / abort。回答"企业规则与可观测性"。
- **Harness = 执行边界协调器（概念）**：进入/退出 Run、统一订阅事件、把外层控制翻译成 Pi 信号、持有边界上下文。当前是 Runtime 内的子职责，**概念上 ≠ Runtime ≠ Agent Engine**。

≠ `"Harness = Runtime = Agent Engine"`。三者边界清晰；只是 Harness 职责当前未独立成模块。

## 8. 生命周期 / 多 Run / 未来能力（架构推断）

`[SOURCE]` + `[EXP]` + `[INF]`

### 8.1 一次 Run 生命周期（已确认）
`Runtime.run()`（collector.startRun）→ `agent.prompt()`（Pi `runWithLifecycle` 设 activeRun+AbortController）→ `runLoop`（多 Turn）→ `streamAssistantResponse`（LLM，pi-ai onPayload）→ `message_end` → `prepareToolCall`(beforeToolCall/Policy) → `tool_execution_*` → `executePreparedToolCall`(Tool) → 回灌 → 下一 Turn → `agent_end`（Pi `finishRun`）→ `Runtime.run()` return。
**入口 = `Runtime.run()`；出口 = `agent_end` + Runtime 派生 Execution Status（Phase 8）。** Policy/Trace 在 Runtime 侧（run 内）；abort 在 Runtime 侧（外层）。

### 8.2 Harness 是否应包住多个 Run？
`[EXP]` 同一 Runtime 顺序跑 Run1 + Run2，单个外层 listener 捕获 2 个 `agent_start`/`agent_end` → **Runtime 已具备顺序多 Run 的外层边界（类 Session）**。
`[SOURCE]` 但 Pi `prompt`/`runWithLifecycle` 均抛错若 `activeRun` 存在 → **Pi 强制单 Run，无并发多 Run**。
⇒ 若未来需"Session 包 Run1/2/3"：顺序模型已可行（Runtime 复用）；并发模型需多 Agent 实例（= Multi-Agent，禁止现在）。Harness 若拆出，应是"顺序多 Run 的包装器"，不是"并发 Run 的调度器"。

### 8.3 Retry 挂哪？
`[INF]` Run 级 Retry = 重用 `Runtime.run()`（外层重跑），即 Harness/Runtime 边界。Tool 级 Retry **当前不可做**（Pi 无 tool-retry hook；`afterToolCall` 未用，未来可借此重试/变换）。Turn 级 Retry 无独立语义（Pi loop 已自动续 Turn）；"重跑某 Turn"= 重 prompt 或重 run。⇒ Retry 属 **Future（Harness/Runtime 层）**，不进 Pi。

### 8.4 Timeout 挂哪？
`[SOURCE]` Pi 把 `AbortController.signal` 一路传到 Tool 执行（`executePreparedToolCall(preparation, signal, emit)` + `signal?.aborted` 检查于 agent-loop.js:321,348,354,368,419,438）。
`[INF]` Run / Turn / Tool 三粒度 Timeout 均**归结为"N ms 后调用 `abort()`"**，底层机制 Pi 已齐备。Timeout 调度器 = **Future（Runtime/Harness 层定时器 → agent.abort()）**，不进 Pi。

### 8.5 Checkpoint 挂哪？
`[INF]` Checkpoint 本质是**State 快照**。State 由 Pi 拥有（`agent.state`：context/messages）。⇒ Checkpoint 需 State 所有权或 Pi 钩子（`prepareNextTurn` 可每 Turn 快照）。当前 Runtime 仅能读 `agent.state.messages`。⇒ Checkpoint = **Future（需 State 所有权 / Pi 钩子）**，Harness 仅协调快照时机；Persistence = 外部 adapter（Future）。

### 8.6 Evaluation 挂哪？
`[INF]` Evaluation 读 Trace 产出业务评价，是**独立系统**，不属于 Harness（Harness = 执行系统，不是评价系统）。⇒ Evaluation = **Future（读 Trace）**，不在 Harness/Runtime 执行链内。

### 8.7 Multi-Agent 挂哪？
`[INF]` 因 Pi Agent 单 Run，Multi-Agent = 每 Agent 一个 Runtime 实例，由**协调器（Future）**管理 N 个 Runtime。模型：多个 Runtime 实例在协调器下，而非单个 Harness 包多个 Agent（避免与"单 Run 边界"冲突）。⇒ Multi-Agent = **Future（禁止现在）**。

## 9. Future Extension Map（只画架构）

```text
Enterprise / Coordinator(Future, Multi-Agent)
      ↓
Runtime ×N (每 Agent 一实例)  ←── Harness 职责（若拆出，在 Runtime 内）
      ├─ Policy / Tool Visibility / Trace / Control Points
      ├─ Run entry / abort
      ├─ Retry(Future): 重跑 run
      ├─ Timeout(Future): 定时器→abort（Pi signal 已到 Tool）
      ├─ Checkpoint(Future): 需 State 所有权 / Pi 钩子
      └─ Persistence(Future): 外部 adapter
      ↓
Pi Agent Core (Agent Engine, 单 Run)
      ↓
pi-ai → Model
      ↓
Evaluation(Future): 读 Trace（独立系统，不在执行链）
```

## 10. Final Decision

```text
HARNESS IS A CONCEPTUAL BOUNDARY, NOT A SEPARATE MODULE YET
```

**为什么概念上需要，但现在不写代码：**
1. `[EXP]` 一次 Run 的完整生命周期已被单个外层 `Runtime.run()` 包装并统一观察；同一 Runtime 已顺序包住多个 Run → "Harness 职责"**已存在于 Runtime**。
2. `[SOURCE]` Pi 自身有 `runWithLifecycle` 内层边界；再加一层独立 Harness 类 = 第三层包裹，纯属**为抽象而抽象**（明确禁止）。
3. `[INF]` 缺失的真实能力（Session 并发 / Retry / Timeout / Checkpoint / Multi-Agent）都属 **Future**，且各自有明确挂载点（见 §8–9），不需要现在预建 Harness 框架。
4. 边界是**真实且须被尊重**的：Runtime 的治理关注（Policy/Trace）不应渗入 Pi；Harness 的边界关注不应渗入 Tool/Policy。但"尊重边界" ≠ "需要独立模块"。

## 11. Acceptance Criteria 自检

```text
PHASE 10 INVESTIGATION: COMPLETE
CODE CHANGED: NO
HARNESS IMPLEMENTED: NO
RETRY IMPLEMENTED: NO
TIMEOUT IMPLEMENTED: NO
CHECKPOINT IMPLEMENTED: NO
PERSISTENCE IMPLEMENTED: NO
MULTI_AGENT IMPLEMENTED: NO
PI MODIFIED: NO
```

**若今天完全不实现 Harness，Enterprise Runtime 是否成立？→ YES。**
原因：`EnterpriseAiRuntime` 已包住 Agent 与每次 Run（`run()`→`agent.prompt` + Trace + Policy + abort），具备 Policy / Tool Visibility / Trace / Control Points / Run entry / abort。Harness-as-module 当前不新增任何能力；其概念边界已被 Runtime 实际承担。未来 Session/Retry/Timeout/Checkpoint/Multi-Agent 为 FUTURE 扩展点，非当前阻塞项。

## 12. Evidence / Source Table

| 结论 | 文件:行 | 标记 |
| --- | --- | --- |
| `run()` 包装 `agent.prompt` + startRun | `runtime.ts:86-94` | `[SOURCE]` |
| `abort()` → `agent.abort()` | `runtime.ts:111-113` | `[SOURCE]` |
| `subscribe` 为观察点（void listener） | `runtime.ts:61,65`；`agent.js:146-149` | `[SOURCE]` |
| Pi `prompt` 单 Run 强制（并发抛错） | `agent.js:226-229` | `[SOURCE]`+`[EXP]` |
| Pi `runWithLifecycle` 内层边界（activeRun+AbortController） | `agent.js:326-348` | `[SOURCE]` |
| signal 传到 Tool 执行 + aborted 检查 | `agent-loop.js:313,363,321,348,354,368,419,438` | `[SOURCE]` |
| beforeToolCall/afterToolCall/shouldStopAfterTurn/prepareNextTurn 钩子 | `agent.js:98-102`；`agent-loop.js:409-459` | `[SOURCE]` |
| 单外层 listener 包住 Run1+Run2（顺序多 Run） | `scripts/_investigate-10.ts` | `[EXP]` |
| 并发 run 抛 "already processing" | 同上 | `[EXP]` |
| Harness 定义 / 三概念区分 / 未来挂载点 | §2,§7,§8 | `[DECISION]`/`[INF]` |
| 最终决策：概念边界，非独立模块 | §10 | `[DECISION]` |

---

```text
PHASE 10 INVESTIGATION: COMPLETE
CODE CHANGED: NO
HARNESS IMPLEMENTED: NO

NEXT STEP (must NOT auto-start):
停止。不进入 Phase 11，不顺手实现 Harness / Retry / Timeout / Checkpoint。
若未来确有 Session / Retry / Timeout / Checkpoint / Multi-Agent 需求，
优先采用 Pi 已提供的钩子（afterToolCall / shouldStopAfterTurn / prepareNextTurn）
与 AbortController.signal 机制，按 §8–9 挂载，无需改 Pi。
```
