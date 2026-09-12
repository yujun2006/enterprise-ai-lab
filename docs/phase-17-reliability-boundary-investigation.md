# Phase 17 — Reliability Boundary Investigation

## 1. Executive Summary

**核心结论：Reliability 的"包络边界"是 Run（执行边界）；但唯一可安全自动重试的最小单元是 LLM Call 与 read-only Tool。State-changing Tool / Turn / Run 绝不能盲目重试——它们的幂等性不归 Runtime，而归 Tool / External Resource。**

```text
Reliability 必须回答的不是"让系统可靠"，而是：
  - Retry 重试什么？  → 仅 LLM Call + read-only Tool；state-changing 需 Tool 提供幂等键
  - Checkpoint 存什么？ → Agent State + Run Context + 外部 Operation ID（≠ Trace）
  - Persistence 存什么？ → Session/messages + Run Context + Resource Reference（≠ Resource Data）
  - Resume 从哪续？ → 重建 Agent State → 新 Run（Pi 不原生耐久）；并回查 External Resource
  - Idempotency 归谁？ → Tool / External Resource（Runtime 只透传幂等键）
  - 哪些 Failure 不能自动重试？ → Unknown Outcome（timeout 后外部已执行）、non-idempotent 副作用
```

```text
PHASE 17 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RETRY / TIMEOUT / CHECKPOINT / PERSISTENCE / RESUME: NOT IMPLEMENTED
```

## 2. What Is the Reliability Unit?

`[DECISION]`（基于 §4 矩阵 + 实验）

- **Model A（LLM Call）**：最安全重试单元。LLM 请求无外部副作用；重试风险低（仅部分 stream 需丢弃重来）。✅ 可作为自动重试对象。
- **Model B（Tool Call）**：取决于幂等性。READ/GET 安全；WRITE/DELETE 非幂等 → 重复副作用风险高。⚠️ 条件重试。
- **Model C（Turn）**：重试整 Turn = 重跑 Turn 内所有 Tool → 若含 state-changing Tool，重复副作用风险高。❌ 不应盲重试。
- **Model D（Run）**：重试整 Run = 重跑全部 Turn/Tool → **重复副作用风险 CRITICAL**（Phase 13 已证 `2→4→6`）。❌ 绝不盲重试 state-changing Run。
- **Model E（Agent Execution）**：多 Run 的 Session 作为 Durable Unit → 需要 Persistence/Checkpoint/Resume，但 External 业务状态必须由外部系统提供，不能由 Runtime 快照替代。⚠️ 仅当耐久需求出现才构建。

**选定**：Reliability 关注单元 = **Run（执行边界）**；安全自动重试最小单元 = **LLM Call + read-only Tool**。State-changing 重试必须由 Tool/External 幂等契约担保。

## 3. Reliability Boundary Matrix

`[SOURCE]`（src 无 retry/checkpoint/persist/resume/timeout，确认未实现）+ `[EXP]`（Exp1-3）+ `[INF]`

| Boundary        | Can Retry?                  | Duplicate Side Effect Risk | Needs Checkpoint?        | Needs Persistence?            | Owner                          |
| --------------- | --------------------------- | -------------------------: | -----------------------: | ----------------------------: | ------------------------------ |
| LLM Call        | ✅ 安全（无副作用）           |                          低 | ❌（in-flight 不可续）     | ❌（瞬时）                     | Pi / Provider                  |
| Tool Call       | ⚠️ 仅 read-only / 幂等 Tool  |                          高（write/delete） | ⚠️ 仅记 outcome/OpID    | ❌（Runtime 不能）             | Tool / External Resource        |
| Turn            | ❌ 盲重试会重跑 Tool          |                          高 | ❌（重跑=副作用）          | ✅ messages                   | Runtime（谨慎）/ Tool          |
| Run             | ❌ 盲重试复制副作用（2→4→6）  |                        CRITICAL | ✅ Run Context          | ✅ Session/messages+RunCtx    | Runtime / Tool(幂等)           |
| Agent Execution | ⚠️ 仅经外部 OpID 对账后       |                          中（依赖 Tool） | ✅ Agent State+OpIDs    | ✅ Session+RunCtx+ResRef      | Runtime（耐久层）/ External    |

## 4. Failure Taxonomy

`[DECISION]`

必须区分 **FAILURE**（确定未成功）与 **UNKNOWN OUTCOME**（无法确定是否成功）：

