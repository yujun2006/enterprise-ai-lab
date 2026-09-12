# Phase 6 — Enterprise Runtime Capability Gap Investigation

## 1. Executive Summary

本 Phase 只做调查：**从 Enterprise Runtime / Harness 角度，当前系统到底还缺哪些真正必要的 Runtime 能力？**

判断方法（本章贯穿全篇）：

> 对每个潜在能力只问一句：**"如果没有它，当前这个 Runtime 是否已经无法可靠地运行一个真实 Enterprise Agent？"**
> "没有" ≠ "需要"。

结论：

- 当前范围（本地单进程、单用户、Ollama、2 tools、短 Run、in-memory）下，**不存在阻塞性的 Runtime Capability Gap**。系统能可靠跑通一个（demo 级）Enterprise Agent。
- 真正"结构性缺失"且当前范围仍不阻塞的只有一项：**Session 抽象**（当前"Session" 仅等于"Agent 实例的生命周期"，无 session id / 多用户 / tenant）。
- 其余常被列为"企业必需"的能力（Persistence / Durable Approval / Timeout / Retry / Audit / Evaluation / Workspace / Multi-Agent）在当前范围**都不是真实问题**，全部记为 `FUTURE`，不实现。
- Runtime 与 Agent Engine 的边界清晰：Agent Loop / LLM 交互 / Tool 调用决策 / Tool 执行 / message&context 属于 **Pi**；Policy / Trace / Tool Registry / Tool Visibility / Governance 属于 **Enterprise Runtime**；State/Session/Retry/Timeout/Approval/Evaluation 当前为"双方协作或 Future"。

```text
PHASE 6 INVESTIGATION: COMPLETE
CODE CHANGED: NO
```

## 2. Current Runtime Capability Map

| Capability | 当前是否存在 | 谁负责 | 证据 |
| --- | --- | --- | --- |
| Agent Loop | ✅ | Pi (`runAgentLoop`) | `agent.js:270-279` |
| State (messages/tools/systemPrompt/model) | ✅（in-memory） | Pi + Runtime 包装 | `agent.js:280-325`；`runtime.ts:102` |
| Tool Registry | ✅ | Enterprise | `registry.ts:10-41` |
| Tool Execution | ✅ | Pi 调用 `tool.execute`；Enterprise 实现 | `agent-loop.js:464` |
| Policy (ALLOW/DENY/ASK) | ✅ | Enterprise (`beforeToolCall`) | `policy/adapter.ts:21-45`；`runtime.ts:52` |
| Trace (Agent Events) | ✅ | Enterprise | `trace/collector.ts:85` |
| LLM Interaction Trace | ✅ | Enterprise (onPayload/onResponse) | `trace/collector.ts:65,77` |
| Tool Visibility (Static Tool Set) | ✅（构造时固定子集） | Enterprise → Pi | `runtime.ts:48`；Phase 5 |
| Session | ❌（隐式=实例生命周期） | —（缺失） | 实验 PART A；§5 |
| Cancellation | ✅（手动 abort） | Pi (`AbortController`) + Runtime 转接 | `agent.js:202`；`runtime.ts:111` |
| Error Handling（Tool 失败） | ✅（Pi 捕获并回灌） | Pi | `agent-loop.js:452-456,479-483,515-518` |
| Error Handling（LLM 失败） | ⚠️（Pi 结束 run，写 error message；Runtime 无额外暴露） | Pi + 缺失观测 | `agent.js:349-359`；§6 |
| Retry | ⚠️（仅 Pi 内 LLM provider 重试，受 `maxRetryDelayMs` 限制） | Pi（窄） | `agent.js:109-110,133,298` |
| Timeout | ❌（仅手动 abort） | —（缺失） | 全代码无 timeout 抽象 |
| Checkpoint | ❌ | —（缺失） | — |
| Persistence | ❌（in-memory） | —（缺失） | `reset()` 清空；无存储 |
| Approval（短等待） | ✅（in-process await） | Enterprise (`ask`) | `policy/adapter.ts:36-44` |
| Approval（长等待/异步） | ❌（无 durable queue） | —（缺失） | §8 |
| Evaluation | ❌ | —（缺失） | — |
| Audit | ❌（Trace ≠ Audit） | —（缺失） | §9 |
| Workspace / Resource | ❌（当前 tool 纯 in-memory） | —（缺失） | §10 |
| Multi-Agent | ❌ | —（缺失/非当前范围） | — |

