# Phase 19 — Durable Recovery Boundary Investigation

## 1. Objective

> **进程死亡后，系统拿着已经持久化的最小信息，如何判断"之前到底发生了什么"，以及"现在从哪里安全继续"。**

核心模型（本阶段证明，不实现）：

```text
Reconstruct → Reconcile → Decide → Resume
```

- **Reconstruct**：用持久化 Session + Run Context + 外部 Resource Reference + Operation Identity，创建**新 Pi Agent** + **新 Run**。
- **Reconcile**：用 operationId/idempotencyKey 向 External Resource 查询真实副作用状态。
- **Decide**：Runtime 决定 CONTINUE / SKIP / RETRY / ESCALATE。
- **Resume**：开启新 Run 继续。

```text
PHASE 19 INVESTIGATION: COMPLETE
CODE CHANGED: NO
RECOVERY / RECOVERYMANAGER / RETRY / CHECKPOINT / PERSISTENCE: NOT IMPLEMENTED (DEFERRED)
```

## 2. Existing Boundaries from Phase 17/18

`[SOURCE]`（docs/phase-17-*.md, phase-18-*.md，均为本系列已确立结论）

```text
Phase 17: Reliability envelope = Run；Run 不是安全盲重试单元。
          安全自动重试最小单元 = LLM Call + read-only/idempotent Tool。
          State-changing Tool 重试需幂等/外部对账；Idempotency 归 Tool/External。
          UNKNOWN ≠ FAILED；toolCallId 跨 Run 不稳定（非耐久身份）。
Phase 18: Agent State 不可直接序列化恢复；恢复 = 持久 Session + Run Context + Resource Reference + OpID
          → 新 Pi Agent → 重建 Session → 对账 External → 决定 → 新 Run。
          Checkpoint ≠ Trace；Persistence 存 messages+sessionId+RunCtx+OpID+ResRef；
          Resource Data 不持久（External 拥有）。
```

## 3. Source Evidence

`[SOURCE]`

| 证据 | 位置 | 含义 |
| --- | --- | --- |
| `AgentState.messages/systemPrompt/model/thinkingLevel/tools` 为数据；`isStreaming/streamingMessage/pendingToolCalls/errorMessage` 为 transient | `pi-agent-core/dist/types.d.ts:290-315` | 可重建 vs 不可持久 |
| `sessionId?` 是 Pi 原生 Session 标识 | `pi-agent-core/dist/agent.d.ts:50` | 跨实例稳定的 Session 身份 |
| `private activeRun` | `pi-agent-core/dist/agent.d.ts:48` | 在内存 live 执行态，不可恢复 |
| `TraceCollector.current/last` 全内存；`runId=randomUUID()` | `src/trace/collector.ts:46-47,54,142` | Trace in-memory；runId 不耐久 |
| `ToolRegistry` 按 name 索引 | `src/tools/registry.ts:18-40` | tools 按名重建，不序列化函数 |
| `beforeToolCall → evaluatePolicy(this.policy,...)` 每次 Tool 调用都执行 | `src/runtime.ts:52-57` | Policy 逐 Tool Call 重评估（Recovery 不绕过） |
| `createOllamaRuntimeDeps(sink?)` sink 可选 | `src/ollama/model.ts:61` | 可构造裸 Pi Agent 验证重建 |

## 4. Crash Experiments

`[EXP]`（真实 Pi + Runtime + Ollama；临时脚本已删除）

**Part A — Exp5/6（UNKNOWN → SKIP）**：子进程在 Tool 内提交外部记录（`{opId,status:COMMITTED}`）后 `process.exit(137)`；崩溃前已持久化 Checkpoint（含 `operationId`）。父进程重启后：

```text
[崩后] External store: {"op-7f3a-commit":{"status":"COMMITTED",...}}
[崩后] 持久 Checkpoint.opId: "op-7f3a-commit"
[Reconcile] 按 opId 查 External → SUCCESS
[Decide]     SKIP（已提交，绝不重试）
```

