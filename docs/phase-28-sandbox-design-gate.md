# Phase 28 — Sandbox Execution Design Gate

> 阶段目标：Design Gate Only。本次**不实现** Sandbox，只通过代码审计 + 最小失败/能力实验，
> 回答「Enterprise Runtime 应该在哪里建立 Sandbox Execution Boundary」。
> 禁止：SandboxManager / ExecutionManager / SecurityManager / ResourceManager、K8s、容器编排、
> Firecracker / gVisor / Kata、多租户、SaaS、权限系统、修改现有 Runtime 架构、大规模重构。

---

## 1. Goal

明确当 Agent 需要执行 Shell / Python / 文件操作等**不可信或受限计算**时，Execution Boundary 应落在哪里，
并回答 Sandbox 到底是保护谁、当前 Runtime 是否已具备该边界、Docker 是否等价于 Sandbox、
Policy / Tool / Sandbox 三者责任如何划分、最小 Sandbox 是什么。

---

## 2. Current Execution Architecture

当前调用链（来自 `src/runtime.ts`、`src/server.ts`）：

```text
Business Client / Consumer
      ↓ run(prompt)  or  HTTP POST /v1/runs
EnterpriseAiRuntime
      ↓ Pi Agent.prompt()
Pi Agent Loop (pi-agent-core)
      ├─ LLM → Tool Call (pi-agent-core)
      ├─ beforeToolCall  → EnterpriseAiRuntime Policy（允许? 拒绝?）
      ├─ tool.execute()  ← 实际执行（同进程，Node event loop）
      └─ Tool Result → LLM → ... → stopReason
      ↓
RunResult（status / answer / trace）
```

关键事实：

- Tool 由 **Pi Agent Loop** 调用 `AgentTool.execute`（`src/tools/registry.ts:38` `toAgentTools()` 交给 Pi）。
- `tool.execute` 是普通 async JS 函数，运行在 **EnterpriseAiRuntime 同进程**内（`src/tools/get-customer.ts:31`）。
- 当前唯一示例 Tool `getCustomer` 是**确定性 in-memory 查询**，无外部副作用、无子进程、无文件 IO
  （`src/tools/get-customer.ts:12` `CUSTOMERS` 常量表）。

---

## 3. Code Audit Evidence

| # | 问题 | 证据 | 结论 |
| --- | --- | --- | --- |
| 1 | Runtime 当前如何执行 Tool？ | `runtime.ts:123` `tools: this.registry.toAgentTools()` → Pi 调用 `execute` | Pi Agent Loop 负责执行 |
| 2 | Tool 执行发生在哪里？ | `get-customer.ts:31` 普通 async；无 child_process / worker | **Runtime 同进程 / 同事件循环** |
| 3 | Policy 在 Tool 执行前还是后？ | `runtime.ts:147` `beforeToolCall` → `evaluatePolicy`；`adapter.ts:30-44` DENY 返回 `{block:true}`，`execute` 永不调用 | **执行前**（决策闸门） |
| 4 | Runtime 能否决定 Tool 是否执行？ | `policy/types.ts:26` `Policy = (call) => PolicyDecision`；`runtime.ts:151` 接入 | **能**（allow/deny/ask） |
| 5 | Tool 是否能执行任意 Node/Python/Shell？ | 当前 `src/tools/` 仅有 `getCustomer`（in-memory）；`execute` 是 JS，作者若 spawn 子进程则无任何拦截 | **无 sandbox 拦截**——若存在 shell Tool，将以容器全部权限运行 |
| 6 | Docker 是 Deployment 还是 Sandbox？ | `Dockerfile` 单容器跑 HTTP Service，`USER node`，无 seccomp/ulimit/网络策略 | **仅 Deployment Boundary** |
| 7 | Runtime 能否限制 CPU/内存/网络/FS/进程寿命/cwd？ | 全代码无 cgroup/ulimit/timeout/network namespace/chroot 设置 | **均不能** |
| 8 | Tool 执行 vs 外部副作用 | `getCustomer` 无副作用；Policy 只决定 `execute` 是否调用，不约束 `execute` 内部行为 | Policy 不约束副作用**内容** |
| 9 | Trace 能否看到 Sandbox 执行？ | `trace/types.ts:4` 仅 `TraceEvent`（agent 事件）/ `LlmCallTrace`；无 subprocess/exit/资源字段 | **看不到**（因尚无 Sandbox 概念） |
| 10 | Recovery 能否区分 Tool/Sandbox/External 失败？ | `recovery/recovery.ts` `decideRecovery(result, tool?.replay)`；`RunResult.error.code` 仅 `llm_error|aborted|unknown`（`runtime.ts:70-73`）；Tool 失败 → Pi 构造 error ToolResult → 循环继续 → status 仍 `completed` | **不能区分**（无失败分类） |

