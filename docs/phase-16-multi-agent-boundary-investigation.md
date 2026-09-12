# Phase 16 — Multi-Agent Boundary Investigation

## 1. Executive Summary

**核心结论：Model A（Multiple Independent Agents）+ 最小 Delegation 足以表达当前阶段 Multi-Agent。不需要 Coordinator / Orchestrator 新控制边界。**

```text
Multi-Agent = 多个独立的 EnterpriseAiRuntime 实例（每个包一个 Pi Agent）
            + 一个 Delegation 原语（Agent A 经 Tool 调起 Agent B.run()）

Agent 之间：
  - 无共享可变 State（各自 messages/systemPrompt/tools/Session/Run/Trace）
  - 通过 Delegation Tool 通信（Tool 仅为 transport，不隐藏 B 的语义）
  - B 的失败作为 Tool result 回传 A，由 A 的 LLM loop 决定下一步
  - Trace 各自独立，可经 parentRunId 关联（元数据，非 Coordinator）

Coordinator：NOT NEEDED（当前阶段）。AgentManager/Registry/Orchestrator/Router/Scheduler/
TaskGraph/MessageBus/Swarm/MCP/Distributed Runtime 一律不实现。
```

```text
PHASE 16 INVESTIGATION: COMPLETE
CODE CHANGED: NO
```

## 2. What Is an Agent?

`[SOURCE]`（src/runtime.ts:30-62）

```text
EnterpriseAiRuntime 实例 = 一个 Pi Agent + Enterprise Runtime Context
  ├── Agent（发动机，含 messages/tools/model/systemPrompt/activeRun/abortController）
  ├── Policy（beforeToolCall 控制点）
  ├── TraceCollector（观察，不控制）
  └── Skill + Workspace 激活上下文（Phase 14/15，作为构造/激活配置）
```

**Agent = `EnterpriseAiRuntime` 实例**（一个 Pi Agent 被 Runtime 包装）。NOT `Skill + Tool Set + Workspace + Policy + Session`（这些是 Agent 的*配置维度*）；NOT "Long-lived Business Identity"（身份由实例承载，但能力可配置）。

## 3. Agent Instance Ownership

`[SOURCE]`（src/runtime.ts:37 `constructor`）+ `[INF]`

```text
Model A（选定）：Application / Runtime-host 直接 new EnterpriseAiRuntime(...)
  const a = new EnterpriseAiRuntime({...})
  const b = new EnterpriseAiRuntime({...})

AgentManager 只是容器，不提供当前缺失的能力 → 不需要。
```

验证（§4 实验前）：多个 `new EnterpriseAiRuntime()` 已天然表达"多个 Agent"。Agent 的 owner = 创建它的 Application / 宿主 Runtime 层。

## 4. Agent vs Tool

`[DECISION]` + `[EXP]`

```text
Tool  = concrete action：固定 schema + execute() + result；确定性、单能力
Agent = independent reasoning/execution entity：model + systemPrompt + tools + state +
        Session + Run + lifecycle + 自己的 Policy/Trace/Failure 语义
```

**Agent ≠ Tool。** 但若把 `delegate_to_researcher` 作为 Agent A 的 Tool，Tool 只是**Delegation 的 transport**，不是 Agent B 的身份。关键：`execute()` 内 `new EnterpriseAiRuntime().run()` 让 B 作为**完整 Agent** 执行——B 的 Session/Run/Policy/Trace/Failure 不被 Tool 抽象隐藏，而是被 Runtime 如实记录（见 §10,§12,§13 实验）。

`[EXP]` Phase 16 Exp1：A 调 `delegate_to_researcher` → `new Agent B`（独立 `agent_start…agent_end`、独立 `get_customer`、独立 `[B trace]`）；B 的语义全部可见，未被压平为单一 `(args)->(result)`。

## 5. Agent vs Skill

`[INF]`（结合 Phase 14）

```text
Skill = Capability Activation Profile（Agent 的可变能力配置，Session 级）
Agent Identity = Runtime 实例本身
```

