# Phase 1 — Minimal Runtime Spec

> 目标：验证 **Pi Agent**（`@earendil-works/pi-agent-core`）能否作为 Enterprise AI Runtime 的最小发动机。
> 状态：**仅规格，未实现。** 本文档基于已安装的 Pi SDK 类型定义（v0.85.1）实地核对。

---

## 1. 当前环境（实测）

| 项 | 值 | 说明 |
|----|----|------|
| 工作目录 | `/Users/jun/workspace/enterprise-ai-lab` | **完全为空**（无 `package.json`、无 `node_modules`、无 `src`） |
| 操作系统 | macOS (darwin) | — |
| Shell | Zsh | — |
| Node.js | **v26.8.2** | Pi 要求 `node >= 22.19.0`，满足 ✓ |
| npm | 11.19.1 | — |
| Pi SDK 安装情况 | **未安装**（项目内无 node_modules） | SDK 通过 `npm pack` 拉取到 `/tmp/pi-inspect` 仅用于**阅读类型定义**，未污染项目 |

> 结论：项目是绿地（greenfield）。Phase 1 需要新建 `package.json` 并安装 `@earendil-works/pi-agent-core`（会顺带拉取 `pi-ai`、`pi-telemetry` 及其 provider SDK 依赖，但均为 tree-shakeable / 懒加载）。

---

## 2. Pi SDK 真实 API（实地从 `.d.ts` 提取）

Pi 由 earendil-works 维护（作者 Armin Ronacher / mitsuhiko），MIT 许可。本项目相关三个包：

- `@earendil-works/pi-agent-core` — **Agent 运行时**（状态管理 + 工具循环 + 生命周期事件 + 转向/跟进队列）
- `@earendil-works/pi-ai` — **统一多提供商 LLM API**（OpenAI / Anthropic / Google / Bedrock / … + 自定义 OpenAI 兼容端点）
- `@earendil-works/pi-telemetry` — 遥测契约（Phase 1 不强制使用）

### 2.1 核心发动机：`Agent`（来自 `pi-agent-core`）

```ts
import { Agent } from "@earendil-works/pi-agent-core";

class Agent {
  constructor(options: AgentOptions);

  // —— 生命周期事件订阅（UI / 编排的关键钩子）——
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void;

  // —— 状态 ——
  get state(): AgentState;            // { systemPrompt, model, thinkingLevel, tools, messages, isStreaming, streamingMessage, pendingToolCalls, errorMessage }

  // —— 驱动 ——
  prompt(input: string, images?: ImageContent[]): Promise<void>;
  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  continue(): Promise<void>;          // 从当前 transcript 继续（最后一条须为 user / toolResult）

  // —— 队列（运行时介入）——
  steer(message: AgentMessage): void;       // 当前 turn 结束后注入
  followUp(message: AgentMessage): void;    // 否则将停止时注入
  set steeringMode(mode: QueueMode);        // "all" | "one-at-a-time"
  set followUpMode(mode: QueueMode);

  // —— 控制 ——
  get signal(): AbortSignal | undefined;
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;
}
```

`AgentOptions`（构造参数，节选）：

```ts
interface AgentOptions {
  streamFn: StreamFn;                 // ★ 必填：模型 I/O 的唯一插口
  model: Model<any>;                  // 初始模型（也可经 initialState 注入）
  systemPrompt?: string;
  initialState?: Partial<AgentState>; // 注入 tools / messages / model 等
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  beforeToolCall?, afterToolCall?: ...;   // Phase 1 不使用
  shouldStopAfterTurn?, prepareNextTurn?: ...;
  toolExecution?: ToolExecutionMode;      // "sequential" | "parallel"（默认 parallel）
  transport?: Transport;                  // "sse" | "websocket" | "websocket-cached" | "auto"
  thinkingBudgets?: ThinkingBudgets;
  sessionId?: string;
}
```

`StreamFn`（模型 I/O 契约）：

```ts
type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

### 2.2 事件协议（编排层消费）

`AgentEvent` 是一组判别联合，Phase 1 最关键的：

- `agent_start` / `agent_end` / `turn_start` / `turn_end`
- `message_start` / `message_update`（流式增量）/ `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

### 2.3 模型与消息数据（来自 `pi-ai`）

```ts
interface Model<TApi extends Api> {
  id: string;            // 例如 "llama3.2"
  name: string;
  api: TApi;             // "openai-completions" | "anthropic-messages" | ... | (string & {})
  provider: ProviderId;  // "ollama" | "openai" | ...
  baseUrl: string;       // ★ 真正发请求的地方，例如 "http://localhost:11434/v1"
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  compat?: OpenAICompletionsCompat;   // ★ 自定义 OpenAI 兼容端点的兼容开关
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;
// AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]
// ToolResultMessage: { role:"toolResult", toolCallId, toolName, content, isError, timestamp }
```

### 2.4 流式助手消息事件（写适配器用，来自 `pi-ai`）

