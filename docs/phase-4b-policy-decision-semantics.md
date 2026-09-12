# Phase 4-B — Policy Decision Semantics Investigation

> 调查阶段（不实现 Policy / HITL / checkpoint / approval queue）。所有结论基于当前安装版本
> `@earendil-works/pi-agent-core`（dist）与 `@earendil-works/pi-ai` 的真实源码与一次真实 Ollama 实验。
> 证据标注：`[SOURCE]` = 源码证据，`[EXP]` = 实验证据，`[INF]` = 推断。

## 1. Executive Summary

- `beforeToolCall` 是 Pi 提供的**正式执行门禁**：返回 `{ block: true }` 阻止执行，`undefined`/无 block 则放行。
- `ALLOW` / `DENY` 完全由 Pi 原生支持，零修改。
- `ASK` 当前 **没有** Pi 原生 suspend/resume 生命周期；但 `beforeToolCall` 是 `await` 的，因此**可以在 Hook 内部 await 外部审批**（Plan A）来近似 ASK，且批准后可执行**原始** Tool Call（无重复）。
- 真正的 suspend/resume / checkpoint / pause 能力 **Pi 不提供**（无相关 API）。
- 重复执行风险仅在"结束 Run 后用新 prompt 恢复"（Plan B）时出现，因为 LLM 可能重新发出同一 Tool Call。需 Enterprise 用 `toolCallId` 去重。

## 2. Actual Pi Agent Lifecycle

`[SOURCE]`
- `Agent.prompt(input)` — `agent.js:226-232`；若 `activeRun` 存在则抛错（`agent.js:227-229`）。一次只能有一个 Run。
- `runWithLifecycle` 创建**每 run 一个** `AbortController`（`agent.js:330`）。
- `beforeToolCall` 由构造函数接收（`agent.js:123`）并透传进 loop config（`agent.js:300`）；`agent-loop.js:412` 实际调用。
- `abort()` — `agent.js:202`（abort 整个 run）；`steer()`/`followUp()` — `agent.js:173-179`；`continue()` — `agent.js:234-256`；`reset()` — `agent.js:214-225`（清空 messages）；`subscribe()` — `agent.js:146-149`（observe-only）。
- `state` 的 `messages`/`tools` 用 accessor 拷贝数组（`agent.js:26-49`），无序列化/反序列化 API（只有普通对象数组可快照）。

## 3. ALLOW Semantics

`[SOURCE]` `agent-loop.js:412-450`
- `beforeToolCall` 返回 `undefined` 或 `{ block: false }`（或不设置 hook）→ 不进入 block 分支。
- `prepareToolCall` 返回 `{ kind: "prepared", tool, args }`（`agent-loop.js:445-450`）。
- `executePreparedToolCall` → `prepared.tool.execute(...)`（`agent-loop.js:464`）→ 真实执行。
- 执行后 `finalizeExecutedToolCall`（含可选 `afterToolCall`）→ `tool_execution_end` → `createToolResultMessage` → `context.messages.push`（`agent-loop.js:491-555, 142-145`）→ 下一轮 LLM。
- `[EXP]` Case ALLOW：`executed=1, isError=[false]`。
- 默认 allow：hook 返回 `undefined` 即为放行（无显式对象要求）。
- Tool 抛异常：`executePreparedToolCall` catch → `createErrorToolResult`，`isError:true`（`agent-loop.js:479-486`），Agent 不崩溃，继续下一轮。

## 4. DENY Semantics

