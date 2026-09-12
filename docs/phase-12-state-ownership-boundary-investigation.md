# Phase 12 — State Ownership Boundary Investigation

## 1. Executive Summary

**State Ownership 边界不是"全归 Runtime"也不是"全归 Pi"，而是按角色划分：**
- **Pi（Agent Engine）拥有执行态**：`messages` / `tools`(执行副本) / `model` / `systemPrompt` / `thinkingLevel` / 瞬态字段 / `activeRun` / `AbortController` 生命周期。
- **Runtime（企业控制平面）拥有控制态**：`ToolRegistry`(注册/可见性) / `policy` / `TraceCollector`(runId/trace) / `agent` 引用 / Run entry / abort 决策。
- **共享态（tools / signal / runId）经既有 seam 桥接**，不移动 `agent.state`、不抽 `StateManager`。
- **Session 当前 = `agent.state.messages` 的隐式累积**（本版本 Pi 无 `sessionId` 字段，更正 Phase 11）；**Trace 是 Runtime 拥有的观察态**，与执行态正交。

```text
PHASE 12 INVESTIGATION: COMPLETE
CODE CHANGED: NO
STATE_MANAGER IMPLEMENTED: NO
```

> **更正（Phase 11）**：在已安装的 `pi-agent-core/dist` 全量搜索 `sessionId` 返回 0 结果 —— 本版本 Pi **不存在独立 `sessionId` 字段**。Phase 11 文档中"Pi `sessionId` 仅转发 LLM 缓存"的论断不成立，特此纠正。当前 Session 完全是 `agent.state.messages` 的隐式累积。

## 2. 什么叫 State Ownership

`[DECISION]`

> **谁拥有某个 State = 谁负责它的（1）生命周期、（2）修改权、（3）恢复方式、（4）未来持久化责任。**

边界不可仅按"模块"划分，须按"角色"划分：执行态归 Agent Engine，控制态归控制平面，二者通过受约束的桥接 seam 交互。

## 3. State 全量分类

`[SOURCE]` + `[EXP]`（在用户给定分类基础上，新增 **Control Handle / Bridged** 两类，因源码证明存在跨层共享态）

| State | 类别 | 拥有方 | 跨 Run | 跨 Agent 实例 |
| --- | --- | --- | --- | --- |
| `messages` | Session / Agent Instance | Pi | ✅ 累积 | ❌ 各实例独立 |
| `tools`(执行副本) | Agent Instance / Bridged | Pi 持有，Runtime 是源 | ✅ | ❌ |
| `model` | Configuration / Agent Instance | Pi 持有，Runtime 配置 | ✅ | ❌ |
| `systemPrompt` | Configuration / Agent Instance | Pi 持有，Runtime 配置 | ✅ | ❌ |
| `thinkingLevel` | Configuration / Agent Instance | Pi 持有，Runtime 配置 | ✅ | ❌ |
| `isStreaming` | Run State / Transient | Pi | ❌ 每 Run 复位 | ❌ |
| `streamingMessage` | Run State / Transient | Pi | ❌ | ❌ |
| `pendingToolCalls` | Run State / Transient | Pi | ❌ | ❌ |
| `errorMessage` | Run State / Transient | Pi | ❌ | ❌ |
| `activeRun` | Run State / Control Handle | Pi | ❌ | ❌ |
| `AbortController`/`signal` | Run State / Control Handle / Bridged | Pi 创建，Runtime 触发 abort | ❌ | ❌ |
| `runId` | Run State / Trace State / Bridged | **Runtime**（TraceCollector） | ❌ | ❌ |
| `TraceCollector.current`/events/llmCalls/finalAnswer | Trace State / Derived | **Runtime** | ❌ | ❌ |
| `ToolRegistry`(注册/可见性) | Runtime State / Bridged | **Runtime** | ✅ | ❌ |
| `policy`(fn) | Runtime State / Configuration | **Runtime** | ✅ | ❌ |
| `agent` 引用 | Runtime State | **Runtime** | ✅ | ❌ |

> 新增类别说明：**Control Handle**（signal/activeRun/runId，随单次 Run 产生消亡，承载控制/标识）；**Bridged**（tools/runId/signal，跨越 Pi↔Runtime 两侧、各有单方面权威）。原 8 类不足以表达这两类共享态，故扩充。

