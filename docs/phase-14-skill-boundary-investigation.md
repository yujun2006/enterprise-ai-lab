# Phase 14 — Skill Boundary Investigation

## 1. Executive Summary

**Skill 在 Enterprise Runtime 中是：一个命名的能力激活剖面（Named Capability Activation Profile）——在 Session/Run 激活时，把 `(systemPrompt + Tool Set 选择 + 可选 Policy Context)` 绑定到一次 Agent 执行。它是"选择并激活哪组能力与指令"的边界，不拥有 Tool、不执行动作、不做治理决策。**

当前它**不需要成为 Runtime 一级对象**——Skill 已是现有原语的组合（systemPrompt + Tool Visibility + Policy context），Runtime 已能表达。仅当多 Skill 会话出现时再提升。

```text
PHASE 14 INVESTIGATION: COMPLETE
CODE CHANGED: NO
SKILL MANAGER IMPLEMENTED: NO
SKILL REGISTRY IMPLEMENTED: NO
SKILL LOADER IMPLEMENTED: NO
SKILL IMPLEMENTATION: DEFERRED
```

## 2. Skill Definition

`[DECISION]`

```text
Skill = 一个命名的能力激活剖面：在 Session/Run 激活时，把
        (systemPrompt + Tool Set 选择 + 可选 Policy Context/Metadata)
        绑定到一次 Agent 执行。
Skill 不拥有 Tool、不执行动作、不做治理决策、不是 Runtime 子系统。
```

**Skill 不是什么：**
- `Skill ≠ Tool`：Tool = 一个具体业务动作（执行）；Skill = 选定"哪些 Tool 可见 + 用哪套指令"。
- `Skill ≠ Prompt`：Prompt = 指令文本；Skill 在 Prompt 之上还绑定 Tool Set 与 Policy Context。
- `Skill ≠ Policy`：Policy = 单次 Tool Call 的 Allow/Deny/Ask 决策；Skill 最多携带 Policy *上下文/元数据*。
- `Skill ≠ Runtime`：Runtime 拥有 Registry/Policy/Trace 与激活动作；Skill 是 Runtime 的一种配置资源。
- `Skill ≠ Session`：Session = 对话历史/连续性；Skill = Session 所使用的能力。
- `Skill ≠ Run`：Run = 一次执行；Skill 是 Run 激活前的输入。
- `Skill ≠ Evaluation`：Evaluation = 未来判 Business Outcome，正交。

**Skill 最不可替代的职责**：**capability selection + activation scope**（选择并激活哪组能力与指令，绑定到哪个生命周期层级）。没有它，Agent 只能在构造时写死一套 systemPrompt+toolset。

## 3. Responsibility Matrix

`[SOURCE]`（agent.js:26-49, 280-285；runtime.ts:43-49, 75-78）+ `[INF]`

| Concept    | Responsibility                              | Lifecycle            | Owner                          |
| ---------- | ------------------------------------------- | -------------------- | ------------------------------ |
| **Skill**  | 选择并激活 (systemPrompt+ToolSet+PolicyCtx) | Session（推荐）/Run（可行） | Enterprise Runtime（激活）；Pi（激活后 agent.state） |
| Tool       | Business Action                             | Agent 实例/Run        | Runtime（Registry）/ Tool      |
| Policy     | Tool Call Decision                          | Run（per call）       | Runtime                         |
| Session    | Conversation Continuity                     | 跨 Run               | Pi（messages 隐式）/ 未来 Session 层 |
| Run        | Execution                                   | Run                  | Pi / Runtime                   |
| Trace      | Observation                                 | Run                  | Runtime                         |
| Evaluation | Business Outcome                            | Future               | Future                         |

## 4. Skill vs Prompt vs Tool vs Policy

`[DECISION]`

```text
Skill
 ├── systemPrompt (instructions)      → Pi: agent.state.systemPrompt   [SOURCE: agent.js:30]
 ├── Tool Set selection               → Tool Visibility → Pi: agent.state.tools  [SOURCE: agent.js:36-38]
 └── Policy Context / Metadata        → Policy engine（非决策）          [INF]
```

仅此三者真正属于 Skill。禁止膨胀为 Memory/RAG/Workflow/MCP/Agent/"Everything"。

**Skill 是否只是 Prompt？** 否。若 Skill 仅是 Prompt 别名，则不应成为独立概念；但 Skill 额外绑定 Tool Set 选择与 Policy Context，这是 Prompt 文本本身不具备的语义 → 因此 Skill 有不可替代职责（capability selection）。

## 5. Skill → Tool Visibility

`[SOURCE]`（runtime.ts:48,75-78；agent.js:36-38）+ `[INF]`

