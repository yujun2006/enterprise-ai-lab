/**
 * Phase 35-B 崩溃子进程（非生产代码）。
 *
 * 与 phase34b 结构一致：用真实 EnterpriseAiRuntime + 真实 FileRecoveryStore + 真实 FileAuditSink
 * + 真实 ExternalResource，但 Tool 是「外部 MCP-style Server」的 Thin Adapter（而非进程内 commit）。
 *
 * 崩溃由 Server 触发（P35_CRASH=before|after → process.exit(137)），
 * 适配器在传输失败时 dieOnTransport=true（模拟 Runtime 宿主在 Tool 执行中途崩溃），
 * 于是 Recovery Record 停留在 running（未标记 recovered），父进程可重建并 recoverIfUnfinished。
 *
 * 关键：Runtime / Policy / Audit / Recovery / Run 全部在 Runtime 进程内，Server 只是 Tool Endpoint。
 */
import path from "node:path";
import { EnterpriseAiRuntime, FileRecoveryStore, FileAuditSink } from "../src/index.js";
import { ScriptedModel, ExternalResource } from "./_p20_fixtures.js";
import { makeMcpCommitTool } from "./_p35_mcp_fixtures.js";

const dir = process.env.P35_DIR!;
const sessionId = process.env.P35_SESSION!;
const key = process.env.P35_KEY!;
const crash = process.env.P35_CRASH ?? "none";
const bad = process.env.P35_BAD === "1";

const extFile = path.join(dir, "external.json");
const callsLog = path.join(dir, "calls.log");
const envLog = path.join(dir, "env.log");

const store = new FileRecoveryStore(dir);
const audit = new FileAuditSink(path.join(dir, "audit.jsonl"));
const ext = new ExternalResource(extFile);

const model = new ScriptedModel();
model.enqueueTool({ name: "create_customer", arguments: { idempotencyKey: key } });
model.enqueueFinal("done");

const runtime = new EnterpriseAiRuntime({
  sessionId,
  store,
  audit,
  model: model.model,
  streamFn: model.streamFn,
  tools: [
    makeMcpCommitTool({
      serverEntry: path.resolve("scripts/_p35_mcp_server.ts"),
      extFile,
      callsLog,
      envLog,
      sink: () => runtime.executionTraceSink(),
      extraEnv: { P35_CRASH: crash, P35_BAD: bad ? "1" : "0" },
      dieOnTransport: true,
    }),
  ],
});

await runtime.run(`create ${key}`);
// 若未因 Server 崩溃 + dieOnTransport 而终止，视为异常（崩溃未触发）。
process.exit(0);
