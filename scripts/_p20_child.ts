/**
 * Phase 20-1 崩溃子进程（非生产代码）。
 *
 * 用真实 EnterpriseAiRuntime + 真实 FileRecoveryStore + 真实 ExternalResource，驱动一次 Tool Call，
 * 在 External 提交（或提交前）调用 process.exit(137) 模拟进程死亡。
 * 父进程（acceptance）随后以同一 dir 重建 Runtime 并 recover。
 */
import path from "node:path";
import { EnterpriseAiRuntime } from "../src/index.js";
import { FileRecoveryStore } from "../src/recovery/file-store.js";
import { ScriptedModel, ExternalResource, makeCommitTool, type CrashMode } from "./_p20_fixtures.js";

const dir = process.env.P20_DIR!;
const sessionId = process.env.P20_SESSION!;
const key = process.env.P20_KEY!;
const mode = (process.env.P20_MODE as CrashMode) ?? "commit-exit";

const store = new FileRecoveryStore(dir);
const resource = new ExternalResource(path.join(dir, "external.json"));
const model = new ScriptedModel();
model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
model.enqueueFinal("done");

const runtime = new EnterpriseAiRuntime({
  sessionId,
  store,
  model: model.model,
  streamFn: model.streamFn,
  tools: [makeCommitTool(resource, mode)],
});

await runtime.run(`commit ${key}`);
// 若未因 process.exit 终止而到达此处，视为异常（崩溃未触发）。
process.exit(0);
