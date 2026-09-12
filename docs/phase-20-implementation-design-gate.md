# Phase 20 — Implementation Design Gate

## 1. Objective

```text
本 Gate 是设计门，不是实现阶段。
目标：在写 Phase 20 代码前，确定第一条最小 Production Reliability Vertical Slice，
并明确哪些东西仍然不能实现。

最终必须能告诉 Phase 20：
  “第一条可靠性闭环是什么 / 需要哪些最小数据 / 谁拥有每个边界 /
   Crash Window 在哪里 / 如何 Reconcile / Recovery 如何 Decide / 哪些明确暂不做。”

CODE CHANGED: NO（本 Gate 不写生产代码）
```

## 2. Phase 17–19 Constraints

`[SOURCE]`（docs/phase-17/18/19-*.md 已确立，本 Gate 不重证）

```text
P17 Reliability envelope = Run；Run 非盲重试单元；安全重试最小单元 = LLM + read-only/idempotent Tool。
    state-changing Tool 重试需幂等/外部对账；toolCallId 跨 Run 不稳定。
P18 Agent State 不可序列化恢复；恢复 = 持久 Session+RunCtx+ResRef+OpID → 新 Pi Agent → 对账 → 决定 → 新 Run。
    messages+sessionId 持久（Phase 18 Persistence）；Resource Data 不持久（External 拥有）。
P19 Durable Recovery = Reconstruct → Reconcile → Decide → Resume。
    UNKNOWN ≠ FAILED；External = 副作用真相；Decision Owner = Runtime；
    Recovery=新 Run=新 Tool Call → Policy 重评估；idempotencyKey 是 crash-safe 耐久身份（operationId 经后续实现验证仅为正常完成回显、非 crash-durable，见下方 [CORRECTION-22 / C1]）；
    sessionId durable；runId/toolCallId 否；Multi-Agent 暂不需 Coordinator；Harness 保持概念边界。
P19 禁止项（仍适用）：RecoveryManager/RetryManager/CheckpointManager/PersistenceManager/ResumeManager/
    DB/Redis/Queue/生产级持久化/修改或 fork Pi。
```

> ### [CORRECTION-22 / C1 + C2] 实现后修正（以 `docs/phase-21-architecture-freeze.md` 为事实优先级）
> - **C1 — operationId 并非 durable identity**：Phase 20 实现验证 `operationId` 仅在 `afterToolCall`
>   （`src/runtime.ts:136-146`）从 `result.details` 补写，进程在 `process.exit(137)` 崩溃时该钩子不触发，
>   故 `operationId` 不跨进程死亡持久。真正的 crash-safe、用于 `reconcile` 的耐久对账身份是 `idempotencyKey`
>   （`runtime.ts:155,171,286`）。本 Gate 前述“operationId+idempotencyKey 是耐久身份”对 `operationId` 部分**不成立**。
> - **C2 — Resume 术语**：本 Gate 与 Phase 19 中 “Reconstruct → Reconcile → Decide → Resume” 的 “Resume”
>   指 **`recover()` 之后由调用方开启“新 Run”**（逻辑续跑），**不是**从进程死亡处“恢复旧 Run”。
>   `recover()` 仅做 Reconstruct/Reconcile/Decide 并返回 retry 计划（`runtime.ts:276-306`）；旧 `runId`/`toolCallId`
>   不复用，新 Run 必经 `beforeToolCall → Policy`（`runtime.ts:118,302`）。上面 §2 末句已据实现修正。

## 3. Current Architecture Boundary

`[SOURCE]`