## 3. Capability Gap Judgment Method

对每一项应用核心问题：

- **Agent Loop / State(in-mem) / Tool Registry / Tool Exec / Policy / Trace / LLM Trace / Tool Visibility / Cancellation / Tool 错误捕获**：**存在** → 无 Gap。
- **Session / Persistence / Durable Approval / Timeout / Audit / Evaluation / Workspace**：**缺失**，但要区分：
  - 本地单进程、单用户、短 Run、Ollama 稳定 → 缺失不构成"无法可靠运行"的真实问题 → `FUTURE`。
  - 一旦进入"多用户 / 长 Run / 进程会重启 / 需合规审计"的生产形态 → 这些缺失会变成真实 Gap。
- 结论：**当前范围没有阻塞 Gap；缺失项均为生产规模触发，记录 FUTURE。**

## 4. Runtime vs Agent Engine Boundary

`[SOURCE]`（基于 `agent.js` / `agent-loop.js` / `runtime.ts`）

### Q1 — 哪些能力永远属于 Pi Agent Core？

| 能力 | 理由 |
| --- | --- |
| Agent Loop | `runAgentLoop` / `runLoop`（`agent.js:270`） |
| LLM interaction（stream / payload / response） | `streamAssistantResponse`（`agent-loop.js:122`） |
| Tool Call 决策（LLM 选 tool） | loop 内 `executeToolCallsParallel`（`agent-loop.js:330`） |
| Tool 执行（调用 `tool.execute`） | `agent-loop.js:464` |
| message / context 处理 | `createContextSnapshot`（`agent.js:280`） |
| 单次 Run 的 abort / 错误收尾 | `runWithLifecycle`（`agent.js:326`） |

### Q2 — 哪些能力明确属于 Enterprise Runtime？

| 能力 | 理由 |
| --- | --- |
| Policy（allow/deny/ask） | `beforeToolCall` 钩子（`runtime.ts:52`；`agent-loop.js:411`） |
| Trace / LLM Interaction Trace | `TraceCollector` 订阅事件 + 包装 onPayload（`trace/*`） |
| Tool Registry / 所有权 | `ToolRegistry`（`registry.ts`） |
| Tool Visibility（Static Tool Set） | 构造 Agent 时注入子集（`runtime.ts:48`） |
| Governance（审计/合规策略入口） | 当前由 Policy + Trace 承载，未来扩展 |

### Q3 — 边界争议项

| 能力 | 归属 | 判断 |
| --- | --- | --- |
| State | 双方协作 | Pi 持有 `_state`；Runtime 仅经 `agent.state` 读写（`runtime.ts:77,102`） |
| Session | Future（Runtime 应拥有） | Pi 只有 `sessionId`（provider 缓存用，`agent.js:103-104`），**非** 业务 Session；Runtime 当前无 Session 抽象 |
| Retry | Pi（窄）/ Future（Runtime） | Pi 仅 provider 请求重试（`maxRetryDelayMs`）；无 Tool/Run 级重试 |
| Timeout | Future（Runtime） | 无抽象；仅手动 `abort()` |
| Checkpoint | Future | 无 |
| Approval | 双方协作 | Runtime 定义决策（ask）+ await；Pi 在 `beforeToolCall` 等待（`policy/adapter.ts:36`） |
| Evaluation | Future（Runtime/外围） | Pi 不负责"做得好不好" |

## 5. State & Session

`[SOURCE]` + `[EXPERIMENT]`

### Q4 — 什么是 Run？
一次 `prompt()` / `continue()` 调用 → 一次 `runAgentLoop` 执行，可含多 Turn，直到 LLM 停止或 `shouldStopAfterTurn`（`agent.js:226-256,270-279`）。由 `activeRun` 跟踪（`agent.js:335`）。

