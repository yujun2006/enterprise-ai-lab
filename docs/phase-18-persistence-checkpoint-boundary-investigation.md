# Phase 18 — Persistence & Checkpoint Boundary Investigation

## 1. Executive Summary

**核心结论：进程死亡后，唯一必须"存活"的最小持久信息是 `Session 的 messages（数据）+ sessionId（标识）+ Run 的 prompt/上下文引用 + 外部 Operation ID`。Agent State 不可直接序列化恢复——必须由持久化的 Session + Run 信息在新 Pi 实例上重建（新 Run）。Trace 只观测、不决定恢复点；External Resource 是真实副作用的唯一事实来源。**

```text
Trace       = What happened?           （观测，Phase 3/17）
Checkpoint  = Where can we resume?     （最小持久状态 + 外部 OpID）
Persistence = What survives death?     （Session msgs + sessionId + RunCtx + OpID + ResRef）
External    = What really happened?    （副作用真相，Runtime 不拥有）
Resume      = 重建 Session → 新 Run（必要时先对账 External）
```

```text
PHASE 18 INVESTIGATION: COMPLETE
CODE CHANGED: NO
PERSISTENCE / CHECKPOINT / RESUME: NOT IMPLEMENTED (DEFERRED)
```

## 2. Part 1 — Current State Inventory

`[SOURCE]`（node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts, types.d.ts；src/runtime.ts, trace/collector.ts, ollama/model.ts, tools/registry.ts）

| State | Current Owner | Lifecycle | Survives Process Crash? | Reconstructable? | Needed for Resume? |
| --- | --- | --- | --- | --- | --- |
| `messages` (transcript) | Pi (`_state`, in-mem) | Session | ❌ | ✅（可序列化数据） | ✅ 核心 |
| `systemPrompt` | Pi | config/Session | ❌ | ✅（string） | ✅ |
| `model` | Pi | config | ❌ | ✅（存 `model.id`） | ✅ |
| `thinkingLevel` | Pi | config | ❌ | ✅ | ⚠️ 可选 |
| `tools` | Pi（Runtime 注入） | config/Run | ❌ | ✅（按 name 从 Registry 重建，registry.ts:18-40） | ✅（按名） |
| `isStreaming` | Pi | transient | ❌ | ❌（派生） | ❌ 不持久 |
| `streamingMessage` | Pi | in-flight | ❌ | ❌（重新请求 LLM） | ❌ |
| `pendingToolCalls` | Pi | in-flight | ❌ | ❌ | ❌ |
| `errorMessage` | Pi | observability | ❌ | ❌ | ❌ |
| `activeRun` | Pi（private） | live exec | ❌ | ❌（promise/abort 不可序列化） | ❌ 不持久 |
| listeners/queues/`streamFunction` | Pi | runtime refs | ❌ | ❌（构造时重供） | ❌ |
| `sessionId` | Pi（`agent.d.ts:50`） | Session | ❌ 内存但**可外部提供** | ✅（传入构造） | ✅ Session 标识 |
| `TraceCollector.current/last` | Runtime（in-mem） | Run | ❌ | ⚠️ 事件可序列化但崩时丢失 | ❌ 仅观测/审计 |
| Run Context (`runId`/`prompt`/`policyCtx`) | Runtime | Run | ❌（`runId`=`randomUUID()` collector.ts:54） | ✅（`prompt` 可持久） | ✅ `prompt`；`runId` 重建 |
| Policy | Runtime | Run | ❌ | ✅（config/function） | ⚠️ 每次调用重评估 |
| Tool Registry | Runtime（代码） | process | ❌ | ✅（代码重建） | ✅ 按名引用 |
| Skill/Workspace ctx | Runtime（激活配置） | Session/Run | ❌ | ✅（配置） | ✅ 作为激活元数据 |

## 3. Part 2 — Session Persistence Boundary

`[DECISION]` + `[EXP]`（Exp-Reconstruct: 注入 `messages`+`sessionId` 后新 Agent 消息数 2→4，逻辑连续）

```text
最小 Session 持久信息：
  - messages（transcript）         ← 不可约的核心，纯数据
  - sessionId（Pi 原生标识）        ← agent.d.ts:50，跨实例稳定
  - systemPrompt / model.id / thinkingLevel  ← 配置，可重派；若按 Session 定制则须精确持久
  - tools（name 列表）             ← 按名从 Registry 重建（函数体在代码，不序列化）
  - Skill / Workspace / Policy ctx ← 激活元数据（引用，非数据）
```

