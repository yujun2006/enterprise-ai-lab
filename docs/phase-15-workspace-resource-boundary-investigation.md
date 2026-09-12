# Phase 15 — Workspace / Resource Boundary Investigation

## 1. Executive Summary

**核心结论：采用 Model C（Hybrid）。**

```text
Workspace / Resource 是 Agent 可访问的数据，
但 Enterprise Runtime 应正式管理的是「Resource Access Boundary」
（Resource Identity + Access Scope + Credential Reference + Policy Context + Workspace Context），
而不是 Resource Data 本身。

真实数据仍属外部系统（GitHub / S3 / Postgres / FS / CRM / KB）。
Runtime 拥有「访问边界」，外部系统拥有「数据本身」。
```

```text
PHASE 15 INVESTIGATION: COMPLETE
CODE CHANGED: NO
WORKSPACEMANAGER IMPLEMENTED: NO
RESOURCEMANAGER IMPLEMENTED: NO
STORAGE / VFS / RAG IMPLEMENTED: NO
```

**与 Phase 14 的关键区别**：Skill 在 Phase 14 被判定为"可推导、暂不需一级对象"；而 Workspace/Resource **不可**由 `agent.state` 完全推导——它引用的是**外部所有权**（数据/凭据在 Runtime 之外），因此它有更强的理由成为 Runtime 一级"资源边界"概念。但**实现仍 DEFERRED**，直到多 Agent 或按 Workspace 隔离真正需要。

## 2. Workspace / Resource 定义

`[DECISION]`

```text
Resource  = 一个具体 Target（被作用对象）：
             文件 / DB 表 / 客户记录 / Git 仓库 / 知识库 / 外部 API 端点
             「对什么做」

Workspace = Resource 的命名容器 / Scope / Namespace / Context：
             一组在某 Session 内"在玩的"Resource 的集合
             「在哪些资源上做」
             （NOT 文件夹；NOT Agent 实例）
```

**Workspace 与 Resource 的关系**：Workspace 是 Resource 的 Scope/Namespace；Resource 是 Workspace 内的个体 Target。二者 ≠ 同一概念。

**Tool vs Resource**：`Tool = Action（做什么）；Resource = Target（对什么做）`成立。
```text
read_file()        → Tool（Action）
project-a/main.ts  → Resource（Target）
Tool → External API → 端点/资源即 Target，Tool 即 Action（同样适用）
```

## 3. Responsibility Matrix

`[SOURCE]`（runtime.ts:43-49,75-78；agent.js:26-49）+ `[INF]`

| Concept    | Responsibility                                  | Lifecycle                | Owner                                  |
| ---------- | ----------------------------------------------- | ------------------------ | ------------------------------------- |
| **Workspace** | Resource Scope（命名资源容器 + 访问边界元数据） | Runtime-level Resource；Session 激活 | Enterprise Runtime（边界/元数据）；External（数据） |
| **Resource**  | 被作用的数据 Target                              | 外部系统生命周期           | External System（数据）；Runtime（Access 边界） |
| Tool       | Business Action                                 | Agent 实例/Run            | Runtime（Registry）/ Tool             |
| Policy     | Tool Call Decision（+未来 Resource Scope 维度） | Run（per call）           | Runtime                                |
| Skill      | Capability Activation（Tool Set 选择）          | Session                   | Runtime                                |
| Session    | Conversation Continuity                          | 跨 Run                    | Pi / 未来 Session 层                   |
| Run        | Execution                                        | Run                       | Pi / Runtime                           |
| Trace      | Observation                                       | Run                       | Runtime                                |

## 4. Resource Ownership vs Resource Access Ownership

`[DECISION]` + `[INF]`