```text
1. LLM Provider Failure      → FAILURE（无副作用）→ 可重试（Model A）
2. Network Failure           → FAILURE（请求未达/响应未回）→ 视是否幂等
3. Stream Interruption       → FAILURE（部分 token）→ 丢弃重来（Model A）
4. Tool Failure              → 业务 FAILURE → 仅幂等/声明安全才可重试
5. Tool Timeout              → UNKNOWN（外部可能已执行）→ 不可盲重试
6. Policy Failure            → 非 Failure，是 Governance 否决 → 不重试（Phase 4/13）
7. Runtime Process Crash     → UNKNOWN（in-flight 全失）→ 见 Exp1
8. Agent Process Crash       → 同上
9. External Resource Failure → FAILURE（外部未提交）→ 可重试若幂等
10. Credential Failure       → FAILURE（配置/权限）→ 不重试（需人工）
11. Resource Conflict        → FAILURE（并发）→ 需外部锁/重试策略
12. Partial Execution        → UNKNOWN（部分提交）→ 不可盲重试
13. Unknown / Ambiguous      → UNKNOWN → 必须视为不可自动重试
```

**最关键**：`Timeout ≠ Failure`。`charge_card()` 超时可能是"已扣款但响应丢失" → UNKNOWN。Runtime 绝不能简单 `timeout = failure`。

## 5. Retry Semantics

`[DECISION]`

```text
Retry Unit      = LLM Call + read-only Tool（state-changing 需 Tool 声明安全）
Retry Condition = 仅确定性失败（provider/network/stream）且无副作用，或操作幂等
Retry Count     = Runtime 控制（LLM/只读），state-changing 由 Tool 契约限定
Retry Identity  = 外部 Idempotency Key / Operation ID
                  （toolCallId 跨 Run 不稳定 → 不可用，Phase 13 已证）
Retry Safety    = Tool / External Resource 拥有（Runtime 只透传幂等键）
Retry Owner     = Enterprise Runtime（执行 LLM/只读重试）；state-changing 安全契约在 Tool
```

## 6. Idempotency Boundary

`[DECISION]`（Model D：Shared responsibility，但可强制 owner = External/Tool）

| Tool                | 类型           | 幂等？               | 谁担保                          |
| ------------------- | -------------- | -------------------- | ------------------------------- |
| `read_file`/`get_*` | Read-only      | ✅（安全重试）        | Runtime 可直接重试              |
| `write_file`(按路径) | State-changing | ⚠️ 覆盖即幂等        | Tool 提供 path 作为天然键       |
| `update_database`   | State-changing | ⚠️ 取决于键          | Tool/External 提供 Operation ID |
| `create_order`      | Non-idempotent | ❌                   | External 提供 Idempotency Key   |
| `charge_card`       | Non-idempotent | ❌                   | External 提供 Idempotency Key   |
| `send_email`        | Non-idempotent | ❌                   | External 提供 Idempotency Key   |
| `delete_customer`   | Non-idempotent | ❌（重复删除危险）    | External 提供 Operation ID      |

**结论**：Runtime **绝不可伪造幂等性**；它只能把 Tool/External 提供的幂等键透传给外部系统。Idempotency 的最终 owner = **Tool / External Resource**。

## 7. Unknown Outcomes

`[DECISION]` + `[EXP]`

```text
Operation started → External executed → Response lost → Runtime sees timeout
= UNKNOWN（不是 FAILURE）
```

- Retry 是否安全？**否**，除非有 Idempotency Key（External 去重）。
- Runtime 下一步：**记录 UNKNOWN → 上报 Recovery Decision Owner（Runtime, Phase 13）→ Escalate / Ask-Human / 外部 Status-Query / Reconciliation**。
- 未来原语（仅调查，不实现）：Idempotency Key、Operation ID、External Status Query、Reconciliation。

`[EXP]` Exp1：Tool 先 `appendFileSync` 提交外部副作用 → `process.exit(137)` 崩溃。崩溃后外部 record.txt **存活**，但 Runtime 对本次 Run 结果为 UNKNOWN（无 Tool result 回传）。证明：External Resource 是副作用真相，Runtime 在崩溃点无法知会结果。

## 8. Checkpoint Boundary

`[DECISION]`

```text
Checkpoint = "execution 可安全 resume 的位置"
组成：
  - Agent State 快照（messages / tools / model / systemPrompt）  ← 重建推理
  - Run Context（runId / signal / policyCtx / prompt）            ← 重建执行边界
  - 外部 Operation ID / committed-flag                            ← 对账 Unknown
```

**Checkpoint ≠ 仅存 messages**（Model A 不足）；也 ≠ 仅存 Agent State（Model B 不足，缺 Run Context + OpID）；正确是 Model C + 外部 OpID。

`[EXP]` Exp2：同进程新建 `rt2`，transcript=0 → Pi 的 Agent State 是内存态，不耐久。故 Enterprise Runtime 若需耐久 Checkpoint，必须在 Pi 之上**自行构建**（Pi 不原生支持 durable resume）。