`[SOURCE]` `agent-loop.js:426-435, 384-385`
- `beforeToolCall` 返回 `{ block: true, reason, terminate? }` → `prepareToolCall` 返回 `{ kind:"immediate", result: createErrorToolResult(reason), isError:true }`。
- **`tool.execute` 永远不会被调用**（立即短路，不经过 `executePreparedToolCall`）。
- 构造的 ToolResult：`isError:true`，`content:[{type:"text", text: reason}]`，`details:{}`。
- 该 error ToolResult 经 `createToolResultMessage`（`role:"toolResult"`）→ 推送进 `context.messages`（`agent-loop.js:317-318, 142-145`）。
- **下一轮 LLM 能看到** `assistant(toolCall) → toolResult(denied/error)`，从而改口或说明。`[EXP]` Case DENY：`beforeToolCallCount=1, executed=0, isError=[true]`。
- `terminate` 语义：`shouldTerminateToolBatch` 仅当**整批**所有 result 的 `terminate===true` 才提前终止 loop（`agent-loop.js:384-385`）。`terminate:false`（默认）→ Agent 继续下一轮 LLM；`terminate:true` → 参与 batch 早停。
- Agent 最终都产生 `agent_end`（正常收敛）。`[EXP]` 同一 Run 内 DENY 后模型产生最终 assistant 答案并 `agent_end`。
- 多 Tool Call 同批：每 call 独立走 `beforeToolCall`，部分 DENY 部分 ALLOW 互不影响；DENY 的转为 error result，ALLOW 的正常执行。

## 5. ASK Semantics

`[SOURCE]` `agent-loop.js:412`（`const beforeResult = await config.beforeToolCall(...)`）
- Pi **没有** `pause/resume/suspend/checkpoint` 这样的正式 ASK 生命周期。
- 但 `beforeToolCall` 是 `await` 的：Hook 内部 `await waitForHumanApproval()` 会**阻塞当前 Agent Run** 直到 Promise resolve，resolve 后按 ALLOW/DENY 继续。
- 这就是"在 Hook 内等待审批"的可行性基础（Plan A）。批准后可执行**原始** Tool Call，无重复、无重新 LLM。
- 无内建 timeout；需 Enterprise 在 Hook 内自己实现超时/取消（用传入的 `signal`）。
- 不支持"暂停后从同一 Tool Call 恢复"——因为 Run 不返回，只是 await。

## 6. Async beforeToolCall

`[SOURCE]` `agent-loop.js:412` + 签名 `types.d.ts:240`（`(context, signal?) => Promise<BeforeToolCallResult | undefined>`）
- 支持 async：`await` 调用，Promise 未 resolve 前 loop 停在 `prepareToolCall`。
- `[EXP]` Case ASK：`beforeToolCall` 内 `await sleep(400)` 后放行 → `executed=1` 且执行发生在等待之后。证明 Run 确实等待 Hook 完成。
- Abort 可打断等待：`signal` 传入 Hook；`agent-loop.js:419` 在 await 后检查 `signal?.aborted` → 返回 "Operation aborted" 立即结果；且 `signal` 也传入 LLM stream（`agent-loop.js:192`），abort 会终止整个 run。
- 风险：等待期间**整个 Agent Run（及其 LLM 连接/排队）被占用**；同 run 内串行，无法并发处理其他审批。

## 7. Abort / Resume

`[SOURCE]` `agent.js:202, 330, 366-372`；`agent-loop.js:419-425`
- `abort()` 触发 `abortController.abort()`，停止整个 Run（LLM stream 收到 signal → `stopReason:"aborted"` → `agent_end`）。
- `finishRun` 清空 `activeRun` 但**不清除** `state.messages`（`agent.js:345-372`）。
- 在 `beforeToolCall` await 期间 abort：Hook 返回后 loop 检查 `signal?.aborted` → 该 Tool Call 转为 "Operation aborted" error result（`agent-loop.js:421-424`），不执行；但 Run 已在下一个 LLM turn 因 signal 而终止。
- **abort 后无法恢复"当前 Tool Call"**：没有 resume API，Pending Tool Call 不被保留为可恢复对象。`[INF]` 要从 abort 点继续，只能 `prompt()` 新 run（见 §9）。

## 8. State / Messages Persistence

`[SOURCE]` `agent.js:26-49, 214-225`
- Pi 拥有内存中的 `state.messages`（转录）、`state.tools`、`state.model`、`state.systemPrompt`。
- 无序列化 API；`messages` 是普通对象数组，Enterprise 可自行 `JSON.stringify` 快照（无 DB）。
- `reset()` 会清空 messages —— 恢复前勿调用。
- Pending Tool Call 的数据（id/name/args）在 `beforeToolCall` 的 `BeforeToolCallContext`（`types.d.ts:75-84`）中可得，但 Pi **不持久化**它。

