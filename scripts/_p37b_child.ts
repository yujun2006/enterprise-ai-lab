/**
 * Phase 37-B 崩溃子进程（非生产代码）。
 *
 * 用真实 EnterpriseAiRuntime + 真实 FileRecoveryStore + 真实 FileAuditSink + 真实 ExternalResource，
 * 驱动一次 ASK-gated commit_record Tool Call，按 env 在指定位置调用 process.exit(137) 模拟进程死亡：
 *  - P37_POLICY=ask   ：commit_record 走 Policy ASK（await 人工）
 *  - P37_APPROVE=resolve：人工批准（approval() 解析 allow）
 *  - P37_APPROVE=never ：人工永不决议（approval() 永不 resolve）→ 用于「crash while pending」
 *  - P37_TOOL=none/precommit-exit/commit-exit：Tool 内部崩溃模式（见 _p20_fixtures.makeCommitTool）
 *  - P37_EXIT=137     ：await 期间强制 process.exit(137)（模拟「pending 时崩溃」）
 *
 * 父进程（phase37b-acceptance）随后以同一 dir 重建 Runtime 并 recoverIfUnfinished / applyDecision。
 */
import path from "node:path";
import { EnterpriseAiRuntime, FileRecoveryStore, FileAuditSink } from "../src/index.js";
import type { Policy, PolicyOutcome } from "../src/index.js";
import { ScriptedModel, ExternalResource, makeCommitTool, type CrashMode } from "./_p20_fixtures.js";

const dir = process.env.P37_DIR!;
const sessionId = process.env.P37_SESSION!;
const key = process.env.P37_KEY!;
const policyMode = process.env.P37_POLICY ?? "ask";
const approveMode = process.env.P37_APPROVE ?? "resolve";
const toolMode = (process.env.P37_TOOL as CrashMode) ?? "none";
const forceExit = process.env.P37_EXIT === "137";

const store = new FileRecoveryStore(dir);
const audit = new FileAuditSink(path.join(dir, "audit.jsonl"));
const ext = new ExternalResource(path.join(dir, "external.json"));
const model = new ScriptedModel();
model.enqueueTool({ name: "commit_record", arguments: { idempotencyKey: key } });
model.enqueueFinal("done");

const policy: Policy = (ctx) => {
  if (ctx.toolName === "commit_record") {
    if (policyMode === "ask") {
      return {
        type: "ask",
        approval: () =>
          approveMode === "never" ? new Promise<PolicyOutcome>(() => {}) : Promise.resolve("allow"),
      };
    }
    return { type: "allow" };
  }
  return { type: "allow" };
};

const runtime = new EnterpriseAiRuntime({
  sessionId,
  store,
  audit,
  policy,
  model: model.model,
  streamFn: model.streamFn,
  tools: [makeCommitTool(ext, toolMode)],
});

if (forceExit) {
  // 注意：await 人工期间事件循环没有其它 ref handle，若 .unref() 进程会立刻退出 0。
  // 这里用 ref timer，确保 durable pending 落盘后（~ms）再模拟进程死亡。
  setTimeout(() => process.exit(137), 400);
}

await runtime.run(`commit ${key}`);
process.exit(0);
