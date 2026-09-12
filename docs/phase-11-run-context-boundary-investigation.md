# Phase 11 — Run Context Boundary Investigation

## 1. Executive Summary

**Enterprise Runtime 当前没有一个显式的 `RunContext` 对象，但 Run Context 作为"概念边界"已经隐式存在且横跨 Pi 与 Runtime 两侧。** 它的数据被分散持有：`runId`/Trace/Prompt 在 Runtime 侧，AbortController/signal 在 Pi 的 `activeRun` 侧。Agent State（Pi `agent.state`）混入了 Session 级与 Agent 实例级数据，不能等同为 Run Context。结论：**Run Context 最小语义边界 = 一次 Run 执行期间的边界标识 + 控制句柄 + 观测句柄（runId, signal/AbortController, prompt, 指向该 Run 的 Trace），不含跨 Run 的 messages/tools/model/systemPrompt（属 Agent State / Session），也不含事后记录（属 Trace）。**

```text
PHASE 11 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RUNCONTEXT IMPLEMENTED: NO
```

## 2. 六个概念严格区分

`[SOURCE]` + `[EXP]` + `[DECISION]`

| 概念 | 是什么 | 拥有方 | 生命周期 |
| --- | --- | --- | --- |
| **User** | 发起交互的外部调用方（Enterprise 身份/权限） | 调用方（未来 Auth） | 跨一切 |
| **Session** | 连续逻辑交互上下文 | 当前 = Pi `agent.state.messages` 累积（隐式）；Pi `sessionId` 仅用于 LLM 缓存 | 跨多个 Run（同 Agent 实例） |
| **Run** | 一次 Agent 执行（agent_start…agent_end） | Pi `activeRun` + Runtime `run()` | 单次 |
| **Run Context** | 一次 Run 的边界标识+控制/观测句柄 | 隐式横跨 Pi(`activeRun`/signal) 与 Runtime(runId/Trace/prompt) | 单次 |
| **Agent State** | Pi `agent.state`（messages/tools/model/systemPrompt/isStreaming/…） | Pi | 实例级；其中 messages 跨 Run，瞬态字段每 Run 复位 |
| **Trace** | 该 Run 发生了什么（runId/events/llmCalls/finalAnswer） | Runtime `TraceCollector`（观察、只读、事后） | 单次，事后可查 |

> **不要假设 §3 的树形图一定正确。** 通过源码验证后修正为：Pi 没有"Session 对象"，Session 是 `agent.state.messages` 的隐式累积；Run 的边界由 Pi `activeRun`（signal）与 Runtime `runId`（Trace）共同界定，二者**不在一个对象里**。

## 3. 当前 Runtime.run() 调查

`[SOURCE]`（`runtime.ts:86-124`；`collector.ts:51-109`；`agent.js:226-372`）

| 信息 | 属于 | 证据 |
| --- | --- | --- |
| `runId` | **Run Context / Trace** | `collector.startRun` 生成 `randomUUID()`（collector.ts:54），`seq` 每 Run 复位 |
| `agent`（实例） | **Agent State（实例级）** | `runtime.ts:43` 构造时创建一次，跨 Run 复用 |
| `agent.state.messages` | **Session（跨 Run）/ Agent State** | `finishRun` 不清 messages（agent.js:366-372）；`[EXP]` Run2 见 Run1 的 messages（4→6） |
| `agent.state.tools/model/systemPrompt` | **Agent State（实例级配置）** | `createMutableAgentState` 闭包持有（agent.js:26-49）；`reset()` 也不清 tools/model |
| `collector` | **Trace（Runtime）** | `runtime.ts:33`，`current/last` 每 Run 切换 |
| `policy` | **Runtime（跨 Run 配置）** | `runtime.ts:41`，构造时设定，每 Tool Call 调用 |
| `tools`（registry） | **Runtime（跨 Run 配置）** | `runtime.ts:39`，同步进 `agent.state.tools` |
| `signal`/`AbortController` | **Run Context（Pi 侧）** | `runWithLifecycle` 每 Run `new AbortController()`（agent.js:330,335） |
| `prompt` | **Run Context（入口）** | `run()` 传 `text` → `agent.prompt(text)`（runtime.ts:91-93） |
| `finalAnswer` | **Trace** | `collector.observe` 从 `message_end` 文本写入（collector.ts:100-103）；`agent_end` 关闭 trace |
| `stopReason`/`errorMessage` | **Agent State（瞬态）/ Trace（部分）** | `activeRun`/事件携带；当前 `ExecutionTrace` 未显式落 stopReason（观测缺口，非本 Phase 修复） |

