import "../env.js";

import {
  createModels,
  createProvider,
  type Api,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { LlmTraceSink } from "../trace/types.js";

/**
 * Provider-neutral LLM configuration (Phase 26.1-A).
 *
 * 配置入口统一为环境变量：
 *   LLM_PROVIDER    provider 名称（默认 "ollama"）
 *   LLM_MODEL       model id
 *   LLM_BASE_URL    OpenAI-compatible 端点
 *   LLM_API_KEY     鉴权 key
 *
 * 向后兼容：LLM_* 未设置时回落到旧的 OLLAMA_* 变量，最终回落到 Ollama 默认值，
 * 因此现有 Ollama 用户无需改变运行方式。
 *
 * 底层完全复用 pi-ai 官方适配器 openAICompletionsApi + createProvider + createModels，
 * 不新增任何 Provider abstraction subsystem。
 *
 * DeepSeek 原生支持（pi-ai@0.85.1 自带 deepseek.json 目录 + openai-completions 内
 * isDeepSeek 兼容分支）；provider="deepseek" 时只需正确的 baseUrl / apiKey 即可，
 * 无需 Adapter。本阶段不调用 DeepSeek（无 API key），仅做配置准备。
 */

type LlmProviderName = "ollama" | "deepseek";

const PROVIDER = ((process.env.LLM_PROVIDER ?? "ollama").toLowerCase()) as LlmProviderName;

interface ProviderDefault {
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

const PROVIDER_DEFAULTS: Record<LlmProviderName, ProviderDefault> = {
  ollama: {
    model: "qwen2.5:14b",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    contextWindow: 32768,
    maxTokens: 4096,
    reasoning: false,
  },
  deepseek: {
    // 实际 model identifier 来自 pi-ai@0.85.1 源码 dist/providers/data/deepseek.json
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: true,
  },
};

const defaults = PROVIDER_DEFAULTS[PROVIDER] ?? PROVIDER_DEFAULTS.ollama;

// provider 专属 key：deepseek 优先 DEEPSEEK_API_KEY，ollama 优先 OLLAMA_API_KEY；
// 再统一回落到 LLM_API_KEY，最后回落到 provider 默认值（ollama="ollama" 占位，deepseek=""）。
const providerKeyEnv =
  PROVIDER === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OLLAMA_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL ?? process.env.OLLAMA_MODEL ?? defaults.model;
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? defaults.baseUrl;
const LLM_API_KEY = process.env.LLM_API_KEY ?? providerKeyEnv ?? defaults.apiKey;

export const ollamaModel: Model<"openai-completions"> = {
  id: LLM_MODEL,
  name: `${PROVIDER} ${LLM_MODEL}`,
  api: "openai-completions",
  provider: PROVIDER,
  baseUrl: LLM_BASE_URL,
  reasoning: defaults.reasoning,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: defaults.contextWindow,
  maxTokens: defaults.maxTokens,
  // Ollama 走标准 chat/completions 语义，显式关闭官方端点才有的字段；
  // 其他 provider（如 deepseek）交由 pi-ai detectCompat 自动识别，不在此硬编码。
  compat:
    PROVIDER === "ollama"
      ? {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          maxTokensField: "max_tokens",
          requiresAssistantAfterToolResult: false,
          requiresToolResultName: false,
        }
      : undefined,
};

export interface OllamaRuntimeDeps {
  models: ReturnType<typeof createModels>;
  streamFn: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

export function createOllamaRuntimeDeps(sink?: LlmTraceSink): OllamaRuntimeDeps {
  const provider: Provider<"openai-completions"> = createProvider({
    id: PROVIDER,
    baseUrl: LLM_BASE_URL,
    auth: {
      apiKey: {
        name: `${PROVIDER} (env LLM_API_KEY${PROVIDER === "deepseek" ? " / DEEPSEEK_API_KEY" : " / OLLAMA_API_KEY"})`,
        resolve: async () => ({ auth: { apiKey: LLM_API_KEY } }),
      },
    },
    models: [ollamaModel],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);

  // 包装 streamFn：复用 Pi 官方 openAICompletionsApi，并接入官方 onPayload / onResponse
  // 钩子做 observe-only 的 LLM Interaction Trace。必须原样 return params，不改变请求。
  const streamFn = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream =>
    models.streamSimple(model, context, {
      ...options,
      onPayload: (params, m) => {
        sink?.observeLlmRequest(params, { id: m.id });
        return params;
      },
      onResponse: (resp, m) => {
        sink?.observeLlmResponse({ status: resp.status, headers: resp.headers }, { id: m.id });
      },
    });

  return { models, streamFn };
}