```text
EnterpriseAiRuntime（src/runtime.ts）
  - 包 pi-agent-core 的 Agent（发动机）
  - beforeToolCall → evaluatePolicy（runtime.ts:52-57）每次 Tool Call 必走
  - afterToolCall：未使用（预留钩子）
  - TraceCollector：仅观测（collector.ts），不控制
  - ToolRegistry：按 name 索引（registry.ts）

Pi Agent 提供的关键 hooks/字段（本次新确认，对设计至关重要）：
  - AgentTool.replay?: "never" | "safe"   (types.d.ts:350-351)  ← Pi 原生“效果恢复策略”
  - beforeToolCall(ctx): ctx.toolCall.id / ctx.args   (types.d.ts:75-84)
  - afterToolCall(ctx): ctx.result.details             (types.d.ts:86-99) ← Tool 可回传 operationId
  - tool_execution_start/end 事件携带 toolCallId/toolName/args/result/isError (types.d.ts:399-415)
  - Agent.sessionId?（agent.d.ts:50）← 跨实例耐久 Session 身份
  - Agent.continue()/prompt()（agent.d.ts:108-111）← 重建后继续

Pi harness 另有 drive/recovery.d.ts / reconcile.d.ts / checkpoint.d.ts，
但运行在 Lane/Drive/ProcedureResult 重型耐久-session 框架上；
EnterpriseAiRuntime 未使用 harness，仅用 Agent。
→ 不采用 Pi harness 的 recovery；在 Runtime 层用 Agent 级 hooks 自建边界（不修改/fork Pi）。
```

## 4. Open Questions Review

### 4.1 operationId propagation

`[DECISION]` + `[SOURCE]`

```text
谁生成 idempotencyKey/operationId？
  - 对外幂等工具：idempotencyKey 是耐久身份，应由调用方/planner 作为 Tool 参数提供，
    或 Runtime 在首次 beforeToolCall 时 mint 并持久（之后 RETRY 复用同一 key，保证 External 去重）。
  - External 回显同一 key 作为 operationId（External 拥有真相）。

如何流向 Runtime 的持久 Checkpoint？
  - 正常完成：Tool 在 result.details 中回传 operationId → Runtime 经 afterToolCall(ctx.result.details) 捕获。
  - 崩溃前丢失 result（关键场景 #5）：result 永不返回，afterToolCall 不触发 →
    必须在 beforeToolCall 即捕获 idempotencyKey（ctx.args.idempotencyKey）写入 Checkpoint。
  ⇒ 耐久身份在 beforeToolCall（最早点）即建立，崩溃前/后都能对账。

Tool 是否应知道 Checkpoint / Persistence？
  否。Tool 只：(a) 把 idempotencyKey 透传给 External；(b) 在 result.details 回显 operationId。
  Runtime 负责持有 Checkpoint 与捕获身份（Runtime 级 wrapper，不污染 Tool 实现）。

结论：operationId 流 = Tool(result.details) 与 args(idempotencyKey) → Runtime(after/beforeToolCall) → Checkpoint。
      无解耦冲突，不把 Persistence/Recovery 逻辑塞进 Tool。
```

### 4.2 Minimum durable recovery record

`[DECISION]`（仅恢复一个 Run 的最小数据；非完整 Persistence Model）

```text
字段分类（每条 Run 一份，key = sessionId + runId）：
  sessionId          REQUIRED  耐久 Session 身份（agent.d.ts:50）
  prompt             REQUIRED  重启 Run / 续对话所需
  status             REQUIRED  running | interrupted | recovered（续跑定位）
  checkpoint.position REQUIRED  before_tool | during_tool | after_tool_before_result | after_tool_result
  checkpoint.toolName REQUIRED*  in-flight 工具名（*有 in-flight 工具时）
  checkpoint.toolArgs REQUIRED*  重执行(RETRY)所需（从 beforeToolCall args 取）
  checkpoint.idempotencyKey REQUIRED* 对账 External 的耐久 key（state-changing 时）
  checkpoint.resourceReference REQUIRED* 查哪个 External（workspaceId/resourceId，Phase 15）
  runId              OPTIONAL  中断 Run 关联（非恢复身份，仅追踪）
  parentRunId        OPTIONAL  血缘（Phase 19：新 Run 关联原 Run）
  updatedAt          REQUIRED  续跑时序

NOT REQUIRED（不进 Checkpoint）：
  activeRun / streamingMessage / pendingToolCalls / abort（transient，agent.d.ts）
  trace events（Trace=观测，≠Checkpoint，Phase 18）
  model 细节（DERIVED/config：model.id 可重派）
  Resource Data（External 拥有，Phase 15/18）

EXTERNAL（不在本记录内）：
  真实副作用状态（External 拥有；Checkpoint 仅持 resourceReference+idempotencyKey 去查）

DERIVED（单独存储，不重复）：
  messages/transcript：由 Phase 18 Persistence 按 sessionId 存；Checkpoint 引用 sessionId 加载。
  ⇒ Checkpoint ≠ transcript；二者分离（Phase 18 已定）。
```

