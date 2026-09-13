# Phase 28-A — Minimal Execution Boundary

> 目标：在 EnterpriseAiRuntime 中增加最小 Execution Boundary 实验能力，证明 Tool 的危险计算
> 不再直接运行在 Runtime 主进程，而是经由「Policy → Execution Boundary → Child Process」执行。
> 这不是完整 Sandbox 系统。禁止：*Manager 类 / 容器编排 / gVisor / Firecracker / cgroup / seccomp /
> 多租户 / Auth / Billing / SaaS / MCP Runtime / Workspace Manager。

---

## Goal

建立一条**执行边界**：把不可信/受限计算（Shell / Python / 文件操作）从 Runtime 主 Node 进程移到
独立子进程，并具备最小可控能力（独立进程、timeout+kill、stdout/stderr、退出码、cwd 隔离、清理）。
不改写 Tool 语义，不暴露 child_process 给 Business Client。

---

## Current Problem

Phase 28 Design Gate 代码证据（`docs/phase-28-sandbox-design-gate.md` §3）：

- Tool 由 Pi Agent Loop 调用 `AgentTool.execute`，**同进程、同事件循环**执行（`get-customer.ts:31`）。
- 若某 Tool 的 `execute` spawn 子进程或直接做危险 IO，它拥有 Runtime 容器的全部权限，无任何拦截。
- `abort()`（`runtime.ts:313`）只调 `agent.abort()`，**无法中断已陷入无限循环 / 无限 await 的 Tool**。
- Trace 仅记录 `tool_execution_start/end`，看不到子进程生命周期（退出码 / 是否超时 / 是否被 kill）。

结论：当前 **没有 Execution Boundary**（DOES NOT EXIST）。

---

## Before Architecture

```text
Business Client
    ↓
EnterpriseAiRuntime
    ↓
Pi Agent
    ↓
Tool.execute()          ← 在 Runtime 主进程内直接执行
    ↓
Business Logic（危险计算与主进程同生共死）
```

风险：失控 Tool 拖垮 Runtime 进程；`abort()` 救不回；Trace 不可观测。

---

## After Architecture

```text
Business Client
    ↓
EnterpriseAiRuntime
    ↓
Policy (beforeToolCall)        ← 允许?
    ↓ allow
Execution Boundary            ← 受限执行（独立子进程）
    ↓
Tool.execute()  ── 委托 ──▶ Child Process ──▶ Command
    ↓                              ↓
Tool Result                 stdout/stderr/exitCode/timedOut
    ↓
RunResult
```

- Tool 语义不变：`sandbox_test` 仍是 `AgentTool.execute`，由 Pi Agent Loop 调用。
- 危险计算委托给 `executeInBoundary()`（子进程），Tool 只把结构化 `ExecutionResult` 回给 LLM。
- Business Client 只看到 `RunResult`，**看不到 child_process**。

---

## Execution Boundary Design

`src/execution/boundary.ts` — `executeInBoundary(req, sink?): Promise<ExecutionResult>`

| 能力 | 实现 |
| --- | --- |
| 独立进程 | `child_process.spawn`（与 Runtime 主进程分离） |
| timeout + kill | `setTimeout` 到点 → `child.kill("SIGKILL")`，标记 `timedOut`/`killed` |
| stdout/stderr | 流式 `data` 事件累积 |
| 退出码 | `close` 事件 `code`（被 kill 时为 null） |
| cwd 隔离 | 未传 `cwd` 时 `mkdtemp(os.tmpdir()/execution-<rand>)`，每次执行独立 |
| cleanup | 执行结束 `rm(cwd, {recursive})`（仅自动目录；传入 cwd 不删） |
| Trace | 可选 `ExecutionTraceSink`：onExecutionStart/Finished/Timeout |

`ExecutionResult`：`{ exitCode, stdout, stderr, durationMs, timedOut, killed }`。

---

## Implementation

- `src/execution/types.ts`：`ExecutionRequest` / `ExecutionResult` / `ExecutionTraceSink`（无 *Manager）。
- `src/execution/boundary.ts`：`executeInBoundary`。
- `src/tools/sandbox-test-tool.ts`：`createSandboxTestTool(sink?)`，支持 5 个用例
  （echo / fail / timeout / output / createfile），timeout 用例用 1000ms 强杀。
