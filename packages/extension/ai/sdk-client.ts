import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, tool } from 'ai';
import type { ToolDefinition } from '../../shared/src/tools.js';

export type { ToolDefinition };

export type SDKModelSettings = {
  provider: string;
  apiKey: string;
  model: string;
  customEndpoint?: string;
  extraHeaders?: Record<string, string>;
  useProxy?: boolean;
  proxyBaseUrl?: string;
  proxyAuthToken?: string;
  proxyProvider?: 'openai' | 'anthropic' | 'kimi' | 'openrouter';
};

/**
 * Auto-prefix bare model names for OpenRouter (requires `provider/model` format).
 */
export function normalizeOpenRouterModelId(modelId: string): string {
  let model = modelId.trim();
  if (/^openrouter\//i.test(model)) {
    const parts = model.split('/');
    if (parts.length >= 2) {
      model = parts.slice(1).join('/');
    }
  }
  if (!model || model.includes('/')) return model;
  const lower = model.toLowerCase();
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4'))
    return `openai/${model}`;
  if (lower.startsWith('claude')) return `anthropic/${model}`;
  if (lower.startsWith('gemini')) return `google/${model}`;
  if (lower.startsWith('deepseek')) return `deepseek/${model}`;
  if (lower.startsWith('qwen')) return `qwen/${model}`;
  if (lower.includes('llama')) return `meta-llama/${model}`;
  return model;
}

export function resolveLanguageModel(settings: SDKModelSettings) {
  const provider = settings.provider || 'openai';
  const modelId = String(settings.model || '').trim();
  const apiKey = settings.apiKey || '';
  const extraHeaders =
    settings.extraHeaders && typeof settings.extraHeaders === 'object' ? settings.extraHeaders : undefined;

  if (!modelId) {
    throw new Error('No model configured. Open Settings and choose a model before running.');
  }

  if (settings.useProxy && settings.proxyBaseUrl && settings.proxyAuthToken) {
    const normalizedBase = settings.proxyBaseUrl.replace(/\/+$/, '');
    const proxyProvider =
      settings.proxyProvider ||
      (provider === 'anthropic' || provider === 'kimi'
        ? 'anthropic'
        : provider === 'openrouter'
          ? 'openrouter'
          : 'openai');

    if (proxyProvider === 'anthropic') {
      const anthropicProxy = createAnthropic({
        apiKey: 'convex-proxy',
        baseURL: `${normalizedBase}/ai-proxy/anthropic/v1`,
        headers: {
          ...extraHeaders,
          Authorization: `Bearer ${settings.proxyAuthToken}`,
        },
      });
      return anthropicProxy(modelId);
    }

    if (proxyProvider === 'kimi') {
      const kimiProxy = createAnthropic({
        apiKey: 'convex-proxy',
        baseURL: `${normalizedBase}/ai-proxy/kimi/v1`,
        headers: {
          ...extraHeaders,
          Authorization: `Bearer ${settings.proxyAuthToken}`,
        },
      });
      return kimiProxy(modelId);
    }

    if (proxyProvider === 'openrouter') {
      const openRouterProxy = createOpenAICompatible({
        name: 'openrouter-proxy',
        apiKey: settings.proxyAuthToken,
        // Convex deployments in the wild commonly route OpenRouter via /v1.
        // Keeping /v1 in the client path avoids HTML fallthrough on older routes.
        baseURL: `${normalizedBase}/ai-proxy/openrouter/v1`,
        headers: {
          ...extraHeaders,
          'HTTP-Referer': 'https://parchi.app',
          'X-Title': 'Parchi',
        },
      });
      return openRouterProxy(normalizeOpenRouterModelId(modelId));
    }

    const openAiProxy = createOpenAICompatible({
      name: 'convex-proxy',
      apiKey: settings.proxyAuthToken,
      baseURL: `${normalizedBase}/ai-proxy/openai`,
      headers: extraHeaders,
    });
    return openAiProxy(modelId);
  }

  if (provider === 'anthropic') {
    const providerInstance = createAnthropic({ apiKey, headers: extraHeaders });
    return providerInstance(modelId);
  }

  if (provider === 'kimi') {
    // Kimi is Anthropic-compatible (x-api-key + /v1/messages)
    // Also requires User-Agent header (enforced via declarativeNetRequest in background.ts)
    let baseURL = (settings.customEndpoint || 'https://api.kimi.com/coding')
      .replace(/\/v1\/messages\/?$/i, '')
      .replace(/\/messages\/?$/i, '')
      .replace(/\/+$/, '');

    // createAnthropic expects base ending in /v1 — it appends /messages
    if (!/\/v1$/i.test(baseURL)) {
      baseURL = `${baseURL}/v1`;
    }

    const kimiProvider = createAnthropic({
      apiKey,
      baseURL,
      headers: extraHeaders,
    });
    return kimiProvider(modelId);
  }

  if (provider === 'openrouter') {
    const openRouterProvider = createOpenAICompatible({
      name: 'openrouter',
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      headers: {
        ...extraHeaders,
        'HTTP-Referer': 'https://parchi.app',
        'X-Title': 'Parchi',
      },
    });
    return openRouterProvider(normalizeOpenRouterModelId(modelId));
  }

  if (provider === 'custom') {
    // Normalize the base URL
    // - Remove /chat/completions suffix if present (SDK will add it)
    // - Remove /messages suffix if present
    // - Remove trailing slashes
    const rawBase = settings.customEndpoint
      ? settings.customEndpoint
          .replace(/\/chat\/completions\/?$/i, '')
          .replace(/\/v1\/messages\/?$/i, '')
          .replace(/\/messages\/?$/i, '')
          .replace(/\/+$/, '')
      : '';

    const baseURL = rawBase;

    if (!baseURL) {
      throw new Error('Custom provider requires a customEndpoint to be configured');
    }

    const customProvider = createOpenAICompatible({
      name: provider,
      apiKey,
      baseURL,
      headers: extraHeaders,
    });
    return customProvider(modelId);
  }

  const providerInstance = createOpenAI({ apiKey, headers: extraHeaders });
  return providerInstance(modelId);
}

export function buildToolSet(
  tools: ToolDefinition[],
  execute: (toolName: string, args: Record<string, unknown>, options: { toolCallId: string }) => Promise<unknown>,
) {
  const entries = tools.map((definition) => {
    const schema = definition.input_schema || {
      type: 'object',
      properties: {},
    };
    return [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(schema),
        execute: async (args, options) =>
          execute(definition.name, args as Record<string, unknown>, {
            toolCallId: options.toolCallId,
          }),
      }),
    ] as const;
  });
  return Object.fromEntries(entries);
}

export async function describeImageWithModel({
  settings,
  dataUrl,
  prompt,
  maxTokens = 512,
}: {
  settings: SDKModelSettings;
  dataUrl: string;
  prompt: string;
  maxTokens?: number;
}) {
  const model = resolveLanguageModel(settings);
  const result = await generateText({
    model,
    maxOutputTokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image: dataUrl },
        ],
      },
    ],
  });
  return result.text;
}