→ 外部副作用已提交且存活；Runtime 未收 result；**对账 External 得 SUCCESS → SKIP（非 FAILED / 非 RETRY）**。

**Part B — Exp7/8（重建 Session → 新 Run → read-only 安全）**：

```text
rt1 transcript msgs=4 → 持久到 session.json
重建 Agent messages=8（注入 4 + 新轮）→ read-only Tool OK
```

→ 持久 `messages`+`sessionId` 注入新 Pi Agent → 同 Session 逻辑连续；read-only Tool 安全重放。

**Part C — Exp10（Policy 重评估，源码级）**：`runtime.ts:52-57` 证明每次 Tool Call 都经 `evaluatePolicy`。Recovery = 新 Run = 新 Tool Call → **Policy 必然重评估，不绕过**。实验尝试以 DENY 观测因模型未发起 Tool Call 而未触发（flaky），但该机制由 `[SOURCE]` 直接保证。

## 5. Reconstruction Findings

`[DECISION]` + `[SOURCE]` + `[EXP]`

```text
Reconstruct 最少需要（Phase 18 已证）：
  - messages（transcript 数据）
  - sessionId（Pi 原生标识）
  - systemPrompt / model.id / thinkingLevel（配置，可重派）
  - tools（name 列表，按 Registry 重建）
  - Run Context（prompt / parentRunId / 激活 ctx 引用）
  - 外部 operationId（in-flight Tool，供对账）
  - Resource Reference（workspaceId/resourceId，Phase 15）

不能恢复（且不应尝试序列化）：
  - activeRun / AbortController / streamingMessage / pendingToolCalls
  - listeners / queues / streamFunction / closures / provider client
  → 这些是新 Pi Agent 构造时重供的 live 执行态

新 Agent / 新 Run 与原 Session / Run 的关系：
  - 新 Agent.sessionId = 原 sessionId（逻辑连续同一 Session）
  - 新 Run.runId = 新生成（原 runId 不耐久；用 parentRunId 关联原 Run）
  - 原 Run 标记 interrupted；新 Run 承接同一 Session 继续
```

Exp7/8 已实证：新 Agent 注入 `messages`+`sessionId` 即恢复 Session，新 Run 可继续。

## 6. Reconciliation Findings

`[DECISION]` + `[EXP]`

```text
Reconcile 谁说了算？
  - Runtime 持有 operationId（来自持久 Checkpoint）
  - External Resource 持有真实副作用状态
  - Trace 不足以判定（Phase 18 Case C：崩溃时仅 tool_execution_start，无 end）

对账三态（Part A 实测 SUCCESS；NOT_FOUND/UNKNOWN 由同一 queryExternal 逻辑得出）：
  SUCCESS   → 外部已提交 → SKIP
  NOT_FOUND → 外部未提交 → 可 RETRY（仅 read-only/idempotent）否则 ESCALATE
  UNKNOWN   → 外部自身无法判定 → ESCALATE
```

## 7. UNKNOWN Semantics

`[DECISION]`（区分 FAILED 与 UNKNOWN）

```text
FAILED  = 确定未成功（Tool 返回 error / Policy DENY / Provider 明确失败）
UNKNOWN = 无法确定是否成功（外部可能已提交，但 Runtime 未收 result）

细分 UNKNOWN 来源：
  1. Tool never started                 → 外部 NOT_FOUND → 可安全重执行（idempotent）
  2. Tool started, no external commit   → 外部 NOT_FOUND → RETRY/idempotent
  3. External committed, result lost    → 外部 SUCCESS   → SKIP（Exp5/6 实测）
  4. External status query unavailable  → 外部 UNKNOWN  → ESCALATE
  5. External status itself UNKNOWN      → 外部 UNKNOWN  → ESCALATE
```

**关键规则（Exp5/6 证明）**：绝不能仅因"未收到 Tool result"就判定 FAILED；可能已提交 → 必须先对账 External。