`Agent = Alice` 与 `Skill = Finance Analyst` 是两个维度：Agent 是实例/身份，Skill 是该实例在某 Session 激活时的能力剖面。Agent ≠ Skill。多 Agent 时，每个 Agent 可有自己的 Skill 配置（在构造/激活时注入 systemPrompt + Tool Set）。

## 6. Agent vs Workspace

`[EXP]`（Phase 15 ExpC）+ `[INF]`（结合 Phase 15）

```text
Workspace = Resource Scope（Runtime 一级 Resource，identity + access boundary）
Agent A → Workspace X
Agent B → Workspace X   ✅ 允许（共享）
Agent A → Workspace X / Agent B → Workspace Y ✅ 允许（隔离）
```

Workspace 是**正交、可共享**的激活上下文。多个 Agent 可共享同一 Workspace（Multi-Agent 共享资源范围的典型场景）。Workspace ≠ Agent 私有，归 Runtime 拥有的 Resource 边界。

## 7. Agent vs Policy

`[INF]`

```text
每个 Agent 的 Tool Call → Policy（beforeToolCall，Runtime 控制点，ALLOW/ASK/DENY）
Agent A → Delegate(Agent B) 本身 = Governance Action → 也应经 Policy
```

当前 Policy 只看到 Tool Call；Delegation 经 Tool 实现时，委托动作已被 Tool 级 Policy 覆盖。若未来需要"Agent A 是否允许委托 Agent B"的细粒度治理，是 Policy 的**增强维度**（在 Policy 输入中增加 delegation 上下文），不是新 Policy Framework。Delegation 属于 Governance Action 的结论成立。

## 8. Session Boundary

`[DECISION]`

```text
Session = Agent-local（每个 EnterpriseAiRuntime 实例拥有自己的 messages = 自己的 Session）
无跨 Agent Session 实体。
```

多 Agent Task = N 个 Agent，各自独立 Session。若需"共享对话"，通过 Delegation payload 传递消息，而非共享 Session 实体。实验佐证：Exp1 中 B 拥有独立 `agent_start…agent_end` 与独立 messages，与 A 的 Session 完全隔离。

## 9. Run Boundary

`[DECISION]` + `[EXP]`

```text
Run = Agent-local。

A → B 委托的语义：
  Run A（Agent A）
    └── tool_call: delegate_to_researcher
         ↓（execute 内 new Agent B）
         Run B（Agent B，独立 Run）
         ↓ result
    继续 Run A（A 的 loop 拿到 tool result 后继续）
```

不是"一个 Run 内同步调另一个 Agent"——每个 Agent 拥有自己的 Run；委托是 Run A 中的一个 Tool Call 步骤，Run B 独立，结果回传后 Run A 继续。`[EXP]` Exp1：A 在单次 run 内多次委托（每次 `new Agent B`），A 的 agent 不结束，B 各自独立运行。

## 10. Agent-to-Agent Communication

`[DECISION]`

```text
选定 Model A（Tool / Delegation transport）：
  Agent A → Tool(delegate_to_X) → Runtime 解析 → new Agent B().run() → result → A

拒绝 Model C（Message Bus）：无消息中间件、无 broker。
```

理由：`EnterpriseAiRuntime` 已支持 Tool，且 Tool 经 Policy 控制、经 Trace 观察、失败回传 LLM loop。Delegation-as-Tool 复用全部既有边界。Model B（Runtime Delegation 原语）语义更干净，但当前 Runtime 无此原语，且 Tool 机制已能表达，故不新增 Runtime 边界。

## 11. Shared State

`[DECISION]`（基于 §2,§8,§9 + Phase 14/15）

| State           | A/B 是否共享               | Owner                | 说明 |
| --------------- | -------------------------- | -------------------- | ---- |
| messages        | ❌ 不共享（Agent-local）    | Pi（per instance）   | 各自 Session |
| tools           | ❌ 不共享实例（可引用同 Registry 定义） | Runtime/Pi     | per-instance config |
| systemPrompt    | ❌ 不共享                  | Pi/Runtime           | 激活配置 |
| Session         | ❌ 不共享（Agent-local）    | Runtime（per agent） | §8 |
| Workspace       | ⚠️ 可共享（Runtime Resource） | Runtime            | Phase 15，可显式共享 |
| Resource Access | ⚠️ 随 Workspace 可共享      | Runtime（边界）      | Phase 15 |
| Policy         | ❌ 不共享实例（同框架，per-agent 配置） | Runtime       | §7 |
| Trace           | ❌ 不共享实例（可经 parentRunId 关联） | Runtime        | §12 |
| Run Context     | ❌ 不共享（Run-local）      | Run                  | Phase 11 |
| Model           | ❌ 不共享（per-agent）      | Agent                | |

