import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Phase 30 — Skill = Capability Declaration / Activation Profile（不是权限容器）。
 *
 * Skill 只声明「本 Skill 激活哪些 Tool 能力」与可选 instructions；
 * 不持有权限 / 凭证 / 授权逻辑。授权仍由 Policy 在 Tool Call 时独立评估。
 *
 *   Skill ≠ Permission Container
 *   Skill ≠ IAM Role
 *   Skill ≠ Credential Bundle
 *   Skill ≠ Authorization Engine
 */
export interface Skill {
  id: string;
  name?: string;
  instructions?: string;
  /** 本 Skill 激活（使其对 Pi Agent 可见）的 Tool 名称集合。空/未声明 = 全部已注册 Tool。 */
  toolNames?: string[];
}

/**
 * 由 Skill 声明计算「本 Run 实际可见的 Tool 集合」（仅影响可见性）。
 *
 * - skill 未声明 toolNames → 返回全部已注册 Tool（兼容既有无 Skill 行为）。
 * - skill 声明 toolNames → 取「已注册 ∩ 声明」交集，作为 Pi 可见 Tool 集。
 *
 * 纯函数、无状态、无 Manager。不涉及任何授权 / Policy 评估。
 */
export function effectiveToolsFor(skill: Skill | undefined, all: AgentTool<any>[]): AgentTool<any>[] {
  if (!skill?.toolNames || skill.toolNames.length === 0) return all;
  const declared = new Set(skill.toolNames);
  return all.filter((t) => declared.has(t.name));
}

/**
 * 组合 system prompt：Runtime 基础指令 + Skill 激活指令（局部拼接，不引入 PromptManager / PromptEngine）。
 */
export function composeSystemPrompt(base: string, skill: Skill | undefined): string {
  if (!skill?.instructions) return base;
  return `${base}\n\n${skill.instructions}`;
}