- `src/trace/collector.ts`：`TraceCollector implements ExecutionTraceSink`，新增
  `execution_started` / `execution_finished` / `execution_timeout` 三类 TraceEvent。
- `src/runtime.ts`：新增 `executionTraceSink()` 暴露 collector，供 Tool 注入边界 Trace。
- `src/index.ts`：导出 `executeInBoundary` / `createSandboxTestTool` / 相关类型。
- `package.json`：新增 `acceptance:phase28a`。

集成位置结论：边界在 **Policy 允许之后、Tool 业务动作之内**。
不放在「Pi Agent → Sandbox」（会绕过 Policy），也不放在「Tool → Sandbox」作为 Tool 自身职责
（应由 Runtime 控制边界）。正确归属是 Runtime 控制的执行能力。

---

## Failure Experiment

用 `mode: "timeout"`（命令 `sleep 30`，边界 `timeout=1000`）：

1. **子进程是否被 kill？** 是 —— `exitCode=null`、`killed=true`、`timedOut=true`，约 1s 内结束。
2. **Runtime 是否继续运行？** 是 —— 超时 Run 结束后，再发起一次 `echo` Run 仍 `completed`（Case D）。
3. **RunResult 是什么？** `status="completed"`，`trace` 含 `execution_timeout` + `execution_finished`。
4. **Trace 是否记录？** 是 —— `execution_started` / `execution_timeout` / `execution_finished` 均在 trace 内。
5. **是否存在 zombie process？** 否 —— `close` 事件正常触发（进程被 reap）；边界 Promise 在 kill 后 resolve。

> 关键对比：在旧架构（无边界）下，同样的 `sleep 30` 会卡住 Run 且 `abort()` 救不回；
> 有了边界，超时由边界自身负责 kill，Runtime 主进程不被污染。

---

## Trace

`src/trace/types.ts` 的 `TraceEvent`（自由 `type`/`data`）无需改类型即可承载新事件：

```text
execution_started  { command, args, cwd, timeoutMs }
execution_finished { exitCode, durationMs, timedOut, killed }
execution_timeout  { command, args }
```

Runtime 的 `ExecutionTrace.events` 现在能看到「Tool execution」+「Execution Boundary lifecycle」两层。
未设计完整 Observability System（仅必要事件）。

---

## Limitations

- 仅进程级隔离（child_process），无容器/kernel 隔离。
- 无内存/CPU 上限：子进程 OOM 仍可能拖垮同机（后续 Sandbox 阶段）。
- 未限制网络：子进程默认可访问网络（含 `host.docker.internal`）。
- 未限制文件系统权限：自动 cwd 仅做隔离与清理，不禁止读写其他路径（传 `cwd` 时由调用方负责）。
- 未过滤环境变量：子进程继承 `process.env`（含 `LLM_API_KEY`）。
- stdout/stderr 未做大小截断（大输出可能撑内存）。

---

## Deferred Sandbox Features

明确 DEFER（属下一阶段真正 Sandbox Runtime）：

- Memory limit（ulimit / cgroup）
- CPU limit（cgroup）
- Network isolation（network namespace / 默认 deny）
- Filesystem permission（只读根 / 白名单挂载）
- Container sandbox（每 Tool 临时容器）
- Kernel isolation（seccomp / gVisor / Firecracker / Kata）

---

## Decision

- **Execution Boundary 现已存在（PARTIAL）**：最小能力（独立进程 / timeout+kill / stdout/stderr /
  退出码 / cwd 隔离 / 清理 / Trace）落地，但内存/CPU/网络/FS 隔离仍缺失，故称 PARTIAL。
- **边界归属**：Runtime 控制的执行能力，位于 Policy 之后、Tool 业务动作之内。
- **Policy / Tool / Sandbox 分工不变**：Policy=允许?；Tool=业务动作；Boundary=如何受限执行。
- **不引入任何 *Manager 类**：边界是 `executeInBoundary()` 函数 + 可选 `sink` 回调，非子系统。
- **下一步**：在 PARTIAL 基础上补 DEFER 项（以容器/kernel 隔离为主），仍保持最小、不引入 Manager。
