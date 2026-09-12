# Phase 5 — Tool Discovery / Tool Routing Investigation

## 1. Executive Summary

- 当前 Enterprise Runtime 仅注册 **2 个 Tool**（`get_customer` + 实验用 `get_weather`），**不存在任何 Tool Discovery 问题**。
- Pi Agent Core 的 Tool Set 生命周期：**每次 run 开始时快照一次**（`createContextSnapshot`），且**每轮边界可通过 `prepareNextTurnWithContext` 重新提供 context（含 tools）**。
- 实验证明 Pi **原生支持动态 Tool Set**：run-level（修改 `state.tools`）与 per-turn（`prepareNextTurnWithContext`）均生效，**零 Pi 修改**。
- Tool schema 随数量线性增长：实测 100 tools ≈ 35.6KB request payload（≈ 356 bytes/tool ≈ ~89 tokens/tool）。按此推算 1000 tools ≈ 89k tokens，**超过当前 qwen2.5:14b 的 32768 context**，因此规模问题是真实存在的，但有明确阈值。
- **结论**：当前 2-tool 规模**不应**实现 Tool Discovery。推荐采用 **Static Tool Set（按 Skill / Session 固定子集）** 作为默认策略；动态 Tool Set（Strategy C）机制已验证可行，但留到 ~100+ tools 时再进入 Phase 6。
- **Discovery ≠ Policy**：Discovery 决定"哪些 Tool 对 LLM 可见"，Policy（Phase 4-C `beforeToolCall`）决定"Agent 想调用的 Tool 是否允许执行"——两者边界不同，互不替代。

## 2. Current Runtime Architecture

```text
EnterpriseAiRuntime
├── ToolRegistry        (src/tools/registry.ts：name→AgentTool Map，Enterprise 拥有)
├── Policy             (src/policy/*：beforeToolCall 控制执行，Phase 4-C)
├── TraceCollector      (src/trace/*：只读观测)
└── pi-agent-core Agent
      └── state.tools  (AgentTool[]，注入点)
```

- `ToolRegistry` 是 Enterprise 自己的目录，不执行 Tool（`registry.ts:7-9`）。
- Runtime 在构造 `Agent` 时把工具注入 `initialState.tools`（`runtime.ts`）。
- Policy 经 `beforeToolCall` 介入执行（Phase 4-C），与 Tool 可见性无关。

## 3. Current Tool Injection Path

`[SOURCE]`
1. `ToolRegistry` 持有 `Map<string, AgentTool>`；`toAgentTools()` 返回 `list()`（`registry.ts:28-40`）。
2. `EnterpriseAiRuntime` 构造时 `new ToolRegistry(opts.tools)`，并 `new Agent({ initialState: { tools: this.registry.toAgentTools() } })`（`runtime.ts`）。
3. `registerTool(tool)` 后通过 `this.agent.state.tools = this.registry.toAgentTools()` 把新工具同步进 Pi（`runtime.ts`）。
4. Pi 在 run 开始时 `createContextSnapshot()` 读取 `this._state.tools`（`agent.js:280-286`）。

**Q1** 当前 Tool 在 `ToolRegistry` 注册（Runtime 构造 / `registerTool`）。
**Q2** `ToolRegistry.toAgentTools()` 导出 `AgentTool[]`（`registry.ts:38-40`）。
**Q3** Runtime 在 `new Agent({ initialState.tools })` 时注入（`runtime.ts`）。
**Q4** Pi 在 `createContextSnapshot()`（每次 run 开始）读取 `state.tools`（`agent.js:284`）。

## 4. Pi Agent Core Tool Lifecycle

`[SOURCE]`
- `createContextSnapshot()`：`tools: this._state.tools.slice()`（`agent.js:284`）—— **run 开始时一次性快照**。
- `runPromptMessages` → `runAgentLoop(messages, this.createContextSnapshot(), ...)`（`agent.js:272`）→ 整个 run 使用这份 context。
- `runLoop` 每轮边界调用 `config.prepareNextTurn?.(lastCompletedTurn)`（`agent-loop.js:90-92`）；Agent 包装器把 `(lastCompletedTurn, signal)` 传给 `prepareNextTurnWithContext`（`agent.js:305-312`）；若返回 `{ context }`，则 `currentContext = nextTurnSnapshot.context`（`agent-loop.js:92`）。
- `streamAssistantResponse` 每次 LLM call 读取 `context.tools`（`agent-loop.js:185-189`）。
- `state.tools` setter：`tools = nextTools.slice()`（`agent.js:36-38`）——可变，但只影响**下一次 run 的快照**。