- `messages` 是否足够？**否**——还需 `sessionId` 标识与激活配置，否则无法区分/重建同一逻辑 Session。
- **Persisting Agent State ≠ Persisting a Session**：Session = 逻辑连续 = `messages + sessionId + 激活上下文`；Agent State 还含有大量 transient（见 §2）。
- 必须精确持久：定制化的 `systemPrompt`/激活配置。可仅重派：默认配置。
- **不应持久**：`isStreaming`/`streamingMessage`/`pendingToolCalls`/`activeRun`/listeners/`streamFunction`（函数/闭包/运行时引用，无法也不应序列化）。

## 4. Part 3 — Run Persistence Boundary

`[DECISION]`

```text
Minimal Run Persistence（resume 必需）：
  - runId（resume 时 NEW，原 runId 不耐久）
  - prompt（原始指令）
  - parentRunId（多 Agent 委托关联，Phase 16）
  - model.id
  - Skill / Workspace / Policy ctx 引用
  - 外部 Operation ID 列表（对账 in-flight Tool）
  - Run status（pending/failed/unknown）

Optional Run Metadata（仅观测/审计）：
  - timestamps, trace ref, toolCall args
```

当前 `runId` 是 `randomUUID()`（collector.ts:54），**不足以**跨进程标识；恢复时生成新 `runId`，靠 `sessionId`+持久化 `prompt` 重建逻辑 Run。

## 5. Part 4 — Agent State vs Run Context

`[DECISION]` + `[SOURCE]`（types.d.ts:290-315；agent.d.ts:48）

**不直接序列化恢复 Agent State**。以下字段本质是非持久的 live 执行态，序列化无意义/危险：
- `activeRun`、`AbortController`、`streamingMessage`、`pendingToolCalls`（promise/信号/in-flight）
- listeners/queues/`streamFunction`/`getApiKey`/closures/provider client（函数与运行时引用）
- `isStreaming`/`errorMessage`（派生/观测）

**正确做法**：进程崩溃后 → 用持久化 **Session(messages)+sessionId** + **Run 信息(config)** → 构造**新 Pi Agent 实例** → **新 Run**。Exp-Reconstruct 已证：新 Agent 注入 `messages`+`sessionId` 即恢复同 Session，无需函数/闭包序列化。

## 6. Part 5 — Trace vs Checkpoint（Case A–E）

`[DECISION]` + `[EXP]`（Exp-NormalFail / Exp-Crash）

| Crash Position | Trace Evidence | Safe Resume Known? | External Query Required? |
| --- | --- | --- | --- |
| A: LLM done, Tool not started | Trace: LLM# end | ✅ 从 Tool 起重跑（state-changing Tool 有副作用风险） | ⚠️ 若 Tool state-changing |
| B: Tool started→done→result | Trace: `end(isError)` | ✅ 下一 LLM | ❌ |
| C: Tool started, ext side-effect, result lost | Trace: **仅 `start`** | ❌ **UNKNOWN** | ✅ 必查 External |
| D: result received, next LLM not started | Trace: `end`+result | ✅ 下一 LLM | ❌ |
| E: LLM started, partial, crash | Trace: 部分 payload | ✅ 重请求 LLM（无副作用） | ❌ |

`[EXP]` Exp-NormalFail：`start(boom) end(boom,isError=true)` → 正常失败结果**已知(FAILED)**。
`[EXP]` Exp-Crash：外部 `COMMITTED` 存活但无 `end` 事件 → **UNKNOWN**，外部可能已变更。
**关键规则（已验证）**：绝不能仅因"未收到 Tool result"就判定 Tool 失败——Case C 外部可能已提交。

## 7. Part 6 — Operation Identity

`[DECISION]`（结合 Phase 17）