### Q5 — 什么是 Session？
**当前没有显式 Session 概念。** Pi 的 `sessionId`（`agent.js:103-104`）仅转发给 LLM provider 做缓存，**不是** 业务会话存储。Enterprise Runtime 未定义 session id / 生命周期 / 多用户路由。

### Q6 — 当前 Pi 的 State 是否等价于 Enterprise Session？
不等价。`agent.state.messages` 在同一 Agent 实例、同一进程内跨 Run 累积（`agent.js:218` reset 才清空），所以"业务 Session"**隐式等于 Agent 实例的生命周期**。但：无 session id、无用户/租户、无跨进程。

### Q7 — Runtime 是否需要自己的 Session abstraction？
**生产形态需要，当前范围不需要。** 单用户本地运行，`new EnterpriseAiRuntime()` 即一个隐式 session，足够。多用户生产必须引入（见 FUTURE）。这是当前唯一"结构性缺失但不阻塞"的能力。

### Q8 — 如果进程重启，现在什么东西会消失？
全部 in-memory 状态：`agent.state.messages`（对话历史）、`ToolRegistry`（其实在构造时重建）、`TraceCollector` 的 trace、`activeRun`。**无任何持久化**（`reset()` 直接清空内存，`agent.js:214`）。

### Q9 — 如果用户连续 Run1/Run2/Run3，当前 Runtime 如何区分？
仅靠"同一 Agent 实例上的顺序调用"区分；无 session 标识。新 `new EnterpriseAiRuntime()` 即全新空白会话。

**实验 PART A（`[EXP]`，真实 Ollama）**：
- Instance A：fresh transcript=0 → Run1 后=2 → Run2 后=4；Run2 回答 "your name is Jun"（跨 Run 记住）。
  ⇒ **state 跨 Run 持久（隐式 session = 实例生命周期）✅**
- Instance B（fresh）：transcript 起始=0；问 "what is my name?" 回答 "I don't have access to your personal information... this chat is anonymous"。
  ⇒ **新实例无共享 Session/State ✅**
- `Runtime.sessionId`：`undefined`；`runId` 为每次 run 的 uuid（`trace/types.ts:35`），非 session id。

## 6. Failure Handling（失败之后怎么办）

`[SOURCE]` + `[EXPERIMENT]`

### Q10 — Tool 失败后 Agent 是否可以继续？
**可以。** Pi 在 `prepareToolCall` / `finalizeExecutedToolCall` 中 `try/catch`，失败转成 `createErrorToolResult(isError:true)` 回灌 loop（`agent-loop.js:452-456,479-483,515-518`）。Agent 看到 error tool result 后可改策略或结束。
实验 PART B（`[EXP]`）：`boom` tool 抛错 → `tool_execution_end.isError=true`、`agent_end` 存在、`finalAnswer` 已生成 ⇒ run 不崩溃 ✅

### Q11 — LLM 请求失败后怎么办？
Pi `runWithLifecycle` 捕获异常 → `handleRunFailure` 写一条 `stopReason:"error"` 的 assistant message 进 transcript，run 结束（`agent.js:342-359`）。**不会自动重试**（见 Q14）。Runtime 侧无额外处理。

### Q12 — Abort 是什么粒度？
**Run 粒度**（一次 `prompt()` 到结束）。`abort()` → `activeRun.abortController.abort()`；signal 贯穿 loop 与 tool 执行（`agent-loop.js` 多处 `signal?.aborted` 检查；`agent.js:202`）。

### Q13 — 当前有没有 Timeout abstraction？
**没有。** 全代码无 timeout 抽象；唯一中断手段是手动 `abort()`。长 Run 若需超时，必须由 Runtime 未来自行实现（如 `setTimeout` + `abort()`）。

### Q14 — 当前有没有 Retry abstraction？
**没有 Enterprise 级 Retry。** Pi 仅实现"provider 请求的 LLM 流重试"，受 `maxRetryDelayMs` 上限约束（`agent.js:109-110,133,298`）；**不存在** Tool 失败重试、Run 级重试、用户可配置重试策略。当前 Ollama 本地稳定，缺失不构成问题 → `FUTURE`。

