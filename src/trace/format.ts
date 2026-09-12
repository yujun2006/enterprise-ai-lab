import type { ExecutionTrace, LlmCallTrace, TraceEvent } from "./types.js";

function roleBreakdown(messages: unknown): string {
  if (!Array.isArray(messages)) return "?";
  const counts: Record<string, number> = {};
  for (const m of messages) {
    const r = (m as { role?: string })?.role ?? "?";
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([r, n]) => `${r}:${n}`)
    .join(" ");
}

function toolNames(request: Record<string, unknown>): string {
  const tools = request.tools;
  if (!Array.isArray(tools) || tools.length === 0) return "(none)";
  return tools
    .map((t) => (t as { function?: { name?: string }; name?: string })?.function?.name ?? (t as { name?: string })?.name ?? "?")
    .join(", ");
}

function toolResultSummary(ev: TraceEvent): string {
  const result = (ev.data as { result?: { details?: unknown } }).result;
  const details = result?.details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    const parts = [d.id, d.name, d.company, d.plan].filter((x) => x !== undefined).map(String);
    if (parts.length) return parts.join(" / ");
  }
  const text = JSON.stringify(result);
  return text.length > 120 ? text.slice(0, 120) + "…" : text;
}

/** 渲染一条人类可读的 Execution Trace（Agent Event + LLM Interaction 合并时间线）。 */
export function formatTrace(trace: ExecutionTrace): string {
  const lines: string[] = [];
  lines.push("=== EXECUTION TRACE ===");
  lines.push(`Run: ${trace.runId}`);
  lines.push(`Started: ${new Date(trace.startedAt).toISOString()}`);
  lines.push(`Ended:   ${trace.endedAt ? new Date(trace.endedAt).toISOString() : "(in progress)"}`);
  lines.push("");
  lines.push(`Prompt: ${trace.prompt}`);
  lines.push("");

  // 合并时间线：LLM calls + tool_execution 事件，按 sequence 排序
  type Item = { seq: number; render: () => void };
  const items: Item[] = [];

  trace.llmCalls.forEach((call: LlmCallTrace, i: number) => {
    items.push({
      seq: call.sequence,
      render: () => {
        const msgCount = Array.isArray(call.request.messages) ? call.request.messages.length : 0;
        lines.push(`LLM #${i + 1}`);
        lines.push(`  Model: ${call.model}`);
        lines.push(`  Request:`);
        lines.push(`    messages: ${msgCount}  [${roleBreakdown(call.request.messages)}]`);
        lines.push(`    tools: ${toolNames(call.request)}`);
        if (call.responseMetadata) {
          lines.push(`  HTTP: status=${call.responseMetadata.status ?? "?"}`);
        }
      },
    });
  });

  for (const ev of trace.events) {
    if (ev.type === "tool_execution_start") {
      items.push({
        seq: ev.sequence,
        render: () => {
          lines.push(`Tool Call: ${String(ev.data.toolName)}(${JSON.stringify(ev.data.args)})`);
        },
      });
    } else if (ev.type === "tool_execution_end") {
      items.push({
        seq: ev.sequence,
        render: () => {
          lines.push(`Tool Result: isError=${ev.data.isError}  ${toolResultSummary(ev)}`);
        },
      });
    } else if (ev.type === "policy_decision") {
      items.push({
        seq: ev.sequence,
        render: () => {
          const d = ev.data as { decision?: string; toolName?: string; args?: unknown; reason?: string };
          lines.push(`Policy: ${d.decision}  tool=${String(d.toolName)}(${JSON.stringify(d.args)})${d.reason ? "  reason=" + d.reason : ""}`);
        },
      });
    } else if (ev.type === "policy_resolved") {
      items.push({
        seq: ev.sequence,
        render: () => {
          const d = ev.data as { outcome?: string; toolName?: string; reason?: string };
          lines.push(`Policy Resolved: ${d.outcome}  tool=${String(d.toolName)}${d.reason ? "  (" + d.reason + ")" : ""}`);
        },
      });
    } else if (ev.type === "checkpoint_created") {
      items.push({
        seq: ev.sequence,
        render: () => {
          const d = ev.data as { sessionId?: string; runId?: string; idempotencyKey?: string; toolName?: string };
          lines.push(`Checkpoint: session=${String(d.sessionId)} run=${String(d.runId)} tool=${String(d.toolName)} idempotencyKey=${String(d.idempotencyKey)}`);
        },
      });
    } else if (ev.type === "recovery_started") {
      items.push({
        seq: ev.sequence,
        render: () => {
          const d = ev.data as { sessionId?: string; fromRun?: string };
          lines.push(`Recovery: started session=${String(d.sessionId)} fromRun=${String(d.fromRun)}`);
        },
      });
    } else if (ev.type === "reconciliation_result") {
      items.push({
        seq: ev.sequence,
        render: () => {
          const d = ev.data as { result?: string };
          lines.push(`Reconcile: ${String(d.result)}`);
        },
      });
    } else if (ev.type === "recovery_decision") {
      items.push({
        seq: ev.sequence,
        render: () => {
          const d = ev.data as { decision?: string };
          lines.push(`Recovery Decision: ${String(d.decision)}`);
        },
      });
    }
  }

  items.sort((a, b) => a.seq - b.seq);
  for (const it of items) it.render();

  lines.push("");
  lines.push("Final Answer:");
  lines.push(trace.finalAnswer);
  return lines.join("\n");
}
