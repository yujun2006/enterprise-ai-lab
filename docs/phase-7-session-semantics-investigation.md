# Phase 7 — Session Semantics Investigation

## 1. Executive Summary

本 Phase 只调查：**Enterprise Runtime 中，Session 到底应该是什么？** 不实现 Session，不增加 `sessionId`，不接 Persistence/Redis/DB。

核心结论（先给）：

- **Session 不是一个字段，而是一个生命周期概念**：一个跨越多个 Run 的"逻辑连续交互上下文"。
- **当前所谓 "Session" 实际 = Agent Instance 的生命周期**（隐式，无对象）。这是 Agent Instance 语义，不是 Session 语义。
- **Run 有隐式生命周期**（running / completed / failed / aborted），但无显式状态枚举；`runId` 由 TraceCollector 生成（per-run uuid），Pi 本身不产生 runId。
- **一个 Runtime = 一个 Pi Agent**，跨 Run 保留；transcript 因 `agent.state.messages` 累加而跨 Run 保留。
- **同一 Runtime 拒绝并发 Run**（run 串行假设，源码强制）。
- **Session 不依赖 Persistence**：Session + no-persistence 当前完全成立（Agent Instance 即隐式 Session）。Persistence 是 Session 的**外部 Adapter**，不是 Session 概念本身。
- **Trace 是 Run 级别**；Session 应聚合多个 Trace（Session ⊃ Run ⊃ Trace）——当前 TraceCollector 已天然 per-run，契合该模型。
- **Tool Set 属 Session 生命周期**（Skill→Static Tool Set，跨 Run 稳定）；**Policy Decision 属 Tool-Call 级别**（每次重新评估），"记住已批准"才是 Session 级（未来）。
- **最终决策**：SESSION ABSTRACTION UNDERSTOOD；SESSION IMPLEMENTATION DEFERRED。当前单进程单用户范围，Agent Instance 生命周期已能提供跨 Run 连续性，无阻塞问题，不实现。

```text
PHASE 7 INVESTIGATION: COMPLETE
CODE CHANGED: NO
```

## 2. Current Lifecycle Model

`[SOURCE]`（基于 `runtime.ts` / `agent.js` / `trace/*`）

当前实际存在的对象层级（注意：**没有 User / Session 对象**）：

```text
EnterpriseAiRuntime (1 个)
        │
        └── Pi Agent Instance (1 个, runtime.ts:32)
                │
                ├── Pi State: messages / tools / model / systemPrompt / isStreaming
                │
                └── Run (每次 prompt()/run() 一个)
                        │
                        └── Trace (TraceCollector, per-run uuid)
```

- **User**：不存在（无身份/租户）。
- **Session**：不存在为显式对象；由 Agent Instance 生命周期隐式充当。
- **Run**：每次 `prompt()`/`run()`（顺序执行）。
- **Agent Instance**：1 Runtime = 1 Pi Agent，进程级。
- **Pi State / Transcript**：Agent Instance 内部（messages 累加）。
- **Trace**：per-run。

## 3. Run Semantics

`[SOURCE]` + `[EXPERIMENT]`

### Q1 — 当前 Run 是什么？
一次 `prompt()` / `continue()` 调用 → 一次 `runAgentLoop`（可含多 Turn，直到 LLM 停止 / `shouldStopAfterTurn`）(`agent.js:226-279`)。由 `activeRun` 跟踪 (`agent.js:335`)。

### Q2 — Run 的生命周期？
`created → running → completed / failed / aborted`。
- **running**：`runWithLifecycle` 设 `isStreaming=true` + `activeRun` (`agent.js:336-335`)。
- **completed**：loop 正常结束，`finishRun()` 复位 `isStreaming=false`、`activeRun=undefined` (`agent.js:366-372`)。
- **failed**：`runWithLifecycle` catch → `handleRunFailure` 写 `stopReason:"error"` 的 message (`agent.js:342-364`)。
- **aborted**：`abort()` → `activeRun.abortController.abort()`；loop 见 `signal.aborted` → `stopReason:"aborted"` (`agent.js:202`, `agent-loop.js`)。
- **注意**：无显式 status 枚举，状态由 `isStreaming` / `activeRun` / `stopReason` / `errorMessage` **派生**。