**结论**：`run()` 生命周期内"只在 Run 内存在"的是 `runId`+`signal`+`prompt`+`current` trace；跨 Run 保存的是 `agent.state.messages/tools/model/systemPrompt`+`policy`+`registry`。**Run Context 不是一个对象，而是一组分散在两处、随单次 Run 产生/消亡的边界信息。**

## 4. Run Context 是否"隐式存在"？

`[SOURCE]` + `[EXP]`

**是，隐式存在且由两类载体共同承担：**

1. **Pi 侧**：`activeRun = { promise, resolve, abortController }`（agent.js:335）。这是 Pi 的 per-Run 载体，持有 `AbortController`（signal）→ 即 Run Context 的**控制句柄**。它本身不含 runId/prompt/policy/trace。
2. **Runtime 侧**：`TraceCollector.current`（collector.ts:53）= `{ runId, startedAt, prompt, events[], llmCalls[], finalAnswer }` + 入参 `prompt` + 传入 `agent.prompt` 的闭包。这是 Run Context 的**标识 + 观测句柄**。

二者经 `agent_end` 对齐：`activeRun` 在 `finishRun` 置 `undefined`（agent.js:371），`current` 在 `observe(agent_end)` 切到 `last`（collector.ts:104-107）——**同一 Run 的两边边界在同一时刻结束**。这证明一次 Run 的边界是由 Pi `activeRun` 与 Runtime `TraceCollector.current` 协同界定的，即"隐式 Run Context"横跨两层。

> 这与 Phase 10 结论一致：Harness/Runtime 边界是**概念边界**，已融合在代码中；Run Context 同理——概念上成立，物理上是分散对象。

## 5. Run Context vs Agent State（最关键）

`[SOURCE]`（`agent.js:26-49, 214-225, 366-372`）+ `[EXP]`

Pi `agent.state` 实际包含**三层不同生命周期**的数据，混在一起：

| 字段 | 生命周期档 | 是否属于 Run Context |
| --- | --- | --- |
| `messages` | **Session 级**（跨 Run 累积，finishRun 不清） | ❌ 否 → 属 Session / Agent State |
| `tools` | **Agent 实例级配置**（跨 Run、连 `reset()` 都不清） | ❌ 否 → 属 Agent State |
| `model` | **Agent 实例级配置** | ❌ 否 → 属 Agent State |
| `systemPrompt` | **Agent 实例级配置** | ❌ 否 → 属 Agent State |
| `isStreaming` | **per-Run 瞬态**（finishRun 复位） | ⚠️ 是 Run 内瞬态，但它是 Pi 私有标志 |
| `streamingMessage` | **per-Run 瞬态** | ⚠️ 同上 |
| `pendingToolCalls` | **per-Run 瞬态** | ⚠️ 同上 |
| `errorMessage` | **per-Run 瞬态** | ⚠️ 同上 |

**为什么不能把 `messages/tools/model/systemPrompt` 全叫 Run Context？**
- `messages` 跨 Run 保留（`[EXP]` Run2 基于 Run1 的 4 条消息继续 → 6 条），它是 Session 级上下文，不是单次 Run 的边界。
- `tools/model/systemPrompt` 是 Agent 实例配置，连 `reset()` 都清不掉（agent.js:214-225 只清 messages/瞬态），属"这台 Agent 是什么"而非"这次 Run 是什么"。
- 只有 `isStreaming/streamingMessage/pendingToolCalls/errorMessage` 是真正的 per-Run 瞬态，但它们是 Pi 内部执行标志，不构成企业侧 Run Context。

⇒ **Agent State ⊃ {Session 级数据 + Agent 实例级配置 + per-Run 瞬态}。Run Context 只取"本次 Run 的边界标识与控制/观测句柄"，与 Agent State 正交。**

## 6. Run Context vs Trace

`[SOURCE]`（collector.ts:51-109）