**默认不共享**；仅 Workspace/Resource Access 可经 Runtime Resource 显式共享。

## 12. Trace Boundary

`[DECISION]` + `[EXP]`

```text
Model B（链接，非合并）：
  Trace A（Agent A 独立）
  Trace B（Agent B 独立）
  关联：B 的 Run Context / Trace 携带 parentRunId（= A 的 delegation Run id）

不做 distributed tracing framework；仅一个元数据字段。
```

`[EXP]` Exp1：A 的 trace（`[A trace]`）与 B 的 trace（`[B trace]`）完全独立输出，B 拥有自己的 `tool_execution_start get_customer` 等事件——证明 Trace 天然 per-agent，只需 parentRunId 关联即可获得可见性。

## 13. Failure / Recovery Boundary

`[DECISION]` + `[EXP]`

```text
Tool Failure in Run B = Agent B 的 Execution Failure
  → Recovery Decision Owner = Runtime（Phase 13），在 Agent B 内处理
B 整体失败 → 错误作为 Delegation Tool 的 result（isError）回传 Run A
  → Agent A 的 LLM loop 决定 next step（retry / abort / continue / escalate）
```

**跨 Agent Recovery 不需要 Coordinator**：A 的既有 LLM loop + 既有 Tool 错误处理已覆盖。`[EXP]` Exp2：B 强制失败 → 错误回传 A → A 的 run 产出"researcher 无法提供信息"的回应，loop 继续。Phase 13 的 Recovery Decision Owner（Runtime）在 B 内生效，A 侧只是普通 tool 结果处理。

## 14. Delegation Model

`[DECISION]`

```text
选定 Model 1：Agent A → Tool → Agent B
  - Tool 仅为 transport；B 经 new EnterpriseAiRuntime().run() 完整执行
  - B 的 Session/Run/Policy/Trace/Failure 不被隐藏（Runtime 如实记录）
  - Delegation 经 Policy（Tool 级）；失败经 Tool result 回传
```

对比 Model 2（Runtime Delegation）：语义更纯（不把 Agent 压成 Tool），但当前 Tool 机制已等价表达，且避免新增 Runtime 边界，故首层采用 Model 1。若未来需要"动态选择目标 Agent"或"委托治理维度"，再评估最小 Runtime Delegation 原语——但非现在。

## 15. Coordinator Necessity

`[DECISION]`

```text
COORDINATOR: NOT NEEDED（当前阶段）

理由（基于 SOURCE + EXP）：
  1. A→B 委托 = Tool Call（经 Policy、经 Trace、失败回传 LLM loop）→ 无需协调者
  2. Session/Run 均 Agent-local，无共享可变 State 需协调者仲裁
  3. Trace 关联 = parentRunId 元数据，非协调者
  4. Recovery 跨 Agent = A 的 LLM loop + 既有 Tool 错误处理，Phase 13 Owner 不变
  5. 现有实验（Exp1/Exp2）证明"多独立 Agent + Delegation Tool"已跑通
```

Full Orchestrator（planning/routing/scheduling/workflow/state/recovery）属"未来可能需要"——明确禁止。仅当以下证据出现才需最小协调边界：
- 动态 Agent 选择（目标 Agent 非设计时预定）
- 跨 Agent 工作流依赖管理（TaskGraph）
- 跨 Agent 共享可变 State

当前实验均为"已知目标 Agent"的委托 → 不需要。

## 16. Multi-Agent Boundary Matrix

`[DECISION]`