### 4.3 Workflow-level checkpoint

`[DECISION]` + `[INF]`

```text
当前 Agent 是 Run 级、无 workflow 引擎；Multi-Agent 用 parentRunId 关联（Phase 16/19），
无证据需要跨多 Run 的统一 workflow checkpoint。
⇒ Workflow-level checkpoint：DEFERRED。Phase 20-1 仅 Run-level Checkpoint + Session transcript。
无充分证据不引入。
```

### 4.4 External UNKNOWN

`[DECISION]`

```text
Runtime 向 External 查询得三态：SUCCESS | NOT_FOUND | UNKNOWN（Phase 19）。
Phase 20-1 第一版不具备处理 UNKNOWN 的复杂能力：
  UNKNOWN → ESCALATE（暴露给调用方/人工），不做自动退避/重试/分布式事务。
  STILL_UNKNOWN 同 ESCALATE。
“请求已发连接断无法确认” = UNKNOWN → ESCALATE（Phase 19 已定）。
UNKNOWN 的具体退避/人工介入协议：保留 [OPEN]（未来定义）。
```

## 5. Candidate Vertical Slices

```text
A. Read-only Tool Recovery
   Run → read-only Tool → crash → reconstruct → retry
   验证 Persistence/Reconstruction/Policy 重评；但不证明真实副作用恢复。

B. Idempotent State-changing Tool Recovery（推荐）
   Run → state-changing Tool(operationId+idempotencyKey) → External commit → crash
        → reconstruct → reconcile External → SUCCESS→SKIP / NOT_FOUND→RETRY
   最接近真实 Production Reliability 闭环，且幂等使 RETRY 安全。

C. Full Recovery（Persistence+Checkpoint+Recovery+Reconcile+Retry+Escalation）
   明显过大 → 拒绝。
```

## 6. Candidate Decision Matrix

| Candidate | 验证价值 | 实现复杂度 | Side Effect 风险 | 适合 Phase 20-1 |
| --- | --- | --- | --- | --- |
| Read-only Recovery (A) | 中（验证 reconstruct+policy 重评，但**不证明副作用恢复**） | 低 | 无 | 否（其机制被 B 包含） |
| Idempotent State-changing Recovery (B) | **高**（证明完整闭环：opId→checkpoint→crash→reconcile→SKIP/RETRY） | 中 | **低**（idempotent，重试安全） | ✅ **是** |
| Full Recovery (C) | 最高 | 高 | 高（UNKNOWN/多 agent/工作流） | 否（过大） |

## 7. Selected Phase 20-1 Vertical Slice

```text
SELECTED = Candidate B：Idempotent State-changing Tool Recovery with Reconciliation

理由：
  - 形成真实闭环，端到端证明 Phase 19 模型（Reconstruct→Reconcile→Decide→Resume）
  - 幂等使 RETRY 安全，副作用风险最低
  - 同时强制验证 Persistence/Reconstruction/Policy 重评（A 的价值被包含）
  - 明确排除最危险部分（UNKNOWN 自动处理、Multi-Agent Coordinator、Workflow Checkpoint）

Phase 20-1 不实现 Full Recovery；不处理 UNKNOWN 自动重试；不引入 Coordinator。
```

## 8. Minimal Durable Record

`[DECISION]`（设计接口，不实现）