### Q3 — runId 当前由谁创建？
**TraceCollector.startRun → `randomUUID()`** (`trace/collector.ts:54`)。**Pi 不产生 runId**——runId 是 Trace 的产物，per-run。当前 `Runtime.sessionId` = undefined (`runtime.ts` 构造 Agent 未传 `sessionId`)。

### Q4 — Run 是否包含 prompt / state / tool calls / LLM calls / policy / final answer / trace？
Run **包含**：prompt（`runtime.run` 注入）、tool calls / LLM calls / policy decisions / final answer / trace（都在 `ExecutionTrace` 内，`trace/types.ts:34-47`）。Run **不独占** agent state——state 跨 Run 共享（`§4 Q10`）。

### Q5 — 一个 Runtime 能否连续多个 Run？
**能**，串行：`prompt()`/`run()` 在上一个 run 完成后再次调用（`runtime.ts:86-94`，需先 `waitForIdle` 或自然结束）。

### Q6 — 两个 Run 是否共享 State？
**共享**。`agent.state.messages` 跨 Run 累加（`agent.js:390`）。
`[EXP]` 实验 A：Runtime A Run1→Run2，transcript 2→4，Run2 看到 "Jun"。

## 4. Agent Instance Semantics

`[SOURCE]`

### Q7 — 一个 EnterpriseAiRuntime 对应几个 Pi Agent？
**恰好 1 个**（`runtime.ts:32 private readonly agent: Agent`）。

### Q8 — Agent Instance 是否跨 Run 保留？
**是**——同一对象跨所有 Run。

### Q9 — Agent Instance 被销毁时什么消失？
随进程/GC 消失：messages、tools、systemPrompt、model、`TraceCollector` 的 trace、`activeRun`。**全 in-memory，无外部存储** (`agent.js:214 reset`)。

### Q10 — transcript 为什么能跨 Run 保留？
`agent.state.messages` 是可变数组，`processEvents` 在 `message_end` 时 `push`（`agent.js:390`）；`reset()` 才清空 (`agent.js:218`)。故同一实例内跨 Run 累积。

### Q11 — 这是 Session semantics 还是 Agent Instance semantics？
**[DECISION] 这是 Agent Instance semantics，不是 Session semantics。** "跨 Run 连续性"只是 Agent 实例存活的副作用；没有 session id、没有用户/租户、没有跨进程身份。把"实例存活"误当作"Session"正是 Phase 6 发现的结构性问题。

## 5. State Semantics

`[SOURCE]` + `[INFERENCE]`

### Q12 — 哪些 State 属于 Pi Agent Engine？
`agent._state`：`messages`、`tools`、`systemPrompt`、`model`、`isStreaming`、`streamingMessage`、`pendingToolCalls`、`errorMessage` (`agent.js:218,388-402`)。

### Q13 — 哪些 State 属于 Enterprise Runtime？
`ToolRegistry`（tools 来源，`registry.ts`）、`Policy`（`beforeToolCall`）、`TraceCollector` + `runId`（`trace/*`）、`RuntimeOptions` 中的 systemPrompt/tools 初始值（`runtime.ts:37-49`）。

### Q14 — 当前 State 是否可视为 Session State？各字段生命周期？
| 字段 | 生命周期 | 是否像 Session State |
| --- | --- | --- |
| messages | 实例级（跨 Run，reset 清空） | 像 session memory，但绑定实例 |
| tools | 实例级（构造时定，可 registerTool） | Skill→Static Tool Set（Phase 5），应属 Session |
| model | 实例级（配置） | 配置，非 session |
| systemPrompt | 实例级（配置） | 配置，非 session |
| isStreaming | **Run 级**（仅运行期 true） | 非 session |

`[INFERENCE]` 只有 messages/tools 具备 session 特征，且都绑定 Agent 实例，故当前 State 仅是"隐式 session"，不是真正的 Session State。

## 6. Session Lifecycle Experiment

`[EXP]` 真实 Ollama + qwen2.5:14b + 真实 `EnterpriseAiRuntime`，不修改 Pi。临时脚本 `scripts/_investigate-7.ts`（已删除）。