---

## 4. What Sandbox Protects

```text
Agent / LLM
    ↓ Tool Call（可能由 prompt 诱导产生恶意指令）
Tool
    ↓ 执行（系统命令 / 脚本 / 文件操作）
Sandbox
    ↓ 受限环境
Host / Runtime（同一 Node 进程 + 容器）
    ↓
External World（文件系统 / 网络 / 内部服务 / 凭据）
```

逐层风险：

- **Agent / LLM**：被 prompt 诱导产生 `执行 python xxx` / `运行 shell xxx` 的 Tool Call。LLM 本身无执行权，风险体现在「生成危险指令」。
- **Tool**：若 `execute` 直接 spawn 子进程或做文件 IO，它拥有**容器内的全部权限**（读 `/app`、`LLM_API_KEY` 等 env、访问 `host.docker.internal`、进程表）。
- **Sandbox（缺失时）**：无隔离 → 失控的计算直接作用在 Runtime 进程与容器上。
- **Host / Runtime**：fork bomb 拖垮容器；大内存触发 OOM；删除/读取宿主机挂载文件；`localhost` 探活内部服务。
- **External World**：经 `host.docker.internal` 访问宿主机 Ollama；扫描内网；用容器内凭据调用外部 API；修改外部系统状态。

具体威胁（本 Runtime 视角的 Execution Boundary，非泛泛 AI Security）：

- 无限循环 / fork bomb → 占用 CPU、进程表
- 大量内存分配 → OOM kill 整个 Runtime 进程
- 删除 / 读取宿主机或容器文件（含 `.env`、密钥）
- 访问 `localhost` / 内部网络 / 读取环境变量 / 偷取 credential
- 网络扫描 / 调用外部系统产生副作用

---

## 5. Docker Deployment vs Sandbox Boundary

**结论：Docker Deployment ≠ Sandbox。答案：NO。**

```text
Business Client
    ↓ HTTP
Dockerized Runtime   ← Deployment Boundary（隔离 Runtime 与 Host）
    ↓
EnterpriseAiRuntime
    ↓
Agent
    ↓
Tool
    ↓
???                ← 这里才是 Sandbox Boundary 应存在的位置
```

区分：

- **Deployment Container**：隔离「Runtime Service 进程」与宿主机（`Dockerfile` `USER node`、网络隔离、只读根 FS 可选）。它保护的是 *Host 不被 Runtime Service 影响*。
- **Sandbox**：隔离「Agent 产生的计算行为」与 *Runtime 进程 / 容器内部资源*。它保护的是 *Runtime 不被 Tool 越界影响*。

当前 Docker 只做到前者。一个容器内 `get_customer` 之外的 shell Tool 仍拥有该容器内一切权限；Docker 不会为每次 Tool Call 单独限权。因此 `???` 处**缺少 Sandbox Boundary**。

---

## 6. Policy vs Tool vs Sandbox

三句话边界（本 Phase 最重要）：

