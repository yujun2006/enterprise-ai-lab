# Phase 9 — Enterprise Agent Execution Boundary Investigation

## 1. Executive Summary

本 Phase 只调查并建模：**Enterprise Runtime 与 Pi Agent Core 之间的责任边界、观察点、控制点、生命周期边界**。不实现任何新功能。

核心结论（先给）：

- **真实调用链（源码确认）**：`Runtime.run()` → `agent.prompt()` → `runWithLifecycle` + `runLoop`（多 Turn）→ `streamAssistantResponse`（LLM）→ `prepareToolCall`（含 `beforeToolCall`/Policy）→ `executePreparedToolCall`（Tool）→ 回灌 → 下一 Turn → `agent_end`。
- **Observation（观察）≠ Control（控制）**：Runtime 通过事件（Layer 3）**只能看，不能改**；`onEvent` 是 `void`，无回写。`[SOURCE]`
- **Runtime 的正式 Control Point 只有两个**：`beforeToolCall`（Policy：ALLOW/ASK/DENY/terminate）与 `abort()`（终止整 Run）。`[SOURCE]`
- **Pi 暴露了更多未使用的控制钩子**：`afterToolCall`、`shouldStopAfterTurn`、`prepareNextTurn`/`prepareNextTurnWithContext`（均 `agent.js:98-102,300-310`）——当前 Runtime **未使用**。它们是 Pi 提供的合法控制面，未来可声明但不修改 Pi。
- **Policy 严格位于 Tool Execution 之前**（实验证实 `policy_decision` 事件先于 `tool_execution_start`）；Policy 只能 **block/allow/ask**，**不能修改 tool 参数或结果**。
- **四层边界模型**稳定：Layer 1 Execution（Pi） / Layer 2 Control（Runtime 控制面） / Layer 3 Observation（Trace） / Layer 4 Governance（Policy + Tool Visibility + 未来 Audit/Eval）。
- **Runtime CANNOT**：决定 LLM 推理、强制 Tool 选择、修改 Pi Loop、修改 tool 参数/结果（via 已用控制点）、恢复已 abort 的 Run、持久化 Run。
- **决策**：边界已清晰且稳定，**当前不需要任何新能力**。仅记录未使用的 Pi 控制钩子作为未来可选控制面。

```text
PHASE 9 INVESTIGATION: COMPLETE
CODE CHANGED: NO
```

## 2. Current Architecture Recap（调用链）

`[SOURCE]`（`runtime.ts` / `agent.js` / `agent-loop.js` / `model.ts`）

```text
User Prompt
   ↓
EnterpriseAiRuntime.run(text)        ── Runtime 入口；collector.startRun
   ↓
Agent.prompt(text)                   ── Pi（runtime.ts:87）
   ↓
runPromptMessages → runWithLifecycle ── Pi（agent.js:326）；设 activeRun/isStreaming
   ↓
runLoop(currentContext, …)          ── Pi（agent-loop.js:66-170）；多 Turn
   ↓
turn_start
   ↓
streamAssistantResponse(...)         ── Pi（agent-loop.js:120-251）；经 pi-ai streamFn
   │    └─ pi-ai onPayload / onResponse  ── LLM 请求/响应观察（model.ts:87-93）
   ↓
message_start/update/end             ── assistant message（可能含 tool_calls）
   ↓
if tool_calls:
   prepareToolCall(ctx, …)           ── Pi（agent-loop.js:409-459）
      ├─ beforeToolCall(ctx)         ── ★ Control Point：Enterprise Policy
      │     └─ evaluatePolicy → allow/ask/deny/terminate（policy/adapter.ts）
      ├─ tool_execution_start        ── 观察
      ├─ executePreparedToolCall      ── Pi 调用 tool.execute（Tool 属 Enterprise 实现）
      └─ tool_execution_end(isError) ── 观察
   tool result 回灌 → 下一 Turn
   ↓
turn_end
   ↓
（循环，直到 LLM 停止 / shouldStopAfterTurn / abort / error）
   ↓
agent_end                            ── Run 结束信号（总是触发）
   ↓
Runtime Outcome（Execution Status 派生，见 Phase 8）
```

## 3. Agent Execution Timeline（真实事件顺序）

`[EXPERIMENT]`（Phase 9 时间线 dump，`scripts/_investigate-9.ts`，已删）

ALLOW 一次 tool-calling Run 的真实 `onEvent` 顺序：

```text
agent_start
turn_start
message_start → message_end          (用户 prompt 回显)
message_start → message_update* → message_end   (assistant，含 tool_calls, stopReason=toolUse)
tool_execution_start → tool_execution_end        (tool 执行；Policy 已先于此评估)
message_start → message_end          (tool result 消息)
turn_end
turn_start
message_start → message_update* → message_end   (final answer, stopReason=stop)
turn_end
agent_end
```