| Concept         | Single Agent          | Multi-Agent                              | Owner                          |
| --------------- | --------------------- | ---------------------------------------- | ------------------------------ |
| Agent           | 1                     | N（多个 EnterpriseAiRuntime 实例）        | Application / Runtime-host     |
| Session         | 1                     | N（Agent-local，不共享）                  | Runtime（per agent）           |
| Run             | 1                     | N（Agent-local，委托=Run A 内 Tool Call）| Pi / Runtime                   |
| Skill           | 1（Session 级配置）    | N（每 Agent 各自激活）                    | Runtime                        |
| Tool Set        | 1（per-instance）      | N（可引用同 Registry 定义）               | Runtime/Tool                   |
| Workspace       | 1（Resource Scope）    | 可共享（跨 Agent 经 Runtime Resource）    | Runtime                        |
| Resource Access | 1                     | 随 Workspace 可共享                       | Runtime                        |
| Policy          | per-agent             | per-agent（委托=Tool 级治理）             | Runtime                        |
| Trace           | 1                     | N（独立 + parentRunId 关联）              | Runtime                        |
| Run Context     | Run-local             | Run-local（携带 parentRunId）             | Run                            |
| Recovery        | Runtime（Phase 13）    | per-agent（失败回传委托方 LLM loop）      | Runtime / 委托方 LLM           |
| Delegation      | N/A                   | Tool transport → new Agent().run()        | Runtime（经 Policy/Trace）     |
| Coordination    | N/A                   | NOT NEEDED                                | —                              |

## 17. Final Architecture Decision

```text
PHASE 16 INVESTIGATION: COMPLETE

AGENT DEFINITION: EnterpriseAiRuntime 实例 = 一个 Pi Agent + Runtime Context(Policy/Trace/Skill+Workspace 激活)

AGENT OWNER: Application / Runtime-host（直接 new EnterpriseAiRuntime）

AGENT INSTANCE MODEL: Multiple Independent Agents（Model A）；无 AgentManager

SESSION BOUNDARY: Agent-local（每实例自有 Session/messages）；无跨 Agent Session

RUN BOUNDARY: Agent-local；委托 = Run A 内 Tool Call → Run B（独立）→ result → Run A 继续

AGENT ↔ TOOL: Agent ≠ Tool；Tool=concrete action，Agent=independent reasoning entity；
            Delegation 用 Tool 作 transport，不隐藏 B 的语义

AGENT ↔ SKILL: Skill = Agent 的可变能力配置（Session 级）；Agent Identity ≠ Skill

AGENT ↔ WORKSPACE: Workspace = Resource Scope（Runtime Resource），可跨 Agent 显式共享

AGENT ↔ POLICY: 每 Agent Tool Call + Delegation 均经 Policy；Delegation=Governance Action

AGENT ↔ TRACE: 各 Agent 独立 Trace；经 parentRunId 关联（无 distributed tracing）

AGENT ↔ RECOVERY: Tool Failure=Agent B Execution Failure(Runtime Owner)；错误回传 A 的 LLM loop 决定 next step

AGENT-TO-AGENT COMMUNICATION: Delegation Tool（transport）；NOT Message Bus

DELEGATION MODEL: Model 1（A → Tool → new Agent B().run()）；B 完整执行、语义不隐藏

COORDINATOR: NOT NEEDED（当前阶段；无动态选择/工作流/共享可变 State 证据）

MULTI-AGENT IMPLEMENTATION: DEFERRED
  未来最小原语（如确需）：Delegation Tool + parentRunId 关联；
  仅当"动态目标 Agent / TaskGraph / 跨 Agent 共享 State"证据出现，才评估最小 Runtime Delegation 边界

CODE CHANGED: NO
```

---

```text
STOP CONDITION: 已回答 — Agent 定义 / 即 Pi 实例 / 谁拥有 / 与 Tool·Skill·Workspace·Policy 边界 /
Session·Run 是否 Agent-local / Delegation 是什么 / 是否共享 State / Trace 跨 Agent /
Failure·Recovery 跨 Agent / 是否需要 Coordinator。

本 Phase 结束，不进入 Phase 17，不实现任何 Multi-Agent 模块
（AgentManager/Registry/Coordinator/Orchestrator/Router/Scheduler/Workflow/TaskGraph/
MessageBus/Swarm/MCP/Distributed Runtime/Agent Persistence），不修改 Pi，不重构 Runtime。
```