## 9. steer / followUp

`[SOURCE]` `agent.js:173-179, 234-256`；`agent-loop.js:58-71, 32-34`
- `steer(msg)`：在当前 assistant turn 结束后注入一条消息（`agent-loop.js:112-119`）。
- `followUp(msg)`：仅在 Agent 将要停止时注入（`agent-loop.js:161-165`）。
- 二者都注入一条**新的 user 消息**，不是恢复某个 pending Tool Call；会让 LLM **重新决策**（可能重新发出同一 Tool Call）。
- `continue()`：`runAgentLoopContinue` 从当前 transcript 续跑，但要求最后一条消息是 `user` 或 `toolResult`（`agent-loop.js:32-34, 62-64`），否则抛错。
- `[EXP]` Resume 实验：DENY（无 terminate）后模型产出最终 assistant 答案，transcript 最后一条是 `assistant` → `continue()` 不可用（会抛 "Cannot continue from message role: assistant"）。要恢复只能 `prompt()` 新 run。
- 结论：`steer`/`followUp`/`continue` 都**不能**恢复一个尚未执行的 Tool Call；它们只能给 Agent 一条新消息 → 重新 LLM。

## 10. ASK Design Comparison

| Design | Pi Native Support | Feasible | Main Risk |
|---|---|---|---|
| A. Wait inside beforeToolCall | Partial：`beforeToolCall` 是 `await` 的，无内建 timeout/cancel（仅 AbortSignal） | Yes | 占用整个 Agent Run/连接直至审批完成；需自行处理超时；同 run 串行 |
| B. End Run + Resume（prompt/continue） | Partial：state 内存持久；`continue()` 存在但要求末条为 user/toolResult（自然 DENY 后末条为 assistant，不可用） | Yes（须用 `prompt()` 新 run） | LLM 重新决策可能**重新发出同一 Tool Call → 重复执行**；Enterprise 须自管 pending state 与去重 |
| C. Suspend / Resume | **No**：无 suspend/resume/pause/checkpoint API | No | 不可行（Pi 不支持） |

## 11. State Ownership

- **Pi Agent**：拥有并维护内存 transcript（`messages`）、`tools`、`model`、`systemPrompt`。不持久化 Pending Tool Call，无 checkpoint。
- **Enterprise Runtime（应拥有）**：`runId`、`policyDecision`、`approvalRequest`、`pendingToolCall { id, name, args }`、以及（Plan B 下）`agent.state.messages` 快照 + 已批准/已执行的 `toolCallId` 集合。Pi 仅提供可快照的 `messages` 数组。

## 12. Duplicate Execution Risk

`[SOURCE]` `agent-loop.js:130, 460-464`；`[INF]`
- Pi 自身**不会**重复执行：同一 Tool Call 在一次 Run 内只执行一次（由 LLM 当轮产生）。
- 重复风险仅在 Plan B（结束 Run 后 `prompt()` 新 run）：LLM 在恢复上下文中可能**重新发出相同 Tool Call** → 再次进入 `beforeToolCall` → 若放行则二次执行。
- 去重依据：`toolCall.id` 在 `BeforeToolCallContext` 中稳定可得（`types.d.ts:79`）。Enterprise 应维护"已批准/已执行 `toolCallId`"集合；对重复 id 可短路（注入缓存结果或再次 deny），避免副作用型 Tool 重复执行。
- Plan A（Hook 内 await）**无重复风险**：同一 Run、单次执行、批准后即执行原始 Call。

## 13. Recommendation

- `ALLOW` / `DENY`：直接用 `beforeToolCall` 返回 `undefined` / `{ block:true, reason }`，零 Pi 修改。
- `ASK`：**最小可行路径 = Plan A**（在 `beforeToolCall` 内 `await` 外部审批）。它是当前 Pi 唯一能在"不重新 LLM、不重复执行"前提下批准并执行**原始** Tool Call 的方式。
- 若审批耗时很长、不能占用 Run：采用 Plan B，但必须由 Enterprise 拥有 pending state 并用 `toolCallId` 去重；接受重新 LLM 的可能性。
- **不采用 Plan C**：Pi 无 suspend/resume。
- 边界保持清晰：**LLM 负责"决策调用哪些 Tool"；Enterprise（经 `beforeToolCall`）负责"是否允许执行"**。