### Q15 — 缺失是否已构成真实问题？
- Tool 失败：Pi 已优雅处理（继续）→ 无问题。
- LLM 失败：run 干净结束 → 当前无问题（仅缺"向调用方暴露错误"的观测，见 §9，FUTURE）。
- Retry / Timeout：本地稳定环境不需要；生产/长 Run/网络不稳时才成问题 → `FUTURE`。

## 7. Long-running Execution（长时间运行）

`[SOURCE]` + `[INFERENCE]`

### Q16 — 当前 Run 能持续多久？
取决于 LLM 何时停止 / `shouldStopAfterTurn` / abort。无内置时间上限。短 Run 正常；长 Run（数十分钟）在单进程内可跑，但全 in-memory、无 checkpoint。

### Q17 — 进程重启后怎么办？
状态全失（`§5 Q8`）。正在进行的 Run 直接中断，无恢复。

### Q18 — 机器崩溃后怎么办？
同上，无持久化 → 无恢复。

### Q19 — 能否从中间状态继续？
**不能。** 无 Checkpoint / 持久化 message 快照。同一进程内 `continue()` 可续跑当前 transcript（`agent.js:234`），但进程外不可。

### Q20 — 当前是否需要 durable execution？
**当前范围不需要。** 本地单进程、短 Run、Ollama 稳定 demo 不需要 checkpoint/持久执行。进入"多用户长任务 / 进程会重启的生产"才需要 → `FUTURE`（Durable Execution / Checkpoint）。

## 8. Human Approval

`[INFERENCE]`（基于 Phase 4 的 `ask` 机制）

### Q21 — 审批 100ms / 1s / 5s：当前方案是否足够？
**足够。** `ask` 在 `beforeToolCall` 内 `await approval()`（`policy/adapter.ts:36-44`），in-process 等待，短延迟无压力。

### Q22 — 审批 10min / 1h / 1d：会发生什么？
进程必须一直存活并持有该 run 的 `await`；**run 不结束、资源不释放**。若进程在此期间重启 → `await` 随进程消失，审批结果丢失，tool call 永远不会被 resolve（无 durable queue）。

### Q23 — 进程重启怎么办？
正在 `ask` 的 run 随进程死亡；无持久化审批请求，无恢复机制。

### Q24 — 是否真的需要 durable approval queue？
- 当前（短审批 demo）：**不需要**，`ask` 够用（`Current`）。
- 若真实业务需要"人工几小时/跨天审批"：才需要 durable approval queue（`Future` / `Required` 在生产形态）。结论：**暂不需要，FUTURE。**

## 9. Evaluation / Audit / Observability

`[INFERENCE]`

### Q25 — Trace 与 Audit 是否同一件事？
**不是。**
- Trace = "发生了什么？"（事件流 + LLM request/response + tool 结果 + policy 决策；`trace/*`）。适合调试/复盘。
- Audit = "谁在什么时候做了什么？"（需 user/tenant 身份、操作主体、合规留存）。当前 Trace **不记录用户/租户身份**，无合规留存策略 ⇒ 不是 Audit。生产合规需另建 Audit（`FUTURE`）。

### Q26 — Trace 与 Evaluation 是否同一件事？
**不是。** Evaluation = "这次 Agent 做得好不好？"（质量/成功率/合规评分）。当前无任何 Evaluation 抽象（`FUTURE`）。

判断：当前 Trace 对**调试**足够；Audit / Evaluation 是生产增强，当前不阻塞 → `FUTURE`。

补充（错误观测小缺口，`[INFERENCE]`）：LLM 失败时 Pi 仅把空 assistant message 写入 transcript，TraceCollector 的 `finalAnswer` 为空，且 trace 无显式 "run_error" 事件。调用方无法从 `prompt()` 拿到异常（`runWithLifecycle` 已吞掉）。这是可观测性小缺口，建议未来在 Runtime 层暴露 run 结果/错误 → `FUTURE`，非阻塞。

## 10. Workspace / Resource Boundary