```text
Option A: Tool owns Resource        → 实现层面 Tool 封装了连接（如 get_customer→CRM），但非架构所有权
Option B: Runtime owns Resource     → 否；Runtime 不应拥有真实数据
Option C: External owns Resource; Runtime owns Access Boundary → ✅ 选定

Resource Ownership(真实数据)   = External System
Resource Access Ownership(身份/范围/凭据/策略) = Enterprise Runtime
```

`[SOURCE]` get_customer（src/tools/get-customer.ts:31-40）已体现"Tool 内连接外部数据"——资源数据不在 Runtime 内。
`[EXP]` Phase 15 ExpC：两个 Agent 各自绑定不同 root 的 read_doc，互不干扰 → 资源访问边界由 Tool 绑定隔离，Runtime 通过 Tool 集控制边界。

## 5. Workspace Boundary（生命周期）

`[DECISION]` + `[EXP]`

- **Workspace = Runtime-level Resource（identity/scope/metadata/credential-ref），在 Session-level 激活。**
- 实验证明：Workspace Scope 由「Tool 绑定的资源根」实现（read_doc 闭包 root）。因 Tool 是 per-Agent-instance 配置且跨 Run 保留（Phase 12），Workspace 自然延续于同一 Session 的多次 Run。
- `[EXP]` ExpA：同 Session 两次 Run，read_doc 均解析到同一 root（wsA）→ 跨 Run 延续。
- `[EXP]` ExpB：同实例内 Workspace A→B 切换 = 重绑 `agent.state.tools` → transcript(messages) 保留但资源 Scope 改变 → 语义上等同 **Session 边界事件**（不应在同 Session 内静默切换）。
- `[EXP]` ExpC：Agent A(wsA) / Agent B(wsB) 各自绑定隔离 → state 隔离。
- 故：**Workspace 激活层级 = Session-level**（Run-level 切换技术可行但 incoherent，视作 Session 边界）。

## 6. Workspace vs Skill

`[INF]`（结合 Phase 14）

```text
Skill     = Capability Scope   （能做什么 → 选择 Tool Set）
Workspace = Resource Scope     （在哪些资源上做 → 限定 Resource Target）
```

- 二者**正交**，在 Session 激活时组合：`Skill + Workspace → 在 Y 资源上做 X 动作`。
- **Skill 不拥有 Workspace**（禁止 Skill owns Workspace）。
- 这是本 Phase 最重要的候选边界：`Skill → Capability Scope；Workspace → Resource Scope`。

## 7. Workspace vs Policy

`[INF]`

```text
Skill     → Capability Scope
Workspace → Resource Scope
Policy    → Action Permission（在 Scope 上允许什么）
```

- Workspace 定义 Resource Scope；Policy 决定在该 Scope 上的动作许可（如 `Workspace=prod-db, Policy=read-only`）。
- 当前 Policy（Phase 4）只看到 Tool Call，未看到 Resource。引入 Workspace 后，Policy *可*额外考量 Resource Scope（未来增强），但**不实现新 Policy Framework**。
- 候选模型成立，能解释现有架构。

## 8. Resource vs Tool Visibility

`[INF]`（结合 Phase 5 / 14）

```text
Skill    → Tool Visibility      （选择哪些 Tool 可见）
Workspace → Resource Visibility  （界定哪些 Resource 在 Scope 内）
```

- **Tool Visibility ≠ Resource Access（必须区分）**：
  - Tool Visibility = 哪些 Tool 对 LLM 可见（Phase 5：Static Tool Set）。
  - Resource Visibility = 哪些 Resource 在 Scope 内（由 Workspace 定义）。
  - Resource Access = 真正的控制点（Policy + Tool 的外部鉴权）。
- Skill 只选 Tool；Resource Visibility 的 canonical owner 是 Workspace，不是 Skill。Skill 至多携带 Policy Context（Phase 14），不拥有 Resource。

## 9. Resource Access Path（真实执行链）

`[SOURCE]`（runtime.ts:50-78 Policy 注入；agent.js:90-102 prepareNextTurn；Phase 4 beforeToolCall）+ `[INF]`