## 9. Checkpoint vs Trace

`[DECISION]`

```text
Trace  = "What happened?"      （Observation，Phase 3）
Checkpoint = "Where to resume?" （Resumable State）
```

```text
Trace:  LLM#1 → Tool A → Result → LLM#2 → Tool B started → Tool B timeout
≠ Checkpoint: safe to resume before Tool B
```

原因：Trace 显示 "Tool B started/timeout" **不能推出** Tool B 是否在外部已提交（Exp1 已证：外部已写但 Runtime 只看到崩溃）。Checkpoint 必须记录 **Tool 返回的 external Operation ID / committed 标志**，不能从 Trace 推断。

## 10. Persistence Boundary

`[DECISION]`

```text
必须跨进程生命周期存在的状态：
  ✅ Session / messages        （恢复推理）
  ✅ Run Context               （恢复执行边界）
  ✅ 外部 Operation ID         （对账 Unknown）
  ✅ Resource Reference        （Phase 15：workspaceId/resourceId/accessScope，非 Data）
不应由 Runtime 保存：
  ❌ Resource Data             （External 拥有，Phase 15）
  ❌ Tool 定义                 （可从代码重建）
  ❌ in-flight LLM stream      （瞬时，丢弃重来）
```

Persistence ≠ 必须 Database；但必须是 **外部存储**（进程死亡后内存全失，Exp2 已证）。

## 11. Resume Boundary

`[DECISION]` + `[EXP]`

```text
Pi 原生 durable resume？ → 否（agent.state 内存态，Exp2 证明）。
Enterprise Runtime 若需 Resume：
  Reconstruct Agent State（从持久化 Session/messages）
    → New Run（同 Run Context + 外部 OpID）
    → 继续
  NOT "continue same in-flight Run"
  AND 必须回查 External Resource 实际状态（Runtime 快照不能替代 External 真相）
```

即：Resume = 重建 Agent State + 新 Run + 外部状态对账。Pi 不原生支持，Runtime 在 Pi 之上构建。

## 12. Process Crash Experiment（Exp A–E 映射）

`[EXP]`（本实验聚焦关键位置：Tool 内副作用已提交→崩溃；并以实例隔离代理"进程重启"）

```text
原理（所有位置 A–E 统一）：
  Pi 的 agent.state（messages/tools/model/systemPrompt）全部内存态
  → 进程崩溃 = 全部 in-memory 丢失
  → 仅"已完成并写入外部"的副作用 与 "外部持久化状态" 存活
```

| 位置 | 实验结论 |
| --- | --- |
| A Before LLM | 无副作用；Session 丢失（内存） |
| B After LLM before Tool | 无副作用；Session 丢失 |
| C During Tool | **已完成副作用存活外部；Run UNKNOWN**（Exp1 实测 `PRE-CRASH SIDE EFFECT` 存活） |
| D After Tool before Result | 同 C：外部已提交，Runtime 未收 result → UNKNOWN |
| E After Result before next LLM | messages 未落外部 → 丢失（除非已持久化） |

`[EXP]` Exp2（实例隔离=代理重启）：`rt1` transcript=4 消息，`rt2`=0 → 无外部持久化则 Session 丢失。
`[EXP]` Exp3：2 Run → 2 外部副作用行 → 重跑 Run 复制副作用（镜像 Phase 13 `2→4→6`）。

## 13. Timeout Boundary

`[DECISION]`

```text
Timeout = Runtime 对 Run Context 的控制信号（Phase 9：Runtime 拥有 abort）
  - LLM Timeout    → Runtime signal → abort / 重试（安全）
  - Tool Timeout    → Resource Access Boundary（Phase 15：External 拥有强制）
  - Turn/Run Timeout → Runtime signal（不自动恢复）
```

Timeout **不成为独立 Reliability subsystem**（当前阶段）。它是 Run Context 的控制信号，由 Runtime 经 `abort()` 施加。Unknown Outcome 经 §7 处理，不自动重试。

## 14. Retry vs Abort

`[DECISION]`

```text
LLM Failure        → Retry（安全，Model A）
Tool Failure       → 仅幂等/声明安全 Retry；否则 Abort → Recovery Owner 决定（Phase 13）
Policy Failure     → 不重试（Governance 否决，Phase 4/13）
Timeout            → Abort（signal）；Unknown Outcome → Escalate
Unknown Outcome    → Escalate / 外部对账；绝不盲重试
```

边界保持：Recovery Decision Owner = Enterprise Runtime（Phase 13）。不设计完整 Recovery Framework。

## 15. Reliability and Policy

`[DECISION]`