```ts
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
// 该类是**公开**的，可直接用于构造 Ollama 适配器输出：
class AssistantMessageEventStream {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
  result(): Promise<AssistantMessage>;
}
// createAssistantMessageEventStream(): AssistantMessageEventStream
```

`AssistantMessageEvent` 判别联合（成功流顺序）：`start` → `text_start` → `text_delta*` → `text_end` → `toolcall_start` → `toolcall_delta*` → `toolcall_end` → `done`/`error`。`done` 携带最终 `AssistantMessage`；失败以 `error` 结束。

### 2.5 设计要点

- **`Agent` 就是发动机**：状态管理、工具循环、重试、生命周期事件、转向/跟进队列、abort、compaction 钩子全部由它负责。
- **模型 I/O 是单一插口 `streamFn`**：`Models.streamSimple` 满足该签名——即"Pi 不绑定任何具体模型，模型只是数据 + 一个 stream 函数"。这正是我们用 Ollama 替换官方端点的依据。
- Phase 1 **不使用** `AgentHarness` / `NodeExecutionEnv` / skills / compaction（属 `pi-agent-core` 的"编码代理"上层），只用裸 `Agent` + `streamFn`，保持最小。

---

## 3. Ollama 如何接入

Ollama 暴露 **OpenAI 兼容的 Chat Completions 端点**：`POST http://localhost:11434/v1/chat/completions`（`stream: true` 走 SSE）。

接入方式（二选一，Phase 1 用 **方案 A**，最小且无内部依赖）：

### 方案 A（推荐，Phase 1）：自定义 `streamFn` 直连 Ollama

- 模型描述符（纯数据）：

```ts
import type { Model } from "@earendil-works/pi-ai";

const ollamaModel: Model<"openai-completions"> = {
  id: "llama3.2",                       // 用 `ollama list` 看到的模型名
  name: "Ollama Llama 3.2",
  api: "openai-completions",            // 走 chat/completions，非 responses
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1", // ★ 指向本地 Ollama
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
  compat: {                             // ★ 关键：关掉官方端点才有的字段
    supportsDeveloperRole: false,       // Ollama 用 system role，不用 developer
    supportsReasoningEffort: false,
    supportsStore: false,
    maxTokensField: "max_tokens",
  },
};
```

- `streamFn` 骨架（用 Pi 公开的 `createAssistantMessageEventStream` 产出事件流）：

```ts
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Model, Context, SimpleStreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";

export function ollamaStreamFn(
  model: Model<"openai-completions">,
  context: Context,
  _options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  // 1) 将 context.messages 映射为 Ollama messages（system 拆出 / tool 结果回填）
  // 2) fetch(`${model.baseUrl}/chat/completions`, { stream:true, ... })
  // 3) 逐行解析 SSE `data:` 块，push text_delta / toolcall_delta
  // 4) 收尾 push done（携带拼好的 AssistantMessage，stopReason="stop"|"toolUse"）
  // 5) 出错 push error
  return stream;
}
```

- 不需要 Pi 的 provider 注册、不需要 `Models` 集合、不需要任何 API key（Ollama 本地无鉴权；如启用可经 `getApiKey` / `ProviderRequestOptions.headers`）。

### 方案 B（后续阶段可选）：用 Pi 的 `Provider` 体系

`pi-ai` 提供 `createProvider()` / `createModels()` + `setProvider()`，可注册一个 Ollama provider，复用其懒加载的 `openAICompletionsApi()` 适配器与统一鉴权/目录。但该适配器未从包根导出（仅内部 provider 工厂引用），Phase 1 不引入，避免依赖内部子路径。

> 结论：**Ollama 接入 = 一个 `openai-completions` 的 `Model` 描述符 + 一个 ~120 行的 `streamFn`**。Pi 的 `Agent` 其余全部照常工作。

---

## 4. Phase 1 Runtime 设计

### 4.1 架构

```
┌─────────────────────────────────────────────────────────┐
│  EnterpriseAiRuntime (Phase 1 薄封装)                     │
│  - 持有 Agent 实例                                        │
│  - prompt(text) → agent.prompt(text)                      │
│  - onEvent(cb)  → agent.subscribe(...) 透传 AgentEvent     │
│  - transcript() → agent.state.messages                   │
│  - abort()      → agent.abort()                          │
└───────────────┬─────────────────────────────────────────┘
                │ streamFn (注入)
                ▼
┌─────────────────────────────────────────────────────────┐
│  ollamaStreamFn (Model I/O 适配器)                        │
│  Model(baseUrl=localhost:11434/v1, api=openai-completions)│
│  → AssistantMessageEventStream (SSE → Pi 事件)            │
└───────────────┬─────────────────────────────────────────┘
                │ HTTP SSE
                ▼
        Ollama  (localhost:11434)
```

### 4.2 组件

| 组件 | 职责 | 来源 |
|------|------|------|
| `EnterpriseAiRuntime` | 对外门面：创建 `Agent`、注入 `streamFn`、透传事件、暴露 transcript/abort | **新建** |
| `ollamaStreamFn` | 把 `Context` 转 Ollama 请求、把 SSE 转 `AssistantMessageEventStream` | **新建** |
| `ollamaModel` | Ollama 模型描述符（纯数据） | **新建** |
| `Agent` | 状态/工具循环/事件/队列/abort | Pi SDK |
| `createAssistantMessageEventStream` | 产出 Pi 事件流 | Pi SDK |

