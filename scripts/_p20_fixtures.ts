/**
 * Phase 20-1 测试夹具（非生产代码）。
 *
 * 提供：
 *  - ScriptedModel：确定性 streamFn，无需真实 LLM 即可驱动指定 Tool Call（含崩溃前 Tool Call）。
 *  - ExternalResource：文件型外部副作用真相源（幂等 commit）。
 *  - makeCommitTool / makeReadOnlyTool：测试用 Tool（含崩溃模式）。
 *
 * 这些仅用于验证 Recovery 边界，不进入 src 生产路径。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ReconcileFn } from "../src/recovery/types.js";

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

/** 确定性模型：每次 streamFn 调用从队列取一个预设响应（Tool Call 或最终文本）。 */
export class ScriptedModel {
  private queue: ScriptedToolCall[] = [];
  private finals: string[] = [];
  /** Phase 34-B — 测试用：在发出任何事件前（Tool 尚未执行）模拟进程崩溃。 */
  crashBeforeTool = false;

  enqueueTool(call: ScriptedToolCall): void {
    this.queue.push(call);
  }

  enqueueFinal(text: string): void {
    this.finals.push(text);
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
    return ((_m: unknown, _c: unknown, _o: unknown) => self.makeStream()) as unknown as StreamFn;
  }

  private makeStream() {
    const call = this.queue.shift();
    let events: Record<string, unknown>[];
    let finalMessage: Record<string, unknown>;
    if (call) {
      const id = call.id ?? `call-${Math.random().toString(36).slice(2)}`;
      const toolCall = { type: "toolCall", id, name: call.name, arguments: call.arguments };
      finalMessage = assistantMsg([toolCall]);
      events = [
        { type: "start", partial: assistantMsg([]) },
        { type: "toolcall_start", contentIndex: 0, toolCall, partial: assistantMsg([toolCall]) },
        { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistantMsg([toolCall]) },
        { type: "done", reason: "toolUse", message: assistantMsg([toolCall]) },
      ];
    } else {
      const text = this.finals.shift() ?? "OK";
      finalMessage = assistantMsg([{ type: "text", text }]);
      events = [
        { type: "start", partial: assistantMsg([]) },
        { type: "text_start", contentIndex: 0, partial: assistantMsg([{ type: "text", text }]) },
        { type: "text_delta", contentIndex: 0, delta: text, partial: assistantMsg([{ type: "text", text }]) },
        { type: "text_end", contentIndex: 0, content: text, partial: assistantMsg([{ type: "text", text }]) },
        { type: "done", reason: "stop", message: assistantMsg([{ type: "text", text }]) },
      ];
    }
    let i = 0;
    const self = this;
    // AssistantMessageEventStream = async-iterable + result()/current(). Pi calls response.result() for the final message.
    const stream: Record<string, unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (self.crashBeforeTool && i === 0) process.exit(137);
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

function assistantMsg(content: unknown[]): Record<string, unknown> {
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
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/**
 * 文件型外部资源 = 真实世界副作用的最终事实来源。
 * 按 idempotencyKey 幂等 commit：重复 commit 不产生新副作用（count 仅计不同 key）。
 */
export class ExternalResource {
  constructor(private readonly file: string) {}

  private async read(): Promise<Record<string, { status: string; committedAt: number }>> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, { status: string; committedAt: number }>;
    } catch {
      return {};
    }
  }

  private async write(data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data), "utf8");
  }

  /** 不同 idempotencyKey 的已提交副作用数量（side effect count）。 */
  async commitCount(): Promise<number> {
    const d = await this.read();
    return Object.keys(d).length;
  }

  async status(key: string): Promise<"SUCCESS" | "NOT_FOUND" | "UNKNOWN"> {
    const d = await this.read();
    return d[key] ? "SUCCESS" : "NOT_FOUND";
  }

  /** 幂等 commit：仅当 key 不存在时落盘。返回是否产生了新副作用。 */
  async commit(key: string): Promise<{ committed: boolean }> {
    const d = await this.read();
    if (d[key]) return { committed: false };
    d[key] = { status: "COMMITTED", committedAt: Date.now() };
    await this.write(d);
    return { committed: true };
  }
}

export function reconcileFileExternal(resource: ExternalResource): ReconcileFn {
  return (key) => resource.status(key);
}

export type CrashMode = "none" | "commit-exit" | "precommit-exit" | "start-exit";

/**
 * 最小 Idempotent State-changing Tool。
 * replay:"safe" 声明可安全重放（前提是对外部幂等）。
 * 崩溃模式：
 *  - commit-exit：提交外部副作用后 process.exit(137)（模拟"已提交但 result 丢失"）
 *  - precommit-exit：提交前 process.exit(137)（模拟"未提交"）
 */
export function makeCommitTool(resource: ExternalResource, mode: CrashMode): AgentTool<any, any> {
  const CommitParams = Type.Object({ idempotencyKey: Type.String() });
  return {
    name: "commit_record",
    label: "Commit Record",
    description: "Commit a durable record to the external resource (idempotent by idempotencyKey).",
    parameters: CommitParams,
    replay: "safe",
    execute: async (_id: string, params: { idempotencyKey: string }) => {
      const key = params.idempotencyKey;
      if (mode === "commit-exit") {
        await resource.commit(key);
        process.exit(137);
      }
      if (mode === "precommit-exit") {
        process.exit(137);
      }
      const r = await resource.commit(key);
      return {
        content: [{ type: "text", text: JSON.stringify(r) }],
        details: { operationId: key, committed: r.committed },
      };
    },
  } as AgentTool<any, any>;
}

/** 最小 read-only Tool（安全重放）。 */
export function makeReadOnlyTool(): AgentTool<any, any> {
  const Params = Type.Object({ value: Type.String() });
  return {
    name: "echo",
    label: "Echo",
    description: "Read-only echo (safe to replay).",
    parameters: Params,
    replay: "safe",
    execute: async (_id: string, params: { value: string }) => ({
      content: [{ type: "text", text: String(params.value) }],
      details: { value: params.value },
    }),
  } as AgentTool<any, any>;
}