`[INFERENCE]`
- 当前所有 Tool 均为纯 in-memory（`get_customer` 读 const map；实验 `boom` 直接抛错），**无文件系统 / 数据库 / 外部资源 / 租户隔离**。
- 真实 Enterprise Tool（读 DB、写文件、调 ERP、访问客户数据）会需要 **Workspace / 资源边界**（路径沙箱、凭证注入、租户隔离）。
- 当前 Tool 不触达外部资源 ⇒ Workspace 不是当前问题 → `FUTURE` / `Not Needed now`。**不实现文件系统 Workspace。**

## 11. Minimal Experiment

`[EXP]` 真实 Ollama + qwen2.5:14b + 真实 `EnterpriseAiRuntime`，不修改 Pi。临时脚本 `scripts/_investigate-6.ts`（已删除）。

- **PART A（Session / durability gap）**：Instance A 跨 Run 持久（transcript 0→2→4，Recall "Jun"）；Instance B fresh 起始=0 且不知 "Jun"；`Runtime.sessionId` = undefined，runId 仅 per-run uuid。
- **PART B（Tool 失败不崩溃）**：`boom` 抛错 → `tool_execution_end.isError=true`、`agent_end` 存在、`finalAnswer` 存在。

## 12. Capability Gap Findings

按"是否阻塞当前范围"分类：

**存在且无 Gap（当前够用）**
Agent Loop、State(in-mem)、Tool Registry、Tool Execution、Policy、Trace、LLM Trace、Tool Visibility、Cancellation(abort)、Tool 错误捕获。

**缺失但当前不阻塞 → FUTURE**
- Session 抽象（唯一结构性缺失，当前由实例生命周期隐式满足）
- Persistence（in-memory，进程重启即失）
- Durable Approval Queue（长审批/跨天）
- Timeout abstraction（仅手动 abort）
- Enterprise Retry（仅 Pi provider 重试）
- Audit（Trace ≠ Audit，缺身份/合规留存）
- Evaluation（无质量评估）
- Workspace / Resource 边界（当前 tool 纯 in-memory）
- Checkpoint / Durable Execution（长 Run 恢复）
- Multi-Agent（非当前范围）

**缺失且构成"真实问题"的能力：无（当前范围）。**

## 13. Architecture Decision

> **当前 Enterprise Runtime 没有阻塞性的 Capability Gap。** 系统能可靠运行本地单进程、单用户、短 Run、2-tool 的 Enterprise Agent。
>
> 唯一结构性缺失是 **Session 抽象**，但当前由"Agent 实例生命周期"隐式满足，不阻塞。
>
> 其余企业级能力（Persistence / Durable Approval / Timeout / Retry / Audit / Evaluation / Workspace / Checkpoint / Multi-Agent）**在当前范围都不是真实问题**，全部记为 `FUTURE`，**本 Phase 不实现**。
>
> 进入生产形态（多用户 / 长 Run / 进程会重启 / 合规审计）时，优先补：**Session → Persistence → Durable Approval → Audit**。顺序由届时真实需求决定，不预先实现。

## 14. Evidence / Source Table