### 4.3 数据流（一次 `prompt`）

1. 调用方 `runtime.prompt("...")` → `agent.prompt(text)`。
2. `Agent` 内部 `agentLoop` 调用 `streamFn(model, context, options)`。
3. `ollamaStreamFn` 发请求到 Ollama，边收 SSE 边 `push` `AssistantMessageEvent`。
4. `Agent` 把这些事件转成 `AgentEvent`（`message_update` 等）并通过 `subscribe` 回调推给调用方。
5. 若模型返回 `toolUse`，`Agent` 执行 tools（Phase 1 为空集，故直接 `stop`）→ 产出 `AssistantMessage`，`turn_end` → `agent_end`。
6. 完整 transcript 始终在 `agent.state.messages`。

### 4.4 显式范围

- **实现**：Runtime 门面、`ollamaStreamFn`、`ollamaModel`、最小 `package.json`、一个冒烟脚本。
- **不实现**（依任务约束）：Tool、Skill、MCP、Policy、Multi-Agent、Database、UI、Harness/NodeExecutionEnv/compaction。
- `tools` 初相位传 `[]`；`convertToLlm` 用默认透传（AgentMessage 即 Message 超集，可直接传）。

---

## 5. 需要创建的文件

| 路径 | 作用 |
|------|------|
| `package.json` | ESM；`type: "module"`；依赖 `@earendil-works/pi-agent-core@^0.85.1`；`engines.node >= 22.19.0`；`scripts`（typecheck / smoke） |
| `tsconfig.json` | 严格模式，`moduleResolution: bundler` 或 `node16`；`target: ES2022` |
| `src/runtime.ts` | `EnterpriseAiRuntime` 门面（包 `Agent`） |
| `src/ollama/stream.ts` | `ollamaStreamFn`（Ollama SSE → `AssistantMessageEventStream`） |
| `src/ollama/model.ts` | `ollamaModel` 描述符 + 从 env 读 `OLLAMA_BASE_URL` / 模型名 |
| `src/index.ts` | 导出 `EnterpriseAiRuntime`、`ollamaStreamFn`、`ollamaModel` |
| `scripts/smoke.ts` | 最小验证：连 Ollama，`prompt("hi")` 打印事件流与最终 transcript |

> 不创建测试框架、不创建 docs 之外的多余文件。Phase 1 以 `scripts/smoke.ts` 手动跑通为验收。

---

## 6. 为什么这样设计

1. **复用经过验证的发动机**：`Agent` 已处理 transcript 状态、工具循环、重试、生命周期事件、转向/跟进队列、abort——这些是 Runtime 最难、最易错的部分。自研等于重造轮子。
2. **最小侵入**：仅需 `streamFn` 一个插口即可替换任意模型后端，Phase 1 用 Ollama 验证"本地、零成本、零密钥"可行性，后续换 Anthropic/OpenAI/Bedrock 只需换 `Model` + `streamFn`，Runtime 门面不动。
3. **单文件适配器**：Ollama 是标准 OpenAI Chat Completions，配合 Pi 公开的 `createAssistantMessageEventStream`，适配器约 120 行，无内部依赖、无需 `Models`/`Provider` 体系。
4. **渐进扩展**：Phase 1 不用 Harness/Tools/Skills，但 `Agent` 已预留 `beforeToolCall`/`afterToolCall`/`shouldStopAfterTurn`/`prepareNextTurn` 钩子，Phase 2+ 接入 Tool/Skill/Policy 时无需改 Runtime 骨架。
5. **环境零摩擦**：当前 Node v26 满足 `>=22.19`；项目为空，从零起最干净；SDK 仅阅读未污染，待确认后再 `npm install`。

---

## 7. 验证检查清单（实现阶段使用，本次不执行）

- [ ] `node -v` ≥ 22.19.0（当前 26.8.2 ✓）
- [ ] Ollama 本地运行：`curl localhost:11434/api/tags` 有返回
- [ ] `npm install` 成功，`tsc --noEmit` 通过
- [ ] `scripts/smoke.ts` 输出 `agent_start → message_* → turn_end → agent_end` 与最终文本
- [ ] `runtime.abort()` 能中断进行中的流
- [ ] 改 `ollamaModel.id` 指向另一个本地模型可切换，无需改 Runtime

---

## 8. 待你确认

1. 是否接受用 **方案 A（自定义 `streamFn` 直连 Ollama）** 作为 Phase 1 的最小连接？
2. Ollama 的运行地址是否就是 `http://localhost:11434`（还是走 Docker / 远程）？
3. Phase 1 目标模型是否 `llama3.2`（还是其它已拉取的本地模型）？
4. 是否同意新建上表 7 个文件、暂不安装依赖（待确认后安装）？