## 4. Agent State 深查（10 问）

`[SOURCE]`（agent.js:26-49, 214-225, 326-372）+ `[EXP]`

| # | 问题 | 答案（以字段分组） |
| --- | --- | --- |
| 1 | 谁创建？ | Pi `createMutableAgentState(initialState)`（agent.js:26）；`initialState` 由 Runtime 经 `new Agent({initialState})` 注入 |
| 2 | 谁修改？ | Pi（loop 在 `message_end` push `messages`；设瞬态字段）。Runtime **仅经受约束 seam** 重设 `tools`（`registerTool`→`agent.state.tools=...`，runtime.ts:77） |
| 3 | 谁读取？ | Pi（loop/tool 查找）；Runtime（`transcript()`/`listTools()`/`policy`/`visibility`）；TraceCollector（事件）；未来 Evaluation |
| 4 | 生命周期？ | per-Agent-实例；`messages` 跨 Run；瞬态字段每 Run 复位（`finishRun` 不清 messages，agent.js:366-372） |
| 5 | 跨 Run？ | `messages`/`tools`/`model`/`systemPrompt`/`thinkingLevel` ✅；瞬态/`activeRun` ❌（`[EXP]` 4→6 条消息；tools 跨 Run 不变） |
| 6 | 跨 Agent 实例？ | 全部 ❌（每实例 `createMutableAgentState` 独立；`tools` 经 `.slice()` 复制，agent.js:27） |
| 7 | Runtime 可安全修改？ | 仅 `tools`（经 `registerTool` seam）；`messages`/`model`/`systemPrompt`/`thinkingLevel` 不应由 Runtime 改（属 Pi 对话/配置域）；瞬态字段永不 |
| 8 | 适合 Persistence？ | `messages` ✅（首要）；配置类（model/tools/systemPrompt）为配置持久化（低优先）；瞬态/`activeRun` ❌ |
| 9 | 适合 Checkpoint？ | `messages` ✅（+ runId 对齐点）；瞬态 ❌ |
| 10 | 适合 Session？ | `messages` = 当前唯一的隐式 Session 态；其余为实例配置 |

**逐字段判定（不可笼统说"都是 Agent State"）：**
- `messages` → **Session 级 Agent State**（Pi 拥有，跨 Run，可持久化/Checkpoint）。
- `tools`(执行副本) → **Agent Instance State + Bridged**（Pi 持有执行副本；Runtime Registry 是源）。
- `model`/`systemPrompt`/`thinkingLevel` → **Agent Instance Configuration**（Runtime 配置，Pi 持有实例）。
- `isStreaming`/`streamingMessage`/`pendingToolCalls`/`errorMessage` → **per-Run Transient**（Pi 私有执行标志）。
- `activeRun`/`AbortController` → **per-Run Control Handle**（Pi 创建，Runtime 触发 abort）。

## 5. 实验结果

`[EXP]`（`scripts/_investigate-12.ts`，已删除）

**Experiment A — 跨 Run（单 Runtime）**
```
init:  msgs=0, tools=get_customer
run1:  runId=…, msgs=4, stream=false, tools=get_customer
run2:  runId=…, msgs=6, stream=false, tools=get_customer
reset: msgs=0, tools=get_customer
A1 runId per-Run (不同):           true
A2 messages 跨 Run 累积(Session级): true  (4->6)
A3 isStreaming 每 Run 复位(transient): true
A4 tools 跨 Run+跨 reset 保留(实例配置): true
A5 reset 清 messages 留 tools:      true
```

**Experiment B — 新 Agent 实例**
```
rtA tools: get_customer,get_customer_v2   (仅 rtA 注册了 v2)
rtB tools: get_customer
rtA msgs after reset: 0 ; rtB msgs: 4 (不受影响)
B1 tools 不跨实例共享(rtB 无 v2): true
B2 messages 不跨实例共享(reset rtA 不影响 rtB): true
```
⇒ **State 是 per-Agent-实例（= per-Runtime-实例）的；不存在跨实例共享的 Session；两个 Agent 不共享 messages/tools。**

## 6. State Ownership Boundary（谁拥有、生命周期/修改/恢复/持久化）