```text
Skill ──(命名 Tool Set 子集选择)──→ Runtime Tool Visibility ──→ Pi agent.state.tools ──→ LLM
```

- **Skill 不拥有 Tool**：Tool Registry 的所有权仍属 Runtime（registry.ts:11）。Skill 只是对 Registry 的一个**命名视图/选择**。
- 这是 Skill 与现有系统最实质的衔接点，且直接复用 Phase 5 的"Static Tool Set"结论（Skill → Static Tool Set → LLM）。
- `[EXP]` Phase 14 ExpB/C：`(rt.agent.state as any).tools = [orderLookup]` 后同实例下一 Run 即调用 `order_lookup` → Tool Set 切换生效。

## 6. Skill Lifecycle

`[DECISION]` + `[INF]`

选择 **Model B（Session-level）**：
```text
User
 ↓
Session (绑定一个 Skill)
 ├── Run 1 → Skill A
 ├── Run 2 → Skill A
 └── Run 3 → Skill A
```

**理由**：
- `systemPrompt`/`tools` 是 Pi 的**Agent 实例级配置**（Phase 12：跨 Run 保留，`reset()` 不清）→ 改变 Skill 即改变 Agent 身份/指令。
- Session = 连贯逻辑上下文（Phase 7）；中途换 Skill（改 systemPrompt）会破坏连贯性 → 故 Skill 应稳定于一个 Session。
- 技术上 Pi 支持 **Run-level** 切换（ExpB/C：同实例 Run1 SkillA → Run2 SkillB 可行），但架构上应把"Run 级切换"视为一次 **Session 边界事件**。
- **Turn-level**（Model D）过度细化：那是 Tool Visibility 的范畴（Phase 5/10：`prepareNextTurn` 可 per-turn 改 Tool Set），不是 Skill。

## 7. Skill Switching

`[INF]` + `[EXP]`

- **Skill A → Skill B 是否允许？** 允许（[EXP] ExpB/C 同实例成功）。
- 是否跨 Session？推荐 = **是（切换即新 Session 边界）**；技术上可同实例跨 Run，但语义不连贯。
- 是否跨 Run？可行（[EXP]），但视作 Session 边界事件。
- 是否影响 Transcript？`agent.state.messages` 不随 Tool Set 切换清除（Phase 11/12）→ 历史保留，但混用不同 Skill 的上下文不连贯。
- 是否影响 Tool Set？是（[EXP] 切换到 order_lookup）。
- 是否影响 Policy？Skill 可携带不同 Policy Context（元数据级），决策仍归 Policy 引擎。
- 是否需要新 Agent？严格清晰做法 = **新 Agent / 新 Runtime**（systemPrompt 属实例配置）；快速做法 = 直接 mutate `agent.state.tools`+`systemPrompt`（[EXP] 已验证可行）。

## 8. Skill 与 Policy

`[INF]`

```text
Refund Skill (携带 Policy Context: refund<$100 auto-allow)
   ↓
refund_order Tool Call
   ↓
Policy Engine → ALLOW / ASK / DENY   ← 决策仍归 Policy，不归 Skill
```

- **Skill 可以提供 Policy Context / Policy Metadata**（如阈值、业务规则提示），但**不得成为 Policy Engine**（不私自做 Allow/Deny 决策）。
- 采用原则：**Skill 携带 Policy Context，Policy 做决策**。边界据此划定。

## 9. Skill 与 Tool Discovery

`[INF]`

| 模型 | 判断 |
| --- | --- |
| Skill → Static Tool Set → LLM (Model A) | ✅ 推荐首选（Phase 5 已定：当前无需 Discovery） |
| Skill → Tool Discovery → Relevant Tools (Model B) | 未来可选；Discovery 归属 Runtime，不在 Skill 内 |
| LLM → Skill Discovery → Skill (Model C) | 过度工程，当前禁止 |

- Skill 本身 **不需要 Discovery**（Skill 由 Runtime 在 Session 激活时显式选定）。
- 一个 Skill 的 Tool Set 可固定（静态选择）；未来若要动态，则由 Runtime 的 Tool Discovery 负责，Skill 只命名一个过滤条件。
- **Tool Discovery 属于 Runtime，不属于 Skill。**

## 10. Skill 与 Runtime Ownership

`[DECISION]`

| 问题 | 答案 |
| --- | --- |
| Who owns Skill? | **Enterprise Runtime**（配置资源；Registry/Policy 也属 Runtime） |
| Who loads Skill? | Runtime（解析命名剖面 → systemPrompt + Tool Set 子集 + PolicyCtx） |
| Who activates Skill? | Runtime（Session/Run 开始，写入 `agent.state`） |
| Who controls Skill lifecycle? | Runtime（Session 范围） |
| Who records Skill in Trace? | Runtime（未来最小增强：在 Run Context/Trace 增加 `skill` 字段；**不现在实现**） |