| 维度 | Run Context | Trace |
| --- | --- | --- |
| 角色 | 执行**期间**的边界载体（驱动 Run 的"门禁"） | 执行**之后**的记录（发生了什么） |
| 可变？ | 是（`signal` 可被 `abort()` 置 aborted） | 否（观察、只读、事后） |
| 关键纽带 | `runId` 是 Run Context 的标识 | `runId` 是 Trace 的主键 |
| 拥有方 | 横跨 Pi(signal)+Runtime(runId/prompt) | Runtime `TraceCollector`（观察侧） |

二者通过 `runId` 关联：Run Context 是"活的边界"，Trace 是"死的记录"，`runId` 是 join key。**区别明确：Trace 不驱动执行，Run Context 不记录历史（它只持有指向 Trace 的句柄）。**

## 7. 谁创建 / 持有 / 修改 Run Context

`[INF]`（基于 §3–4 源码）

- **创建**：`Runtime.run()` 触发两件事 —— Runtime 侧 `collector.startRun(prompt)` 生成 `runId`+`current`；Pi 侧 `agent.prompt()`→`runWithLifecycle` 生成 `activeRun`+`AbortController`。**Run Context 由 Runtime 与 Pi 协同创建，分属两侧。**
- **持有**：`runId`/`prompt`/`Trace` 由 Runtime 持有（`collector`/`runtime`）；`signal`/`activeRun` 由 Pi 持有（`agent`）。
- **修改**：Runtime 写 `runId`/`events`；Pi 写 `signal.aborted`（经 `abort()`）、管理 `activeRun` 生命周期；Policy 改 per-Tool-Call 子集（见 §8）；Tool 只读 Agent-State 上下文。

## 8. Policy / Tool / Trace 是否应读 Run Context

`[SOURCE]` + `[INF]`

- **Policy**：当前 `evaluatePolicy(policy, ctx)` 的 `ctx` 是 `BeforeToolCallContext`（adapter.ts:23），即 **Agent State 的 per-Tool-Call 子集**（toolCall + currentContext），**不携带 `runId`/`signal`**。⇒ 当前 Policy 读的是 Agent State 上下文，不是 Run Context。若未来需要"按 runId 的限流/审计策略"，Run Context 必须注入 Policy。**现在不需要。**
- **Tool**：工具经 `prepareToolCall` 收到 `context: currentContext`（AgentContext：messages/tools/model…），**不含 `runId`**（agent-loop.js:400-419）。⇒ Tool 读 Agent State 上下文，不读 Run Context。符合边界：Tool 只关心"当前上下文能调什么"。
- **Trace**：`TraceCollector` 自己生成 `runId` 并记录事件 —— **它就是 Run Context 观测侧的实现**。Trace 不"读"Run Context，它"是"Run Context 的记录投影。

## 9. 未来能力对 Run Context 的依赖

`[INF]`

| 能力 | 是否依赖 Run Context | 关系 |
| --- | --- | --- |
| **Retry** | 是 | 需以 runId 标识"重跑哪次 Run"；Retry = 新建 Run Context（新 runId）重驱 `run()`，或复用 signal 语义 |
| **Timeout** | 是（底层已齐备） | 需 Run Context 的 `signal`/`AbortController`（agent.js:330,335）做"N ms 后 abort"；Pi 已把 signal 传到 Tool（agent-loop.js:313,363） |
| **Checkpoint** | 是 | 需把"某执行点"关联到 `runId` 并快照 Agent State（messages）；Run Context 提供 runId 关联键 |
| **Persistence** | 是（join key） | 持久化 Trace + Agent State 时，`runId` 是关联主键；Run Context 不必持久化自身，只需可被重建 |
| **Evaluation** | 间接 | 读 Trace（含 runId）即可，不需直接持 Run Context |
| **Multi-Agent** | 是 | 每 Agent 一个 Runtime 实例 → 每实例一套 Run Context；协调器以 runId 关联跨 Agent 轨迹 |

## 10. Run Context 最小语义边界（定义）

`[DECISION]`

> **Run Context = 一次 Run 执行期间，由 Runtime/Harness 持有、用于界定该次执行边界并支撑控制与观测的最小可变状态集合：`runId`（标识）、`AbortController`/`signal`（控制句柄）、`prompt`（入口）、指向该 Run 的 `Trace` 句柄，以及可选的 per-Tool-Call 上下文。它不含跨 Run 的 `messages`/`tools`/`model`/`systemPrompt`（属 Agent State / Session），也不含事后记录（属 Trace）。**

