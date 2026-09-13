# Phase 27-C — Product Delivery

> 学习线：把「源代码」变成「别人可以调用和部署的产品」，亲手走通一次完整交付链。
> 本阶段不是 SaaS，不实现 Auth / Multi-tenancy / Billing / RBAC / Kubernetes / Manager 类。

---

## 1. Delivery Goal

```text
Source Code → Public API → Package → HTTP Service → Docker → Deployment → Remote Business Client
```

最终证明：

```text
Business Client
      ↓ HTTP
      ↓
EnterpriseAiRuntime
      ↓
Pi Agent
      ↓
LLM
      ↓
Tool / Policy
      ↓
RunResult
      ↓
Business Client
```

---

## 2. Package Boundary

- 新增 `tsconfig.build.json`（`tsc -p`，`rootDir: src`，`declaration: true`，`outDir: dist`，仅编译 `src`）。
- `package.json`：`main`/`types`/`exports`/`files` 指向 `dist` + `README.md`。
- `npm run build` → `dist/`（含 `.d.ts`）。
- `npm pack` → `enterprise-ai-runtime-0.1.0.tgz`（36 文件，仅 `dist` + `README` + `package.json`，不含 `src/`、`scripts/`、`docs/`）。
- 确定性测试后端 `ScriptedModel` 随包导出（`src/scripted-model.ts`），供 Consumer / 离线 HTTP 使用，不进入生产 Provider 抽象。

验证：`experiments/phase27c/package-consumer/` 安装 tarball，`node consumer.mjs`
→ `import { EnterpriseAiRuntime, ScriptedModel, getCustomer } from "enterprise-ai-runtime"`
→ `runtime.run("Find customer Alice")` → `RunResult.status === "completed"`。**PASS**。

---

## 3. HTTP Boundary

- `src/server.ts`：Node 原生 `http`，**无 Web 框架**。
- `GET /health` → `{ "status": "ok" }`。
- `POST /v1/runs` `{ prompt }` → 直接序列化 `RunResult`（不重新设计数据模型）。
- 错误映射分两个维度：
  - 请求非法（缺 prompt / 非 JSON）→ **400** `invalid_request`
  - 未知路由 → **404** `not_found`
  - 服务意外崩溃 → **500** `service_error`
  - `RunResult.status`（failed/aborted/unknown）→ **HTTP 200**（执行结果，非 transport 错误）
- graceful shutdown：`SIGINT`/`SIGTERM` → `server.close`。

---

## 4. Deployment Boundary

- `Dockerfile`：基于 `node:22-bookworm-slim`，仅 `npm install --omit=dev`，`USER node`，`EXPOSE 3000`，
  `HEALTHCHECK` 调 `/health`，`CMD ["node","dist/server.js"]`。
- `.dockerignore`：排除 `node_modules`/`src`/`scripts`/`docs`/`experiments`/`.env`/`*.tgz`（保留 `dist`）。
- 不 bake `.env` / 密钥；`LLM_*` 经 `docker run -e` 注入。
- 容器 `localhost` ≠ 宿主机 `localhost`：连宿主机 Ollama 用
  `-e LLM_BASE_URL=http://host.docker.internal:11434/v1`。
- `npm run build` 必须在 `docker build` 之前产出 `dist/`（已验证）。

---

## 5. Architecture

```text
Package (npm tarball, dist)
   ↓ import { EnterpriseAiRuntime }
Consumer (experiments/phase27c/package-consumer)
   ── 或 ──
HTTP Client (scripts/phase27c-business-client.ts)
   ↓ POST /v1/runs
HTTP Service (src/server.ts, Node http)
   ↓ runtime.run(prompt)
EnterpriseAiRuntime
   ↓ Pi Agent / pi-ai / Ollama|DeepSeek
RunResult ──→ HTTP 200 JSON ──→ Client
```

三个边界：

| 边界 | 解决的问题 |
| --- | --- |
| Package Boundary | 别人如何安装和 import 我的代码？ |
| HTTP Boundary | 别的进程如何调用我的 Runtime？ |
| Deployment Boundary | 我的 Runtime 如何在另一台机器上运行？ |
| Authentication | 谁可以调用？（**本阶段推迟**） |

---

## 6. Package Experiment

```bash
npm run build
npm pack                              # 生成 enterprise-ai-runtime-0.1.0.tgz
cd experiments/phase27c/package-consumer
npm install                          # 安装 file: 本地 tarball
node consumer.mjs                    # 经 Public API 跑通，status=completed
```

结果：**PACKAGE CONSUMER: OK**。

---

## 7. HTTP Experiment

```bash
npm run acceptance:phase27c         # 启动 scripted 模式子进程，确定性验证
```

覆盖：health 200 / run 200+completed / 缺 prompt 400 / 非 JSON 400 / 未知路由 404。
结果：**PHASE 27-C HTTP ACCEPTANCE: PASS**。

手动起服务（脚本化后端，无需 Ollama）：

```bash
RUNTIME_BACKEND=scripted PORT=3000 npm run serve
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/v1/runs -H 'content-type: application/json' -d '{"prompt":"Find customer Alice"}'
```

