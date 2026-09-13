/**
 * Phase 30 — Skill Capability Boundary Acceptance（离线，确定性）。
 *
 * 中央架构命题：Skill 是「能力声明 / 激活 Profile」，不是「权限容器 / 授权机制」。
 *
 *   Skill
 *     ├── identity
 *     ├── optional instructions
 *     └── declared tool capabilities (toolNames)
 *
 * 关键不变量：
 *   - Skill 决定「哪些 Tool 对 Pi 可见」（可见性）；
 *   - Policy 仍对每次 Tool Call 独立裁决（授权）。
 *   - Skill 声明了某 Tool ≠ 该 Tool Call 被自动 ALLOW。
 *
 * Cases：
 *   A   Skill 激活 get_customer          → 该 Tool 可见
 *   B   Skill 未声明 restricted_tool      → 该 Tool 不可见（effective set 不含）
 *   C   Skill 声明 get_customer + Policy ALLOW   → Tool.execute 调用 (counter=1)
 *   D   Skill 声明 get_customer + Policy DENY    → Tool.execute 不调用 (counter=0)
 *   E   同 Skill / 同 Tool / 不同 Policy → ALLOW 执行、DENY 不执行（最重要证据）
 *   F   Skill instructions 被激活进入 system prompt（无 PromptManager）
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  EnterpriseAiRuntime,
  ScriptedModel,
  type Policy,
  type PolicyContext,
  type Skill,
} from "../src/index.js";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
  }
}

/** 计数 Tool：execute 被调用时 counter++。用于证明 DENY 是否阻止执行。 */
function makeCounterTool(name: string, counter: { n: number }): AgentTool<any> {
  return {
    name,
    label: name,
    description: `Counting test tool: ${name}`,
    parameters: Type.Object({}),
    execute: async () => {
      counter.n += 1;
      return { content: [{ type: "text", text: `executed ${name}` }], details: { n: counter.n } };
    },
  };
}