| Identity | 归属 | 跨重启存活？ | Resume 可复用？ |
| --- | --- | --- | --- |
| `sessionId` | Pi/Agent（外部提供） | ✅ | ✅ Session 关联 |
| `runId` | Runtime（`randomUUID`） | ❌ 重建 | ❌（新 runId） |
| `toolCallId` | Pi（per call） | ❌ 不稳定 | ❌（Phase 17 已证不可用） |
| `operationId` | Tool/External（分配） | ✅ 持久 | ✅ 对账 |
| `idempotencyKey` | External | ✅ | ✅ 防重复 |
| `resourceRef` | Runtime/Workspace（Phase 15） | ✅ | ✅ 定位资源 |
| `businessId` | External | ✅ | ✅ 对账 |

**耐久操作身份 = `operationId`/`idempotencyKey`（Tool/External 拥有）+ `sessionId`（Runtime 提供）**。`toolCallId`/`runId` 不是耐久跨 Run 身份。

## 8. Part 7 — Checkpoint Boundary

`[DECISION]`

```text
Checkpoint MUST contain:
  - Session messages 快照引用（或内容）
  - sessionId
  - Run Context（prompt / parentRunId / model.id / Skill-Workspace-Policy ctx 引用）
  - 外部 Operation ID（in-flight Tool，供对账）
  - Run status（pending/failed/unknown）

Checkpoint MUST NOT contain:
  - in-flight LLM stream / streamingMessage
  - in-flight Tool execution / pendingToolCalls
  - promises / callbacks / sockets
  - AbortController / activeRun
  - provider client 实例 / streamFunction / closures / functions
  - Resource Data（External 拥有，Phase 15）
```

选定 **Option E（Hybrid）**：Session 数据 + Run 上下文 + 外部 OpID。Checkpoint 不是 Agent State 全量拷贝（证明见 §4/§5）。

## 9. Part 8 — Persistence Boundary

`[DECISION]`

| Object | Persist? | Why | Owner |
| --- | --- | --- | --- |
| Session (messages+ctx) | ✅ | 恢复推理所必需 | Runtime |
| Run (prompt+ctx+OpID) | ✅（最小） | 重建 Run 必需 | Runtime |
| Checkpoint | ✅ | 安全恢复点 | Runtime |
| Trace | ⚠️ 可选 | 仅观测/审计，非恢复决策 | Runtime |
| Resource Reference | ✅（引用） | 定位/对账 External（Phase 15） | Runtime |
| Resource Data | ❌ | External 拥有（Postgres/S3/CRM/File/Payment） | External |

Runtime 不拥有 Resource Data（Phase 15）：持久化的是**引用/上下文**，非数据本身。

## 10. Part 9 — Process Crash Experiments（Exp1–7）

`[EXP]` + `[INF]`（ consolidated 实验覆盖关键位置；原理对所有位置一致：Pi 内存态全失，外部已提交副作用存活）

| Exp | 位置 | Pi 内发生 | Runtime 内 | 存活 | 消失 | 外部存活 | 可重建 | 须查询 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | before LLM | 无 | 无 | — | 配置/messages | — | ✅ 配置 | ❌ |
| 2 | during LLM | 部分 token | Trace 部分 | — | in-flight | — | ✅ 重请求（无副作用） | ❌ |
| 3 | after LLM, before Tool | 无 | Trace: LLM end | — | 配置 | — | ✅（Tool 未执行） | ⚠️ state-changing |
| 4 | during Tool | 执行中 | Trace: `start` | — | in-flight | ⚠️ 可能 | ❌（UNKNOWN） | ✅ |
| 5 | Tool side-effect then crash | 写外部 | Trace: `start` | — | in-flight | ✅ | ❌（UNKNOWN） | ✅ |
| 6 | result then crash | 结果产生 | Trace: `end` | — | 配置 | — | ✅ 下一 LLM | ❌ |
| 7 | next LLM begins then crash | 部分 | Trace 部分 | — | in-flight | — | ✅ 重请求 | ❌ |

`[EXP]` Exp-Crash 实证 Exp4/5：外部 `COMMITTED` 存活、无 `end` → UNKNOWN。

## 11. Part 10 — Resume Model

`[DECISION]`

```text
Model A（续原 Run）        ❌ Pi 不耐久 in-memory Run
Model B（续同逻辑 Run）     ❌ 同上
Model C（恢复 state+新 Run） ✅ 基础
Model D（重建 Session+新 Run）✅ 选定基础
Model E（先对账 External+新 Run）✅ 选定（UNKNOWN 时）

选定：Model E ∪ D —— 恢复时若有 UNKNOWN(in-flight Tool)，先查 External Resource 状态，
       再重建 Session（messages+sessionId）+ 新 Run。
```

