import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Tool Registry — Enterprise Runtime 拥有的 Tool 目录。
 *
 * 仅承担"所有权/目录"职责：按 name 索引 AgentTool，并按需导出供 Pi 使用的
 * AgentTool[]。真正的 Tool 执行由 pi-agent-core 的 Agent Loop 负责（调用
 * AgentTool.execute），本 Registry 不执行任何 Tool。
 */
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
