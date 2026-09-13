/**
 * Phase 27-B — Business Client 示例（非生产代码）。
 *
 * 这是一个「真实业务应用」的缩影：它只通过 EnterpriseAiRuntime 的 Public API 工作，
 * 不接触任何 Pi 内部（Agent / Agent State / ToolRegistry / TraceCollector / Policy evaluator /
 * RecoveryStore / Provider / streamFunction）。
 *
 * 它唯一能做的四件事：
 *   1. 构造 Runtime（传入 tools / policy / model / systemPrompt）
 *   2. execute(task) → 拿到结构化 RunResult
 *   3. abort() → 中止当前 Run
 *   4. 读取 sessionId（稳定身份）
 */
import { EnterpriseAiRuntime } from "../src/index.js";
import type { AgentTool, Policy, RunResult } from "../src/index.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export interface BusinessClientOptions {
  tools: AgentTool<any>[];
  policy?: Policy;
  /** 注入自定义 Model（生产默认 Ollama；测试注入 ScriptedModel）。 */
  model?: Model<any>;
  /**
   * 测试用注入：确定性 streamFn（离线驱动 Tool Call）。生产路径不传，
   * Runtime 使用默认 Ollama streamFn。这里仅为可重复的 acceptance 而暴露。
   */
  streamFn?: StreamFn;
  systemPrompt?: string;
}

export class BusinessClient {
  private readonly runtime: EnterpriseAiRuntime;

  constructor(opts: BusinessClientOptions) {
    this.runtime = new EnterpriseAiRuntime({
      tools: opts.tools,
      policy: opts.policy,
      model: opts.model,
      streamFn: opts.streamFn,
      systemPrompt: opts.systemPrompt ?? "You are a helpful enterprise assistant.",
    });
  }

  /** 提交一个业务任务，返回结构化的 Run Result。 */
  async execute(task: string): Promise<RunResult> {
    return this.runtime.run(task);
  }

  /** 中止当前正在进行的 Run（调用方主动取消）。 */
  abort(): void {
    this.runtime.abort();
  }

  /** 跨实例稳定的 Session 身份。 */
  get sessionId(): string {
    return this.runtime.getSessionId();
  }
}
