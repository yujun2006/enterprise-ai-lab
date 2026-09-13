/**
 * Phase 27-C — Remote Business Client（非生产代码）。
 *
 * 与 Phase 27-B 的根本区别：
 *   Phase 27-B  Business Client → TypeScript Public API → Runtime（同进程 / 同库）
 *   Phase 27-C  Business Client → HTTP → Remote Runtime Service（跨进程 / 跨机器）
 *
 * 本 Client **不 import EnterpriseAiRuntime**，它只知道一个 HTTP endpoint。
 * 它只做四件事：
 *   1. 拼一个 prompt
 *   2. POST /v1/runs（JSON）
 *   3. 拿到 HTTP 响应（RunResult 序列化体）
 *   4. 读取 status / answer / sessionId / runId
 */
const BASE = (process.env.RUNTIME_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const prompt = process.argv[2] ?? "Find customer Alice";

async function main(): Promise<void> {
  console.log(`POST ${BASE}/v1/runs`);
  console.log(`prompt: ${prompt}\n`);

  const res = await fetch(`${BASE}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  const body = (await res.json()) as unknown;
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));

  if (!res.ok) process.exit(1);
  console.log("\nREMOTE BUSINESS CLIENT OK");
}

main().catch((err) => {
  console.error("REMOTE BUSINESS CLIENT FAILED");
  console.error(err);
  process.exit(1);
});
