import { EnterpriseAiRuntime } from "../src/runtime.js";

/**
 * Phase 1 真实 Ollama smoke test。
 * 要求：本地 Ollama 正在运行（默认 http://localhost:11434），且已拉取 qwen2.5:14b
 * （可用 OLLAMA_MODEL 环境变量覆盖）。
 *
 * 运行：npm run smoke  ["可选的自定义 prompt"]
 */
async function main(): Promise<void> {
  const runtime = new EnterpriseAiRuntime({
    systemPrompt:
      "You are a concise assistant. Always answer in one or two short sentences.",
  });

  runtime.onEvent((event) => {
    switch (event.type) {
      case "agent_start":
        console.log("\n=== agent_start ===");
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        break;
      case "tool_execution_start":
        console.log(`\n[tool] ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "turn_end":
        console.log("\n=== turn_end ===");
        break;
      case "agent_end":
        console.log("=== agent_end ===");
        break;
      case "message_start":
        console.log("\n[assistant]: ");
        break;
    }
  });

  const prompt = process.argv[2] ?? "用一句话介绍你自己。";
  console.log(`Model : ${runtime.model.id} @ ${runtime.model.baseUrl}`);
  console.log(`Prompt: ${prompt}\n`);

  await runtime.prompt(prompt);
  await runtime.waitForIdle();

  console.log("\n--- transcript (roles) ---");
  for (const m of runtime.transcript()) {
    console.log(`[${m.role}]`);
  }

  console.log("\nSMOKE TEST OK");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED");
  console.error(err);
  process.exit(1);
});