async function main(): Promise<void> {
  let lastReceived: PolicyContext | undefined;

  // 同一 Policy 实例，mode 在运行前切换，以证明 Skill 声明不影响授权结果。
  let mode: "allow" | "deny" = "allow";
  const policy: Policy = (ctx) => {
    lastReceived = ctx;
    if (ctx.toolName === "get_customer") {
      return mode === "allow"
        ? { type: "allow" }
        : { type: "deny", reason: `policy denies ${ctx.toolName}` };
    }
    return { type: "allow" };
  };

  const supportSkill: Skill = {
    id: "customer-support",
    name: "Customer Support",
    instructions: "You are a customer support agent. Use get_customer to look up customers.",
    toolNames: ["get_customer"],
  };

  const allTools: AgentTool<any>[] = (() => {
    const cs = { n: 0 };
    const rt = { n: 0 };
    return [makeCounterTool("get_customer", cs), makeCounterTool("restricted_tool", rt)];
  })();

  // ---- Case A: Skill 激活 get_customer → 该 Tool 可见 ----
  console.log("Case A: Skill activates declared Tool (get_customer visible)");
  {
    const runtime = new EnterpriseAiRuntime({ tools: allTools, policy, skill: supportSkill });
    const effective = runtime.listEffectiveTools();
    check("get_customer is in effective Tool set", effective.includes("get_customer"), effective);
    check("activeSkill.id == customer-support", runtime.activeSkill()?.id === "customer-support", runtime.activeSkill());
  }

  // ---- Case B: Skill 未声明 restricted_tool → 不可见 ----
  console.log("Case B: Skill does not activate undeclared Tool (restricted_tool not visible)");
  {
    const runtime = new EnterpriseAiRuntime({ tools: allTools, policy, skill: supportSkill });
    const effective = runtime.listEffectiveTools();
    check("restricted_tool is NOT in effective Tool set", !effective.includes("restricted_tool"), effective);
    check("effective set == exactly the declared tool", effective.length === 1 && effective[0] === "get_customer", effective);
  }

  // ---- Case F: Skill instructions 进入 system prompt（无 PromptManager） ----
  console.log("Case F: Skill instructions activate into system prompt");
  {
    const runtime = new EnterpriseAiRuntime({ tools: allTools, policy, skill: supportSkill });
    const prompt = runtime.effectiveSystemPrompt();
    check("base prompt present", prompt.includes("helpful enterprise assistant"), prompt);
    check("skill instructions appended", prompt.includes("customer support agent"), prompt);
    const noSkill = new EnterpriseAiRuntime({ tools: allTools, policy });
    check("no-skill prompt == base only", !noSkill.effectiveSystemPrompt().includes("customer support agent"), noSkill.effectiveSystemPrompt());
  }

  // ---- Case C: declared Tool + Policy ALLOW → execute (counter=1) ----
  console.log("Case C: declared Tool + Policy ALLOW → Tool.execute called");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("get_customer", {});
    m.enqueueFinal("done C");
    mode = "allow";
    const runtime = new EnterpriseAiRuntime({
      tools: allTools.map((t) => (t.name === "get_customer" ? makeCounterTool("get_customer", counter) : t)),
      policy,
      skill: supportSkill,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task C", { workspace: { workspaceId: "ws" } });
    check("RunResult completed", result.status === "completed", result.status);
    check("Tool.execute called (counter=1)", counter.n === 1, counter.n);
    check("Policy received toolName=get_customer", lastReceived?.toolName === "get_customer", lastReceived?.toolName);
  }

  // ---- Case D: declared Tool + Policy DENY → NOT executed (counter=0) ----
  console.log("Case D: declared Tool + Policy DENY → Tool.execute NOT called");
  {
    const counter = { n: 0 };
    const m = new ScriptedModel();
    m.enqueueTool("get_customer", {});
    m.enqueueFinal("done D");
    mode = "deny";
    const runtime = new EnterpriseAiRuntime({
      tools: allTools.map((t) => (t.name === "get_customer" ? makeCounterTool("get_customer", counter) : t)),
      policy,
      skill: supportSkill,
      model: m.model,
      streamFn: m.streamFn,
    });
    const result = await runtime.run("task D", { workspace: { workspaceId: "ws" } });
    check("RunResult still completed (deny ≠ run failure)", result.status === "completed", result.status);
    check("Tool.execute NOT called (counter=0)", counter.n === 0, counter.n);
    check("Policy received DENY request for get_customer", lastReceived?.toolName === "get_customer", lastReceived?.toolName);
  }

  // ---- Case E: same Skill, same Tool, different Policy decision ----
  console.log("Case E: same Skill + same Tool + different Policy → allow executes / deny blocks");
  {
    const counter = { n: 0 };
    // 两次构造独立 counter，使用同一 Skill 声明。
    const makeRuntime = (setMode: "allow" | "deny") => {
      const m = new ScriptedModel();
      m.enqueueTool("get_customer", {});
      m.enqueueFinal(`done E ${setMode}`);
      mode = setMode;
      return new EnterpriseAiRuntime({
        tools: [makeCounterTool("get_customer", counter)], // 共享 counter 以对比
        policy,
        skill: supportSkill,
        model: m.model,
        streamFn: m.streamFn,
      });
    };
    await makeRuntime("allow").run("task E-allow", { workspace: { workspaceId: "ws" } });
    check("ALLOW → Tool.execute called (counter=1)", counter.n === 1, counter.n);
    await makeRuntime("deny").run("task E-deny", { workspace: { workspaceId: "ws" } });
    check("DENY → Tool.execute NOT called again (counter still 1)", counter.n === 1, counter.n);
    check("Skill identical across both runs", makeRuntime("allow").activeSkill()?.id === "customer-support");
  }

  // ---- Skill contains no secrets / no authorization fields ----
  console.log("Case G: Skill is capability-only (no secret / permission / credential / policy fields)");
  {
    const keys = Object.keys(supportSkill).sort();
    const forbidden = ["credential", "secret", "permission", "policy", "authorize", "token", "password", "role"];
    check("Skill keys are only id/name/instructions/toolNames", keys.every((k) => ["id", "name", "instructions", "toolNames"].includes(k)), keys);
    check("Skill has no secret/permission fields", forbidden.every((k) => !(k in supportSkill)), supportSkill);
  }

  // ---- Case H: no Skill → all registered Tools visible (backward compatible) ----
  console.log("Case H: no Skill → all registered Tools visible (backward compatible)");
  {
    const runtime = new EnterpriseAiRuntime({ tools: allTools, policy });
    const effective = runtime.listEffectiveTools();
    check("no-skill effective set == all registered", effective.length === 2 && effective.includes("restricted_tool"), effective);
  }

  console.log(`\nPHASE 30 ACCEPTANCE: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("PHASE 30 ACCEPTANCE: FAILED (uncaught)");
  console.error(err);
  process.exit(1);
});