**Q5** 一次 run 内 Tool Set 默认固定（run 开始快照）；但通过 `prepareNextTurnWithContext` 可在轮间改变。
**Q6** 下一次 LLM Call 可看到不同 Tool Set（经 `prepareNextTurnWithContext`）。
**Q7** Runtime 在 Agent Loop 中修改 `state.tools` → Pi 下一次 run 使用新 set（`[EXP]` Part 2）；或在 `prepareNextTurnWithContext` 中返回新 context → 同 run 下一轮使用新 set（`[EXP]` Part 1）。
**Q8** Tool Set 在 `createContextSnapshot`（run 开始）进入 LLM request（`agent.js:284` → `agent-loop.js:188`）。
**Q9** 不是 Agent 创建时永久固定；每次 LLM call 读 `context.tools`，而 `context` 可被 `prepareNextTurnWithContext` 每轮替换。
**Q10** `state.tools` 生命周期：可变数组，setter 做浅拷贝；run 开始快照；run 内若不替换 context 则不变。
**Q11** 可以在 Turn 之间改变（经 `prepareNextTurnWithContext`）。
**Q12** 最自然控制点：**per-turn → `prepareNextTurnWithContext`**（Pi 原生，零修改）；**per-run/session → 在 `prompt()` 前修改 `state.tools` 或在 `Agent` 构造时设定**。
**Q13** 支持动态 Tool Set（见 `[EXP]`）；无需修改 Pi。

## 5. Real Problem Analysis

### Token / Context  `[EXPERIMENT]`
实测 request payload（含 tools JSON schema）随 tool 数线性增长：

| N tools | request payload | 每 tool 平均 |
|---|---|---|
| 10  | 3,753 bytes  | ~375 B |
| 50  | 17,913 bytes | ~358 B |
| 100 | 35,613 bytes | ~356 B |

推算：1000 tools ≈ 356 KB ≈ **~89k tokens**（英文 JSON ≈ 4B/token），**超过 qwen2.5:14b 的 32768 context**。结论：本模型下约 **300–400 tools** 即会耗尽 context；100 tools（~9k tokens schema）仍可接受但已占 context 显著比例。

### Latency  `[INFERENCE]`
更大的 tools JSON 增加 LLM prefill（首 token 前）计算量，可能抬高延迟；本实验未量化延迟，仅确认 payload 随 N 线性增长。

### Model Selection Accuracy  `[INFERENCE]`
相似/重名 Tool（如 `get_customer` / `search_customer` / `lookup_customer`）增多会提升 LLM 误选概率；此为题面已举例的直观风险，但本阶段未做受控准确率实验，故标为 `[INFERENCE]`，不写为事实。

### Maintainability  `[INFERENCE]`
1000 个 Tool 全量注册进单一 Registry 会使人工审阅/调试困难；按 Skill/领域分桶更合理。

## 6. Tool Exposure Strategies

### All Tools  `[SOURCE]/[EXP]`
- 优点：实现最简（当前默认），无路由逻辑，LLM 总能看到全部能力。
- 缺点：Token/Context 随 N 线性膨胀（见 §5）；准确率先降后崩。
- 适用规模：当前 2-tool；约 ≤ 20–50 tools 仍可接受（取决于 model context）。

### Static Tool Set  `[INFERENCE]`
- 在 Agent/Skill/Session 创建时确定固定子集（如 Customer Skill → 10 tools）。
- 优点：零运行时开销、可预测、与 Skill 天然契合。
- 缺点：跨领域任务需预先切分；不能按单条 user intent 细化。
- **当前最推荐**（见 §11）。

### Dynamic Tool Set  `[EXP]/[INFERENCE]`
- Runtime 在每轮边界（或每 run）选出相关 Tool 子集再交给 Pi。
- 控制点：`prepareNextTurnWithContext`（per-turn）或 `state.tools`（per-run）——均已实验验证可用。
- 谁负责选择：`[INFERENCE]` 未来由 Enterprise Runtime（可能基于 Skill + user intent 的轻量规则，非必须 Semantic Search）。
- 风险：增加一次选择计算；若选择错误，LLM 看不到应看的 Tool。

### Discovery Tool  `[INFERENCE]`
- 仅暴露 `search_tools(query)`，LLM 先发现再调用。
- 优点：LLM context 最小。
- 缺点：额外 LLM/Tool round-trip → 更高延迟；可能多次往返；准确性依赖 `search_tools` 质量。
- 是否优于 Runtime-side routing：`[INFERENCE]` 通常**不如**Runtime 侧在每轮直接给相关子集（Strategy C），因为 Discovery Tool 把路由决策又交回 LLM，反而增加开销与不确定。