```text
LLM
 ↓
Tool Call
 ↓
Policy (beforeToolCall — Runtime 控制点)   ← 当前唯一 Runtime 介入点
 ↓
Tool.execute
 ↓
Resource (External System，凭据在 Tool 内或 Workspace 绑定中)
```

- 当前没有独立的 Resource Resolver / VFS；Policy 是 Runtime 控制点，Tool 自身连资源（get_customer→CRM）。
- 若引入 Workspace：其 Scope 通过**在 Session/Run 激活时把 Tool 绑定到 Workspace 上下文**实现（Tool 构造时带 root/credential），**不进入 Pi 的 agent loop**。
- `[EXP]` Phase 15：read_doc 的 root 由闭包固定即 Workspace Scope 的落地方式。

## 10. Resource Context vs Agent State

`[DECISION]`

| Model | 判断 |
| --- | --- |
| A: Resource Context ∈ Agent State | ❌ agent.state 是 Pi 拥有的认知状态（systemPrompt/tools/messages），Workspace 是执行上下文，不应污染 |
| B: Resource Context ∈ Run Context | ✅ 作为 Run 的激活前输入（与 Skill 同），记入 Trace |
| C: Resource Context ∈ Session Context | ✅ Workspace 稳定跨 Run，归属 Session 最自然 |
| D: Resource Context ∈ Runtime Control State | ✅ Workspace 作为 Runtime 管理的 Resource 实体（identity/scope/credential）存在 |

**最终**：Workspace = **Session 级上下文**（跨 Run 稳定）+ **Runtime 级 Resource 实体**（identity/metadata）；**作为 Run Context 输入记入 Trace**；**不在 agent.state**。与 Phase 11（Run Context=执行边界）、Phase 14（Skill=Session 级配置）一致。

## 11. Persistence Implication

`[INF]`

- 未来 Checkpoint 应保存 **Resource Reference / Context**（`workspaceId, resourceId, resourceType, accessScope, credential reference`），**不是 Resource Data**。
- 与 Phase 12 一致：`createContextSnapshot`（agent.js:280-285）保存 systemPrompt/messages/tools；Workspace 作为 Session 元数据附加，**数据留在外部**。
- 明确区分：`Resource Data`（外部）vs `Resource Reference / Context`（Runtime 持久化）。

## 12. Security / Policy Boundary

`[DECISION]`

```text
Resource  → "是什么资源"
Tool      → "做什么动作"
Policy    → "是否允许动作"（未来可考量 Workspace Scope）
Runtime   → "控制执行"（激活 Workspace 绑定、运行 Policy）
External System → "真正拥有数据/权限"（在其边界强制）
```

模型成立，明确记录。Runtime 拥有访问边界 + 执行控制；External 拥有数据。

## 13. Multi-Agent Implication

`[INF]`

```text
Agent A ─┐
Agent B ─┼── Workspace X
Agent C ─┘
```

- Workspace 与 Agent 生命周期**独立**（多 Agent 共享同一 Workspace）→ Workspace 应独立于 Agent 的一级 Runtime Resource 实体。
- 这正是 Workspace 区别于 Skill 之处：Skill 可由 systemPrompt+toolset 推导（Phase 14 暂不需一级对象）；**Workspace 引用外部所有权（数据/凭据在 Runtime 外），无法由 agent.state 推导**，故更有理由成为一级 Resource 概念——但**实现 DEFERRED**。

## 14. Final Decision