- **A — Same Runtime, multiple Runs**：Run1 `transcript=2`，Run2 `transcript=4`，Run2 回答含 "Jun"；`runId` 为 per-run uuid。⇒ 同实例跨 Run 共享 state ✅
- **B — New Runtime (new Agent instance)**：新实例起始 `transcript=0`，问名字回答 "I don't have access to personal information..."。⇒ 新实例无共享 transcript/state ✅
- **C — Concurrent Runs on same Runtime**：第二个并发 `prompt()` 抛 `"Agent is already processing a prompt. Use steer() or followUp()..."`。⇒ 同 Runtime 拒绝并发 Run（run 串行）✅ `[SOURCE]` 印证 `agent.js:227-229`

## 7. Session Semantics（定义）

`[DECISION]` **Session = 一个跨越 ≥1 个 Run 的逻辑连续交互上下文**，归属某个 User/Client，独立于单个 Run 的生命周期。它**不是**一个 ID、不是存储、不是进程。

当前现实：Session 由 "Agent Instance 生命周期" 隐式实现（单进程内，实例存活 = Session 存活）。这是合法但隐式的 Session——一旦需要跨进程/多用户/重启存活，就必须显式化。

## 8. Session vs Persistence

`[INFERENCE]` + `[DECISION]`

### Q15 — Session 是否必须依赖 Persistence？
**否**。Session 可纯内存存在（当前即是）。

### Q16 — 没有 Persistence，Session 是否仍有价值？
**是**。`[EXP]` 单进程单用户下，Agent Instance = 有效 Session，提供跨 Run 连续性。

### Q17 — Persistence 是否应属 Session Layer？
Persistence 是 **Session 的外部 Adapter**，不是 Session 概念本身：

```text
Session
   │
   └── Persistence Adapter (future, optional)
```

引入 Persistence 是为了"Session 跨进程存活"，与 Session 概念解耦。`[DECISION]` 当前两者都不需要。

## 9. Session vs Trace

`[SOURCE]` + `[DECISION]`

### Q18 — Trace 是 Run 级还是 Session 级？
**Run 级**：`ExecutionTrace` 有 `runId` / `startedAt` / `endedAt`，由 `TraceCollector` 每次 `run()` 新建 (`trace/types.ts:34-47`, `collector.ts:51`)。

### Q19 — 一个 Session 是否应包含多个 Trace？
**是**，模型成立：

```text
Session
 ├── Run 1 ─ Trace 1
 ├── Run 2 ─ Trace 2
 └── Run 3 ─ Trace 3
```

`[DECISION]` 当前 TraceCollector 已天然 per-run 产出 Trace，未来只需在 Session 层聚合这些 per-run Trace，无需改动 Trace 结构。

## 10. Session vs Agent Instance

`[INFERENCE]` 两种模型：

- **Model A — Session 绑定固定 Agent Instance**（Session ⊃ 固定 Agent Instance ⊃ Run…）
  - 优点：简单，无 Persistence，当前现实。
  - 缺点：进程重启/崩溃即失；无法水平扩展；多 worker 不共享。
- **Model B — Session 跨多个 Agent Instance**（Run1→InstanceA, Run2→InstanceB…）
  - 优点：水平扩展、多 worker、durable session、进程重启可恢复。
  - 缺点：必须引入 Persistence + Session Store + Session Router（Phase 6 FUTURE）。

`[DECISION]` 当前选 Model A（已是现实）。Model B 仅在生产多实例形态才需要。不预选。

## 11. Session vs Tool Set

`[INFERENCE]` + `[DECISION]`（结合 Phase 5）

### Q20 — Tool Set 属于哪个生命周期？
**属于 Session**（Skill→Static Tool Set，跨 Run 稳定）。同一 Session 内 Run1/2/3 用同一 Tool Set 合理。

### Q21 — Session 中切换 Skill 时 Tool Set 如何变？
切换 Skill = 后续 Run 用新 Tool Set；历史 Run 的 transcript 保留。实现上 `registerTool` 可更新 `agent.state.tools`（`runtime.ts:75-78`），但**本 Phase 不实现**，仅分析。

## 12. Session vs Policy / Approval

`[SOURCE]` + `[INFERENCE]`