DENY（Policy 拦截）额外在 Trace 中出现：`policy_decision:deny` → `policy_resolved:undefined`，且 `tool_execution_start/end` **仍触发**（但 `isError:true`，tool 实现未执行）。⇒ **Policy Control Point 位于 Tool Execution 之前**，且只能 block 不能改参/改结果。

## 4. Stage Ownership Matrix

`[SOURCE]` + `[DECISION]` 区分 **Own（拥有/负责）** vs **Observe（仅观察）**。

| Stage | Pi | Runtime | LLM | Tool | Policy | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| Prompt intake | 处理 | **入口 API** | | | | Runtime 提供 `run/prompt`；Pi 处理 |
| Context assembly | **组装** | 提供初始 config（tools/systemPrompt/model） | | | | Pi `createContextSnapshot`（`agent.js:280`） |
| LLM request | **发起** | 观察(onPayload) | **生成** | | | Runtime 不发起 LLM |
| LLM response | **消费流** | 观察(onResponse) | **生成** | | | |
| Tool Call decision | **决策**(LLM 选) | 不可强制 | 决定 | | | Runtime 不能强制选 tool |
| Policy decision | 调用 | 转接 | | | **决定** | `beforeToolCall`→Policy（`runtime.ts:52`） |
| Tool execution | **调用** `.execute` | **拥有实现** | | **执行** | | Tool impl 属 Enterprise（`registry.ts`） |
| Tool result | 消费 | 观察(Trace) | | **返回** | | |
| Next LLM | **编排** | — | | | | loop 属 Pi |
| Run termination | **决定**(loop/error) | 可强制(abort/shouldStopAfterTurn) | | | | |
| Execution outcome | 产生 stopReason | **派生** Execution Status | | | | Phase 8 模型 |

## 5. Observation Points（观察点）

`[SOURCE]`（Pi 事件 `agent-loop.js:49-170,204-251,556-559`；LLM `model.ts:87-93`）

| Point | Source | When | Data available | Can Runtime modify? |
| --- | --- | --- | --- | --- |
| `agent_start` | Pi | Run 开始 | — | 否（void listener） |
| `turn_start` | Pi | 每 Turn 开始 | — | 否 |
| `message_start` | Pi | 消息开始 | message（partial） | 否 |
| `message_update` | Pi | 流式增量 | delta | 否 |
| `message_end` | Pi | 消息结束 | **message + stopReason + errorMessage** | 否 |
| `tool_execution_start` | Pi | tool 调用前 | toolCallId | 否 |
| `tool_execution_end` | Pi | tool 返回后 | **result + isError** | 否 |
| `turn_end` | Pi | Turn 结束 | message, toolResults | 否 |
| `agent_end` | Pi | Run 结束 | messages | 否 |
| `policy_decision` | Runtime(Trace) | `beforeToolCall` 内 | call + decision | 否（仅记录） |
| `policy_resolved` | Runtime(Trace) | approval 结束 | outcome + reason | 否 |
| LLM `onPayload` | pi-ai | LLM 请求前 | model/messages/tools | **钩子可改（当前返回原值→观察）** |
| LLM `onResponse` | pi-ai | LLM 响应后 | status/headers | 否（当前仅观察） |

`[DECISION]` **Observation ≠ Control**：所有 Agent 事件 listener 为 `void`，Runtime 无法借观察改执行；`onPayload` 钩子理论可改请求，但当前 Runtime 有意返回原值（观察-only）。

## 6. Control Points（控制点）

`[SOURCE]`（`runtime.ts` / `agent.js:98-102,300-310` / `agent-loop.js:426-436` / `policy/adapter.ts`）

| Control Point | 可用? | Runtime 使用? | 能做什么 | 不能做什么 | Owner |
| --- | --- | --- | --- | --- | --- |
| `beforeToolCall` | ✅ | **使用** | ALLOW / ASK / DENY(block) / terminate | 改 tool 参数、改 tool 结果 | Pi 调用 + Policy 决策 |
| `abort()` | ✅ | **使用** | 终止整个 Run（AbortController） | 恢复、局部回退 | Runtime→Pi signal |
| Tool Set（Static） | ✅ | **使用** | 决定哪些 Tool 对 LLM 可见（构造/registerTool） | 运行时按 turn 动态换（未做） | Runtime/Registry |
| Agent config（model/systemPrompt） | ✅ | **使用** | 设定模型/系统提示 | 运行中改 LLM 推理 | Runtime（构造） |
| `afterToolCall` | ✅ | 未用 | （Pi 钩子）tool 后观察/变换结果 | —（语义待采用时确认） | Pi 提供 |
| `shouldStopAfterTurn` | ✅ | 未用 | 每 Turn 后**终止 Run**（治理：max turns） | — | Pi 提供 |
| `prepareNextTurn`/`WithContext` | ✅ | 未用 | 下一 Turn 前**注入/裁剪 context** | — | Pi 提供 |
| `onPayload`/`onResponse` | ✅ | 观察-only | 可改 LLM 请求/响应（当前未用） | — | pi-ai 提供 |