## 7. Skill vs Tool Discovery

`[INFERENCE]/[ARCH]`
- **Skill 应作为 Tool Discovery 的第一层过滤器**：Customer Service Skill 自带 Customer Tools 子集，而非把 1000 enterprise tools 全给 LLM。
- 这等价于 **Static Tool Set（按 Skill）**，是当前最干净的 Layer-1 过滤，无需 Semantic Search / Vector DB。
- 当单 Skill 内 Tool 仍过多（如 >100），再在 Skill 内做 Dynamic Tool Set（Strategy C）。
- 因此 Tool Discovery 的职责归属：**Skill（第一层，静态子集）→ Runtime（可选第二层，按 intent 动态精简）**；LLM / Semantic Search / Policy 不负责 Discovery。

## 8. Runtime Control Boundary

```text
User Prompt
   ↓
Enterprise Runtime  ──(Discovery/Routing: 选相关 Tool 子集)──  [未来：prepareNextTurnWithContext / state.tools]
   ↓
Pi Agent Core ──(LLM 决策调用哪个 Tool)──
   ↓
Enterprise Runtime Policy (beforeToolCall) ──(Allow/Deny/Ask)──  [Phase 4-C]
   ↓
Tool.execute()
```

- **Discovery = 可见性**（哪些 Tool 进 LLM context）；控制点在 Runtime 注入 tools 之前。
- **Policy = 执行许可**（Agent 已决定调用，是否放行）；控制点在 `beforeToolCall`。
- 二者正交，必须分开设计。

## 9. Minimal Experiment

`[EXP]` 真实 Ollama + qwen2.5:14b + 真实 pi-agent-core，不修改 Pi。临时脚本 `scripts/_investigate-5.ts`（已删除）。

- **Part 1 — per-turn dynamic tools**：Agent 初始 tools=[get_customer, get_weather]，`prepareNextTurnWithContext` 在首轮后返回 `{ context: { ...turn.context, tools: [get_weather] } }`。
  - LLM#1 tools = `[get_customer, get_weather]`
  - LLM#2 tools = `[get_weather]`
  - ⇒ **per-turn 动态 Tool Set 经 Pi 原生钩子生效**。
- **Part 2 — run-level dynamic tools**：Run1 后 `agent.state.tools = [getWeather]`，Run2 request tools = `[get_weather]`。
  - ⇒ **run-level 动态 Tool Set 经 `state.tools` 生效**。
- **Part 3 — schema 增长**：N=10/50/100 → payload 3.7KB / 17.9KB / 35.6KB（线性）。
- 注：**`prepareNextTurn`（无 WithContext）钩子由 Agent 包装器只传入 `signal` 而非 turn**（`agent.js:305-312`），因此真正可用的每轮钩子是 `prepareNextTurnWithContext`。

## 10. Decision Matrix

| Strategy | Token | Latency | Accuracy | Complexity | Enterprise Fit | 当前是否实现 |
|---|---|---|---|---|---|---|
| All Tools | 高（随 N 线性↑） | 低 | 低（N 大时↓） | 最低 | 小/中规模 OK | **YES**（当前默认） |
| Static Tool Set | 低（固定子集） | 低 | 高（子集聚焦） | 低 | 高（贴合 Skill） | **NO**（无 Skill 运行时，未来做） |
| Dynamic Tool Set | 低（每轮精简） | 中（多一次选择） | 高（聚焦） | 中 | 高（大目录） | **NO**（Pi 已支持，未实现） |
| Discovery Tool | 最低 | 高（额外 round-trip） | 中（依赖 search 质量） | 高 | 中（通常劣于 C） | **NO** |

"当前是否实现"列：仅 **All Tools = YES**（即当前把所有注册 Tool 直接注入）；其余均为 **NO**。

## 11. Architecture Decision

> **当前阶段（2 tools）：不实现 Tool Discovery。** 采用 **Static Tool Set** 思维——Runtime 按 Skill / Session 注入固定相关子集（未来引入 Skill 运行时时落地）。
>
> **何时升级**：当单 Runtime / 单 Skill 的 Tool 数量达到 **~100+**（或 context 被 schema 占去 >30%）时，进入 Phase 6 实现 **Dynamic Tool Set（Strategy C）**，控制点用 Pi 原生 `prepareNextTurnWithContext`（每轮）或 `state.tools`（每 run），**不引入 Semantic Search / Vector DB / MCP**（除非未来准确率证据要求）。
>
> **边界**：Discovery 归 Runtime（可见性），Policy 归 `beforeToolCall`（执行许可），Skill 归第一层静态过滤。