不假设"resume = 继续同一内存 Pi 执行"（Pi 不支持，§4/§5）。

## 12. Part 11 — External Resource Reconciliation

`[DECISION]`

| Operation | Crash Risk | Can Query Status? | Needs OpID? | Safe Resume Strategy |
| --- | --- | --- | --- | --- | --- |
| `create_order` | 高 | ✅（按 orderId） | ✅ | 查订单状态；OpID 去重 |
| `charge_card` | 高 | ✅（按 txnId） | ✅ | 查交易；idempotencyKey 防重复扣款 |
| `send_email` | 高 | ⚠️（可能无查询） | ✅ | 幂等键；失败则人工/重发 |
| `write_file` | 中 | ✅（按 path 读） | ⚠️ path 即键 | 读文件确认是否写入 |
| `update_database` | 中 | ✅（按主键读） | ⚠️ 主键即键 | 读行确认；幂等更新需 OpID |

**Runtime 持久化 `operationId`/`resourceRef`，崩溃后据此向 External 查询真实状态——这是 UNKNOWN→KNOWN 的唯一路径。**

## 13. Part 12 — Multi-Agent Implication

`[INF]`（结合 Phase 16）

```text
A delegates B；B 执行 Tool；B 崩溃：
  - B 独立持久自身 Checkpoint（每 Agent 独立，Phase 16 无 Coordinator）
  - A 持久 delegation 状态（parentRunId 足够作为关联元数据）
  - A 崩溃而 B 继续：B 独立；A 重启后 re-delegate（新 Run）或查 B 状态
  - parentRunId 作为关联元数据仍充分
```

**Phase 16 "无 Coordinator" 结论仍然成立**。无证据要求新 Coordinator Boundary。

## 14. Part 13 — Harness Boundary

`[DECISION]`

```text
Persistence owner:        Enterprise Runtime（Control Plane）
Checkpoint owner:         Enterprise Runtime
Resume decision owner:    Enterprise Runtime（Recovery Decision Owner, Phase 13）
Agent state owner:        Pi（in-memory，Runtime 负责重建）
External state owner:     External Resource
```

Harness 保持**概念边界**（Phase 10）；Persistence/Checkpoint 属 Runtime 职责，不进 Pi（Pi 保持执行引擎、内存态），不新建 Harness 模块。

## 15. Part 14 — Required Architecture Matrix

| Concept | Purpose | Owner | Lifecycle | Persist? | Reconstructable? | External Source of Truth? |
| --- | --- | --- | --- | --- | --- | --- |
| Session | 逻辑连续交互 | Pi/Runtime | 跨 Run | ✅ | ✅(messages+ctx) | ❌ |
| Run | 一次执行 | Pi/Runtime | Run | ✅(最小) | ✅(prompt+ctx) | ❌ |
| Run Context | 执行边界/控制 | Runtime | Run | ✅ | ✅ | ❌ |
| Agent State | 认知/执行态 | Pi | in-mem | ❌(重建) | ✅(由 Session 重建) | ❌ |
| Trace | 观测 | Runtime | Run | ⚠️ 审计 | ⚠️ | ❌ |
| Checkpoint | 安全恢复点 | Runtime | Run | ✅ | ✅ | ❌ |
| Operation ID | 外部操作身份 | Tool/External | 外部 | ✅(Runtime 存引用) | ✅ | ✅ |
| Resource Reference | 资源定位/对账 | Runtime | Session/Run | ✅(引用) | ✅ | ❌(指向 External) |
| Resource Data | 真实副作用 | External | 外部 | ❌ | ❌ | ✅ |
| Policy Context | 调用治理 | Runtime | Run | ⚠️(配置) | ✅ | ❌ |
| Skill Context | 能力激活 | Runtime | Session | ✅(元数据) | ✅ | ❌ |
| Workspace Context | 资源 Scope | Runtime | Session | ✅(元数据) | ✅ | ❌(指向 External) |

## 16. Final Architecture Decision