```text
Policy = Tool Call Governance（一次决策对应一次 Tool Call，Phase 4）
Retry = 一次新的 Tool Call → 必须重新评估 Policy（fresh decision）
Policy ≠ Retry Manager / Recovery Manager
```

保持 Phase 4 边界：Retry 是新的调用，需重新走 Policy；Policy 不被改造成重试/恢复管理器。

## 16. Reliability and Workspace / Resource

`[DECISION]` + `[EXP]`

```text
Tool → Resource → External System
崩溃/超时后，Runtime 仅凭 Tool/Trace 无法判断 Resource 是否已变。
write_file() timeout：文件可能未写，也可能已写。
→ External Resource = Reliability 的最终事实来源。
→ Checkpoint/Trace 不能替代 External Resource State。
```

`[EXP]` Exp1：外部 record 存活、Runtime UNKNOWN → External 是真相。结合 Phase 15：Runtime 拥有 Resource Access Boundary，External 拥有 Resource Data；Reliability 的"已提交"事实在 External。

## 17. Multi-Agent Reliability

`[INF]`（结合 Phase 16）

```text
Agent A → Delegation → Agent B
B Run Failure = Agent B Recovery（Runtime Owner）→ 错误回传 A 的 LLM loop（Phase 16 Exp2）
跨 Agent Retry = Agent A 的 loop 决定（重试委托 Tool）→ 无 global retry/checkpoint/scheduler
```

**Phase 16 "无 Coordinator" 结论仍然成立**。仅当出现 global retry / global checkpoint / global state / global scheduling 才需讨论新 Coordinator Boundary——当前无证据。

## 18. Harness Boundary

`[INF]`（结合 Phase 10）

```text
Harness = 概念执行边界（Phase 10）
Reliability（Retry/Timeout/Checkpoint/Persistence/Recovery）= Runtime-level 关注点，
  位于 Pi 之上、Harness 控制范围内，作为 Control Plane 职责，而非 Pi 内部。
```

不把 Reliability 塞进 Pi（不改 Pi）；不作为独立 subsystem（除非证据要求）。保持为 Runtime（Control Plane）责任。

## 19. Final Decision

```text
PHASE 17 INVESTIGATION: COMPLETE

RELIABILITY UNIT:           Run（执行边界）是关注单元；安全自动重试最小单元 = LLM Call + read-only Tool
RETRY UNIT:                 LLM Call + read-only Tool（安全）；state-changing Tool/Turn/Run = 禁止盲重试
RETRY IDENTITY:             外部 Idempotency Key / Operation ID（toolCallId 跨 Run 不稳定，不可用）
RETRY SAFETY OWNER:         Tool / External Resource（Runtime 仅透传幂等键）
UNKNOWN OUTCOME:            视为不可自动重试 → Escalate / 外部 Status-Query / Reconciliation
IDEMPOTENCY OWNER:          Tool / External Resource（Runtime 不伪造幂等）
CHECKPOINT:                 Agent State + Run Context + 外部 Operation ID（≠ Trace）
PERSISTENCE:                Session/messages + Run Context + Resource Reference（≠ Resource Data，≠ in-flight stream）
RESUME:                     重建 Agent State → 新 Run（Pi 不原生耐久）+ 回查 External Resource
TIMEOUT:                    Run Context 控制信号（Phase 9）；非独立 subsystem
RELIABILITY OWNER:          Enterprise Runtime（Control Plane），位于 Pi 之上
RELIABILITY ↔ POLICY:       每次（重试）调用重新评估 Policy；Policy ≠ Retry/Recovery Manager
RELIABILITY ↔ WORKSPACE/RES: External Resource = 真相；Checkpoint/Trace 不替代 External State
MULTI-AGENT RELIABILITY:    Phase 16 无 Coordinator 仍成立
HARNESS:                    Reliability 属 Runtime 职责，不进 Pi、不独立 subsystem

RETRY / TIMEOUT / CHECKPOINT / PERSISTENCE / RESUME: NOT IMPLEMENTED (DEFERRED)
CODE CHANGED: NO
```

---

```text
STOP CONDITION: 已回答 —
  Reliability 包络什么 / Retry 重试什么 / Checkpoint 存什么 / Persistence 存什么 /
  Resume 从哪续 / Idempotency 归谁 / 哪些 Failure 不可自动重试 /
  以及 LLM Call·Tool Call·Turn·Run·Agent Execution 各边界矩阵。

本 Phase 结束，不进入 Phase 18，不实现 Retry/Timeout/Checkpoint/Persistence/Resume/
Idempotency Framework/Recovery Framework。仅确立边界，待未来证据（如生产耐久需求、
Unknown Outcome 对账、跨 Run 恢复）出现再实现对应最小原语。
```