## 14. Evidence

| 结论 | 文件:行 | 标记 |
|---|---|---|
| `beforeToolCall` 被 `await` 调用 | `agent-loop.js:412` | `[SOURCE]` |
| DENY 短路、构造 error ToolResult、不执行 | `agent-loop.js:426-435` | `[SOURCE]` |
| `terminate` 批量早停规则 | `agent-loop.js:384-385` | `[SOURCE]` |
| 真实执行点 `prepared.tool.execute` | `agent-loop.js:464` | `[SOURCE]` |
| `beforeToolCall` 经 Agent 透传 | `agent.js:123, 300` | `[SOURCE]` |
| `subscribe` observe-only（返回值丢弃） | `agent.js:146-149, 417-419` | `[SOURCE]` |
| `prompt()` 禁止并发 run | `agent.js:227-229` | `[SOURCE]` |
| `continue()` 要求末条 user/toolResult | `agent-loop.js:32-34, 62-64` | `[SOURCE]` |
| AbortSignal 传入 LLM 与 hook | `agent-loop.js:192, 419` | `[SOURCE]` |
| ALLOW 执行成功 | 实验 Case ALLOW `executed=1` | `[EXP]` |
| DENY 不执行、isError | 实验 Case DENY `executed=0, isError=[true]` | `[EXP]` |
| async beforeToolCall 可行 | 实验 Case ASK `executed=1`（400ms 后） | `[EXP]` |
| 自然 DENY 后末条=assistant → continue 不可用 | 实验 Resume 末条 `role=assistant` | `[EXP]` |
| Pi 无 suspend/resume API | 无对应方法（仅 prompt/continue/steer/followUp/abort/reset） | `[SOURCE]` |

---

### 必须回答的 8 个问题

1. **ALLOW 准确语义**：`beforeToolCall` 返回 `undefined`/无 block → `prepareToolCall` 返回 `prepared` → `tool.execute` 执行 → ToolResult 入 context → 下一轮 LLM。默认即放行。
2. **DENY 准确语义**：返回 `{ block:true, reason }` → 立即构造 `isError:true` 的 ToolResult（content=reason），**`tool.execute` 永不调用**；无 `terminate` 则 Agent 继续并见 denied 结果；有 `terminate:true` 参与批量早停。
3. **ASK 当前 Pi 是否原生支持**：**否**（无 suspend/resume/pause/checkpoint）。但 `beforeToolCall` 是 `await` 的，可在 Hook 内等待审批（Plan A）。
4. **beforeToolCall 能否 async 等待**：**能**，被 `await`（`agent-loop.js:412`）；`[EXP]` 已验证 await 400ms 后执行。
5. **abort() 后能否恢复当前 Tool Call**：**不能**。abort 终止整个 Run；Pending Tool Call 不被保留为可恢复对象；无 resume API。
6. **steer()/followUp() 能否恢复 pending Tool Call**：**不能**。它们注入新 user 消息，使 LLM 重新决策（可能重发 → 重复）；`continue()` 要求末条 user/toolResult，自然 DENY 后末条为 assistant 故不可用。
7. **Pi 不支持 suspend/resume 时，pending state 由谁存**：**Enterprise Runtime** 拥有 `runId`/`policyDecision`/`approvalRequest`/`pendingToolCall{id,name,args}` 及 `messages` 快照与已执行 `toolCallId` 集合；Pi 仅持内存 transcript。
8. **ASK 应采用哪种生命周期模型**：**Plan A（Hook 内 await 审批）** 为最小可行且零修改、无重复；长耗时审批用 Plan B（Enterprise 自管 pending + `toolCallId` 去重），接受重 LLM。**不采用 Plan C**。

```text
PHASE 4-B INVESTIGATION: COMPLETE
CODE CHANGED: NO
```
