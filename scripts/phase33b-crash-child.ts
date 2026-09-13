/**
 * Phase 33-B Crash Child — 由 acceptance 通过 `tsx` 派生执行。
 * 仅负责：构造 Runtime → 跑一次 Run（审计同步落盘）→ process.exit。
 * 父进程随后读取同一 audit 文件，证明「进程死亡 ≠ 审计丢失」。
 */
import { EnterpriseAiRuntime } from "../src/index.js";
import { ScriptedModel } from "../src/scripted-model.js";
import { getCustomer } from "../src/tools/get-customer.js";
import { FileAuditSink } from "../src/audit/file-sink.js";

async function main(): Promise<void> {
  const [auditPath] = process.argv.slice(2);
  const m = new ScriptedModel();
  const runtime = new EnterpriseAiRuntime({
    model: m.model,
    streamFn: m.streamFn,
    tools: [getCustomer],
    audit: new FileAuditSink(auditPath),
  });
  m.enqueueTool("get_customer", { name: "Alice" });
  m.enqueueFinal("ok");
  await runtime.run("hi", { identity: { userId: "u1" }, workspace: { workspaceId: "w1" } });
  // 审计事件已由 appendFileSync 同步落盘；此处模拟进程在 Run 后退出（崩溃/重启场景）。
  process.exit(0);
}

void main();
