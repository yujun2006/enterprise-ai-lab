/**
 * Phase 27-C — Package Consumer（纯 ESM，运行需 node，不依赖 tsx）。
 *
 * 证明：
 *   Consumer
 *     ↓
 *   npm install <local-tarball>   (enterprise-ai-runtime)
 *     ↓
 *   import { EnterpriseAiRuntime, ScriptedModel, getCustomer } from "enterprise-ai-runtime"
 *     ↓
 *   runtime.run(task) → RunResult
 *
 * 注意：本文件只依赖「打包后的 Public API」，不 import 任何 src/ 或 scripts/ 路径。
 */
import { EnterpriseAiRuntime, ScriptedModel, getCustomer } from "enterprise-ai-runtime";

const model = new ScriptedModel();
model.enqueueTool("get_customer", { name: "Alice" });
model.enqueueFinal("Found Alice (Acme, Enterprise plan) via packaged runtime.");

const runtime = new EnterpriseAiRuntime({
  tools: [getCustomer],
  model: model.model,
  streamFn: model.streamFn,
});

const result = await runtime.run("Find customer Alice");
console.log(JSON.stringify(result, null, 2));

if (result.status !== "completed") {
  console.error("PACKAGE CONSUMER: FAILED (status !== completed)");
  process.exit(1);
}
console.log("\nPACKAGE CONSUMER OK");
