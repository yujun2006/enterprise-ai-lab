# Phase 27-C — Product Delivery Design Gate

> 目标：一次性走通 `Source Code → Public API → Package → HTTP Service → Docker → Deployment → Remote Business Client`。
> 本 Gate 先回答边界问题，再动手实现。结论已落地到 `docs/phase-27c-product-delivery.md` 与代码。

---

## 1. Delivery Boundary

当前（Phase 27-B）：

```text
Business Client
      ↓
EnterpriseAiRuntime        (同进程 / 同库，TypeScript Public API)
```

Product Delivery 后：

```text
Business Client
      ↓
HTTP
      ↓
Service (Process Boundary)
      ↓
EnterpriseAiRuntime
```

**结论**：HTTP 层只是 **Transport Boundary**，不是 Runtime Boundary。
Runtime 的 Public API（`run()` → `RunResult`）在 HTTP 之下保持不变；HTTP 只做
「请求 → Public API → 响应」的翻译。

---

## 2. Package Boundary

**当前 Public API 是否已足够形成一个 package artifact？** 是。

- `src/index.ts` 已导出稳定 Public 集合：`EnterpriseAiRuntime` / `RunResult` 等 /
  `AgentTool` / `Policy` / `ExecutionTrace` / `ScriptedModel`（确定性测试后端）。
- `package.json` 已声明运行期依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`dotenv`。
- TypeScript build 可产出 `dist/`（含 `.d.ts`）。

需要补充的打包元数据：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `main` | `dist/index.js` | CJS/ESM 入口 |
| `types` | `dist/index.d.ts` | 类型入口 |
| `exports` | `{ ".": { types, import } }` | 现代入口映射 |
| `files` | `["dist", "README.md"]` | 仅发布构建产物 + README；**不含** `src/`、`scripts/`、`docs/` |

**本阶段不发布到 npm registry**：`npm pack` 生成 `enterprise-ai-runtime-0.1.0.tgz` 本地 tarball，
由 `experiments/phase27c/package-consumer/` 安装并验证「Consumer ↓ Package ↓ EnterpriseAiRuntime」。

> 关键学习点：**"package 可以交付" ≠ "已经发布到 npm"**。本地 tarball + 独立 Consumer 即可证明可交付性。

---

## 3. HTTP Boundary（核心学习点）

```text
HTTP Request
    ↓
Transport DTO ( { prompt } )
    ↓
Public API ( runtime.run(prompt) )
    ↓
EnterpriseAiRuntime
```

HTTP 层负责：HTTP method / URL / JSON 解析 / status code / 请求校验 / 序列化 / transport error。
Runtime 负责：Agent 执行 / Tool / Policy / Trace / Recovery / Run 生命周期。

**禁止**把 Policy / Tool / Agent Loop / Recovery 塞进 HTTP Handler —— Handler 只翻译，不实现。

端点（最小）：

```http
GET  /health     → { "status": "ok" }
POST /v1/runs    → { "prompt": string } → RunResult (按 Public Contract 直接序列化)
```

不引入 Web 框架：使用 Node.js 原生 `http`。

---

## 4. Error / Failure 是两个维度（不混淆）

| 维度 | 含义 | 例子 |
| --- | --- | --- |
| HTTP status | Transport / API 层结果 | 400 非法请求 / 404 未知路由 / 500 服务崩溃 |
| `RunResult.status` | Runtime Execution Outcome | `completed` / `failed` / `aborted` / `unknown` |

**结论**：`failed` / `aborted` / `unknown` 仍返回 **HTTP 200** —— 它们是有意义的执行结果，
不是 transport 错误。只有「请求本身非法 / 路由不存在 / 服务意外崩溃」才返回 4xx/5xx。

---

## 5. API Versioning

仅做最小实验：`/v1/runs`。

- 不实现 `/v1` + `/v2` + `/v3` 并存。
- 价值：当 Public Contract 发生 breaking change 时，可保留旧 `/v1` 同时提供新版本。
- 本阶段只验证 `/v1` 这一概念存在即可。

---

## 6. Docker Boundary

```text
Docker Container
    ↓
HTTP Service
    ↓
EnterpriseAiRuntime
```

要求：

- 非 root 用户（`node` 镜像内置 `node` 用户）。
- ENV 配置（不 bake `.env` / API keys；密钥经 `docker run -e` 注入）。
- health endpoint（HEALTHCHECK → `/health`）。
- graceful shutdown（SIGTERM → `server.close`）。

**关键认知**：容器 `localhost` ≠ 宿主机 `localhost`。
- 容器内默认 `LLM_BASE_URL=http://localhost:11434/v1` 指向**容器自身**，不是宿主机 Ollama。
- 连宿主机 Ollama：`docker run -e LLM_BASE_URL=http://host.docker.internal:11434/v1`
  （macOS Docker Desktop 自动解析；Linux 需 `--add-host=host.docker.internal:host-gateway`）。

---

## 7. Authentication（推迟）

本阶段**不实现** Auth：

```text
HTTP Deployment
      ↓
Trust Boundary
      ↓
Authentication
      ↓
Authorization
```

记录：Auth 属于下一层 Product/SaaS 问题，**不属于**本次最小 Delivery 实验。
保护本机实验用网络层限制（`-p 127.0.0.1:3000:3000` 或防火墙），不实现 JWT/API Key 系统。

---

## 8. STOP Condition（实现前确认）

满足以下全部即实现、不扩张：

1. Package 可被独立 Consumer 安装并 import Public API → RunResult。
2. HTTP `/health` 与 `/v1/runs` 工作。
3. HTTP 错误映射正确（400/404/500 与 RunResult.status 分离）。
4. Docker 镜像可构建并运行（含 health）。
5. Remote Business Client 经 HTTP 调用成功。
6. 不引入 Manager / SDK framework / Auth / SaaS。

实现落地后见 `docs/phase-27c-product-delivery.md`。
