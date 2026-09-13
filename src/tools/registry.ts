import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResourceContext, CredentialContext } from "../policy/types.js";

/**
 * Tool Registry — Enterprise Runtime 拥有的 Tool 目录。
 *
 * 仅承担"所有权/目录"职责：按 name 索引 AgentTool，并按需导出供 Pi 使用的
 * AgentTool[]。真正的 Tool 执行由 pi-agent-core 的 Agent Loop 负责（调用
 * AgentTool.execute），本 Registry 不执行任何 Tool。
 */

/**
 * Phase 29-C — Resource-aware Tool。
 *
 * 在 Pi 的 AgentTool 之上增加一个**可选**的 `resource` 解析器：Tool 自行声明
 * 「本次调用正在访问哪个 Resource Identity（仅 type/id，不含数据）」。
 * 业务 Resource 语义由 Tool / Resource integration 确定，Runtime 作为控制平面
 * 不猜测业务参数语义（不引入 ResourceManager）。
 */
export interface ResourceAwareTool extends AgentTool<any> {
  resource?: (args: unknown) => ResourceContext | undefined;
}

/**
 * Phase 29-D — Credential-aware Tool。
 *
 * 在 Pi 的 AgentTool 之上增加一个**可选**的 `credential` 解析器：Tool 自行声明
 * 「本次调用需要使用哪个 Credential Reference（仅 type/id，不含密钥）」。
 * 业务 Credential 语义由 Tool / Integration 确定，Runtime 作为控制平面
 * 不猜测业务参数语义（不引入 CredentialManager / Vault / SecretProvider）。
 */
export interface CredentialAwareTool extends AgentTool<any> {
  credential?: (args: unknown) => CredentialContext | undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<any>>();

  constructor(initial: AgentTool<any>[] = []) {
    for (const tool of initial) this.register(tool);
  }

  /** 注册/覆盖一个 Tool（按 tool.name 索引）。 */
  register(tool: AgentTool<any>): void {
    this.tools.set(tool.name, tool);
  }

  /** 按名称取回 Tool。 */
  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Phase 29-C — 解析某 Tool 在当前 args 下访问的 Resource Identity。
   * 由 Tool 自身的 `resource` 解析器确定；Registry 不猜测语义。无解析器则返回 undefined。
   */
  resourceOf(name: string, args: unknown): ResourceContext | undefined {
    const tool = this.tools.get(name) as ResourceAwareTool | undefined;
    return tool?.resource ? tool.resource(args) : undefined;
  }

  /**
   * Phase 29-D — 解析某 Tool 在当前 args 下所需的 Credential Reference（仅 type/id，不含密钥）。
   * 由 Tool 自身的 `credential` 解析器确定；Registry 不猜测语义。无解析器则返回 undefined。
   */
  credentialOf(name: string, args: unknown): CredentialContext | undefined {
    const tool = this.tools.get(name) as CredentialAwareTool | undefined;
    return tool?.credential ? tool.credential(args) : undefined;
  }

  /** 返回所有已注册 Tool。 */
  list(): AgentTool<any>[] {
    return [...this.tools.values()];
  }

  /** 返回已注册 Tool 名称。 */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 导出供底层 Agent 使用的 Tool 数组（每次返回新数组，避免外部修改内部 Map）。 */
  toAgentTools(): AgentTool<any>[] {
    return this.list();
  }
}