## 12. Future Work

- Skill Runtime：把 Tool 按 Skill 分桶，作为 Layer-1 静态过滤（实现 Static Tool Set）。
- Phase 6（条件触发）：Dynamic Tool Set via `prepareNextTurnWithContext`（基于 Skill + 轻量 intent 规则选子集；**非必须** Embedding/Vector）。
- 若准确率实验证明相似 Tool 误选率高，再评估 Discovery Tool（Strategy D）或 Semantic Search——目前无证据，标 FUTURE。
- 不引入：MCP、LangChain/LangGraph、OpenTelemetry、生产级 Tool Router/Ranking/Permission。

## 13. Evidence / Source Table

| 结论 | 文件:行 | 标记 |
|---|---|---|
| Runtime 经 `initialState.tools` 注入 Tool | `runtime.ts`（`new Agent({ initialState:{tools} })`） | `[SOURCE]` |
| `ToolRegistry.toAgentTools()` 导出 `AgentTool[]` | `registry.ts:38-40` | `[SOURCE]` |
| `state.tools` setter 浅拷贝可变 | `agent.js:36-38` | `[SOURCE]` |
| `createContextSnapshot` 每次 run 读 `state.tools` | `agent.js:280-286` | `[SOURCE]` |
| `prepareNextTurnWithContext` 每轮替换 context（含 tools） | `agent.js:305-312`；`agent-loop.js:90-92` | `[SOURCE]` |
| `streamAssistantResponse` 每 LLM call 读 `context.tools` | `agent-loop.js:185-189` | `[SOURCE]` |
| per-turn 动态 tools 生效 | 实验 Part 1（LLM#2=[get_weather]） | `[EXP]` |
| run-level 动态 tools 生效 | 实验 Part 2（Run2=[get_weather]） | `[EXP]` |
| schema 随 N 线性增长 | 实验 Part 3（10/50/100 → 3.7/17.9/35.6KB） | `[EXP]` |
| 1000 tools 超 32k context（推算） | 35.6KB×10 ≈ 356KB ≈ 89k tokens | `[INFERENCE]` |
| `prepareNextTurn`（无 WithContext）仅收 signal | `agent.js:305-312` | `[SOURCE]` |
| Skill 作为 Layer-1 过滤 | 架构分析 | `[INFERENCE]` |

---

### 必须回答的 10 个问题（结论）

1. **当前 Runtime 是否已有 Tool Discovery 问题？** 否（仅 2 tools）。`[SOURCE]`
2. **多少数量级开始值得关注？** 约 **100+ tools**（本模型 schema ~9k tokens；~300–400 即耗尽 32k context）。`[EXP]/[INFERENCE]`
3. **主要问题是什么？** Token/Context（已实验证实线性增长）；Latency、Model accuracy、Maintainability（推断）；Security 由 Policy 覆盖，独立于 Discovery。
4. **Pi Tool Set 生命周期？** run 开始快照一次（`createContextSnapshot`）+ 每轮可经 `prepareNextTurnWithContext` 替换。`[SOURCE]`
5. **Pi 是否支持动态 Tool Set？** 是（run-level `state.tools` + per-turn `prepareNextTurnWithContext`）。`[EXP]`
6. **最合理控制边界？** per-turn：`prepareNextTurnWithContext`；per-run/session：`state.tools` 或构造时设定。`[SOURCE]/[EXP]`
7. **Enterprise Runtime 是否应拥有 Tool Discovery？** 当前规模不必；~100+ tools 时由 Runtime 负责选子集（可见性），与 Policy 分离。`[INFERENCE]`
8. **Skill 是否应作为第一层过滤？** 是——Skill 天然限定 Tool 子集（Static Tool Set）。`[INFERENCE]`
9. **当前最合理策略？** **Static Tool Set（按 Skill/Session）**；当前 2-tool 下 All Tools 亦可。`[DECISION]`
10. **Phase 6 是否值得实现 Tool Discovery？** **暂否**——当前规模不 justify；留作 FUTURE，阈值 ~100+ tools。`[DECISION]`

```text
PHASE 5 INVESTIGATION: COMPLETE

CODE CHANGED: NO

IMPLEMENTATION:
Tool Discovery: NOT IMPLEMENTED
Tool Routing: NOT IMPLEMENTED
Semantic Search: NOT IMPLEMENTED
MCP: NOT IMPLEMENTED
```
