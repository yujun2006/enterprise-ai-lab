# Enterprise AI Runtime Lab

一个用于**学习 Enterprise AI Runtime 架构**的实验项目。

本项目不试图从零重写 Agent Loop，而是在
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
（一个可嵌入的 Agent Runtime）之上构建 **Enterprise Runtime Control Plane**，覆盖
Policy、Trace、Recovery、Checkpoint、Session 边界、Resource 访问边界等治理问题。

> 本仓库是学习 Lab，不是产品 SDK。详见文末 [Current Status](#current-status)。

---

## What this project is

```text
Enterprise AI Runtime Lab
        ↓
EnterpriseAiRuntime            ← 本项目学习和构建的部分
        ↓
@earendil-works/pi-agent-core  ← Agent Execution Engine（嵌入依赖）
        ↓
@earendil-works/pi-ai          ← Model / Provider 层（嵌入依赖）
        ↓
Ollama / DeepSeek / other providers
```

核心结论：

> **Pi 是底座，本项目研究的是企业 Runtime 如何建立在 Agent Runtime 之上。**

我们不重新实现 Agent Loop；我们在 Pi Agent Core 之上叠加 Enterprise 治理能力
（Policy / Trace / Recovery / Boundary）。

---

## Architecture

```text
┌─────────────────────────────────────┐
│         Business Application        │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│       EnterpriseAiRuntime           │
│                                     │
│  Policy / Tool / Trace / Recovery   │
│  Runtime Control / Business API     │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│      @earendil-works/pi-agent-core  │
│                                     │
│  Agent Loop                         │
│  Agent State                        │
│  Tool Calling                       │
│  Tool Execution                     │
│  Tool Result Refeed                 │
│  Events / Abort                     │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│          @earendil-works/pi-ai      │
│                                     │
│  Model / Provider Abstraction       │
│  OpenAI-compatible APIs             │
│  Provider Implementations            │
└─────────────────┬───────────────────┘
                  │
          ┌───────┴────────┐
          ▼                ▼
       Ollama           DeepSeek
          │
          ▼
       Qwen Model
```

### Pi Agent Core

Pi Agent Core 是本 Lab 的 **Agent Execution Engine**。它负责：

- Agent Loop（`LLM → Tool Call → Tool Result → LLM`）
- Agent State
- Tool execution
- Event streaming
- Abort
- Follow-up / Steering

它**不负责 Enterprise Governance**。

### pi-ai

`pi-ai` 是 Model / Provider 层。它负责：

- Model abstraction
- Provider abstraction
- Provider-specific request handling
- Streaming model response

```text
EnterpriseAiRuntime
        ↓
Pi Agent Core
        ↓
pi-ai
        ↓
Ollama / DeepSeek
```

### EnterpriseAiRuntime

这是本项目真正学习和构建的部分。它负责：

- Tool Registry
- Policy
- Trace
- Run Context
- Recovery
- Checkpoint
- Session boundary
- Resource access boundary
- Enterprise control plane

---

## Pi CLI vs Pi Agent Core

```text
Pi CLI
    ↓
Developer / Interactive Coding Experience

Pi Agent Core
    ↓
Embeddable Agent Runtime
```

本项目的核心依赖是：

```text
@earendil-works/pi-agent-core
@earendil-works/pi-ai
```

而不是通过 shell 调用 Pi CLI 来运行 Enterprise Runtime。实际依赖关系为：

```text
EnterpriseAiRuntime
      ↓
import @earendil-works/pi-agent-core
```

> 注：Pi CLI 是 Pi 提供的交互式开发工具，是开发/实验辅助手段，**不是** EnterpriseAiRuntime
> 的运行时依赖。本项目通过 `import` 引入 npm 包，不依赖 `pi` 命令行进程。

---

## Requirements

以当前 `package.json` 为准：

```bash
node --version   # 需要 >= 22.19.0
npm --version
```

| 项 | 值 |
| --- | --- |
| Node.js | `>=22.19.0` |
| 包管理 | npm |
| 模块系统 | ESM（`"type": "module"`） |

### 依赖版本（实际锁定）

| 包 | 版本 |
| --- | --- |
| `@earendil-works/pi-agent-core` | `0.85.1` |
| `@earendil-works/pi-ai` | `0.85.1` |
| `dotenv` | `17.4.2` |
| `typescript`（dev） | `^5.6.0` |
| `tsx`（dev） | `^4.19.0` |
| `@types/node`（dev） | `^22.0.0` |

---

## Installation

```bash
git clone https://github.com/yujun2006/enterprise-ai-lab.git
cd enterprise-ai-lab
npm install
```

依赖由 `package.json` 管理，核心运行依赖即上表的三个包（pi-agent-core / pi-ai / dotenv）。
不需要手工复制 `node_modules`。

---

## Ollama（默认本地 Model Provider）

Ollama 是当前默认本地 Provider。如需运行真实 LLM 路径（如 `npm run smoke`），需要本地 Ollama。

- 官方站点：<https://ollama.com>
- 安装后检查：

```bash
ollama --version
ollama list
```

如果模型不存在，按当前项目默认配置拉取：

```bash
ollama pull qwen2.5:14b
```

当前默认配置（`src/ollama/model.ts`）：

| 配置 | 默认值 |
| --- | --- |
| `LLM_PROVIDER` | `ollama` |
| `LLM_MODEL` | `qwen2.5:14b` |
| `LLM_BASE_URL` | `http://localhost:11434/v1` |
| `LLM_API_KEY` | `ollama`（占位） |

---

## Environment Configuration

项目使用 `.env`（通过 `dotenv` 加载）。

```bash
cp .env.example .env
```

`.env.example` 当前内容：

```env
LLM_PROVIDER=ollama
LLM_MODEL=qwen2.5:14b
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
```

环境变量说明（以 `src/ollama/model.ts` 实际读取为准）：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_PROVIDER` | provider 名称（`ollama` / `deepseek`） | `ollama` |
| `LLM_MODEL` | model id | `qwen2.5:14b` |
| `LLM_BASE_URL` | OpenAI-compatible 端点 | `http://localhost:11434/v1` |
| `LLM_API_KEY` | 统一鉴权 key | `ollama` |
| `OLLAMA_API_KEY` | Ollama 专属 key（回落到 `LLM_API_KEY`） | — |
| `OLLAMA_MODEL` / `OLLAMA_BASE_URL` | 旧变量，向后兼容回落 | — |
| `DEEPSEEK_API_KEY` | provider=`deepseek` 时使用 | — |

> `.env` **不应**提交 Git；`.env.example` 是安全模板。DeepSeek 等远程 Provider 仅为可选配置，
> 第一次运行不强制配置。

---

## First Run

### 离线最短路径（不需要 Ollama）

```bash
npm install
cp .env.example .env
npm run typecheck            # 离线：类型检查
npm run acceptance:phase27b  # 离线：ScriptedModel 驱动，验证 Public API + 完整调用链
```

`acceptance:phase27b` 用确定性的 `ScriptedModel` 离线跑通：

```text
Business Client → Public API → EnterpriseAiRuntime → Pi Agent → LLM → Tool
→ Policy → Tool Execution → Tool Result → LLM → RunResult → Business Client
```

覆盖 Normal Run / Policy DENY / Tool Failure / Abort 四个用例，无需本地 LLM。

### 真实 LLM 路径（需要 Ollama）

```bash
ollama list                  # 确认 qwen2.5:14b 已存在，否则 ollama pull qwen2.5:14b
npm run smoke                # 真实 LLM 调用的最小 smoke test
```

---

## First Run Architecture

运行 `npm run smoke`（或任意 `run()`）后的实际调用链：

```text
Business / Smoke Script
        ↓
EnterpriseAiRuntime.run()
        ↓
Pi Agent.prompt()
        ↓
Pi Agent Loop
        ↓
pi-ai（openAICompletionsApi）
        ↓
Ollama
        ↓
Qwen
        ↓
Assistant Response
        ↓
EnterpriseAiRuntime Trace
```

若发生 Tool Call：

```text
LLM
 ↓
Tool Call
 ↓
EnterpriseAiRuntime Policy
 ↓
Tool
 ↓
Tool Result
 ↓
Pi Agent
 ↓
LLM
```

这是本项目最核心的学习路径。

---

## Public API（Business-facing）

`EnterpriseAiRuntime` 的最小 Business API（详见 `docs/phase-27b-public-api-design-gate.md`）：

```ts
import { EnterpriseAiRuntime, getCustomer } from "enterprise-ai-runtime";

const runtime = new EnterpriseAiRuntime({
  tools: [getCustomer],
  systemPrompt: "You are a helpful enterprise assistant.",
});

// run() 返回结构化 RunResult（不再返回 void）
const result = await runtime.run("Find customer Alice");
console.log(result.status);   // "completed" | "failed" | "aborted" | "unknown"
console.log(result.answer);   // 最终 Assistant 回答
console.log(result.sessionId); // 稳定 Session 身份
console.log(result.trace);    // 只读执行轨迹（可选）
```

`RunResult` 契约（"status" 是执行生命周期状态，**不等于**业务成功）：

```ts
type RunStatus = "completed" | "failed" | "aborted" | "unknown";

interface RunResult {
  status: RunStatus;
  answer?: string;
  sessionId: string;
  runId: string;
  trace?: ExecutionTrace;   // 只读观测模型，不持有 Pi 对象
  error?: { code: "llm_error" | "aborted" | "unknown"; message: string };
}
```

设计要点（Phase 8 / 17–22）：

- Final Answer ≠ Success：`answer` 存在不代表 `status === "completed"`。
- UNKNOWN ≠ FAILED：无法确定结果时给 `unknown`，绝不误标 `failed`。
- Abort ≠ LLM failure：二者都可能是 `error` 态，但 `abort()` 产生独立的 `aborted` 状态。
- Tool / Policy 失败**不**终止 Run：Run 仍 `completed`，失败只体现在 `trace` 中。
- Recovery **不是**普通 `RunResult`：`recover()` / `resume()` 是独立生命周期入口。

`src/index.ts` 导出的稳定 Public 集合：

```text
EnterpriseAiRuntime
AgentTool / EnterpriseTool        (Tool 契约)
Policy / PolicyDecision           (Policy 契约)
RunResult / RunStatus / RunError  (Run 结果契约)
ExecutionTrace / TraceEvent / LlmCallTrace  (Trace 只读模型)
```

其余导出（`ToolRegistry` / `TraceCollector` / `evaluatePolicy` / `decideRecovery` /
`FileRecoveryStore` / `ollamaModel` 等）为测试/实验复用而 export，属内部实现，非稳定契约。

---

## Development Commands

仅列出 `package.json` 真实存在的 scripts：

```bash
npm run typecheck           # tsc --noEmit
npm run smoke               # tsx scripts/smoke.ts（真实 LLM，需 Ollama）
npm run acceptance:phase20  # tsx scripts/phase20-acceptance.ts（离线，Durable Recovery）
npm run acceptance:phase27b # tsx scripts/phase27b-acceptance.ts（离线，Public API）
```

其他实验脚本（`scripts/*.ts`）可通过 `npx tsx scripts/<name>.ts` 运行，但未注册为 npm script。

---

## Architecture Learning Map

```text
Phase 1–6
Agent / Tool / Trace / Policy / Capability

Phase 7–13
Session / Run / Harness / State / Failure / Recovery Boundary

Phase 14–19
Skill / Workspace / Multi-Agent / Reliability

Phase 20–22
Durable Recovery / Persistence / Architecture Freeze

Phase 23–26
Real Business Agent Pressure Tests

Phase 27
Public Boundary / Product Delivery
```

学习主线与辅助线：

```text
Main Architecture Track
    ↓
Sandbox
    ↓
Policy Runtime
    ↓
Tool / MCP Runtime
    ↓
...

Product Delivery Track
    ↓
Public API（Phase 27-B 已完成）
    ↓
Package / HTTP / Deployment（已实现，见 Product Delivery / How Others Integrate）
```

> Product Delivery（npm publish / HTTP / Docker / Auth / SaaS 等）是**辅助学习线**，
> 不取代 Enterprise Runtime Architecture 主线。

---

## Why Pi?

为什么不自己从零写 Agent Loop？

Agent Loop 本身不是本 Lab 的主要研究对象。Pi 已经提供：

- Agent Loop
- Tool Calling
- Tool Execution
- Agent State
- Model integration

因此本项目把学习重点放在：

- Enterprise Policy
- Runtime Boundary
- Reliability
- Recovery
- Persistence
- Workspace / Resource
- Governance
- Public Boundary

也就是说：

> **Pi 是底座，本项目研究的是企业 Runtime 如何建立在 Agent Runtime 之上。**

---

## Project Layout

```text
src/
  index.ts            # 公共导出（稳定 Public + 内部复用）
  runtime.ts          # EnterpriseAiRuntime（Business API / run / abort / recovery）
  ollama/model.ts     # Provider-neutral LLM 配置（LLM_* 环境变量）
  tools/              # ToolRegistry + 示例 Tool（getCustomer）
  trace/              # TraceCollector / ExecutionTrace 模型
  policy/             # Policy adapter（接 Pi beforeToolCall 控制点）
  recovery/           # Checkpoint / decideRecovery / FileRecoveryStore
scripts/
  smoke.ts            # 最小真实 LLM smoke test
  phase20-acceptance.ts / phase27b-acceptance.ts  # 离线 acceptance
  phase27b-business-client.ts / phase27b-fixtures.ts
docs/                 # 各 Phase 设计/调查文档
experiments/          # 真实业务 Agent 压力测试（部分需真实 LLM）
```

---

## Product Delivery (Phase 27-C)

完整交付链已验证：`Source → Public API → Package → HTTP → Docker → Remote Client`。

最小 HTTP Service（Node 原生 `http`，无 Web 框架）：

```bash
npm run build
RUNTIME_BACKEND=scripted PORT=3000 npm run serve   # 离线（ScriptedModel，无需 Ollama）
# 生产默认连 Ollama（LLM_* 环境变量驱动）
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/v1/runs -H 'content-type: application/json' \
  -d '{"prompt":"Find customer Alice"}'
```

打包为本地可交付 artifact（不发布到 npm；`private: true`）：

```bash
npm run build && npm pack        # 生成 enterprise-ai-runtime-0.1.0.tgz
```

Docker（容器 `localhost` ≠ 宿主机 `localhost`；连宿主机 Ollama 用 `host.docker.internal`）：

```bash
npm run build
docker build -t ear:27c .
docker run -d -p 3000:3000 -e RUNTIME_BACKEND=scripted ear:27c
```

详情见 [`docs/phase-27c-product-delivery-design-gate.md`](docs/phase-27c-product-delivery-design-gate.md)
与 [`docs/phase-27c-product-delivery.md`](docs/phase-27c-product-delivery.md)。

---

## How Others Integrate and Use the Runtime

EnterpriseAiRuntime can be integrated in two ways:

- **Package integration**: run the Runtime inside the consumer's own process.
- **HTTP integration**: run the Runtime as a separate service and call it remotely.

两种方式的底层都调用**同一个 Public Runtime Contract**（`EnterpriseAiRuntime.run()` → `RunResult`），
区别只在于「Consumer 在哪调用它」。

### A. Package Integration

```text
Consumer Application
    ↓ import
EnterpriseAiRuntime
    ↓
Pi Agent
    ↓
LLM / Tools
```

别人把本地产物当 npm package 安装：

```bash
npm install ./enterprise-ai-runtime-0.1.0.tgz
```

然后直接调用 Public API（不依赖 `src/...`，也无需了解 Pi Agent 内部实现）：

```ts
import { EnterpriseAiRuntime, getCustomer } from "enterprise-ai-runtime";

const runtime = new EnterpriseAiRuntime({
  tools: [getCustomer],
});

const result = await runtime.run("查询 Alice 的客户信息");
console.log(result.status);   // "completed" | "failed" | "aborted" | "unknown"
console.log(result.answer);
```

要点：

- Consumer 直接调用 Public API；Tool 在 Runtime 创建时通过 `RuntimeOptions.tools` 提供。
- Consumer **不应** import 任何 `src/...` 路径，只依赖打包后的 Public 导出。
- 需要离线 / 确定性验证时，可额外注入导出的 `ScriptedModel`（`model` / `streamFn`）作为测试后端。
- 这是同进程 / package integration。

### B. HTTP Integration

```text
Consumer Application
    ↓ HTTP
Runtime Service
    ↓
EnterpriseAiRuntime
    ↓
Pi Agent
    ↓
LLM / Tools
```

HTTP Client **不需要安装** `enterprise-ai-runtime`，它只需要知道 HTTP API。
运行时由 `npm run serve`（或 Docker 容器）启动一个 HTTP Service（端点见 [Product Delivery](#product-delivery-phase-27-c)）：

```http
POST /v1/runs
Content-Type: application/json

{
  "prompt": "查询 Alice 的客户信息"
}
```

客户端示例：

```ts
const response = await fetch("http://localhost:3000/v1/runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "查询 Alice 的客户信息" }),
});

const result = await response.json();
// result 即 RunResult 序列化体：{ status, answer, sessionId, runId, trace, error? }
```

实际响应（RunResult 风格）：

```json
{
  "status": "completed",
  "answer": "Alice works at Acme and is on the Enterprise plan.",
  "sessionId": "56646222-655a-431c-8840-8073b1564ccc",
  "runId": "c3ca2eaa-0297-4388-b85f-193384163d7e",
  "trace": { "runId": "...", "startedAt": 1789201762343, "endedAt": 1789201762345, "prompt": "查询 Alice 的客户信息", "events": [] }
}
```

> 完整 RunResult 字段以 [`docs/phase-27b-public-api-design-gate.md`](docs/phase-27b-public-api-design-gate.md)
> 与 [Public API](#public-api-business-facing) 为准。`failed` / `aborted` / `unknown` 仍返回 **HTTP 200**
> （它们是执行结果，不是 transport 错误）。

### Where Do Tools Come From?

HTTP Client **通常不在**每一次 `/v1/runs` 请求中把 Tool 代码传给 Runtime。
当前 Phase 27-C 的实现中：

```text
Runtime Service
  ├── EnterpriseAiRuntime
  └── Tools registered when Runtime starts (RuntimeOptions.tools)

HTTP Request:
{
  "prompt": "..."
}

而非：
{
  "prompt": "...",
  "tools": [...]
}
```

原因：

- Tool 是 Runtime 的**执行能力**，不是普通请求参数。
- Runtime 在启动 / 初始化时配置并注册 Tools。
- HTTP Client 只提交**任务（prompt）**；Runtime 决定当前 Run 可以使用哪些 Tools。

> Passing executable Tool code through the HTTP request is intentionally not part of the current design.

### Package vs HTTP

| Integration | Consumer knows | Runtime location |
| --- | --- | --- |
| Package | TypeScript Public API | Same process |
| HTTP | HTTP API | Separate process / container |

- Package = “把 Runtime 装进我的程序里”
- HTTP = “把 Runtime 当成一个远程服务调用”

两种方式最终调用的是**同一个 Public Runtime Contract**。

### Current Integration Boundary

当前 Phase 27-C 已验证：

```text
Business Client
  → Package OR HTTP
  → EnterpriseAiRuntime
  → Pi Agent
  → LLM
  → Tool
  → RunResult
```

明确不属于当前 Phase 27-C：

- Authentication / Authorization
- SaaS / Multi-tenancy / Billing
- API Gateway / Kubernetes
- Dynamic Tool upload / Remote executable code injection
- Tool Manager / MCP Runtime

> Tool / MCP 的远程能力发现与调用属于后续 Enterprise AI Runtime 主线，不是 HTTP Transport 本身的职责。

---

## Current Status

This repository is an architecture learning lab.

It is not currently:

- a production SDK
- a hosted SaaS
- a complete workflow engine
- a multi-tenant platform
- a general-purpose agent framework

The project intentionally evolves through small, evidence-driven phases.

```text
TYPECHECK:           see `npm run typecheck`
REGRESSION:          phase20 / phase27b acceptance (offline PASS)
DEFAULT MODEL:       qwen2.5:14b (Ollama)
CORE DEPENDENCIES:   @earendil-works/pi-agent-core@0.85.1, @earendil-works/pi-ai@0.85.1
```