```text
PHASE 18 INVESTIGATION: COMPLETE

PERSISTENCE DEFINITION:
  进程死亡后必须存活的最小信息 = Session messages + sessionId + Run prompt/ctx + 外部 Operation ID + Resource Reference

SESSION PERSISTENCE:
  messages + sessionId + 激活配置(systemPrompt/model.id/tools按名/Skill/Workspace/Policy ctx)

RUN PERSISTENCE:
  prompt + parentRunId + model.id + Skill/Workspace/Policy ctx + Operation ID 列表 + status（runId 重建）

RUN CONTEXT PERSISTENCE:
  prompt / parentRunId / model.id / 激活 ctx 引用（runId 不耐久，重建）

AGENT STATE:
  不可直接序列化恢复；由持久化 Session + Run 信息在新 Pi 实例重建（新 Run）

TRACE:
  观测（What happened），非恢复决策；可选项持久化仅用于审计；崩溃时 in-memory 丢失

CHECKPOINT DEFINITION:
  最小安全恢复点 = Session 快照 + Run Context + 外部 Operation ID（Hybrid）

CHECKPOINT MUST CONTAIN:
  messages 引用 + sessionId + Run Context(prompt/parentRunId/model.id/激活ctx) + 外部 OpID + status

CHECKPOINT MUST NOT CONTAIN:
  in-flight LLM stream / streamingMessage / pendingToolCalls / activeRun / AbortController /
  promises / callbacks / sockets / provider client / streamFunction / closures / Resource Data

OPERATION IDENTITY:
  耐久身份 = operationId + idempotencyKey（Tool/External）+ sessionId（Runtime）；
  toolCallId / runId 非耐久跨 Run 身份（Phase 17）

  > [CORRECTION-22 / C1] 后续 Phase 20 实现 + Phase 21 冻结审计推翻了本处对 `operationId` 的“耐久”断言：
  > 实现中 `operationId` 仅在正常完成路径（`afterToolCall`）从 `result.details` 补写，进程崩溃（`process.exit(137)`）
  > 时不持久；真正 crash-safe、用于 `reconcile` 的耐久对账身份只有 `idempotencyKey`。详见 `phase-21-architecture-freeze.md` C1。

RESOURCE REFERENCE:
  Runtime 持久化 workspaceId/resourceId/accessScope/credential-ref（引用，非数据）

RESOURCE DATA:
  External 拥有，Runtime 不持久化；仅经 Reference 定位与对账

EXTERNAL RESOURCE RECONCILIATION:
  UNKNOWN(in-flight Tool) 时，用 operationId/resourceRef 向 External 查询真实状态 → UNKNOWN→KNOWN

RESUME MODEL:
  Model E ∪ D：先对账 External（若有 UNKNOWN），再重建 Session + 新 Run（非续原内存 Run）

PROCESS CRASH SEMANTICS:
  Pi 内存态全失；外部已提交副作用存活；Trace in-memory 丢失；
  Case C/D/E 类未收 result = UNKNOWN，须查 External，不得判 FAILED

PERSISTENCE OWNER:
  Enterprise Runtime（Control Plane）

CHECKPOINT OWNER:
  Enterprise Runtime

RESUME DECISION OWNER:
  Enterprise Runtime（Recovery Decision Owner, Phase 13）

RUNTIME ↔ PI BOUNDARY:
  Pi = 执行引擎（in-memory Agent State）；Runtime = 持久化/检查点/恢复决策/外部对账

MULTI-AGENT IMPLICATION:
  Phase 16 无 Coordinator 仍成立；每 Agent 独立 Checkpoint；parentRunId 关联充分

HARNESS ROLE:
  保持概念边界（Phase 10）；Persistence/Checkpoint 属 Runtime，不进 Pi、不建 Harness 模块

IMPLEMENTATION:
  DEFERRED

CODE CHANGED:
  NO
```

---

```text
STOP CONDITION: 已回答 22 项（Session/Run 构成、Agent State/Run Context 持久边界、Trace 责任、
Checkpoint 含义与最小内容、禁止持久项、Operation Identity、Resource Reference/Data 边界、
各崩溃位置可恢复性、External 对账时机、Resume=新 Run、Persistence/Checkpoint/Resume Owner、
Pi 内 vs Runtime、Multi-Agent 无新边界、Harness 概念）。

本 Phase 结束，不进入 Phase 19，不实现任何 Persistence/Checkpoint/Resume 模块。
仅确立边界，待生产耐久需求（进程重启恢复、UNKNOWN 对账、跨 Run 恢复）出现再实现对应最小原语。
```