- **Policy**：「**允许不允许**执行？」——`beforeToolCall` 的决策闸门（`allow/deny/ask`）。
- **Sandbox**：「允许执行的话，**在哪个受限环境**执行？」——执行时的资源/边界约束。
- **Tool**：「**具体执行什么业务动作**？」——`execute` 内的业务语义。

三者位置（基于代码）：

```text
Agent
  ↓ Tool Call
Policy Decision（runtime.ts beforeToolCall → evaluatePolicy）   ← 允许?
  ↓ allow
Execution Boundary（MISSING）                                   ← 受限环境?
  ↓
Tool.execute（业务动作）                                         ← 做什么?
  ↓ Result
Tool Result → Agent
```

当前事实：Policy 存在且有效；Tool 存在；**Execution Boundary 不存在**——`execute` 直接在同进程运行。

---

## 7. Execution Boundary Model

候选最小模型（**暂未假设其正确，待实验验证**）：

```text
Agent
  ↓ Tool Call
Policy Decision        (Runtime + Pi)
  ↓ allow
Execution Boundary     (Sandbox：独立进程/受限容器，带 timeout/kill/limits)
  ↓
Tool Business Action   (execute 内的具体命令/脚本/文件操作)
  ↓ Result (exit code / stdout / stderr)
Tool Result            (回给 Agent)
  ↓
Agent
```

验证结论（对照代码）：

- Policy 在 Tool 前 —— 已验证（`beforeToolCall` 先于 `execute`）。
- Sandbox 应在 Policy 之后、Tool.execute 之内/之前 —— **当前缺失**，工具直接在 Runtime 进程内执行。
- Runtime 应控制「哪些 Tool 需要进 Sandbox」与边界参数（timeout / fs / net）。
- Sandbox 应控制「执行环境」（进程隔离、资源上限、网络、cwd、env 过滤、kill/cleanup）。

---

## 8. Minimum Sandbox Capability

MVP 最小集合（不列几十项）：

| 能力 | 分类 | 理由 |
| --- | --- | --- |
| 进程隔离（与 Runtime 进程分离） | MUST | 失控计算不能拖垮 Runtime 主进程 |
| 超时 + 可 kill | MUST | 防无限循环 / fork bomb；当前**完全没有** |
| 退出码捕获 | MUST | 区分正常/失败（含 sandbox kill） |
| stdout/stderr 捕获 | MUST | Tool Result 与可观测性所需 |
| 工作目录隔离（cwd） | MUST | 限制文件落点 |
| 内存上限 | SHOULD | 防 OOM 扩散；Node 层实现成本高（需容器/cgroup） |
| 网络策略（默认 deny） | SHOULD | 防内网扫描 / 窃凭据 |
| 文件系统边界（只读/白名单） | SHOULD | 防读密钥 / 删文件 |
| 环境变量隔离（过滤凭据） | SHOULD | 防 `LLM_API_KEY` 泄漏给子进程 |
| CPU 上限（cgroup） | DEFER | 需容器/系统能力，非 MVP |
| seccomp / gVisor / Firecracker | DEFER | 超出最小实验范围 |
| 容器池 / 预热 | DEFER | 过度工程，本阶段禁止 |

---

## 9. Minimal Experiment

**Experiment A** — 用一个受控 shell Tool（**仅作实验设想，本 Gate 不实现**）验证当前能力：

1. 正常命令（echo）→ 当前：Tool 同进程返回结果。✅ 可工作。
2. 非零退出（exit 3）→ 当前：Pi 构造 error ToolResult，Agent 继续，status=`completed`。⚠ 可见但无 "sandbox failure" 分类。
3. 超时（sleep 3600）→ **CURRENT GAP**：Runtime 无 timeout，Run 永不结束，需手动 kill 进程。
4. 大输出（cat 1GB）→ **CURRENT GAP**：无流控/截断，可能撑爆内存。
5. 写文件（> /tmp/x）→ 当前：可写容器任意可写路径。**CURRENT GAP**：无 fs 边界。
6. 读允许目录（/tmp）→ 当前：可读。**CURRENT GAP**：无白名单机制。
7. 读禁止目录（读 `.env` / `/app/dist`）→ 当前：可读。**CURRENT GAP**：无 fs 边界。
8. 访问网络（curl host.docker.internal:11434）→ 当前：容器内可访问。**CURRENT GAP**：无网络策略。