当前该集合**物理上分散**于 Pi `activeRun`（signal）与 Runtime `TraceCollector.current`（runId/prompt/trace）之间——概念成立，非单一对象。

## 11. Final Decision

```text
RUN CONTEXT IS A CONCEPTUAL BOUNDARY, NOT A SEPARATE OBJECT YET
```

**为什么概念上需要、现在不写代码：**
1. `[EXP]`+`[SOURCE]` Run Context 已是隐式事实：Pi `activeRun`(signal) 与 Runtime `runId`(Trace) 协同界定单次 Run 边界，二者同步起止。
2. `[SOURCE]` Agent State 混入 Session 级与实例级数据，**不能直接当 Run Context**；若未来要显式隔离"本次 Run 的边界信息"，才值得抽 `RunContext`——但那应伴随 Retry/Timeout/Checkpoint 一起，而非现在。
3. 当前所有已确认能力（Policy/Tool/Trace/abort）都能在"隐式 Run Context"下正确工作；无阻塞项。
4. 抽 `RunContext` 现在 = 为抽象而抽象（禁止）。

## 12. Acceptance Criteria 自检

```text
PHASE 11 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RUNCONTEXT IMPLEMENTED: NO
RETRY IMPLEMENTED: NO
TIMEOUT IMPLEMENTED: NO
CHECKPOINT IMPLEMENTED: NO
PERSISTENCE IMPLEMENTED: NO
SESSION IMPLEMENTED: NO
MULTI_AGENT IMPLEMENTED: NO
PI MODIFIED: NO
```

**若今天完全不实现 RunContext，Enterprise Runtime 是否成立？→ YES。** Run Context 已隐式存在（Pi `activeRun` + Runtime `runId`/Trace）；缺失项（显式 RunContext 对象）属 Future，且仅在 Retry/Timeout/Checkpoint 出现时才有抽取价值，非当前阻塞。

## 13. Evidence / Source Table

| 结论 | 位置 | 标记 |
| --- | --- | --- |
| `createMutableAgentState`：messages/tools/model/systemPrompt 闭包持久；瞬态字段分离 | `agent.js:26-49` | `[SOURCE]` |
| `finishRun` 不清 messages/tools（仅复位瞬态）→ 跨 Run | `agent.js:366-372` | `[SOURCE]` |
| `reset()` 不清 tools/model/systemPrompt | `agent.js:214-225` | `[SOURCE]` |
| `activeRun={promise,resolve,abortController}` per-Run 载体 | `agent.js:335` | `[SOURCE]` |
| `sessionId` 仅转发 LLM 缓存（非企业 Session） | `agent.js:103-104` | `[SOURCE]` |
| `runId=randomUUID()`/seq 每 Run 复位，Trace 随 agent_end 关闭 | `collector.ts:51-109` | `[SOURCE]` |
| Policy 收 `BeforeToolCallContext`（Agent State 子集，无 runId） | `adapter.ts:23` | `[SOURCE]` |
| Tool 收 `context: currentContext`（无 runId） | `agent-loop.js:400-419` | `[SOURCE]` |
| signal 传到 Tool 执行（abort 机制） | `agent-loop.js:313,363,321,348,354,368` | `[SOURCE]` |
| runId 每 Run 不同 / messages 跨 Run 累积 / isStreaming 每 Run 复位 | `scripts/_investigate-11.ts` | `[EXP]` |
| Pi 自带 `harness/`（coding-agent，非本 Runtime 范围） | `node_modules/.../harness/*` | `[SOURCE]` |
| Run Context 定义 / 三概念区分 / 未来依赖 | §2,§10,§9 | `[DECISION]`/`[INF]` |

---

```text
PHASE 11 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RUNCONTEXT IMPLEMENTED: NO

NEXT STEP (must NOT auto-start):
停止。不进入 Phase 12，不顺手实现 RunContext / Session / Retry / Timeout / Checkpoint。
若未来需抽 RunContext：随 Retry/Timeout/Checkpoint 一起，将 Pi activeRun(signal)
与 Runtime collector.current(runId/prompt/trace) 收敛为一个显式边界对象；
不要为抽象提前抽。
```
