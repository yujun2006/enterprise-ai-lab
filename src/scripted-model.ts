/**
 * ScriptedModel — 确定性 LLM 后端（实验/测试用，非生产 Provider）。
 *
 * 用途：
 *  - 让 Consumer / HTTP Service / Acceptance 在没有真实 LLM（Ollama / DeepSeek）的情况下，
 *    也能跑通「Runtime → Pi Agent → Tool → LLM → RunResult」完整调用链。
 *  - 通过 enqueue* 预设每一轮的响应（Tool Call / 最终文本 / 挂起），使 Run 完全可重复。
 *
 * 这是 EnterpriseAiRuntime 的一个 **可选测试后端**，通过 RuntimeOptions.model / streamFn 注入，
 * 不进入生产 Provider 抽象（生产仍走 pi-ai + Ollama）。
 *
 * 复刻自 scripts/phase27b-fixtures.ts 的 ScriptedModelV2，迁到 src 以便被打包进 package，
 * 供外部 Consumer / 离线 HTTP Acceptance 使用。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

type Turn =
  | { kind: "tool"; name: string; args: Record<string, unknown>; id?: string }
  | { kind: "final"; text: string; stopReason?: "completed" | "error" | "aborted" }
  | { kind: "hang" };

function assistant(content: unknown[], stopReason: string): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export class ScriptedModel {
  private turns: Turn[] = [];

  enqueueTool(name: string, args: Record<string, unknown>, id?: string): void {
    this.turns.push({ kind: "tool", name, args, id });
  }

  enqueueFinal(text: string, stopReason: "completed" | "error" | "aborted" = "completed"): void {
    this.turns.push({ kind: "final", text, stopReason });
  }

  /** 挂起：发出 start 后监听 AbortSignal，被中止时以 stopReason="aborted" 结束。 */
  enqueueHang(): void {
    this.turns.push({ kind: "hang" });
  }

  get model(): Model<any> {
    return {
      id: "fake",
      name: "Fake Model",
      api: "fake",
      provider: "fake",
      baseUrl: "http://fake.local",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
    } as Model<any>;
  }

  get streamFn(): StreamFn {
    const self = this;
    return ((_m: unknown, _c: unknown, opts: unknown) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      return self.makeStream(signal);
    }) as unknown as StreamFn;
  }

  private makeStream(signal?: AbortSignal): unknown {
    const turn = this.turns.shift();
    const events: Record<string, unknown>[] = [];
    let finalMessage: Record<string, unknown>;

    if (!turn || turn.kind === "final") {
      const text = turn ? turn.text : "OK";
      const sr = turn && turn.stopReason ? turn.stopReason : "completed";
      finalMessage = assistant([{ type: "text", text }], sr);
      events.push({ type: "start", partial: assistant([], sr) });
      events.push({ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text }], sr) });
      events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant([{ type: "text", text }], sr) });
      events.push({ type: "text_end", contentIndex: 0, content: text, partial: assistant([{ type: "text", text }], sr) });
      events.push({ type: "done", reason: "stop", message: finalMessage });
    } else if (turn.kind === "tool") {
      const id = turn.id ?? `call-${Math.random().toString(36).slice(2)}`;
      const toolCall = { type: "toolCall", id, name: turn.name, arguments: turn.args };
      finalMessage = assistant([toolCall], "toolUse");
      events.push({ type: "start", partial: assistant([], "toolUse") });
      events.push({ type: "toolcall_start", contentIndex: 0, toolCall, partial: assistant([toolCall], "toolUse") });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant([toolCall], "toolUse") });
      events.push({ type: "done", reason: "toolUse", message: finalMessage });
    } else {
      // hang：start 已发，finalMessage 预设为 aborted，待 abort 信号后发 done。
      finalMessage = assistant([{ type: "text", text: "" }], "aborted");
      events.push({ type: "start", partial: assistant([], "aborted") });
    }

    const isHang = !!turn && turn.kind === "hang";
    let i = 0;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Record<string, unknown>>> {
            if (isHang) {
              if (i === 0) {
                i++;
                return { value: events[0], done: false };
              }
              if (signal) {
                await new Promise<void>((resolve) => {
                  if (signal.aborted) return resolve();
                  signal.addEventListener("abort", () => resolve(), { once: true });
                });
              } else {
                await new Promise((r) => setTimeout(r, 1500));
              }
              return { value: { type: "done", reason: "stop", message: finalMessage }, done: false };
            }
            if (i < events.length) return { value: events[i++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
      result: () => Promise.resolve(finalMessage),
      current: () => Promise.resolve(finalMessage),
    };
    return stream;
  }
}
