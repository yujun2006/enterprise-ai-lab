/**
 * Phase 35-B MCP-style Server（实验 Boundary，非生产代码）。
 *
 * 仅实现本实验所需的最小 stdio JSON-line 协议：
 *   stdin  ← { method:"tools/call", name, arguments:{idempotencyKey}, meta:{runId,sessionId,resource,credentialRef} }
 *   stdout → { method:"tools/call", ok:true, name, committed, operationId }
 *
 * 它只是「Tool Execution Endpoint」：
 *   - 持有 ExternalResource（文件型外部副作用真相源，复用 _p20_fixtures）
 *   - 不持有 Run / Policy / Audit / Recovery / Session
 *   - 不创建第二套 Runtime Context
 *
 * 崩溃模式（模拟外部 Tool 在 commit 前后崩溃）：
 *   P35_CRASH=before  → 收到 call 后、commit 前 process.exit(137)
 *   P35_CRASH=after   → commit 成功后 process.exit(137)（result 丢失）
 *   P35_BAD=1         → 返回坏 JSON（MALFORMED）
 *
 * 安全约束：
 *   - 启动时把 process.env 的 key 快照写入 envLog，证明没有 secret env 泄漏进 Server。
 *   - 适配器只把 P35_* 显式传入，绝不继承完整 Runtime env。
 */
import { promises as fs } from "node:fs";
import { ExternalResource } from "./_p20_fixtures.js";

const extFile = process.env.P35_EXT!;
const callsLog = process.env.P35_CALLS_LOG!;
const envLog = process.env.P35_ENV_LOG!;
const crash = (process.env.P35_CRASH as "none" | "before" | "after") ?? "none";
const bad = process.env.P35_BAD === "1";

const ext = new ExternalResource(extFile);

// 启动即快照 env keys（S3 证据：Server env 不含任何 secret key）。
await fs.writeFile(envLog, JSON.stringify(Object.keys(process.env)));

async function handleCall(msg: { name: string; arguments?: Record<string, unknown>; meta?: unknown }): Promise<void> {
  const name = msg.name;
  const args = (msg.arguments ?? {}) as Record<string, unknown>;
  const meta = msg.meta ?? null;
  // 记录 Server 实际收到的 call（含 meta，供 S1 / S2 / S4 验证）。
  await fs.appendFile(callsLog, JSON.stringify({ name, args, meta, at: Date.now() }) + "\n");
  if (crash === "before") process.exit(137);
  const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
  if (!key) {
    process.stdout.write(JSON.stringify({ method: "tools/call", ok: false, error: "missing idempotencyKey" }) + "\n");
    return;
  }
  const r = await ext.commit(key);
  if (crash === "after") process.exit(137);
  if (bad) {
    process.stdout.write("NOT_JSON_RESPONSE\n");
    return;
  }
  process.stdout.write(
    JSON.stringify({ method: "tools/call", ok: true, name, committed: r.committed, operationId: key }) + "\n",
  );
}

process.stdin.on("data", (chunk) => {
  const text = chunk.toString();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let msg: { method: string; name?: string; arguments?: Record<string, unknown>; meta?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ method: "initialize", ok: true }) + "\n");
      continue;
    }
    if (msg.method === "tools/call") {
      handleCall(msg).catch(() => process.exit(137));
    }
  }
});