## 8. Safe Resume Point

`[DECISION]`（6 个崩溃位置矩阵）

| # | 崩溃位置 | 可恢复？ | 恢复点 | 需 External 对账？ | 可 Retry？ | 只能 Escalate？ |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | LLM 前 | ✅ | 新 Run（重发 prompt） | ❌ | ✅ LLM（无副作用） | ❌ |
| 2 | LLM 中 | ✅ | 重请求 LLM | ❌ | ✅ LLM | ❌ |
| 3 | LLM 完，Tool 前 | ✅ | 新 Run 重规划/重调 Tool | ⚠️ 若 state-changing 须确认未提交 | ⚠️ 仅 idempotent | ❌ |
| 4 | Tool 执行中（提交前） | ✅ | 对账→NOT_FOUND | ✅ | ✅ idempotent | 否则 ESCALATE |
| 5 | 外部提交后，result 前 | ✅ | 对账→SUCCESS→SKIP | ✅ | ❌（已提交） | ❌ |
| 6 | result 已得，下轮 LLM 前 | ✅ | 下轮 LLM | ❌ | ✅ LLM | ❌ |

**Safe Resume Point 定义**：恢复点必须是"外部副作用状态已确定（SUCCESS/NOT_FOUND 且可安全重执行）或纯无副作用的 LLM 边界"。在 #4/#5 必须**先对账 External** 才能定位安全点；#5 只能 SKIP，不能 RETRY。

## 9. Operation Identity

`[DECISION]` + `[SOURCE]`

| Identity | 生命周期 | durable? | 适合作 External Operation Identity? |
| --- | --- | --- | --- |
| `sessionId` | Session | ✅（Pi 原生，agent.d.ts:50） | 仅作关联/相关键，非单操作身份 |
| `runId` | Run | ❌（`randomUUID`，collector.ts:54） | 否 |
| `toolCallId` | Tool Call | ❌（跨 Run 不稳定，Phase 17） | 否 |
| `operationId` | External Operation | ✅（Tool/External 分配，存 Checkpoint） | ✅ 是 |
| `idempotencyKey` | Operation | ✅（External） | ✅ 是（去重/安全重试） |

**结论**：跨进程/Run 稳定的身份 = `operationId` + `idempotencyKey`（Tool/External 拥有）；`sessionId` 耐久作关联；`runId`/`toolCallId` 不是。`[EXP]` Part A 用持久 Checkpoint 的 `operationId` 成功对账。

## 10. Recovery Decision Ownership

`[DECISION]`（结合 Phase 13/17/18）

```text
Decide owner = Enterprise Runtime（Recovery Decision Owner，Phase 13）
候选 CONTINUE / SKIP / RETRY / ESCALATE 由 Runtime 在对账 External 后决定。

区分两个独立问题（不得混为一谈）：
  Policy:  "这个 Tool Call 能否执行？"        → 逐调用治理（Phase 4，runtime.ts:52）
  Recovery:"中断 Run 后是否继续 / 如何继续？"   → Runtime 决策（本 Phase）
```

## 11. Policy Interaction

`[DECISION]` + `[SOURCE]`

```text
Recovery replay = 新 Run = 新 Tool Call
  → runtime.ts:52-57 的 beforeToolCall 必然调用 evaluatePolicy
  → Policy 逐调用重评估，Recovery 不绕过 Policy

恢复后重执行 Tool：
  - 若 Policy DENY/ASK → 该 Tool Call 被阻止（与正常 Run 一致）
  - Recovery 的 Continue/Skip/Retry 决策独立于 Policy；Policy 只在"实际执行某 Tool"时介入
```

## 12. External Resource Boundary

`[DECISION]` + `[EXP]`

