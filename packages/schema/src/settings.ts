import { z } from 'zod';
import { AssetSettings, MediaRoute } from './assets.ts';

/** 某个接入点上某个模型的价格，单位：每百万 token。 */
export const ModelPricing = z.object({
  input: z.number().min(0).default(0),
  output: z.number().min(0).default(0),
  /** 命中缓存的输入价格；不填按 input 计。 */
  cachedInput: z.number().min(0).optional(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

/**
 * 能力探测结果。同样是 OpenAI 兼容接口，各家支持的东西差别很大，
 * 引擎按这里的结果选择调用方式和降级路径。
 */
export const Capabilities = z.object({
  model: z.string(),
  testedAt: z.string(),
  chat: z.boolean(),
  streaming: z.boolean(),
  /** 流式返回时能否通过 stream_options.include_usage 拿到用量。 */
  streamUsage: z.boolean(),
  jsonSchema: z.boolean(),
  jsonObject: z.boolean(),
  tools: z.boolean(),
  /** 该模型要求用 max_completion_tokens 而不是 max_tokens（如 OpenAI 推理模型）。 */
  useMaxCompletionTokens: z.boolean().default(false),
  /** 该模型不接受自定义 temperature。 */
  noTemperature: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** 一个 OpenAI 兼容的接入点（OpenAI、DeepSeek、通义千问、Ollama……）。 */
export const Endpoint = z.object({
  id: z.string(),
  name: z.string().min(1),
  kind: z.literal('openai-compatible').default('openai-compatible'),
  baseURL: z.url(),
  /** 模型列表：手填或从 /models 拉取。 */
  models: z.array(z.string()).default([]),
  defaultModel: z.string().optional(),
  /** 额外请求头，例如 OpenRouter 的 HTTP-Referer。 */
  headers: z.record(z.string(), z.string()).default({}),
  currency: z.enum(['USD', 'CNY']).default('USD'),
  pricing: z.record(z.string(), ModelPricing).default({}),
  capabilities: z.record(z.string(), Capabilities).default({}),
  createdAt: z.string(),
});
export type Endpoint = z.infer<typeof Endpoint>;

/** 引擎里的模型职责。见 docs/ARCHITECTURE.md 7.2。 */
export const ROLE_IDS = ['default', 'director', 'actor', 'narrator', 'archivist', 'worldgen', 'critic'] as const;
export const RoleId = z.enum(ROLE_IDS);
export type RoleId = z.infer<typeof RoleId>;

export const ROLE_LABELS: Record<RoleId, { name: string; hint: string }> = {
  default: { name: '默认', hint: '没有单独指定模型的职责都用它' },
  director: { name: '导演', hint: '决定剧情走向与节奏，建议用最强的模型' },
  actor: { name: '演员', hint: '扮演各个角色说话行动，调用最频繁，可用便宜模型' },
  narrator: { name: '旁白', hint: '叙述与舞台指令，需要文笔' },
  archivist: { name: '书记', hint: '写摘要、更新记忆，便宜模型即可' },
  worldgen: { name: '创世', hint: '一键生成世界，建议用强模型' },
  critic: { name: '审校', hint: '检查设定矛盾，可关闭' },
};

export const RoleRoute = z.object({
  endpointId: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type RoleRoute = z.infer<typeof RoleRoute>;

/** settings.json：应用设置（不含任何密钥，密钥单独加密保存）。 */
export const AppSettings = z.object({
  formatVersion: z.number().int().default(0),
  endpoints: z.array(Endpoint).default([]),
  roles: z.partialRecord(RoleId, RoleRoute).default({}),
  /** 图像、抠图、音乐（以后还有语音）职责。和文本职责分开：没配就不生成，不会退回「默认」。 */
  media: z.object({ image: MediaRoute.optional(), cutout: MediaRoute.optional(), music: MediaRoute.optional() }).prefault({}),
  /** 素材管线的全局设置（18.11）。 */
  assets: AssetSettings.prefault({}),
});
export type AppSettings = z.infer<typeof AppSettings>;