```ts
// 设计用最小结构（Phase 20 实现参考）；messages 不在此，由 Phase 18 Persistence 按 sessionId 存。
interface DurableRecoveryRecord {
  sessionId: string;                                   // REQUIRED 耐久 Session 身份
  runId: string;                                       // OPTIONAL 中断 Run 关联
  parentRunId?: string;                                // OPTIONAL 血缘
  prompt: string;                                      // REQUIRED 重启/续对话
  status: "running" | "interrupted" | "recovered";     // REQUIRED 续跑定位
  checkpoint: {
    position: "before_tool" | "during_tool" | "after_tool_before_result" | "after_tool_result";
    toolName?: string;                                 // REQUIRED* in-flight
    toolArgs?: unknown;                                // REQUIRED* RETRY 所需
    idempotencyKey?: string;                           // REQUIRED* 对账 key (state-changing)
    resourceReference?: { workspaceId?: string; resourceId?: string }; // REQUIRED* 查 External
  };
  updatedAt: number;                                   // REQUIRED 时序
}
```

## 9. Operation Identity Flow

`[DECISION]` + `[SOURCE]`

```text
T1 beforeToolCall(ctx):
      Runtime 取 ctx.args.idempotencyKey（planner 提供或 Runtime mint）
      → 写入 DurableRecoveryRecord.checkpoint（耐久，最早点）
      → 若 checkpoint 写失败：block Tool（beforeToolCall 返回 {block:true}），禁止无身份执行

T2 Tool.execute(params, ..., ):
      Tool 用 idempotencyKey 调 External（External 去重/提交）
      Tool 在 result.details 回显 operationId（与 idempotencyKey 同一）

T3 Tool 返回 result：
      Runtime afterToolCall(ctx): 取 ctx.result.details.operationId 补写记录（正常完成路径）

T4 Run 结束：记录 status=recovered 或清理

身份归属：
  idempotencyKey/operationId：Tool/External 拥有语义；Runtime 仅持有+持久+对账
  sessionId：Pi 原生耐久（agent.d.ts:50）
  runId/toolCallId：非耐久恢复身份（Phase 17/19）
```

## 10. Checkpoint / External Commit Ordering

`[DECISION]`（本 Gate 最重要工程结论）

```text
顺序（安全）：
  Checkpoint WRITE（beforeToolCall，持 idempotencyKey）
        ↓
  External COMMIT（Tool.execute 内）
        ↓
  process dies?

崩溃窗口只剩两种，且都安全（因 Checkpoint 先于 commit 持久）：
  (a) 崩于 Checkpoint 后、External commit 前 → External NOT_FOUND → RETRY（safe）
  (b) 崩于 External commit 后、result 返回前 → External SUCCESS → SKIP（Phase 19 Exp5/6）
  无任何窗口处于“已提交但无身份”→ 故 Recovery 总能对账，不会落入无解 UNKNOWN。

禁止的顺序（危险）：
  External COMMIT → Checkpoint WRITE
  → 崩于 commit 后、checkpoint 前 = 已提交但无耐久身份 → 只能 ESCALATE（不可接受）
  ⇒ 必须用“Checkpoint 先于 External commit”顺序消除该窗口。

能否消除 Crash Window？
  两系统（本存储 + External）非同一事务，无法原子 join（禁止 2PC/分布式事务）。
  但通过“Checkpoint 先写”+ Reconciliation，窗口被压缩为可安全解析的两种（NOT_FOUND/SUCCESS）。
```

## 11. Crash Windows

`[DECISION]`（结合 §10）

```text
T1 Tool starts（beforeToolCall 触发）
T2 Checkpoint 持久（含 idempotencyKey）—— 本地原子写（temp+rename）
T3 External commit（Tool.execute 内）
T4 Tool result 返回 / process dies

窗口分析：
  T1→T2 崩：无 in-flight 记录，按普通新 Run 重启（LLM 边界，安全）
  T2→T3 崩：Checkpoint 有 key，External NOT_FOUND → RETRY（replay=="safe" 方可）
  T3→T4 崩：Checkpoint 有 key，External SUCCESS → SKIP（已提交，绝不重试）
  T4 后崩：result 已知 → 下一 LLM 边界继续（安全）

关键不变量：在 External commit 发生的瞬间，Checkpoint 已耐久。
⇒ Recovery 永远持耐久 idempotencyKey → 总能 reconcile。
```

## 12. Reconciliation

`[DECISION]` + `[SOURCE]`

