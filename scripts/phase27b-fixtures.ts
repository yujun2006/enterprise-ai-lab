/**
 * Phase 27-B 测试夹具（非生产代码）。
 *
 * 提供：
 *  - ScriptedModelV2：确定性 streamFn，支持正确的 stopReason（completed/error/aborted）
 *    以及「挂起」行为以离线驱动 abort（监听 Pi 传入的 AbortSignal）。
 *  - makeFailingTool：返回 isError 结果的 Tool（不抛异常，验证 Public API 不泄漏内部异常）。
 *  - denyGetCustomerPolicy：拒绝 get_customer 的 Policy（验证 Policy DENY 不执行 Tool）。
 *
 * 仅用于验证 Public API / RunResult 边界，不进入 src 生产路径。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Policy } from "../src/index.js";

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

/** 确定性模型：每轮 streamFn 从队列取一个预设响应（Tool Call / 最终文本 / 挂起）。 */
export class ScriptedModelV2 {
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

  private makeStream(signal?: AbortSignal): Record<string, unknown> {
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

/** 返回 isError 结果的 Tool（不抛异常）：验证 Tool Failure 不泄漏内部异常到 Public API。 */
export function makeFailingTool(): AgentTool<any, any> {
  const Params = Type.Object({ key: Type.String() });
  return {
    name: "unreliable_lookup",
    label: "Unreliable Lookup",
    description: "A tool that fails by returning an isError result (no throw).",
    parameters: Params,
    replay: "safe",
    execute: async (_id: string, _params: { key: string }) => ({
      content: [{ type: "text", text: "connection refused: upstream timeout" }],
      details: { error: "timeout" },
      isError: true,
    }),
  } as AgentTool<any, any>;
}

/** 拒绝 get_customer 的 Policy（其余放行）。 */
export const denyGetCustomerPolicy: Policy = (call) => {
  if (call.toolName === "get_customer") {
    return { type: "deny", reason: "customer lookup disabled by enterprise policy" };
  }
  return { type: "allow" };
};