```text
External Resource = 真实世界副作用的最终事实来源（Phase 15/18）
  - Runtime 不拥有 Resource Data（Phase 15）
  - Runtime 持 Resource Reference + operationId，向 External 查询
  - Reconcile = Runtime 读 External（Exp5/6 实测 SUCCESS→SKIP）

Trace / Checkpoint 不能替代 External 状态：
  Trace 只观测；Checkpoint 只记"去哪继续 + opId"，不持有业务数据
```

## 13. Multi-Agent Implications

`[INF]`（结合 Phase 16）

```text
A delegate B；B 执行 Tool；B 崩溃：
  - B = 独立 Runtime 实例（Phase 16）→ B 用自身 Checkpoint + External 独立恢复
  - A 经 Tool result 知 B 结果；若 B 崩溃前未回传，A 的 Run 亦中断 → A 恢复自身 Run
  - 二者均独立 Reconstruct→Reconcile→Decide→Resume
  - 无需共享 Recovery Manager / Coordinator；parentRunId 关联元数据足够

Phase 16 "No Coordinator" 结论仍然成立（无证据要求新边界）。
```

## 14. Harness Boundary

`[DECISION]`（结合 Phase 10）

```text
Recovery 属于 Enterprise Runtime（Control Plane）职责，不是 Pi 内部，也不是新 subsystem。
Harness 保持概念边界（Phase 10）。
  Pi        = execution engine（重建新 Agent）
  Runtime   = recovery decision owner（Reconstruct/Reconcile/Decide/Resume）
  External   = side-effect truth
  Policy     = Tool Call governance（恢复重评估）
  Trace      = observation
  Checkpoint = safe continuation info（持久）
  Persistence= durable info（持久）
```

## 15. Recovery State Machine

`[DECISION]` + `[EXP]`

```text
        RUNNING
           │ (process death)
           ▼
      PROCESS_DEATH
           │
           ▼
      RECONSTRUCT ── 持久 Session+RunCtx+OpID+ResRef → 新 Pi Agent + 新 Run
           │
           ▼
      RECONCILE ──── 按 operationId 查 External Resource
           │
     ┌──────┼──────────────┐
     ▼      ▼              ▼
 SUCCESS  NOT_FOUND      UNKNOWN
     │      │              │
     ▼      ▼              ▼
   SKIP   RETRY?(idempotent  ESCALATE
          /safe) else
          ESCALATE
     │      │
     └──────┴──────→ RESUME（新 Run 继续）
```

> 禁止 `UNKNOWN → RETRY` 简单规则（Phase 8 要求）。SUCCESS 必须 SKIP；NOT_FOUND 仅在 idempotent/safe 时可 RETRY；UNKNOWN 必须 ESCALATE。

## 16. Final Architecture Decision

```text
RECOVERY DEFINITION:
  Reconstruct → Reconcile → Decide → Resume（基于持久最小信息的安全恢复）

RECONSTRUCTION BOUNDARY:
  新 Pi Agent（注入持久 messages+sessionId+config）；不恢复 activeRun/streaming/abort

RECONCILIATION BOUNDARY:
  External Resource 用 operationId/idempotencyKey 告知真实副作用；Trace 不足

SAFE RESUME POINT:
  外部副作用已确定（SUCCESS/NOT_FOUND 可安全重执行）或纯 LLM 无副作用边界；#4/#5 须先对账

UNKNOWN HANDLING:
  绝不等同 FAILED；SUCCESS→SKIP，NOT_FOUND→RETRY(idempotent)，UNKNOWN→ESCALATE

DECISION OWNER:
  Enterprise Runtime（CONTINUE/SKIP/RETRY/ESCALATE，在对账后）

OPERATION IDENTITY:
  operationId + idempotencyKey（Tool/External，耐久）；sessionId 关联；runId/toolCallId 否

  > [CORRECTION-22 / C1] 此“operationId 耐久”断言被 Phase 20 实现 + Phase 21 冻结审计推翻：`operationId`
  > 仅正常完成时（`afterToolCall`）持久，崩溃时不持久；crash-safe 耐久对账身份仅为 `idempotencyKey`。

POLICY INTERACTION:
  Recovery=新 Tool Call → Policy 逐调用重评估（runtime.ts:52），不绕过

EXTERNAL RESOURCE:
  side-effect truth；Runtime 持 Reference+OpID 查询，不拥有 Data

MULTI-AGENT:
  每 Agent 独立恢复；No Coordinator（Phase 16 成立）

HARNESS:
  Recovery 属 Runtime（Control Plane）；Harness 保持概念边界
```

