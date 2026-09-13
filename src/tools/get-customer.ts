import { Type } from "@earendil-works/pi-ai";
import type { ResourceContext } from "../policy/types.js";
import type { ResourceAwareTool } from "./registry.js";

/** 确定性 in-memory 客户档案（非数据库、非 CRM、非 HTTP）。 */
export interface Customer {
  id: string;
  name: string;
  company: string;
  plan: string;
}

const CUSTOMERS: Record<string, Customer> = {
  Alice: { id: "C001", name: "Alice", company: "Acme", plan: "Enterprise" },
};

const CustomerParams = Type.Object({ name: Type.String() });

/**
 * get_customer — Phase 2 最小 Enterprise Tool（确定性）。
 *
 * - 输入：{ name: string }
 * - 输出：AgentToolResult，content 回给 LLM（JSON 文本），details 为结构化档案
 * - 不存在的 name → 抛错（Pi 自动转为 isError 的 tool result，Agent 不崩溃）
 */
export const getCustomer: ResourceAwareTool = {
  name: "get_customer",
  label: "Get Customer",
  description:
    "Look up a customer profile by customer name. Returns id, name, company, and plan.",
  parameters: CustomerParams,
  // Phase 29-C — Tool 声明其访问的 Resource Identity（customer:<name>），不含完整数据。
  resource: (args): ResourceContext | undefined => {
    const name = (args as Record<string, unknown> | undefined)?.name;
    return typeof name === "string" ? { type: "customer", id: name } : undefined;
  },
  execute: async (_toolCallId, args) => {
    const { name } = args as { name: string };
    const customer = CUSTOMERS[name];
    if (!customer) {
      throw new Error(`Customer not found: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(customer) }],
      details: customer,
    };
  },
};

export { CUSTOMERS };
