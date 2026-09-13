/**
 * Phase 34-B 崩溃子进程（非生产代码）。
 *
 * 用真实 EnterpriseAiRuntime + 真实 FileRecoveryStore + 真实 FileAuditSink + 真实 ExternalResource，
 * 驱动一次 commit_record Tool Call，按 P34_MODE 在指定位置调用 process.exit(137) 模拟进程死亡：
 *  - commit-exit   ：提交外部副作用后崩溃（External 已 COMMIT，result 丢失）
 *  - precommit-exit：提交前崩溃（External 未提交）
 *  - start-exit    ：Tool 尚未执行（stream 发事件前）崩溃（无 checkpoint、无副作用）
 *  - none          ：正常完成（仅用于对照）
 *
 * 父进程（acceptance）随后以同一 dir 重建 Runtime 并 recoverIfUnfinished。
 */
import path from "node:path";
import { EnterpriseAiRuntime, FileRecoveryStore, FileAuditSink } from "../src/index.js";
import { ScriptedModel, ExternalResource, makeCommitTool, type CrashMode } from "./_p20_fixtures.js";

const dir = process.env.P34_DIR!;
const sessionId = process.env.P34_SESSION!;
const key = process.env.P34_KEY!;
const mode = (process.env.P34_MODE as CrashMode) ?? "none";

const store = new FileRecoveryStore(dir);
const audit = new FileAuditSink(path.join(dir, "audit.jsonl"));
const ext = new ExternalResource(path.join(dir, "external.json"));
const model = new ScriptedModel();
if (mode === "start-exit") model.crashBeforeTool = true;
model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
model.enqueueFinal("done");

const runtime = new EnterpriseAiRuntime({
  sessionId,
  store,
  audit,
  model: model.model,
  streamFn: model.streamFn,
  tools: [makeCommitTool(ext, mode)],
});

await runtime.run(`commit ${key}`);
// 若未因 process.exit 终止而到达此处，视为异常（崩溃未触发）。
process.exit(0);