## 17. Open Questions

`[OPEN]`

1. **operationId 如何从 Tool 流向 Runtime 的持久 Checkpoint？** 当前 Pi Tool result 不显式携带 operationId；Runtime 需在 Tool prepare 时记录（实验以 Checkpoint 直接写 opId 模拟）。真实机制（Tool 暴露 opId 的渠道）待定。
2. **Checkpoint 自身的耐久存储选型**（文件/DB/Redis）属 Phase 18 延后项，本 Phase 不决定。
3. **workflow 级 durable checkpoint 是否必要**——当前 Run 级已足够；仅当多步长事务需跨 Run 事务语义再评估。
4. **External status query 本身 UNKNOWN 时的退避/人工介入协议**未定义（本 Phase 仅定 ESCALATE）。

## 18. Implementation Deferred

```text
禁止实现项全部未实现：
  RecoveryManager / RetryManager / CheckpointManager / PersistenceManager / ResumeManager
  DB / Redis / Queue / 生产级持久化 / Production Recovery Framework
  Pi 未改、未 fork；Runtime 未重构
CODE CHANGED: NO
```

---

## Phase 19 Result

```text
INVESTIGATION: COMPLETE

KEY FINDING:
  进程死亡后，安全恢复 = 持久最小信息（messages+sessionId+RunCtx+OpID+ResRef）
  → 新 Pi Agent + 新 Run → 用 operationId 对账 External → Decide → Resume。
  Tool 已提交外部副作用但 result 丢失 = UNKNOWN，对账 External 得 SUCCESS → SKIP（非 RETRY）。

RECOVERY MODEL:
  Reconstruct → Reconcile → Decide → Resume

DECISION OWNER:
  Enterprise Runtime（CONTINUE/SKIP/RETRY/ESCALATE，对账后）

SAFE RESUME BOUNDARY:
  外部副作用状态已确定（SUCCESS/NOT_FOUND 可安全重执行）或纯 LLM 无副作用边界；
  #4/#5 必须先对账 External；#5 只能 SKIP，不能 RETRY。

UNKNOWN HANDLING:
  绝不判 FAILED；SUCCESS→SKIP，NOT_FOUND→RETRY(idempotent)，UNKNOWN→ESCALATE。

OPERATION IDENTITY:
  operationId + idempotencyKey（Tool/External，耐久跨 Run）；sessionId 关联；runId/toolCallId 否。

  > [CORRECTION-22 / C1] 同上：`operationId` 崩溃时非耐久；真正 crash-safe 身份为 `idempotencyKey`。

POLICY INTERACTION:
  Recovery 新 Tool Call → Policy 逐调用重评估（runtime.ts:52），不绕过；Policy≠Recovery 决策。

MULTI-AGENT:
  每 Agent 独立恢复；No Coordinator（Phase 16 仍成立）。

CODE CHANGED:
  NO

FILES CHANGED:
  docs/phase-19-durable-recovery-boundary-investigation.md（新增）
  临时实验脚本 scripts/_investigate-19.ts、scripts/_crash19_child.ts 已删除
  /tmp/p19 临时目录已清理

IMPLEMENTATION:
  DEFERRED

OPEN QUESTIONS:
  1. operationId 从 Tool 到 Runtime 持久 Checkpoint 的真实传递渠道
  2. Checkpoint 耐久存储选型（Phase 18 延后）
  3. workflow 级 durable checkpoint 必要性
  4. External status 自身 UNKNOWN 的退避/人工介入协议
```
