/**
 * Phase 27-C — HTTP Acceptance（Layer 2，确定性，不依赖真实 LLM）。
 *
 * 通过启动一个 RUNTIME_BACKEND=scripted 的 HTTP Service 子进程，验证：
 *   A. GET /health                                   → 200 { status: "ok" }
 *   B. POST /v1/runs { prompt }                      → 200 RunResult（status=completed）
 *   C. POST /v1/runs { } （缺 prompt）               → 400 invalid_request
 *   D. POST /v1/runs 非 JSON body                     → 400 invalid_request
 *   E. GET /unknown                                  → 404 not_found
 *
 * 不依赖 Qwen / Ollama；用 ScriptedModel 离线跑通完整调用链。
 * 前置：dist 已构建（本脚本直接 spawn tsx 运行 src/server.ts，无需先 build）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function startServer(): ChildProcess {
  return spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
    {
      cwd: root,
      env: { ...process.env, RUNTIME_BACKEND: "scripted", PORT: String(PORT), HOST: "127.0.0.1" },
      stdio: "ignore",
    },
  );
}

async function waitHealth(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

async function main(): Promise<void> {
  const child = startServer();
  try {
    await waitHealth();

    console.log("Case A — GET /health");
    const h = await fetch(`${BASE}/health`);
    assert(h.status === 200, "health returns 200");
    const hb = (await h.json()) as { status?: string };
    assert(hb.status === "ok", "health body status === 'ok'");

    console.log("Case B — POST /v1/runs (normal)");
    const r = await fetch(`${BASE}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Find customer Alice" }),
    });
    assert(r.status === 200, "run returns 200");
    const rb = (await r.json()) as {
      status?: string;
      answer?: string;
      sessionId?: string;
      runId?: string;
    };
    assert(rb.status === "completed", `RunResult.status === 'completed' (got ${rb.status})`);
    assert(typeof rb.answer === "string" && rb.answer.length > 0, "RunResult.answer present");
    assert(typeof rb.sessionId === "string" && rb.sessionId.length > 0, "RunResult.sessionId present");
    assert(typeof rb.runId === "string" && rb.runId.length > 0, "RunResult.runId present");

    console.log("Case C — POST /v1/runs (missing prompt) → 400");
    const bad = await fetch(`${BASE}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(bad.status === 400, "missing prompt returns 400");

    console.log("Case D — POST /v1/runs (invalid JSON) → 400");
    const badJson = await fetch(`${BASE}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert(badJson.status === 400, "non-JSON body returns 400");

    console.log("Case E — GET /unknown → 404");
    const nf = await fetch(`${BASE}/unknown`);
    assert(nf.status === 404, "unknown route returns 404");
  } finally {
    child.kill("SIGTERM");
  }

  if (failures > 0) {
    console.error(`\nPHASE 27-C HTTP ACCEPTANCE: FAIL (${failures} assertion(s) failed)`);
    process.exit(1);
  }
  console.log("\nPHASE 27-C HTTP ACCEPTANCE: PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nPHASE 27-C HTTP ACCEPTANCE: FAIL");
  console.error(err);
  process.exit(1);
});