```text
Reconcile 谁说了算：
  Runtime 持 idempotencyKey + resourceReference（来自 Checkpoint）
  External 持真实副作用状态（Phase 19/Phase 15）

Phase 20-1 接口（设计）：
  type ReconcileFn = (key: string, ref: ResourceReference) => Promise<"SUCCESS"|"NOT_FOUND"|"UNKNOWN">
  Runtime 调用 reconcile(key, ref) 三态查询；不拥有 Resource Data。

真实闭环由“提供 ReconcileFn 的 External 集成”注入；
Phase 20-1 用进程内模拟 External store 验证（属验收测试，非生产 External）。
```

## 13. Recovery Decision

`[DECISION]` + `[SOURCE]`

```text
Decide owner = Enterprise Runtime（Phase 19 已定）。
用 reconcile 结果 + Tool.replay（types.d.ts:350-351）决策：

  SUCCESS   → SKIP      （已提交，绝不重试；Phase 19 Exp5/6 [EXP]）
  NOT_FOUND → replay=="safe"  ? RETRY
              replay=="never" ? ESCALATE（禁止盲重执行）
  UNKNOWN   → ESCALATE  （Phase 19/§4.4）

RETRY 实现：启动新 Run（新 Agent）续跑，重发同一 idempotencyKey 的 Tool 调用
          → 必过 beforeToolCall → evaluatePolicy（runtime.ts:52，Policy 重评，不绕过）。
SKIP 实现：不重调 Tool，直接以“已提交”结论继续/返回。
ESCALATE：暴露给调用方（事件/返回值），不自动重试。

Policy 与 Recovery 是两独立问题（Phase 19）：Policy 管“某 Tool Call 能否执行”，
Recovery 管“中断 Run 后如何继续”；前者在 RETRY 重发时自然重评。
```

## 14. Policy Interaction

`[SOURCE]` + `[DECISION]`

```text
Recovery RETRY = 新 Run = 新 Tool Call
  → runtime.ts:52-57 的 beforeToolCall 必调 evaluatePolicy → Policy 逐调用重评估，不绕过。

设计纪律（不可违反）：
  Recovery 绝不调用 Tool.execute() 直接重放。
  RETRY 必须经由新 Run → beforeToolCall → Policy（ALLOW/DENY/ASK）。
  SKIP 不触发 Tool；ESCALATE 不触发 Tool。
  故不存在“Recovery 绕过 Governance”的路径。
```

## 15. Runtime Boundary

`[DECISION]`

```text
Recovery 是 Runtime 的生命周期能力，不是独立 subsystem。

Phase 20-1 形态（设计，不实现）：
  EnterpriseAiRuntime 增加：
    - 可选 RecoveryStore（数据接口，非 Manager）：writeCheckpoint / readCheckpoint / loadTranscript / saveTranscript
    - beforeToolCall 内：捕获 idempotencyKey 写 Checkpoint（先于 commit）
    - afterToolCall 内：补写 operationId
    - recover(sessionId) 方法：加载 transcript+Checkpoint → 新 Agent → reconcile → decide → 新 Run
  - 决策逻辑放 recovery.ts 纯函数（reconcile/decide），不建 Manager 类。

命名纪律（违禁名不出现）：
  禁止 RecoveryManager / RetryManager / CheckpointManager / PersistenceManager / ResumeManager
  允许：RecoveryStore（数据接口，非编排）/ recovery.ts（纯函数）
  RecoveryStore 明确是“存储抽象”，不是“编排 Manager”。
```

## 16. Storage Decision

`[DECISION]`

```text
MVP（Phase 20-1）：
  Chosen Storage = File（本地文件，按 sessionId 组织的 JSONL/单文件）
  Reason：
    - durability 足够本地开发/验收（temp+rename 原子写，OS 级 crash-safe）
    - 零基建，契合 Gate“不真的接数据库”
    - 单进程写入，原子 rename 满足 recovery atomicity
    - concurrency：MVP 单写者；多写者未来再议
  Implementation：FileRecoveryStore（temp-write + atomic rename）

Production：
  OPEN / future decision（SQLite / PostgreSQL / Redis / 既有应用 DB 待评估）
  不强行决定（项目规模尚不足以定生产存储）。
```