### Q22 — Policy Decision 是 Run-scoped / Session-scoped / User-scoped / Tool-Call-scoped？
**Tool-Call-scoped**：`evaluatePolicy` 每次 tool call 重新评估（`policy/adapter.ts:21-45`）。
- "Session 内用户已批准 X，后续复用" → 这是 **Session-scoped approval memory**，当前**不存在**（每次都重新 `ask`）。
- 当前 `ask` = Run 内 in-process await（`policy/adapter.ts:36-44`，Phase 4）。

`[INFERENCE]` 若未来要"记住已批准"，应放在 Session 层，但需 Persistence（Phase 6 FUTURE）。

## 13. Session & Future Durable Approval

`[INFERENCE]` 未来模型可能：

```text
Session
 ├── Run
 ├── Trace
 └── Pending Approval (持久化，跨重启)
```

但**不预设**——仅记录：若引入 Durable Approval，Session 会是 Pending Approval 的自然上层归属；前提是 Persistence。本 Phase 不实现。

## 14. Multi-Instance Runtime

`[INFERENCE]`

### Q23 — Session 是否应独立于 Runtime Instance？
**仅当 Persistence 存在时**才应独立。当前无 Persistence → Session == Runtime Instance，不能跨 worker。

### Q24 — 若应独立（未来），为什么？
支持 horizontal scaling、durable session、worker 独立、进程重启恢复。

### Q25 — 若不应独立（当前），为什么？
单进程单用户 demo 简单够用；Session==实例已提供连续性；无需 Session Store / Router 复杂度。

`[DECISION]` 当前选"不独立"（=Model A）。这也直接决定：未来若需多实例，才引入 Persistence + Session Store + Session Router（均 FUTURE）。

## 15. Proposed Lifecycle Model

`[DECISION]` 推荐概念模型（当前仅 Agent Instance 层有真实对象，Session/User 为概念占位）：

```text
User            (future: Auth/Identity layer — NOT in current code)
  │
  ▼
Session         (concept: spans ≥1 Run; TODAY realized implicitly by Agent Instance lifetime)
  │
  ├── Run 1 ── Trace 1
  ├── Run 2 ── Trace 2
  └── Run 3 ── Trace 3
        │
        ▼
   Agent Instance (1 per EnterpriseAiRuntime)   ← Pi Agent
        │
        ▼
   Pi State (messages / tools / model / systemPrompt / isStreaming)
```

- **Agent Instance** 置于 Session 之下（Model A）。
- **Pi State** 归属 Agent Instance（messages 近似 Session memory；isStreaming 属 Run）。

## 16. Ownership Matrix

| Object | Lifecycle | Owner | Current Implementation | Future |
| --- | --- | --- | --- | --- |
| User | 跨 Session | —（无） | 不存在 | Auth/Identity 层（FUTURE） |
| Session | ≥1 Run，当前=Agent 实例寿命 | （仅概念） | 隐式=Agent Instance，无对象 | 显式 Session 对象 + Persistence Adapter（FUTURE，**不实现**） |
| Run | 一次 prompt()→end | Pi(`runWithLifecycle`)+Runtime(`run`) | `activeRun`+`isStreaming` | 同 |
| Agent Instance | 进程寿命 | Runtime 持有 1 Pi Agent | `runtime.ts:32` | 多实例时 pool/router（FUTURE） |
| Pi State | 实例级(messages)/Run(isStreaming) | Pi(`_state`) | `agent.state` | 同；Persistence 为外部 Adapter |
| Transcript | 实例级（至 reset） | Pi(messages) | `agent.state.messages` | 可经 Persistence 变 Session 级（FUTURE） |
| Trace | per Run | Enterprise(`TraceCollector`) | `trace/*` | per-Run，聚合于 Session（FUTURE） |
| Tool Set | Session（跨 Run 稳定） | Enterprise(`ToolRegistry`) | `registry.ts`，构造时定 | per-Session Tool Set（FUTURE） |
| Policy Decision | Tool-Call 级 | Enterprise(`Policy`) | `policy/adapter.ts` | 可加 Session 级 approval memory（FUTURE） |
| Approval | Run 级（in-process） | Enterprise(`ask`) | `policy/adapter.ts:36` | Session 级 durable pending（FUTURE） |

## 17. Decision: Implement or Defer Session

`[DECISION]`

**Decision A：`Session 当前不需要实现`（DEFERRED）。** 但本 Phase 已"定义 abstraction"（概念模型 + Ownership Matrix），不落地任何代码。