`[DECISION]` + `[SOURCE]`

### 6.1 Pi 拥有（Agent Engine / 执行态）
- **生命周期**：Pi 创建（`createMutableAgentState`）、Pi 修改（loop）、Pi 恢复（自身 loop / `reset()`）。
- **修改权**：独享。Runtime 仅经 `registerTool` seam 重设 `tools`，经 `abort()` seam 触发 Pi 自有 abort。
- **恢复**：Pi `reset()` 清 messages+瞬态（agent.js:214-225）；`finishRun` 复位瞬态。
- **持久化责任**：`messages` 是未来 Persistence 的主对象；但**触发持久化的决策不属 Pi**。

### 6.2 Runtime 拥有（企业控制平面 / 控制态）
- **ToolRegistry**：注册/可见性源（`registry.ts`）。生命周期=Runtime 实例；修改=Runtime；持久化=配置级。
- **policy**：构造时设定，无可变状态（当前为纯函数）；若未来有可变策略态（限流计数等），归 Runtime。
- **TraceCollector / runId / trace**：观察态，每 Run 由 `startRun` 生成 runId，随 `agent_end` 收口（collector.ts:51-109）。纯净观察，只读。
- **`agent` 引用 / Run entry / abort 决策**：Runtime 决定何时 `run()`、何时 `abort()`。

### 6.3 Bridged（共享态，各有单方面权威）
- **tools**：Runtime Registry = *注册/可见性*权威；Pi = *执行*权威。桥 = `registerTool` 重设 `agent.state.tools`。
- **signal / abort**：Pi = `AbortController` 创建与传播权威；Runtime = *何时 abort* 决策权威。桥 = `Runtime.abort()`→`agent.abort()`。
- **runId**：Runtime = *创建/记录*权威；Pi 不感知 runId。桥 = TraceCollector 的 `current` 与 Pi `activeRun` 在同一 `agent_end` 收口。

## 7. Session / Run / Trace 归属

`[DECISION]`
- **Session**：当前无 Session 对象；隐式 = `agent.state.messages` 累积（同实例跨 Run）。未来若需显式 Session（跨多个 Agent 实例、携带 user 身份/runIds 列表），它应作为**新层**持有"对 Agent 实例的引用 + 元数据"，**不夺走 Pi 对 messages 的所有权**。
- **Run**：边界由 Pi `activeRun`(signal) + Runtime `runId`(trace) 协同界定（见 Phase 11）。Run State = 上述 per-Run 档（activeRun/signal/isStreaming/瞬态/runId/trace）。
- **Trace**：Runtime 拥有的观察态，事后只读，与执行态正交。

## 8. 未来能力对 State Ownership 的影响

`[INF]`

| 能力 | 谁该持有相关 State | 备注 |
| --- | --- | --- |
| **Persistence** | `messages`→Persistence Adapter（读 Pi，不夺所有权）；`ToolRegistry`/`policy` 配置→Runtime | Pi 仍拥有 messages；Adapter 只负责落盘/恢复 |
| **Checkpoint** | 关联键 = `runId`（Runtime）；快照对象 = `messages`（Pi） | Checkpoint 是"Pi 态 + Run 标识"的外部投影，不移动 agent.state |
| **Snapshot** | 同 Checkpoint；外部只读投影 | 禁止移入 Runtime 内部 |
| **Recovery** | 由 Persistence 提供 messages → 重建 Agent 实例（新 Runtime）；Pi 不负责恢复 | 恢复 = 新建实例并注水，非修改运行中 agent.state |
| **Retry** | 新 Run Context（新 runId）；messages 复用（Pi 自然累积） | Retry 不夺 Pi 所有权 |
| **Timeout** | `signal`（Pi 创建，Runtime 触发 abort） | 已齐备 |
| **Multi-Agent** | 每 Agent 一个 Runtime 实例 → 各自独立 State（实验 B 已证不共享） | 协调器持有 runIds，不共享 messages/tools |

**核心原则**：所有未来能力均**不移动 `agent.state`、不抽 `StateManager`、不重构 Runtime**。Persistence/Checkpoint 以"外部投影 + 重建"方式工作，Pi 继续独占执行态。

## 9. Final Decision