`[DECISION]` 当前 Runtime 的**正式控制面 = `beforeToolCall` + `abort` + Tool Set + Agent config**。其余 Pi 钩子为**可用但未声明的控制面**，未来若需（如治理 max-turns、context 注入）可直接采用，**不修改 Pi**。

## 7. Runtime 到底能控制什么？

`[DECISION]` 精确边界：

**Runtime 可以：**
- ✓ 决定 **Tool 是否执行**（Policy block/terminate）。
- ✓ 决定 **哪些 Tool 对 LLM 可见**（Static Tool Set / registerTool）。
- ✓ **Abort** 当前 Run（整 Run 终止）。
- ✓ 记录 LLM / Tool / Policy / Agent 全事件（Observation）。
- ✓ 设定 model / systemPrompt（Agent 配置）。

**Runtime 目前不能（源码确认）：**
- ✗ 直接决定 LLM 的 reasoning / 选词（LLM 拥有）。
- ✗ 强制 LLM 选择某个 Tool（只能 block，不能 steer 选择）。
- ✗ 修改 Pi Agent Loop（loop 属 Pi）。
- ✗ 透过 `beforeToolCall` 改 tool 参数或结果（只 block）。
- ✗ 中途恢复已 abort 的 Run（无 Resume）。
- ✗ 持久化 Run / Session（无 Persistence）。
- ✗ 借 Observation 改执行（listener 为 void）。

## 8. Four-Layer Boundary Model

`[DECISION]` 基于上述证据建立：

```text
┌──────────────────────────────────────────────────────────────┐
│ Layer 1 — AGENT EXECUTION  (Pi Agent Core 拥有)               │
│   Agent Loop · LLM interaction · Tool decision · Tool exec    │
│   Context assembly · Run mechanics · stopReason               │
│   职责：把 prompt 变成结果（the "how"）                         │
└──────────────────────────────────────────────────────────────┘
        ▲ observe (events)          ▲ control (defined points)
        │                           │
┌───────┴──────────────┐   ┌────────┴───────────────────────────┐
│ Layer 3 — OBSERVATION│   │ Layer 2 — CONTROL (Runtime 控制面)  │
│   Trace              │   │  beforeToolCall(Policy) · abort     │
│   Agent events      │   │  Tool Set · Agent config            │
│   LLM onPayload/Resp│   │  (+unused: afterToolCall,           │
│   Tool/Policy/Run   │   │   shouldStopAfterTurn,              │
│   职责：记录 what   │   │   prepareNextTurn)                  │
│    happened         │   │  职责：whether / how-far / which-tools│
└─────────────────────┘   └─────────────────────────────────────┘
        ▲                                   ▲
        │                                   │
┌───────┴───────────────────────────────────┴──────────────────┐
│ Layer 4 — GOVERNANCE  (企业规则编码)                            │
│   Policy (allow/deny/ask) · Tool Visibility (Skill→Tool Set)  │
│   Trace observability (Audit-ready) · 未来 Audit / Evaluation │
│   职责：the "rules / why" over Layers 2&3                     │
└──────────────────────────────────────────────────────────────┘
```

边界规则（不可逾越）：
1. Runtime **只能经 Layer 2 的正式控制点**改变 Layer 1 执行；不能从 Layer 3 观察反向改执行。
2. Layer 1 的"决策权"（LLM 推理、tool 选择、loop）永不移交 Runtime。
3. Layer 4 是 Layer 2+3 之上的企业规则层；当前 = Policy + Tool Visibility + Trace（审计就绪），Audit/Evaluation 为 FUTURE。

## 9. Governance Boundary

`[DECISION]`
- **当前 Governance = Policy + Tool Visibility + Trace observability**。
- Policy 是唯一能改变执行的治理控制点（`beforeToolCall`）；它通过"block"实现"不允许做某事"，但**不改变业务结果本身**（Phase 8：DENY 是正常业务拒绝，非 Run Failure）。
- Tool Visibility（Skill→Static Tool Set，Phase 5）是"谁能用什么工具"的治理，属 Layer 2/4。
- Trace 是治理的**可审计基础**（记录 what/who-at-tool-level），但缺 user/tenant 身份 → 不是 Audit（Phase 6）。
- 未来 Audit/Evaluation 在 Layer 4 之上叠加，不改动 Layer 1–3。

## 10. Run Lifecycle Boundary（与 Phase 8 衔接）