## 17. Explicit Non-Goals

```text
NOT IMPLEMENTING in Phase 20-1：
  - RecoveryManager / RetryManager / CheckpointManager / PersistenceManager / ResumeManager
  - generic workflow engine / saga / distributed transaction / 2PC
  - queue / Redis / 生产数据库迁移
  - multi-agent coordinator（Phase 16/19：No Coordinator 仍成立）
  - durable Pi / fork Pi / 修改 Pi（仅用 Agent 级 hooks）
  - arbitrary checkpoint graph
  - automatic UNKNOWN retry（UNKNOWN → ESCALATE 即可）
  - complex escalation service（暴露事件/返回值即够）
  - workflow-level checkpoint（DEFERRED，§4.3）
  - 真实生产 External（用进程内模拟 External 验证，属测试）
```

## 18. Phase 20-1 Acceptance Tests

`[DESIGN]`（以下为 Phase 20 验收标准，非本 Gate 实现）

```text
Test 1  process death → reconstruct Session
       持久 sessionId+messages → 新 Pi Agent 注入 → 同 Session 连续（Phase 19 Exp7 [EXP]）

Test 2  read-only operation → safe retry
       重建后重放 read-only Tool → 安全（Phase 19 Exp8 [EXP]）

Test 3  state-changing committed → reconcile SUCCESS → SKIP
       提交后崩 → 对账 SUCCESS → SKIP，绝不重试（Phase 19 Exp5/6 [EXP]；本切片核心）

Test 4  state-changing NOT_FOUND → recovery decision
       未提交崩 → reconcile NOT_FOUND → replay=="safe" 则 RETRY，=="never" 则 ESCALATE

Test 5  External UNKNOWN → no blind retry
       对账 UNKNOWN → ESCALATE，不自动重试（§4.4/§13）

Test 6  recovery-generated Tool Call → Policy re-evaluated
       RETRY 经新 Run → beforeToolCall → evaluatePolicy 命中（runtime.ts:52 [SOURCE]）

Test 7  new Run retains logical Session continuity
       新 Run.sessionId == 原 sessionId，messages 续接（agent.d.ts:50 [SOURCE]）

Test 8  operation identity survives Run/process boundary
       idempotencyKey 在 beforeToolCall 持久，跨 Run/进程仍可作对账 key（§9/§10 [DECISION]）
```

## 19. Final Architecture

`[DECISION]`（最小架构图）

```text
             Enterprise Runtime
                    │
             Recovery Boundary  (生命周期能力，非 subsystem)
                    │
        ┌───────────┼───────────────┐
        ↓           ↓               ↓
   Persistence   Reconcile       Decision
   (RecoveryStore) (ReconcileFn)  (Runtime)
        │           │               │
        ↓           ↓               ↓
   Checkpoint   External         CONTINUE/
                Resource         SKIP / RETRY /
                (truth)          ESCALATE
                    │               │
                    └───────┬───────┘
                            ↓
                        New Run
                            │
                            ↓
                         Policy (beforeToolCall → evaluatePolicy)
                            │
                            ↓
                           Pi (Agent)
```

边界归属（与 Phase 19 一致）：

```text
Pi        = execution engine（重建新 Agent；不修改/fork）
Runtime   = Recovery Decision Owner（Reconstruct/Reconcile/Decide；随后由调用方 Resume = Start New Run，非恢复旧 Run，见 [CORRECTION-22/C2]）
External  = side-effect truth（Runtime 持 key+ref 查询，不拥有 Data）
Policy    = Tool Call governance（RETRY 重发必重评）
Trace     = observation（不控制）
Checkpoint= safe continuation info（先于 External commit 持久）
Persistence= durable info（File，temp+rename 原子）
```

## 20. Remaining Open Questions

`[OPEN]`