```text
STATE OWNERSHIP BOUNDARY IS ESTABLISHED BY ROLE, NOT BY MODULE.
NO STATE MANAGER / STATE STORE REQUIRED YET.
```

**为什么不需要现在实现 StateManager：**
1. `[EXP]`+`[SOURCE]` 归属已清晰：Pi 独占执行态，Runtime 独占控制态，共享态经 3 个 seam（registerTool / abort / runId-trace 对齐）桥接。
2. 边界**已被当前代码尊重**（Runtime 不 mutate messages；仅经 seam 改 tools；abort 经 Pi）。
3. 缺的仅是"外部持久化/Checkpoint"——它们应作为**外部投影**工作，不需要内部 StateManager。
4. 抽 `StateManager` / 移动 `agent.state` = 违反禁止项 + 为未来抽象。

## 10. Acceptance Criteria 自检

```text
PHASE 12 INVESTIGATION: COMPLETE
CODE CHANGED: NO
STATE_MANAGER IMPLEMENTED: NO
STATE_STORE IMPLEMENTED: NO
SESSION_STORE IMPLEMENTED: NO
PERSISTENCE IMPLEMENTED: NO
CHECKPOINT IMPLEMENTED: NO
SNAPSHOT IMPLEMENTED: NO
RECOVERY IMPLEMENTED: NO
agent.state NOT MOVED
RUNTIME NOT REFACTORED
PI MODIFIED: NO
```

**若今天完全不实现 StateManager/Persistence，Enterprise Runtime 是否成立？→ YES。** State 归属已由角色清晰划分并被代码尊重；缺失项（Persistence/Checkpoint）属 Future 外部投影，非当前阻塞。

## 11. Evidence / Source Table

| 结论 | 位置 | 标记 |
| --- | --- | --- |
| `agent.state` 字段（systemPrompt/model/thinkingLevel/tools/messages/瞬态） | `agent.js:26-49` | `[SOURCE]` |
| `tools`/`messages` setter 经 `.slice()` 复制（独立实例） | `agent.js:27,36-44` | `[SOURCE]` |
| `finishRun` 仅复位瞬态，不清 messages/tools | `agent.js:366-372` | `[SOURCE]` |
| `reset()` 清 messages+瞬态，保留 tools/model/systemPrompt | `agent.js:214-225` | `[SOURCE]` |
| `activeRun={promise,resolve,abortController}` per-Run | `agent.js:335` | `[SOURCE]` |
| `runWithLifecycle` 每 Run `new AbortController()` | `agent.js:330` | `[SOURCE]` |
| `runId=randomUUID()`/seq 每 Run 复位，随 agent_end 收口 | `collector.ts:51-109` | `[SOURCE]` |
| Runtime `registerTool` 重设 `agent.state.tools`（Bridged seam） | `runtime.ts:75-78` | `[SOURCE]` |
| Runtime `abort()`→`agent.abort()`（Bridged seam） | `runtime.ts:111-113` | `[SOURCE]` |
| `ToolRegistry` 每 Runtime 实例私有（不跨实例共享） | `registry.ts:11,13` | `[SOURCE]` |
| 全量 `sessionId` 搜索 = 0（**更正 Phase 11**） | `pi-agent-core/dist` grep | `[SOURCE]` |
| 实验 A：runId 每 Run 异 / messages 跨 Run / tools 跨 Run+reset / reset 清 messages | `scripts/_investigate-12.ts` | `[EXP]` |
| 实验 B：tools/messages 不跨 Agent 实例共享 | `scripts/_investigate-12.ts` | `[EXP]` |
| 归属按角色划分 / 不抽 StateManager | §2,§6,§9 | `[DECISION]`/`[INF]` |

---

```text
PHASE 12 INVESTIGATION: COMPLETE
CODE CHANGED: NO

NEXT STEP (must NOT auto-start):
停止。不进入 Phase 13，不顺手实现 StateManager / StateStore / SessionStore /
Persistence / Checkpoint / Snapshot / Recovery / Retry / Timeout / Multi-Agent。
未来 Persistence/Checkpoint 若实现，须作为"Pi 执行态 + Runtime runId"的外部投影，
不得移动 agent.state、不得重构 Runtime、不得改 Pi。
```