结论：**当前 Runtime 没有任何 Execution Boundary**。上述 3–8 项均无法限制。

---

## 10. Failure Experiment

设想 Tool `execute` 内执行 `while(true){}` / `sleep infinity` / 大数组分配：

- Runtime 是否还能继续？**否** —— 同步死循环阻塞 event loop；异步不返回则 Run 挂起。
- Run 是否能结束？**否** —— 无 timeout，无自动终止。
- Tool Result 是什么？**永不产生**（挂起）或进程 OOM 崩溃。
- Process 是否仍存活？死循环存活但不可用；内存溢出被 OS OOM kill。
- 是否能 kill？**Runtime 内不能**——`abort()`（`runtime.ts:313`）只调 `agent.abort()`，无法中断已在执行的同步循环或无限 await；只能 OS / `docker kill`。
- 是否污染 Runtime Process？**是** —— 同进程，主 Runtime 被拖垮。
- Trace 是否记录？仅 `tool_execution_start`/`tool_execution_end`（`trace/types.ts`），**无**子进程退出码 / 资源 / kill 记录。
- 外部资源是否受影响？若 Tool 含副作用（调外部 API），会持续产生。

> **核心结论**：Sandbox 中程序失控时，当前**没有任何层负责 kill**——属于 MISSING BOUNDARY。
> 候选负责方应为「Sandbox 执行环境自身」（自带 timeout/kill），而非 Tool / Pi / Runtime 被动等待。

---

## 11. Ownership Matrix

| Responsibility | Owner |
| --- | --- |
| Tool Call decision（允许/拒绝） | Pi Agent Loop + Runtime Policy（`beforeToolCall`） |
| Sandbox creation | **MISSING BOUNDARY**（当前无；候选：Runtime 为有需要的 Tool 预置执行环境） |
| Command / script execution | Tool（业务动作），在 Sandbox 内运行 |
| Timeout | **MISSING BOUNDARY**（当前无；候选：Sandbox 执行环境） |
| Kill（失控程序） | **MISSING BOUNDARY**（当前仅 OS OOM / `docker kill`；候选：Sandbox） |
| Cleanup（进程/临时文件） | **MISSING BOUNDARY**（候选：Sandbox） |
| Resource limits（CPU/内存/网络/FS） | **MISSING BOUNDARY**（候选：Sandbox + 容器/系统能力） |
| Result collection（exit/stdout/stderr） | 当前：Tool.execute 直接返回；候选：Sandbox 捕获后交给 Tool |
| External side effect | External Resource（DB/API），由 Policy 闸门约束 |

> 不为填表而发明组件：当前缺失项统一标记为 MISSING BOUNDARY，而非直接创建 Manager 类。

---

## 12. Current Gaps

- **P0**：Tool 执行无隔离、无 timeout/kill —— 失控或恶意 Tool 可拖垮/危害 Runtime 进程与容器。
- **P0**：Docker 仅 Deployment Boundary，不可视为 Sandbox。
- **P1**：Recovery / RunResult 无失败分类（tool vs sandbox vs external）；`error.code` 仅有 `llm_error|aborted|unknown`。
- **P1**：无资源约束（CPU/内存/网络/FS/cwd/env 过滤）。
- **P1**：Trace 无法观测 Sandbox 执行（无子进程 / 退出码 / 资源 / kill 字段）。
- **P2**：无退出码捕获与 stdout/stderr 边界（当前依赖 Tool 自行返回）。

---

## 13. Candidate Architecture

Sandbox 是什么？（候选，不预设，待实现阶段验证）