```text
1. UNKNOWN 的退避/人工介入协议未定义（Phase 20-1 仅 ESCALATE）。
2. 生产存储选型（SQLite/PG/Redis/既有 DB）未定。
3. 多写者并发下 FileRecoveryStore 的一致性（MVP 单写者足够）。
4. idempotencyKey 由 planner 提供还是 Runtime mint 的默认策略（设计已支持两种，默认取 args，缺失则 mint）。
5. reconcile 失败（网络错）是否等同 UNKNOWN（建议是，但仍 [OPEN] 待实现定）。
```

---

## Implementation Design Gate Result

```text
GATE: PASS

Phase 20-1 Vertical Slice:
  Candidate B — Idempotent State-changing Tool Recovery with Reconciliation
  （Run → state-changing Tool（以 idempotencyKey 为 crash-safe 耐久身份；operationId 正常完成时回显）
   → External commit → crash
   → reconstruct → reconcile External（用 idempotencyKey）→ SUCCESS→SKIP / NOT_FOUND→RETRY）

Why this slice:
  形成真实闭环，端到端证明 Phase 19 模型；幂等使 RETRY 安全、副作用风险最低；
  同时验证 Persistence/Reconstruction/Policy 重评（A 的价值被包含）；排除最危险部分。

Minimum Durable Record:
  DurableRecoveryRecord{sessionId, runId?, parentRunId?, prompt, status,
    checkpoint{position, toolName?, toolArgs?, idempotencyKey?, resourceReference?}, updatedAt}
  messages 由 Phase 18 Persistence 按 sessionId 存，不进 Checkpoint（二者分离）。

Operation Identity:
  idempotencyKey：Tool/External 语义，Runtime 在 beforeToolCall（最早点）从 args 捕获并持久（崩溃前/后均可对账，crash-safe）；
  operationId：Tool/External 语义，Runtime 仅在正常完成（afterToolCall）从 result.details 回显补写，进程崩溃时不持久（非 crash-durable）；
  reconcile 使用 idempotencyKey。sessionId 耐久关联；runId/toolCallId 否。
  （[CORRECTION-22/C1]：本 Gate 原“operationId+idempotencyKey 是耐久身份”对 operationId 部分不成立。）

Checkpoint Boundary:
  Checkpoint 必须在 beforeToolCall（External commit 之前）持久；
  消除“已提交但无身份”窗口；唯一窗口为 NOT_FOUND→RETRY / SUCCESS→SKIP（均安全）。
  写失败则 block Tool（不执行无身份工具）。

Reconciliation:
  Runtime 持 idempotencyKey+resourceReference，调 ReconcileFn → SUCCESS|NOT_FOUND|UNKNOWN；
  External 拥有真相；不拥有 Resource Data。

Recovery Decision Owner:
  Enterprise Runtime；SUCCESS→SKIP / NOT_FOUND→(replay=="safe"?RETRY:ESCALATE) / UNKNOWN→ESCALATE。
  用 Pi 原生 AgentTool.replay（types.d.ts:350-351）判定 RETRY vs ESCALATE。

Policy Boundary:
  RETRY 必经新 Run → beforeToolCall → evaluatePolicy（runtime.ts:52）；
  Recovery 绝不直调 Tool.execute；SKIP/ESCALATE 不触发 Tool；不绕过 Governance。

Storage:
  MVP = File（temp+rename 原子写，单进程）；Production = OPEN。

Crash Window Strategy:
  Checkpoint 先于 External commit；窗口压缩为两种可安全解析态（NOT_FOUND→RETRY / SUCCESS→SKIP）；
  不引入 2PC/分布式事务。

UNKNOWN Strategy:
  ESCALATE（不自动重试）；退避/人工介入协议 OPEN。

Workflow Checkpoint:
  DEFERRED（Run-level + Session transcript 足够；无 workflow 证据）

Multi-Agent Coordinator:
  DEFERRED（Phase 16/19 No Coordinator 仍成立）

Pi Modification:
  NO（仅用 Agent 级 hooks：before/afterToolCall、AgentTool.replay、sessionId、tool_execution_*）

CODE CHANGED:
  NO（本 Gate 仅设计；临时实验脚本同 Phase 19 惯例删除，不进生产）

PHASE 20 READY:
  YES
```
