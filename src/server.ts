/**
 * EnterpriseAiRuntime HTTP Service（Phase 27-C — Product Delivery / Transport Boundary）。
 *
 * 角色：HTTP 只是一个 **Transport Boundary**，不是 Runtime Boundary。
 *  - 负责：HTTP method / URL / JSON 解析 / status code / 请求校验 / 序列化 / transport error。
 *  - 不负责：Agent 执行 / Tool / Policy / Trace / Recovery / Run 生命周期（那些归 EnterpriseAiRuntime）。
 *
 * 不引入 Web 框架：使用 Node.js 原生 http。
 *
 * 端点：
 *   GET  /health        → { "status": "ok" }
 *   POST /v1/runs       → { prompt } → RunResult（按 Public Contract 直接序列化）
 *
 * 错误映射（两个维度，互不混淆）：
 *   - HTTP status = Transport / API 层结果
 *   - RunResult.status = Runtime Execution Outcome（completed|failed|aborted|unknown）
 *   因此 failed/aborted/unknown 仍返回 HTTP 200（它们是有意义的执行结果，不是 transport 错误）。
 *   只有「请求本身非法 / 路由不存在 / 服务意外崩溃」才返回 400 / 404 / 500。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { EnterpriseAiRuntime, getCustomer, ScriptedModel } from "./index.js";
import type { IdentityContext, RunContextInput, WorkspaceContext } from "./index.js";
import { FileRecoveryStore } from "./recovery/file-store.js";
import { FileAuditSink } from "./audit/file-sink.js";
import type { ReconcileFn } from "./recovery/types.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const BACKEND = (process.env.RUNTIME_BACKEND ?? "ollama").toLowerCase();

/** Phase 34-B — 进程级 Durable 上下文（单例）。未配置则行为与旧版一致（无耐久 / 无审计）。 */
const RECOVERY_DIR = process.env.RECOVERY_DIR;
const AUDIT_FILE = process.env.AUDIT_FILE;
const store = RECOVERY_DIR ? new FileRecoveryStore(RECOVERY_DIR) : undefined;
const audit = AUDIT_FILE ? new FileAuditSink(AUDIT_FILE) : undefined;
/**
 * Phase 34-B — HTTP 暴露的 get_customer 为 read-only，无外部副作用；崩溃未提交即视为已 reconcile。
 * state-changing Tool 必须提供 idempotencyKey + reconcile（见 Phase 34-B Tool contract）。
 */
const reconcile: ReconcileFn = () => "SUCCESS";

/** 每请求构造一个 Runtime（scripted 后端需要每请求重置确定性队列）。注入进程级 Durable 上下文 + sessionId。 */
function buildRuntime(sessionId?: string): EnterpriseAiRuntime {
  if (BACKEND === "scripted") {
    const m = new ScriptedModel();
    // 走完整 Tool → Policy → ToolResult → LLM 链（验证 HTTP 层不忘泄漏内部）。
    m.enqueueTool("get_customer", { name: "Alice" });
    m.enqueueFinal("Found Alice (Acme, Enterprise plan) via scripted backend.");
    return new EnterpriseAiRuntime({
      tools: [getCustomer],
      model: m.model,
      streamFn: m.streamFn,
      store,
      audit,
      sessionId,
    });
  }
  // 生产默认：Ollama（LLM_* 环境变量驱动，连接 pi-ai → Ollama/DeepSeek）。
  return new EnterpriseAiRuntime({ tools: [getCustomer], store, audit, sessionId });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (req.method === "POST" && path === "/v1/runs") {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: { code: "invalid_request", message: "Body is not valid JSON" } });
        return;
      }
      const prompt = (parsed as { prompt?: unknown }).prompt;
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        sendJson(res, 400, {
          error: { code: "invalid_request", message: "Field 'prompt' must be a non-empty string" },
        });
        return;
      }

      // Phase 29-B：HTTP 仅负责把 caller 提供的上下文转交给 Runtime（不做认证 / 信任判断）。
      const body = parsed as {
        prompt?: unknown;
        workspace?: WorkspaceContext;
        identity?: IdentityContext;
        sessionId?: string;
      };
      const context: RunContextInput | undefined =
        body.workspace || body.identity
          ? { workspace: body.workspace, identity: body.identity }
          : undefined;

      const sessionId =
        typeof body.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : randomUUID();
      const runtime = buildRuntime(sessionId);
      // Phase 34-B — 崩溃续跑：若本 session 有未完成 Recovery Record，先进入 Recovery 路径
      // （Reconstruct → Reconcile → Decide），再开始新 Run。Resume = 新 Run，不复活旧 loop。
      await runtime.recoverIfUnfinished(reconcile);
      const result = await runtime.run(prompt, context);
      // RunResult.status 是执行结果，不是 transport 错误 → 始终 HTTP 200。
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, {
      error: { code: "not_found", message: `No route for ${req.method} ${path}` },
    });
  } catch (e) {
    sendJson(res, 500, {
      error: { code: "service_error", message: (e as Error).message ?? "Unexpected error" },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EnterpriseAiRuntime HTTP service listening on ${HOST}:${PORT} (backend=${BACKEND})`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