激活后，Pi 拥有 `agent.state.systemPrompt`/`tools` 实例（与现有一致）。

## 11. Future Implications

`[INF]`

- **Tool Discovery**：Skill = 静态 Tool Set 过滤器（复用 Phase 5 结论）。
- **Workspace**：未来 Skill 可绑定一个 Workspace（文件系统/数据源），但 Workspace 是独立 Runtime 资源，不是 Skill 的子集。
- **Persistence / Checkpoint**：Skill 应作为 Agent 配置快照的一部分（`createContextSnapshot` 已快照 systemPrompt/messages/tools，agent.js:280-285）——持久化时 Skill 可由该快照派生，无需单独存储。
- **Multi-Agent**：每个 Agent 实例对应一个 Skill 剖面（1 Agent = 1 Skill 配置）→ 多 Agent = 多 Skill 配置。
- **Evaluation**：Skill 可声明期望的 Output Contract / Evaluation Criteria（元数据），但 Evaluation 是独立未来系统，不归入 Skill 执行链。

## 12. Final Decision

```text
PHASE 14 INVESTIGATION: COMPLETE

SKILL DEFINITION: Named Capability Activation Profile =
                 (systemPrompt + Tool Set 选择 + 可选 Policy Context) 绑定到 Session/Run 执行

SKILL OWNER: Enterprise Runtime（激活/加载/生命周期）；Pi（激活后持有 agent.state）

SKILL LIFECYCLE: Session-level（推荐）；Run-level 技术可行但视为 Session 边界事件

SKILL → TOOL VISIBILITY: Skill 命名 Tool Set 子集 → Runtime Tool Visibility → Pi tool set
                            （Skill 不拥有 Tool；Registry 归属不变）

SKILL ↔ POLICY BOUNDARY: Skill 携带 Policy Context/Metadata；决策仍归 Policy Engine

SKILL ↔ SESSION BOUNDARY: Skill 是 Session 使用的 capability；切换 = 新 Session 边界

SKILL ↔ RUN BOUNDARY: Skill 是 Run 的激活前输入（记入 Run Context/Trace metadata），
                      非 Run 活边界（runId/signal）

SKILL IMPLEMENTATION: DEFERRED
   （当前无足够理由成为 Runtime 一级对象；已是 systemPrompt+Tool Visibility+PolicyCtx 的组合，
    Runtime 已能表达。仅当多 Skill 会话出现时再提升为一级资源。）

CODE CHANGED: NO
```

## 13. Evidence / Source Table

| 结论 | 位置 | 标记 |
| --- | --- | --- |
| `agent.state.systemPrompt` 为普通可变属性（Pi 每 Run 读取） | agent.js:30 | `[SOURCE]` |
| `agent.state.tools` 有 slice-setter（每 Run 读取，可被 Runtime 重设） | agent.js:36-38 | `[SOURCE]` |
| `registerTool` 重设 `agent.state.tools` = Skill→ToolSet 切换的同机制 | runtime.ts:75-78 | `[SOURCE]` |
| `createContextSnapshot` 快照 systemPrompt/messages/tools（Checkpoint 基础） | agent.js:280-285 | `[SOURCE]` |
| 构造时一次性设定 systemPrompt+tools（实例级配置） | runtime.ts:43-49 | `[SOURCE]` |
| ExpA: 同 Skill 跨两 Run → Tool Set 一致 | scripts/_investigate-14.ts | `[EXP]` |
| ExpB/C: 同实例 SkillA→SkillB `(agent.state.tools=...; systemPrompt=...)` → 下一 Run 调 order_lookup（切换生效） | 同上 | `[EXP]` |
| messages 跨 Run 累积、不随 Tool Set 切换清除 | Phase 11/12 | `[EXP]` |
| Skill = capability selection + activation scope（最小不可替代职责） | §2,§4 | `[DECISION]`/`[INF]` |
| Skill 当前不需成为 Runtime 一级对象 | §12 | `[DECISION]` |

---

```text
PHASE 14 INVESTIGATION: COMPLETE
CODE CHANGED: NO

NEXT STEP (must NOT auto-start):
停止。不进入 Phase 15，不顺手实现 SkillManager / SkillRegistry / SkillLoader /
Skill Discovery / Tool Discovery / Multi-Agent / Workspace / Policy Framework。
若未来多 Skill 会话出现，再将 Skill 提升为 Runtime 一级资源（命名剖面 = systemPrompt
+ Tool Set 选择 + Policy Context），并经 Runtime 在 Session 激活时写入 agent.state；
同时最小增强 Trace（Run Context 增加 skill 字段）。不现在实现。
```