```text
PHASE 15 INVESTIGATION: COMPLETE

WORKSPACE / RESOURCE MODEL: Model C (Hybrid)
  Runtime owns Resource Access Boundary (Identity + Scope + Credential Ref + Policy Ctx + Workspace Ctx)
  External System owns Resource Data

WORKSPACE DEFINITION: Resource 的命名 Scope/Namespace（"在哪些资源上做"）
RESOURCE DEFINITION:  具体 Target（"对什么做"）；Tool = Action，Resource = Target

WORKSPACE OWNER: Enterprise Runtime（边界/元数据/激活）；External（数据）
RESOURCE OWNER:       External System（数据）；Runtime（Access 边界）

WORKSPACE LIFECYCLE: Runtime-level Resource 实体 + Session-level 激活
                     （Run 级切换技术可行但视作 Session 边界事件）

WORKSPACE → SKILL: 正交；Skill=Capability Scope，Workspace=Resource Scope；Skill 不拥有 Workspace
WORKSPACE → POLICY: Workspace=Resource Scope；Policy=Action Permission（未来可考量 Scope）
WORKSPACE → TOOL VISIBILITY: Workspace→Resource Visibility；vs Tool Visibility 必须区分
WORKSPACE → AGENT STATE: 不在 agent.state；∈ Session Context + Run Context(input) + Trace
WORKSPACE → PERSISTENCE: 保存 Resource Reference/Context，不保存 Resource Data

MULTI-AGENT: Workspace 独立于 Agent 生命周期（共享），是 Runtime 一级 Resource 候选

SHOULD BECOME FORMAL RUNTIME BOUNDARY? YES（作为 access-boundary/context 概念）
  Runtime 拥有访问边界，External 拥有数据（避免内置 Storage/VFS 过度工程）

WORKSPACE IMPLEMENTATION: DEFERRED
  （理由强于 Skill：引用外部所有权，无法由 agent.state 推导；
   但等到多 Agent / 按 Workspace 隔离真正需要再实现）

CODE CHANGED: NO
```

## 15. Evidence / Source Table

| 结论 | 位置 | 标记 |
| --- | --- | --- |
| 无 Workspace/Resource 概念（src 搜索 0 命中） | src/* | `[SOURCE]` |
| Tool 封装外部数据连接（get_customer→CRM 模拟） | src/tools/get-customer.ts:31-40 | `[SOURCE]` |
| `agent.state` 仅含 systemPrompt/tools/messages/model（无 workspace 字段） | agent.js:26-49 | `[SOURCE]` |
| `registerTool` 重设 `agent.state.tools` = Workspace 切换同机制 | runtime.ts:75-78 | `[SOURCE]` |
| Policy 为 Tool Call 控制点（beforeToolCall） | runtime.ts:50-60；Phase 4 | `[SOURCE]` |
| ExpA: 同 Session 两次 Run，Workspace root 一致（跨 Run 延续） | scripts/_investigate-15.ts | `[EXP]` |
| ExpB: 同实例 Workspace A→B = 重绑 tools；messages 保留、Scope 变 | 同上 | `[EXP]` |
| ExpC: Agent A(wsA)/Agent B(wsB) 各自绑定隔离 | 同上 | `[EXP]` |
| Workspace ∈ Session Context，不入 agent.state | §10 | `[DECISION]` |
| Runtime 拥有 Access Boundary，External 拥有数据 | §4,§12 | `[DECISION]` |
| Workspace 比 Skill 更有理由成一级 Resource，但实现仍 DEFERRED | §13,§14 | `[DECISION]` |

---

```text
PHASE 15 INVESTIGATION: COMPLETE
CODE CHANGED: NO

NEXT STEP (must NOT auto-start):
停止。不进入 Phase 16，不顺手实现 WorkspaceManager / ResourceManager / Storage / VFS / RAG /
Credential Vault / 新 Policy Framework / Multi-Agent。
若未来多 Agent 或按 Workspace 隔离需要，再将 Workspace 提升为 Runtime 一级 Resource（identity
+ scope + metadata + credential reference），在 Session 激活时把 Tool 绑定到 Workspace 上下文，
并最小增强 Trace（Run Context 增加 workspace 字段）、Checkpoint 保存 Resource Reference（非 Data）。
不现在实现。
```