---

## 8. Docker Experiment

```bash
npm run build
docker build -t ear:27c .
docker run -d --rm --name ear27c -p 3000:3000 -e RUNTIME_BACKEND=scripted ear:27c
curl -s http://localhost:3000/health                 # {"status":"ok"}
curl -s -X POST http://localhost:3000/v1/runs -H 'content-type: application/json' -d '{"prompt":"Find customer Alice"}'
docker rm -f ear27c
```

连宿主机真实 LLM：

```bash
docker run -d --rm -p 3000:3000 \
  -e RUNTIME_BACKEND=ollama \
  -e LLM_BASE_URL=http://host.docker.internal:11434/v1 \
  -e LLM_MODEL=qwen2.5:14b \
  ear:27c
```

结果：镜像构建成功；scripted 与 ollama（host Ollama）两种后端均
`/health`=ok、`POST /v1/runs` 返回 `completed`。**DOCKER: PASS**。

---

## 9. Deployment Experiment

本机 Docker 即最小部署环境（无云产品 / K8s）。已验证：

```bash
curl /health        → 200 {"status":"ok"}
POST /v1/runs       → 200 RunResult（scripted 与真实 Qwen 均通过）
```

---

## 10. Business Client

`scripts/phase27c-business-client.ts`：

- **不 import EnterpriseAiRuntime**；只知道一个 HTTP endpoint（`RUNTIME_BASE_URL`，默认 `http://localhost:3000`）。
- `POST /v1/runs` → 读取 `RunResult.status / answer / sessionId / runId`。

与 Phase 27-B 的本质区别：

```text
Phase 27-B  Business Client → TypeScript Public API → Runtime（同库）
Phase 27-C  Business Client → HTTP → Remote Runtime Service（跨进程/机器）
```

验证：脚本化与真实 LLM 两种后端下，`REMOTE BUSINESS CLIENT OK`。

---

## 11. Failure / Error Mapping

| 场景 | HTTP | body |
| --- | --- | --- |
| 健康 | 200 | `{ status: "ok" }` |
| 正常 Run | 200 | `RunResult` |
| 缺 prompt / 非 JSON | 400 | `{ error: { code: "invalid_request" } }` |
| 未知路由 | 404 | `{ error: { code: "not_found" } }` |
| 服务崩溃 | 500 | `{ error: { code: "service_error" } }` |

`RunResult.status` 的 `failed`/`aborted`/`unknown` **永不**映射为 5xx（它们是执行结果，非 transport 错误）。

---

## 12. Authentication Deferred

明确记录：Auth 属于 Product/SaaS 下一层，不在最小 Delivery 实验内。
本机实验可用网络层限制（`-p 127.0.0.1:3000:3000`）替代，不实现 JWT / API Key 系统。

---

## 13. Lessons Learned

- **边界分离**：Public API 不变，HTTP 只翻译；Runtime 生命周期与 transport 错误是两维。
- **package 可交付 ≠ 已发布**：本地 tarball + 独立 Consumer 已足够证明可交付性。
- **容器网络**：`localhost` 在容器内指向容器自身，跨进程调宿主机服务必须用 `host.docker.internal`。
- **确定性后端价值**：`ScriptedModel` 让 Package / HTTP / Docker 三层均能离线跑通，不依赖真实 LLM。
- **不要过度工程**：无 Web 框架、无 Manager 类、无 Auth，仍完成完整交付链。

---

## 14. Architecture Decisions

- AD-1：HTTP 用 Node 原生 `http`（不引入 Express/Fastify）。
- AD-2：`RunResult` 直接作为 HTTP 响应体（不另造 wire DTO）。
- AD-3：错误双维度分离（HTTP status vs RunResult.status）。
- AD-4：`ScriptedModel` 打包进 `dist` 作为可选测试后端（经 `RuntimeOptions.model/streamFn` 注入）。
- AD-5：`package.json` 保持 `private: true`（可 `npm pack`，不 `npm publish`）。

---

## 15. Limitations

- 单 Runtime 实例、无并发 Session 管理（属后续 Runtime 主线，非 Delivery）。
- 无 Auth / 限流 / TLS（本机实验由网络层兜底）。
- 未发布到公共 registry（仅本地 tarball 验证）。
- 仅 `/v1` 一个版本（versioning 仅做概念验证）。

---

## 16. STOP Condition

全部满足 → **STOP Product Delivery Track**，回到 Runtime 主线（Phase 28 — Sandbox Execution）：

1. ✅ Package 可被独立 Consumer 安装并 import Public API → RunResult。
2. ✅ HTTP `/health` + `/v1/runs` 工作。
3. ✅ HTTP 错误映射正确（400/404/500 与 RunResult.status 分离）。
4. ✅ Docker 镜像可构建并运行（含 health）。
5. ✅ Remote Business Client 经 HTTP 调用成功（脚本化 + 真实 LLM 均验证）。
6. ✅ 未引入 Manager / SDK framework / Auth / SaaS。

不继续：Auth / SaaS / Multi-tenant / Billing / Kubernetes / API Gateway / SDK framework。