`[DECISION]` Layer 1 产生 `agent_end` + `stopReason`；Layer 2/3 不决定结局，仅：
- Control：`abort`（整 Run 终止）、`shouldStopAfterTurn`（每 Turn 终止）。
- Observation：记录结局。
- Execution Status 派生（COMPLETED/FAILED/ABORTED）由 Runtime 依据 `stopReason`+`errorMessage`+`tool isError` 在 Layer 2 侧做（Phase 8 模型）。当前无对象，仅文档契约。

## 11. Consolidated Ownership Matrix

| Concern | Pi | Runtime | LLM | Tool | Policy | Future |
| --- | --- | --- | --- | --- | --- | --- |
| Agent Loop | ✅ | | | | | |
| LLM interaction | ✅ | 观察 | ✅ | | | |
| Tool decision (选哪个) | ✅(LLM) | | 决定 | | | |
| Tool execution | ✅(调用) | 拥有实现 | | ✅ | | |
| Policy decision | 调用 | 转接 | | | ✅ | |
| Tool visibility | | ✅(Set) | | | | |
| Abort | ✅(signal) | ✅(调用) | | | | |
| shouldStopAfterTurn | ✅(钩子) | 未用 | | | | 治理用(Future) |
| prepareNextTurn | ✅(钩子) | 未用 | | | | context 注入(Future) |
| afterToolCall | ✅(钩子) | 未用 | | | | 变换(Future) |
| Run outcome 派生 | 产生信号 | ✅(派生) | | | | 正式对象(Future) |
| Observation(Trace) | 发事件 | ✅(收集) | 提供 | 提供 | 记录 | |
| Governance | | (Policy+Visibility) | | | ✅ | Audit/Eval(Future) |

## 12. Decision

`[DECISION]`
- 边界已**完整且稳定**：Execution(Pi) / Control(Runtime 控制面) / Observation(Trace) / Governance(Policy+Visibility+未来 Audit)。
- 当前 Runtime 控制面足够覆盖单进程单用户范围；**不需要新能力**。
- 记录 Pi 未使用控制钩子（`afterToolCall`/`shouldStopAfterTurn`/`prepareNextTurn`）为**未来可选控制面**，采用时无需改 Pi。
- 继续禁止横向扩展（Memory/RAG/MCP/Multi-Agent 等），它们属 Phase 6 已判 FUTURE。

## 13. Evidence / Source Table

| 结论 | 文件:行 | 标记 |
| --- | --- | --- |
| 调用链 run→prompt→runWithLifecycle→runLoop | `runtime.ts:86-94`；`agent.js:226-279,326`；`agent-loop.js:66-170` | `[SOURCE]` |
| 事件列表（agent_start…agent_end） | `agent-loop.js:49-170,204-251,556-559` | `[SOURCE]` |
| Policy 位于 Tool 执行前（beforeToolCall） | `agent-loop.js:409-459,426-436` | `[SOURCE]` |
| Policy 仅 block/allow/ask，不改参/结果 | `policy/adapter.ts:21-45`；`agent-loop.js:426-436` | `[SOURCE]` |
| Runtime 仅观察事件（listener void） | `runtime.ts:18-21,61,65` | `[SOURCE]` |
| LLM onPayload/onResponse 观察-only（返回原值） | `model.ts:87-93` | `[SOURCE]` |
| Pi 额外控制钩子（afterToolCall/shouldStopAfterTurn/prepareNextTurn） | `agent.js:98-102,300-310` | `[SOURCE]` |
| abort → AbortController signal | `runtime.ts:111`；`agent.js:202` | `[SOURCE]` |
| Tool Set 控制（构造/registerTool） | `runtime.ts:48,75-78`；`registry.ts` | `[SOURCE]` |
| 实验：ALLOW 时间线（含 tool_execution） | `scripts/_investigate-9.ts` | `[EXP]` |
| 实验：DENY 时 policy_decision 先于 tool_execution | 同上 | `[EXP]` |
| 四层边界模型 / 控制面清单 | §8,§6,§7 | `[DECISION]` |
| 当前无需新能力；未用钩子记 FUTURE | §12 | `[DECISION]` |

---

```text
PHASE 9 INVESTIGATION: COMPLETE

CODE CHANGED: NO

NEW CAPABILITY IMPLEMENTED: NO
NEW CONTROL POINT ADDED: NO
PI MODIFIED: NO

NEXT RECOMMENDED STEP:
不实现任何新模块。Enterprise Agent Execution Boundary 已稳定建模为四层
（Execution / Control / Observation / Governance）。若下一真实场景需要治理增强
（如 max-turns、context 注入、tool 结果变换、审计），优先采用 Pi 已提供的未使用钩子
（shouldStopAfterTurn / prepareNextTurn / afterToolCall），无需修改 Pi；
Audit / Evaluation 仍属 FUTURE（见 Phase 6/8）。
```