| 结论 | 文件:行 | 标记 |
| --- | --- | --- |
| Agent Loop 属 Pi | `agent.js:270-279` | `[SOURCE]` |
| State 跨 Run 累积（隐式 session=实例生命周期） | `agent.js:218`（reset 才清空） | `[SOURCE]` |
| Pi `sessionId` 仅 provider 缓存，非业务 session | `agent.js:103-104,130,293` | `[SOURCE]` |
| Runtime 无 sessionId 暴露 | `runtime.ts`（无该字段） | `[SOURCE]` |
| Tool 失败被 Pi 捕获并回灌 loop（继续） | `agent-loop.js:452-456,479-483,515-518` | `[SOURCE]` |
| LLM 失败 → run 结束并写 error message | `agent.js:342-359` | `[SOURCE]` |
| Abort 为 Run 粒度，signal 贯穿 | `agent.js:202`；`agent-loop.js` 多处 `signal?.aborted` | `[SOURCE]` |
| 无 Timeout 抽象（仅手动 abort） | 全代码无 timeout | `[SOURCE]` |
| 无 Enterprise Retry；仅 Pi provider 重试（`maxRetryDelayMs`） | `agent.js:109-110,133,298` | `[SOURCE]` |
| Policy(allow/deny/ask) 属 Runtime | `policy/adapter.ts:21-45`；`runtime.ts:52` | `[SOURCE]` |
| Trace / LLM Trace 属 Runtime | `trace/collector.ts:65,77,85` | `[SOURCE]` |
| Tool Registry 属 Runtime | `registry.ts:10-41` | `[SOURCE]` |
| 实验：跨 Run 持久 + 新实例无共享 | `scripts/_investigate-6.ts` PART A | `[EXP]` |
| 实验：Tool 失败 run 不崩溃 | `scripts/_investigate-6.ts` PART B | `[EXP]` |
| Session/Persistence/Audit/Eval/Timeout/Retry = FUTURE | 架构判断 | `[INFERENCE]` |
| Trace ≠ Audit；Trace ≠ Evaluation | §9 | `[INFERENCE]` |
| Workspace 当前不需要（tool 纯 in-memory） | §10 | `[INFERENCE]` |

---

### 必须回答的边界问题（结论）

- **Q1** Pi 永远拥有：Agent Loop / LLM 交互 / Tool 决策 / Tool 执行 / message&context / Run 级 abort&错误收尾。
- **Q2** Runtime 明确拥有：Policy / Trace / LLM Trace / Tool Registry / Tool Visibility / Governance 入口。
- **Q3** 争议：State(协作)、Session(Future/Runtime)、Retry(Pi 窄+Future)、Timeout(Future)、Checkpoint(Future)、Approval(协作)、Evaluation(Future)。
- **Q4** Run = 一次 `prompt()`/`continue()`（多 Turn）。
- **Q5** Session = 无显式概念（Pi `sessionId` 仅 provider 缓存）。
- **Q6** Pi State ≠ Enterprise Session（隐式=实例生命周期）。
- **Q7** 生产需 Runtime Session 抽象；当前不需要。
- **Q8** 进程重启 → 全 in-memory 状态丢失。
- **Q9** Run1/2/3 仅由同实例顺序调用区分；新实例=空白。
- **Q10** Tool 失败 → Agent 继续（error result 回灌）。`[EXP]`
- **Q11** LLM 失败 → run 干净结束（写 error message）。
- **Q12** Abort = Run 粒度。
- **Q13** 无 Timeout 抽象。
- **Q14** 无 Enterprise Retry（仅 Pi provider 重试）。
- **Q15** 缺失不构成当前真实问题（FUTURE）。
- **Q16** Run 时长无内置上限；当前短 Run 正常。
- **Q17/18** 进程重启/崩溃 → 状态全失，无恢复。
- **Q19** 不能从中间状态继续（无 checkpoint）。
- **Q20** 当前不需要 durable execution（FUTURE）。
- **Q21** 短审批（≤5s）当前 `ask` 足够。
- **Q22/23** 长审批（min~天）需进程常驻；重启即丢失 → 需 durable queue（FUTURE）。
- **Q24** 当前不需要 durable approval（FUTURE）。
- **Q25** Trace ≠ Audit（缺身份/合规留存）。
- **Q26** Trace ≠ Evaluation（无质量评估）。

```text
PHASE 6 INVESTIGATION: COMPLETE

CODE CHANGED: NO

IMPLEMENTATION:
Memory: NOT IMPLEMENTED
RAG: NOT IMPLEMENTED
Workflow: NOT IMPLEMENTED
Multi-Agent: NOT IMPLEMENTED
MCP: NOT IMPLEMENTED
Tool Discovery: NOT IMPLEMENTED
Tool Routing: NOT IMPLEMENTED
Checkpoint: NOT IMPLEMENTED
Persistence: NOT IMPLEMENTED
Approval Queue: NOT IMPLEMENTED
Retry: NOT IMPLEMENTED
Timeout: NOT IMPLEMENTED
Evaluation: NOT IMPLEMENTED
OpenTelemetry: NOT IMPLEMENTED
```