依据（回到核心问题）：
> 没有 Session，当前 Runtime 是否**无法可靠支持下一个真实场景**？

- 当前真实场景：本地单进程、单用户、短 Run、Ollama、2 tools。
- Agent Instance 生命周期已提供跨 Run 连续性（`[EXP]` A/B）。
- 无 User/多实例/多租户/重启存活需求 ⇒ 缺 Session 对象**不构成阻塞问题**。
- 故：**SESSION ABSTRACTION: UNDERSTOOD；SESSION IMPLEMENTATION: DEFERRED。**

## 18. Future Implications（重验 Phase 6 排序）

Phase 6 排序：Session → Persistence → Durable Approval → Audit。本 Phase 重验：

- **Session 为何排第一**：它是 Run/Trace/Approval 的自然容器，概念上应先于 Persistence。但 **Session 概念与 Persistence 可分离**——当前两者都不需要。
- **Session 与 Persistence 是否应一起出现**：不必。可先"显式化 Session（内存，=正式化 Agent Instance）"而不接 Persistence；仅当进入多实例/重启存活才引入 Persistence。
- `[DECISION]` 修正：生产化时顺序仍为 **Session(显式化) → Persistence → Durable Approval → Audit**，但**两者当前均 DEFER**。不要因为"企业一般有 Session"就提前实现。

## 19. Evidence / Source Table

| 结论 | 文件:行 | 标记 |
| --- | --- | --- |
| 1 Runtime = 1 Pi Agent | `runtime.ts:32` | `[SOURCE]` |
| Run = 一次 prompt()→runAgentLoop（多 Turn） | `agent.js:226-279` | `[SOURCE]` |
| Run 状态为隐式（isStreaming/activeRun/stopReason） | `agent.js:336-372,342-364` | `[SOURCE]` |
| runId 由 TraceCollector 生成（per-run uuid），Pi 不产生 | `trace/collector.ts:54`；`runtime.ts` 未传 sessionId | `[SOURCE]` |
| 同 Runtime 多 Run 共享 state（messages 累加） | `agent.js:390` | `[SOURCE]` |
| transcript 跨 Run 因 messages 累加；reset 清空 | `agent.js:218,390` | `[SOURCE]` |
| 同 Runtime 拒绝并发 Run（run 串行） | `agent.js:227-229` | `[SOURCE]` |
| Agent Instance 销毁 = 全 in-memory 丢失 | `agent.js:214` | `[SOURCE]` |
| Tool Set 属 Session（Skill→Static） | Phase 5 / `runtime.ts:48,75-78` | `[INFERENCE]` |
| Policy Decision 属 Tool-Call 级 | `policy/adapter.ts:21-45` | `[SOURCE]` |
| Trace 属 Run 级 | `trace/types.ts:34-47` | `[SOURCE]` |
| 实验 A：同实例跨 Run 保留/看到 Jun | `scripts/_investigate-7.ts` PART A | `[EXP]` |
| 实验 B：新实例无共享 state | `scripts/_investigate-7.ts` PART B | `[EXP]` |
| 实验 C：并发 Run 被拒 | `scripts/_investigate-7.ts` PART C | `[EXP]` |
| "当前 Session = Agent Instance 语义" | §4 Q11 | `[DECISION]` |
| Session ≠ Persistence（Session+no-persistence 成立） | §8 | `[DECISION]` |
| Session ⊃ Run ⊃ Trace 模型 | §9,§15 | `[DECISION]` |
| 当前 DEFER Session 实现，仅定义 abstraction | §17 | `[DECISION]` |

---

```text
PHASE 7 INVESTIGATION: COMPLETE

CODE CHANGED: NO

SESSION IMPLEMENTED: NO

PERSISTENCE IMPLEMENTED: NO

CHECKPOINT IMPLEMENTED: NO

NEXT RECOMMENDED STEP:
DEFER Session/Persistence。继续按 Phase 5 结论保持 Skill→Static Tool Set；
若下一真实场景进入"多用户 / 多实例 / 进程会重启"，再显式化 Session（内存，
=正式化 Agent Instance），并随之引入 Persistence Adapter（Session⊃Run⊃Trace）。
当前无需任何代码改动。
```
