/**
 * Phase 25 — Deterministic Skill Workflow Slice (experiment harness, NOT production code).
 *
 * Wires the REAL equity-research-skill scripts as Enterprise Tools and drives the Pi Agent loop
 * with a deterministic ScriptedModel (no real LLM, no network, no financial data).
 *
 * Pipeline verified:
 *   Skill instructions → EnterpriseAiRuntime / Pi Agent
 *     → Tool A: scripts/dcf.py  → Artifact (valuation text)
 *     → Tool B: scripts/check_research_output.py → Validation Result
 *     → Agent continues (scripted decision)
 *
 * No modification to src/ runtime, Pi, or the skill. CODE CHANGED applies only to this experiment file + fixtures.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { EnterpriseAiRuntime } from "../src/index.js";
import { ScriptedModel } from "./_p20_fixtures.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const execFileP = promisify(execFile);
const SKILL = "/Users/jun/workspace/equity-research-skill/scripts";
const FIX = "/Users/jun/workspace/enterprise-ai-lab/experiments/phase25/fixtures";

async function runPy(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP("python3", args, { maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

/** Tool A — runs the real deterministic DCF script; captures stdout as an Artifact file. */
function makeDcfTool(): AgentTool<any, any> {
  return {
    name: "run_dcf",
    label: "Run DCF Valuation",
    description: "Run scripts/dcf.py with an assumptions JSON; returns deterministic valuation text.",
    parameters: Type.Object({ configPath: Type.String() }),
    replay: "safe",
    execute: async (_id: string, params: { configPath: string }) => {
      const r = await runPy([path.join(SKILL, "dcf.py"), "--config", params.configPath]);
      const artifact = path.join(path.dirname(params.configPath), "valuation_output.txt");
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, r.stdout, "utf8");
      return {
        content: [{ type: "text", text: r.stdout }],
        details: { artifact, exitCode: r.code },
      };
    },
  } as AgentTool<any, any>;
}

/** Tool B — runs the real deterministic checker; returns issues + exit code. */
function makeCheckerTool(): AgentTool<any, any> {
  return {
    name: "run_checker",
    label: "Run Research Output Checker",
    description:
      "Run scripts/check_research_output.py on assumptions/report/financials; P0/P1 => FAIL (exit 1).",
    parameters: Type.Object({
      assumptionsPath: Type.String(),
      reportPath: Type.String(),
      financialsPath: Type.String(),
      industry: Type.String(),
      language: Type.String(),
    }),
    replay: "safe",
    execute: async (
      _id: string,
      p: { assumptionsPath: string; reportPath: string; financialsPath: string; industry: string; language: string },
    ) => {
      const r = await runPy([
        path.join(SKILL, "check_research_output.py"),
        "--assumptions", p.assumptionsPath,
        "--report", p.reportPath,
        "--financials", p.financialsPath,
        "--industry", p.industry,
        "--language", p.language,
      ]);
      const pass = r.code === 0;
      return {
        content: [{ type: "text", text: r.stdout || r.stderr }],
        details: { exitCode: r.code, pass },
      };
    },
  } as AgentTool<any, any>;
}

const A = path.join(FIX, "assumptions.json");
const F = path.join(FIX, "financials.csv");
const R_PASS = path.join(FIX, "report_pass.md");
const R_FAIL = path.join(FIX, "report_fail.md");

async function runCase(name: string, enqueue: (m: ScriptedModel) => void): Promise<void> {
  const model = new ScriptedModel();
  enqueue(model);
  const runtime = new EnterpriseAiRuntime({
    sessionId: `phase25-${name}`,
    model: model.model,
    streamFn: model.streamFn,
    tools: [makeDcfTool(), makeCheckerTool()],
  });
  console.log(`\n================ CASE ${name} ================`);
  console.log("listTools:", runtime.listTools().join(", "));
  await runtime.run("Research slice: run DCF then validate the research output.");
  await runtime.waitForIdle();

  const trace = runtime.lastTrace();
  const events = (trace?.events ?? []).map((e: any) => e.type);
  console.log("Trace event types:", JSON.stringify(events));
  for (const ev of trace?.events ?? []) {
    if (ev.type === "tool_execution_start" || ev.type === "tool_execution_end") {
      console.log(`  [${ev.type}] ${JSON.stringify(ev).slice(0, 320)}`);
    }
  }
  const llm = trace?.llmCalls ?? [];
  console.log(`LLM calls captured: ${llm.length} (model=${llm[0]?.model ?? "n/a"})`);
  console.log(`Final assistant text: ${(trace?.finalAnswer ?? "").slice(0, 200)}`);
}

async function main() {
  // Case A — PASS
  await runCase("A-PASS", (m) => {
    m.enqueueTool({ name: "run_dcf", arguments: { configPath: A } });
    m.enqueueTool({
      name: "run_checker",
      arguments: { assumptionsPath: A, reportPath: R_PASS, financialsPath: F, industry: "saas", language: "zh" },
    });
    m.enqueueFinal("DCF valuation produced; checker PASS; skill slice complete.");
  });

  // Case B — FAIL → REVISION → PASS
  await runCase("B-FAIL-PASS", (m) => {
    m.enqueueTool({ name: "run_dcf", arguments: { configPath: A } });
    m.enqueueTool({
      name: "run_checker",
      arguments: { assumptionsPath: A, reportPath: R_FAIL, financialsPath: F, industry: "saas", language: "zh" },
    });
    // Agent-continuation: the validation result (P1) drives a revision; re-run checker on the fixed report.
    m.enqueueTool({
      name: "run_checker",
      arguments: { assumptionsPath: A, reportPath: R_PASS, financialsPath: F, industry: "saas", language: "zh" },
    });
    m.enqueueFinal("Checker FAIL on missing source section; revised report PASS; skill slice complete.");
  });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