- **A. Runtime 内部的执行能力**：将「受限执行」作为 Tool 执行的一种包装（最贴合现有 `beforeToolCall → execute` 结构，改动最小）。
- B. 独立进程：Tool 动作在 child_process / worker 中运行（A 的常见实现形态）。
- C. 一个 Docker container：为每次/每类 Tool 起临时容器（隔离最强，但超出 MVP）。
- D. 外部 Sandbox Service：独立微服务（过度工程，禁止）。
- E. Tool 自己负责：不可取——把安全边界推给每个 Tool 作者，无统一保证。

**推荐（候选）**：A + B —— Sandbox 作为 Runtime 控制的 **Tool 执行包装**（child_process 带 timeout/kill + 退出码 + stdout/stderr + cwd + 过滤 env；网络默认 deny、FS 只读/白名单在 MVP 之后）。**不引入 SandboxManager 类**，作为 Runtime 的一个聚焦能力。

---

## 14. Decision

1. **当前 Runtime 是否已存在 Sandbox Boundary？** 否（DOES NOT EXIST）。Tool 在 Runtime 同进程无隔离执行。
2. **Docker Deployment 是否可直接视为 Sandbox？** 否。它只隔离 Runtime Service 与 Host。
3. **Sandbox 的真正 Owner 是谁？** 当前 MISSING；正确归属为 Runtime 控制的 Execution Boundary（在 Policy 允许之后、Tool.execute 之内预置受限执行环境）。
4. **Policy 和 Sandbox 边界？** Policy = 允许?（闸门）；Sandbox = 怎么受限执行?（环境）。两者正交。
5. **Tool 和 Sandbox 边界？** Tool = 业务动作（what）；Sandbox = 执行环境（where/how constrained）。Runtime 决定哪些 Tool 需进 Sandbox。
6. **Runtime 对 Sandbox 应拥有什么控制权？** 选择启用、设定 timeout / cwd / env 过滤 / 网络与 FS 策略、接收结构化结果、负责 kill/cleanup。
7. **最小 Sandbox 是什么？** 进程隔离 + timeout/kill + 退出码 + stdout/stderr 捕获 + cwd 隔离（MUST）。内存/网络/FS/env 为 SHOULD/DEFER。
8. **下一阶段应实现什么？** 一个最小 Sandbox 执行包装（child_process + timeout/kill + 退出码/stdout/stderr + cwd + 过滤 env），作为可选 Tool 执行模式，由 Experiment A + Failure Experiment 验证。
9. **现在明确不做？** gVisor/Firecracker/Kata、容器池、K8s、多租户、SaaS、权限系统、Auth、SDK framework、任何 *Manager 类。

---

## 15. Explicit Non-Goals

- 不实现 SandboxManager / ExecutionManager / SecurityManager / ResourceManager。
- 不引入 Kubernetes / 容器编排 / Firecracker / gVisor / Kata。
- 不实现多租户 / SaaS / Billing / RBAC / OAuth / JWT。
- 不修改现有 Runtime 架构（本 Gate 仅文档）。
- 不实现完整网络/FS 策略（属 SHOULD/DEFER）。

---

## 16. STOP Conditions

满足即 STOP（进入实现前确认）：

1. ✅ 已通过代码审计确认当前无 Sandbox Boundary（证据见 §3）。
2. ✅ 已明确 Docker ≠ Sandbox（§5）。
3. ✅ 已界定 Policy / Tool / Sandbox 三者责任（§6、§11）。
4. ✅ 已给出最小 Sandbox 能力集与 MUST/SHOULD/DEFER（§8）。
5. ✅ 已设计 Minimal / Failure Experiment 并标出 CURRENT GAP（§9、§10）。
6. ✅ 未创建任何 Manager 类、未实现 Sandbox、未改源码。

**STOP：本 Gate 不进入实现。下一动作只能是「一个最小 Sandbox 执行包装」的实现实验（Phase 28 实现阶段）。**
